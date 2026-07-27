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

const DOCUMENT_SELECTOR: vscode.DocumentSelector = [{ scheme: 'file', language: TONO_LANGUAGE_ID }];

function isExecutable(candidate: string): boolean {
  try {
    if (!fs.statSync(candidate).isFile()) {
      return false;
    }
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveContext(): ResolveContext {
  return {
    env: process.env,
    workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
    home: os.homedir(),
    exeSuffix: process.platform === 'win32' ? '.exe' : '',
    probe: { isExecutable },
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
    const root = this.context.extensionUri.fsPath;
    try {
      this.highlighting = await registerHighlighting(
        {
          runtimeDir: path.join(root, 'dist'),
          parserWasmPath: path.join(root, 'grammar', 'tono.wasm'),
          queryPath: path.join(root, 'grammar', 'highlights.scm'),
        },
        DOCUMENT_SELECTOR,
        this.log
      );
    } catch (error) {
      this.log.error(`tree-sitter highlighting is unavailable: ${String(error)}`);
      void vscode.window.showWarningMessage(
        'Tono syntax highlighting could not start. See the Tono output channel for details.'
      );
    }
  }

  private stopHighlighting(): void {
    this.highlighting?.dispose();
    this.highlighting = undefined;
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
      await this.reportMissingServer(describeFailure('Tono language server (tono_lsp)', resolution));
      return;
    }

    this.log.info(`starting tono_lsp from ${resolution.path} (${resolution.source})`);
    const client = createLanguageClient(resolution.path, this.log);
    this.client = client;
    try {
      await client.start();
    } catch (error) {
      this.client = undefined;
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
