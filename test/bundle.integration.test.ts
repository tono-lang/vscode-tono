import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

// Exercises dist/extension.js, the file that actually ships, against a stub of the
// VS Code API. Unit tests import from src and so cannot catch bundling faults: the
// emscripten runtime inside web-tree-sitter breaks when its ESM build is rewritten
// into CommonJS, and only loading the bundle reveals it.

const root = path.resolve(__dirname, '..', '..');

interface PushedToken {
  readonly range: FakeRange;
  readonly tokenType: string;
  readonly modifiers: readonly string[];
}

class FakeRange {
  constructor(
    readonly startLine: number,
    readonly startChar: number,
    readonly endLine: number,
    readonly endChar: number
  ) {}
}

class FakeDisposable {
  constructor(private readonly onDispose?: () => void) {}
  dispose(): void {
    this.onDispose?.();
  }
}

class FakeTokensBuilder {
  readonly pushed: PushedToken[] = [];
  push(range: FakeRange, tokenType: string, modifiers: readonly string[] = []): void {
    this.pushed.push({ range, tokenType, modifiers });
  }
  build(): PushedToken[] {
    return this.pushed;
  }
}

interface AppliedReplacement {
  readonly fsPath: string;
  readonly text: string;
}

class FakeWorkspaceEdit {
  readonly replacements: AppliedReplacement[] = [];
  replace(uri: { fsPath: string }, _range: FakeRange, text: string): void {
    this.replacements.push({ fsPath: uri.fsPath, text });
  }
}

interface SemanticTokensProviderLike {
  provideDocumentSemanticTokens(document: unknown): PushedToken[] | undefined;
}

/**
 * A document whose version follows a script, so the test can decide that the file
 * changed while the formatter was running without depending on timing.
 */
class FakeDocument {
  readonly languageId = 'tono';
  readonly isUntitled = false;
  readonly isDirty = false;
  readonly uri: { fsPath: string };
  private versionRead = 0;

  constructor(
    fsPath: string,
    private readonly text: string,
    private readonly versions: readonly number[]
  ) {
    this.uri = { fsPath };
  }

  get version(): number {
    const version = this.versions[Math.min(this.versionRead, this.versions.length - 1)];
    this.versionRead++;
    return version ?? 1;
  }

  getText(): string {
    return this.text;
  }

  positionAt(offset: number): { offset: number } {
    return { offset };
  }

