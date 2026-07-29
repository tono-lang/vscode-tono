import * as vscode from 'vscode';
import { LEGEND } from './captures';
import { TonoHighlighter, type GrammarPaths } from './grammar';

export const SEMANTIC_TOKENS_LEGEND = new vscode.SemanticTokensLegend(
  LEGEND.tokenTypes,
  LEGEND.tokenModifiers
);

class TonoSemanticTokensProvider implements vscode.DocumentSemanticTokensProvider {
  constructor(
    private readonly highlighter: TonoHighlighter,
    private readonly log: vscode.LogOutputChannel
  ) {}

  provideDocumentSemanticTokens(document: vscode.TextDocument): vscode.SemanticTokens | undefined {
    const builder = new vscode.SemanticTokensBuilder(SEMANTIC_TOKENS_LEGEND);
    try {
      for (const span of this.highlighter.highlight(document.getText())) {
        builder.push(
          new vscode.Range(span.line, span.startChar, span.line, span.startChar + span.length),
          span.tokenType,
          span.modifiers
        );
      }
    } catch (error) {
      this.log.error(`highlighting ${document.uri.fsPath} failed: ${String(error)}`);
      return undefined;
    }
    return builder.build();
  }
}

/**
 * Registers tree-sitter backed highlighting for Tono files.
 *
 * Highlighting is computed in the extension from the grammar's own query rather
 * than requested from the language server: the grammar is the source of truth for
 * Tono syntax, and semantic tokens are only how VS Code accepts the result.
 */
export async function registerHighlighting(
  paths: GrammarPaths,
  selector: vscode.DocumentSelector,
  log: vscode.LogOutputChannel
): Promise<vscode.Disposable> {
  const highlighter = await TonoHighlighter.load(paths);
  const registration = vscode.languages.registerDocumentSemanticTokensProvider(
    selector,
    new TonoSemanticTokensProvider(highlighter, log),
    SEMANTIC_TOKENS_LEGEND
  );
  log.info('tree-sitter highlighting ready');

  return new vscode.Disposable(() => {
    registration.dispose();
    highlighter.dispose();
  });
}
