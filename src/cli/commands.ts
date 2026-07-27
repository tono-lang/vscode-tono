import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { describeFailure, type Resolution } from '../binaries';
import { formatArgs, previewArgs } from './args';

const run = promisify(execFile);

export const TONO_LANGUAGE_ID = 'tono';

export interface CommandDeps {
  readonly resolveCli: () => Resolution;
  readonly log: vscode.LogOutputChannel;
}

/**
 * Returns the Tono document to act on, after flushing it to disk.
 *
 * The CLI reads the file from disk, so an unsaved buffer would be formatted or
 * previewed against stale content.
 */
async function activeTonoFile(): Promise<vscode.TextDocument | undefined> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== TONO_LANGUAGE_ID) {
    void vscode.window.showWarningMessage('Open a .tono file first.');
    return undefined;
  }
  const document = editor.document;
  if (document.isUntitled) {
    void vscode.window.showWarningMessage('Save the file to disk before running Tono commands.');
    return undefined;
  }
  if (document.isDirty && !(await document.save())) {
    return undefined;
  }
  return document;
}

function cliOrComplain(deps: CommandDeps): string | undefined {
  const resolution = deps.resolveCli();
  if (resolution.kind === 'found') {
    deps.log.debug(`using tono CLI at ${resolution.path} (${resolution.source})`);
    return resolution.path;
  }
  const message = describeFailure('tono CLI', resolution);
  deps.log.error(message);
  void vscode.window.showErrorMessage(message);
  return undefined;
}

/** stderr carries the diagnostics report, which is the useful part of a failure. */
function failureDetail(error: unknown): string {
  const stderr = (error as { stderr?: unknown }).stderr;
  const text = typeof stderr === 'string' ? stderr.trim() : '';
  return text.length > 0 ? text : String(error);
}

async function formatCommand(deps: CommandDeps): Promise<void> {
  const document = await activeTonoFile();
  if (!document) {
    return;
  }
  const cli = cliOrComplain(deps);
  if (!cli) {
    return;
  }

  const formattedFrom = document.version;
  let formatted: string;
  try {
    const result = await run(cli, formatArgs(document.uri.fsPath), {
      cwd: path.dirname(document.uri.fsPath),
      maxBuffer: 32 * 1024 * 1024,
    });
    formatted = result.stdout;
  } catch (error) {
    const detail = failureDetail(error);
    deps.log.error(`tono fmt failed: ${detail}`);
    void vscode.window.showErrorMessage(`tono fmt failed. ${detail.split('\n')[0] ?? ''}`);
    return;
  }

  // The CLI formatted what was on disk. Anything typed while it ran would be
  // silently reverted by replacing the whole document with that output.
  if (document.version !== formattedFrom) {
    deps.log.info('tono fmt: the file changed while formatting, discarding the result');
    return;
  }

  if (formatted === document.getText()) {
    deps.log.debug('tono fmt: already formatted');
    return;
  }

  const edit = new vscode.WorkspaceEdit();
  const whole = new vscode.Range(
    document.positionAt(0),
    document.positionAt(document.getText().length)
  );
  edit.replace(document.uri, whole, formatted);
  if (!(await vscode.workspace.applyEdit(edit))) {
    void vscode.window.showErrorMessage('Could not apply the formatted Tono source.');
  }
}

async function previewCommand(deps: CommandDeps): Promise<void> {
  const document = await activeTonoFile();
  if (!document) {
    return;
  }
  const cli = cliOrComplain(deps);
  if (!cli) {
    return;
  }

  const settings = vscode.workspace.getConfiguration('tono', document.uri);
  let args: string[];
  try {
    args = previewArgs(
      document.uri.fsPath,
      settings.get<string[]>('preview.targets') ?? [],
      settings.get<boolean>('preview.watch') ?? true
    );
  } catch (error) {
    void vscode.window.showErrorMessage(String(error instanceof Error ? error.message : error));
    return;
  }

  // A task rather than a child process: preview streams output and, in watch
  // mode, keeps running until the user stops it.
  const task = new vscode.Task(
    { type: 'tono', command: 'preview' },
    vscode.workspace.getWorkspaceFolder(document.uri) ?? vscode.TaskScope.Workspace,
    'preview',
    'tono',
    new vscode.ProcessExecution(cli, args, { cwd: path.dirname(document.uri.fsPath) })
  );
  task.presentationOptions = {
    reveal: vscode.TaskRevealKind.Always,
    panel: vscode.TaskPanelKind.Dedicated,
    clear: true,
  };

  deps.log.info(`tono ${args.join(' ')}`);
  await vscode.tasks.executeTask(task);
}

export function registerCommands(deps: CommandDeps): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('tono.format', () => formatCommand(deps)),
    vscode.commands.registerCommand('tono.preview', () => previewCommand(deps)),
  ];
}