  save(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

const settings = new Map<string, unknown>();
const logged: string[] = [];
const commands = new Map<string, () => Promise<void>>();
const appliedEdits: FakeWorkspaceEdit[] = [];
const shownErrors: string[] = [];

let provider: SemanticTokensProviderLike | undefined;
let legend: { tokenTypes: string[]; tokenModifiers: string[] } | undefined;
let activeDocument: FakeDocument | undefined;

const explicitStub: Record<string, unknown> = {
  Range: FakeRange,
  Disposable: FakeDisposable,
  SemanticTokensBuilder: FakeTokensBuilder,
  WorkspaceEdit: FakeWorkspaceEdit,
  SemanticTokensLegend: class {
    constructor(
      readonly tokenTypes: string[],
      readonly tokenModifiers: string[]
    ) {}
  },
  window: {
    createOutputChannel: () => ({
      info: (message: string) => logged.push(message),
      warn: (message: string) => logged.push(message),
      error: (message: string) => logged.push(message),
      debug: (message: string) => logged.push(message),
      show: () => undefined,
      dispose: () => undefined,
    }),
    showWarningMessage: () => Promise.resolve(undefined),
    showErrorMessage: (message: string) => {
      shownErrors.push(message);
      return Promise.resolve(undefined);
    },
    showInformationMessage: () => Promise.resolve(undefined),
    get activeTextEditor(): { document: FakeDocument } | undefined {
      return activeDocument ? { document: activeDocument } : undefined;
    },
  },
  commands: {
    registerCommand: (id: string, handler: () => Promise<void>) => {
      commands.set(id, handler);
      return new FakeDisposable();
    },
    executeCommand: () => Promise.resolve(undefined),
  },
  workspace: {
    workspaceFolders: undefined,
    getConfiguration: () => ({ get: (key: string) => settings.get(key) }),
    onDidChangeConfiguration: () => new FakeDisposable(),
    getWorkspaceFolder: () => undefined,
    applyEdit: (edit: FakeWorkspaceEdit) => {
      appliedEdits.push(edit);
      return Promise.resolve(true);
    },
  },
  languages: {
    registerDocumentSemanticTokensProvider: (
      _selector: unknown,
      registered: SemanticTokensProviderLike,
      registeredLegend: { tokenTypes: string[]; tokenModifiers: string[] }
    ) => {
      provider = registered;
      legend = registeredLegend;
      return new FakeDisposable();
    },
  },
};

// The bundle also contains vscode-languageclient, which subclasses parts of the
// API while its modules load. Rather than transcribe the whole namespace, hand out
// an empty class for anything not stubbed explicitly, which is enough to be
// extended, constructed or read from.
const vscodeStub: Record<string, unknown> = new Proxy(explicitStub, {
  get(target, property) {
    if (typeof property !== 'string') {
      return undefined;
    }
    target[property] ??= class Placeholder {};
    return target[property];
  },
  has: () => true,
});

type Loader = (request: string, parent: unknown, isMain: boolean) => unknown;
const loaderHost = Module as unknown as { _load: Loader };
let originalLoad: Loader;

interface ExtensionModule {
  activate(context: { extensionUri: { fsPath: string }; subscriptions: unknown[] }): Promise<void>;
  deactivate(): Promise<void>;
}

let extension: ExtensionModule;
const FORMATTED = 'struct charge {\n  amount: i64\n}\n';

/** A stand-in for the tono CLI, so no real toolchain is needed. */
function writeFakeCli(dir: string): string {
  const cli = path.join(dir, 'tono');
  writeFileSync(cli, `#!/bin/sh\ncat <<'TONOFMT'\n${FORMATTED}TONOFMT\n`);
  chmodSync(cli, 0o755);
  return cli;
}

// The command runs the CLI with the file's directory as cwd, so both have to exist.
const workDir = mkdtempSync(path.join(os.tmpdir(), 'tono-fmt-'));
const documentPath = path.join(workDir, 'charge.tono');

before(async () => {
  writeFileSync(documentPath, 'struct charge{amount:i64}');
  settings.set('server.enabled', false);
  settings.set('highlight.enabled', true);
  settings.set('cli.path', writeFakeCli(workDir));

  originalLoad = loaderHost._load;
  loaderHost._load = function (request, parent, isMain) {
    if (request === 'vscode') {
      return vscodeStub;
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  extension = require(path.join(root, 'dist', 'extension.js')) as ExtensionModule;
  await extension.activate({ extensionUri: { fsPath: root }, subscriptions: [] });
});

after(async () => {
  await extension.deactivate();
  loaderHost._load = originalLoad;
});

beforeEach(() => {
  appliedEdits.length = 0;
  shownErrors.length = 0;
  logged.length = 0;
});

describe('the packaged extension bundle', () => {
  it('registers a semantic tokens provider with the full legend', () => {
    assert.ok(provider, 'no semantic tokens provider was registered');
    assert.ok(legend);
    assert.ok(legend.tokenTypes.includes('keyword'));
    assert.ok(legend.tokenTypes.includes('escapeSequence'));
    assert.deepEqual([...legend.tokenModifiers].sort(), ['builtin', 'declaration']);
  });

  it('loads the wasm grammar and tokenizes through the bundled runtime', () => {
    const source = 'pub struct charge {\n  amount: i64\n}';
    const tokens = provider?.provideDocumentSemanticTokens({
      getText: () => source,
      uri: { fsPath: '/w/charge.tono' },
    });

    assert.ok(tokens, 'the provider returned no tokens');
    const lines = source.split('\n');
    assert.deepEqual(
      tokens.map((token) => [
        lines[token.range.startLine]?.slice(token.range.startChar, token.range.endChar),
        token.tokenType,
      ]),
      [
        ['pub', 'keyword'],
        ['struct', 'keyword'],
        ['charge', 'type'],
        ['amount', 'property'],
        ['i64', 'type'],
      ]
    );
  });

  it('registers every contributed command', () => {
    assert.deepEqual(
      [...commands.keys()].sort(),
      ['tono.format', 'tono.preview', 'tono.restartServer', 'tono.showServerOutput']
    );
  });
});

describe('the format command', () => {
  it('replaces the document with what the CLI printed', async () => {
    activeDocument = new FakeDocument(documentPath, 'struct charge{amount:i64}', [7, 7]);
    await commands.get('tono.format')?.();

    assert.equal(appliedEdits.length, 1);
    assert.deepEqual(appliedEdits[0]?.replacements, [
      { fsPath: documentPath, text: FORMATTED },
    ]);
    assert.deepEqual(shownErrors, []);
  });

  it('discards the result when the file changed while formatting', async () => {
    // Otherwise whatever the user typed during the CLI run would be reverted.
    activeDocument = new FakeDocument(documentPath, 'struct charge{amount:i64}', [7, 8]);
    await commands.get('tono.format')?.();

    assert.deepEqual(appliedEdits, []);
    assert.ok(logged.some((entry) => entry.includes('changed while formatting')));
  });

  it('does nothing when the document is already formatted', async () => {
    activeDocument = new FakeDocument(documentPath, FORMATTED, [7, 7]);
    await commands.get('tono.format')?.();

    assert.deepEqual(appliedEdits, []);
    assert.deepEqual(shownErrors, []);
  });
});
