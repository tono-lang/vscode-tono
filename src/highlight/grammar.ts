import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Language, Parser, Query } from 'web-tree-sitter';
import { buildTokenSpans, type RawCapture, type TokenSpan } from './tokenize';

export interface GrammarPaths {
  /** Directory holding the emscripten runtime wasm (web-tree-sitter.wasm). */
  readonly runtimeDir: string;
  /** The Tono parser compiled to wasm from the pinned grammar revision. */
  readonly parserWasmPath: string;
  /** The grammar's own queries/highlights.scm, copied verbatim at build time. */
  readonly queryPath: string;
}

let runtimeReady: Promise<void> | undefined;

// Parser.init boots a shared emscripten module, so it must happen exactly once
// per extension host even if the highlighter is reloaded.
function initRuntime(runtimeDir: string): Promise<void> {
  runtimeReady ??= Parser.init({
    locateFile: (name: string) => path.join(runtimeDir, name),
  });
  return runtimeReady;
}

export class TonoHighlighter {
  private constructor(
    private readonly parser: Parser,
    private readonly query: Query
  ) {}

  static async load(paths: GrammarPaths): Promise<TonoHighlighter> {
    await initRuntime(paths.runtimeDir);

    const [parserWasm, querySource] = await Promise.all([
      readFile(paths.parserWasmPath),
      readFile(paths.queryPath, 'utf8'),
    ]);

    const language = await Language.load(parserWasm);
    const parser = new Parser();
    parser.setLanguage(language);

    let query: Query;
    try {
      query = new Query(language, querySource);
    } catch (error) {
      parser.delete();
      throw new Error(
        `the highlight query does not match the compiled grammar (${path.basename(paths.queryPath)}): ${String(error)}`
      );
    }

    return new TonoHighlighter(parser, query);
  }

  highlight(text: string): TokenSpan[] {
    const tree = this.parser.parse(text);
    if (!tree) {
      return [];
    }
    try {
      const captures: RawCapture[] = this.query.captures(tree.rootNode).map((capture) => ({
        name: capture.name,
        patternIndex: capture.patternIndex,
        startIndex: capture.node.startIndex,
        endIndex: capture.node.endIndex,
      }));
      return buildTokenSpans(text, captures);
    } finally {
      // Trees live in wasm memory that the JS garbage collector cannot reclaim.
      tree.delete();
    }
  }

  dispose(): void {
    this.query.delete();
    this.parser.delete();
  }
}
