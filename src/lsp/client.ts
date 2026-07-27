import type * as vscode from 'vscode';
import { RevealOutputChannelOn, type LanguageClientOptions } from 'vscode-languageclient';
import { LanguageClient, TransportKind, type ServerOptions } from 'vscode-languageclient/node';
import { TONO_LANGUAGE_ID } from '../cli/commands';

/**
 * Builds the client for the `tono_lsp` server.
 *
 * The server speaks JSON-RPC over stdio and takes no arguments. Diagnostics,
 * hover and formatting all come from the same OCaml frontend the `tono` CLI
 * uses, so the editor and `tono check` cannot disagree about a single file.
 */
export function createLanguageClient(binary: string, log: vscode.LogOutputChannel): LanguageClient {
  const serverOptions: ServerOptions = {
    command: binary,
    transport: TransportKind.stdio,
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: 'file', language: TONO_LANGUAGE_ID }],
    outputChannel: log,
    revealOutputChannelOn: RevealOutputChannelOn.Never,
  };

  // The id is the configuration section the client reads `trace.server` from,
  // so it has to match the tono.server.trace.server setting.
  return new LanguageClient('tono.server', 'Tono Language Server', serverOptions, clientOptions);
}
