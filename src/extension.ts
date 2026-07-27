import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';
import {
  describeFailure,
  resolveCli,
  resolveLanguageServer,
  type ResolveContext,
  type Resolution,
} from './binaries';
import { registerCommands, TONO_LANGUAGE_ID } from './cli/commands';
import { registerHighlighting } from './highlight/provider';
import { createLanguageClient } from './lsp/client';

// Highlighting is a pure function of the buffer text, so it applies to every
// scheme. Restricting it to `file` would leave Tono uncoloured in diff views and
// in the Timeline, and with no TextMate grammar there is nothing to fall back on.
const HIGHLIGHT_SELECTOR: vscode.DocumentSelector = [{ language: TONO_LANGUAGE_ID }];

function isExecutable(candidate: string): boolean {
  try {
    if (!fs.statSync(candidate).isFile()) {
      return false;
    }
    // Windows reports every existing file as executable, so there the extension
    // list in binaries.ts is what actually decides.
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function exists(candidate: string): boolean {
  return fs.existsSync(candidate);
}

function resolveContext(): ResolveContext {
  return {
    env: process.env,
    workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
    home: os.homedir(),
    exeSuffix: process.platform === 'win32' ? '.exe' : '',
    probe: { isExecutable, exists },
  };
}

function settings(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('tono');
}

function resolveCliBinary(): Resolution {
  return resolveCli(settings().get<string>('cli.path') ?? '', resolveContext());
}

class TonoExtension {
  private client: LanguageClient | undefined;
  private highlighting: vscode.Disposable | undefined;
  // Configuration changes arrive as events that cannot be awaited, so the work
  // they trigger is queued. Two quick edits to tono.server.path would otherwise
  // start a second server while the first is still shutting down.
  private pending: Promise<unknown> = Promise.resolve();
  // Bumped by every start and stop. Loading the grammar is asynchronous, so a
  // load that finishes after it was superseded has to throw its result away:
  // web-tree-sitter has no way to free a Language, making an orphan permanent.
  private highlightGeneration = 0;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: vscode.LogOutputChannel
  ) {}

  async activate(): Promise<void> {
    this.context.subscriptions.push(
      ...registerCommands({ resolveCli: resolveCliBinary, log: this.log }),
      vscode.commands.registerCommand('tono.restartServer', () => this.restartServer()),
      vscode.commands.registerCommand('tono.showServerOutput', () => this.log.show()),
      vscode.workspace.onDidChangeConfiguration((event) => this.onConfigurationChanged(event))
    );

    await Promise.all([this.startHighlighting(), this.startServer()]);
  }

  async dispose(): Promise<void> {
    // Let any queued restart finish first, so its client cannot outlive dispose.
    await this.pending.catch(() => undefined);
    this.highlighting?.dispose();
    this.highlighting = undefined;
    await this.stopServer();
  }

  private enqueue(work: () => Promise<void>): void {
    this.pending = this.pending.then(work, work);
  }

  private async startHighlighting(): Promise<void> {
    if (this.highlighting || !(settings().get<boolean>('highlight.enabled') ?? true)) {
      return;
    }
    this.warnIfSemanticHighlightingOff();

    const generation = ++this.highlightGeneration;
    const root = this.context.extensionUri.fsPath;
    try {
      const registration = await registerHighlighting(
        {
          runtimeDir: path.join(root, 'dist'),
          parserWasmPath: path.join(root, 'grammar', 'tono.wasm'),
          queryPath: path.join(root, 'grammar', 'highlights.scm'),
        },
        HIGHLIGHT_SELECTOR,
        this.log
      );
      if (generation !== this.highlightGeneration) {
        registration.dispose();
        return;
      }
      this.highlighting = registration;
    } catch (error) {
      this.log.error(`tree-sitter highlighting is unavailable: ${String(error)}`);
      void vscode.window.showWarningMessage(
        'Tono syntax highlighting could not start. See the Tono output channel for details.'
      );
    }
  }

  private stopHighlighting(): void {
    this.highlightGeneration++;
    this.highlighting?.dispose();
    this.highlighting = undefined;
  }

  /**
   * Tono has no TextMate grammar, so semantic tokens are the only source of
   * colour. When they are switched off the file renders as plain text with
   * nothing in the UI to explain why.
   */
  private warnIfSemanticHighlightingOff(): void {
    const enabled = vscode.workspace
      .getConfiguration('editor')
      .get<boolean | string>('semanticHighlighting.enabled');
    if (enabled === false) {
      this.log.warn(
        'editor.semanticHighlighting.enabled is false, so Tono files will not be coloured. ' +
          'Set it to true or "configuredByTheme".'
      );
    }
  }

  private async startServer(): Promise<void> {
    if (this.client || !(settings().get<boolean>('server.enabled') ?? true)) {
      return;
    }

    const cli = resolveCliBinary();
    const resolution = resolveLanguageServer(
      settings().get<string>('server.path') ?? '',
      cli.kind === 'found' ? cli.path : undefined,
      resolveContext()
    );

    if (resolution.kind !== 'found') {
      if (resolution.kind === 'not-found') {
        this.log.info(`searched for tono_lsp in:\n  ${resolution.searched.join('\n  ')}`);
      }
      // Deliberately not awaited. A notification carrying an action button stays
      // pending until the user answers it, and awaiting that here would leave the
      // extension activating forever on the common first run with no server built.
      void this.reportMissingServer(describeFailure('Tono language server (tono_lsp)', resolution));
      return;
    }

    this.log.info(`starting tono_lsp from ${resolution.path} (${resolution.source})`);
    const client = createLanguageClient(resolution.path, this.log);
    this.client = client;
    try {
      await client.start();
    } catch (error) {
      // Only clear the field if it still holds this client: a restart that
      // overlapped this one would otherwise lose track of a running process.
      if (this.client === client) {
        this.client = undefined;
      }
      this.log.error(`the Tono language server failed to start: ${String(error)}`);
      void vscode.window.showErrorMessage(
        'The Tono language server failed to start. See the Tono output channel for details.'
      );
    }
  }

  private async reportMissingServer(message: string): Promise<void> {
    this.log.warn(message);
    const openSettings = 'Open Settings';
    const choice = await vscode.window.showWarningMessage(
      `${message} Syntax highlighting still works without it.`,
      openSettings
    );
    if (choice === openSettings) {
      await vscode.commands.executeCommand('workbench.action.openSettings', 'tono.server.path');
    }
  }

  private async stopServer(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    if (!client) {
      return;
    }
    try {
      await client.stop();
    } catch (error) {
      this.log.warn(`the Tono language server did not stop cleanly: ${String(error)}`);
    }
  }

  private async restartServer(): Promise<void> {
    await this.stopServer();
    await this.startServer();
    if (this.client) {
      void vscode.window.showInformationMessage('Tono language server restarted.');
    }
  }

  private onConfigurationChanged(event: vscode.ConfigurationChangeEvent): void {
    if (
      event.affectsConfiguration('tono.server.path') ||
      event.affectsConfiguration('tono.server.enabled')
    ) {
      this.enqueue(() => this.restartServer());
    }
    if (event.affectsConfiguration('tono.highlight.enabled')) {
      this.enqueue(async () => {
        this.stopHighlighting();
        await this.startHighlighting();
      });
    }
  }
}

let extension: TonoExtension | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const log = vscode.window.createOutputChannel('Tono', { log: true });
  context.subscriptions.push(log);

  extension = new TonoExtension(context, log);
  await extension.activate();
}

export async function deactivate(): Promise<void> {
  await extension?.dispose();
  extension = undefined;
}
