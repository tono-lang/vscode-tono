import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  describeFailure,
  resolveCli,
  resolveLanguageServer,
  type ResolveContext,
} from '../src/binaries';

// Paths are built with path.join so the fixtures use the separator of whichever
// platform the suite runs on, matching what the resolver itself produces.
const p = (...segments: string[]): string => path.join(path.sep, ...segments);

const USR_BIN = p('usr', 'bin');
const LOCAL_BIN = p('usr', 'local', 'bin');
const HOME = p('home', 'dev');

function context(
  executables: readonly string[],
  overrides: Partial<ResolveContext> = {},
  markers: readonly string[] = []
): ResolveContext {
  const present = new Set(executables);
  const existing = new Set([...executables, ...markers]);
  return {
    env: { PATH: [LOCAL_BIN, USR_BIN].join(path.delimiter) },
    workspaceFolders: [],
    home: HOME,
    exeSuffix: '',
    probe: {
      isExecutable: (candidate) => present.has(candidate),
      exists: (candidate) => existing.has(candidate),
    },
    ...overrides,
  };
}

describe('resolveLanguageServer', () => {
  it('prefers the explicit setting over everything else', () => {
    const configured = p('opt', 'tono_lsp');
    const ctx = context([configured, path.join(USR_BIN, 'tono_lsp')]);
    assert.deepEqual(resolveLanguageServer(configured, undefined, ctx), {
      kind: 'found',
      path: configured,
      source: 'tono.server.path setting',
    });
  });

  it('reports a wrong setting instead of quietly using another binary', () => {
    // Falling through would run a different server than the user asked for.
    const missing = p('opt', 'missing');
    const ctx = context([path.join(USR_BIN, 'tono_lsp')]);
    assert.deepEqual(resolveLanguageServer(missing, undefined, ctx), {
      kind: 'invalid-setting',
      path: missing,
      setting: 'tono.server.path',
    });
  });

  it('expands ~ in the setting', () => {
    const expanded = path.join(HOME, 'bin', 'tono_lsp');
    const ctx = context([expanded]);
    const result = resolveLanguageServer('~/bin/tono_lsp', undefined, ctx);
    assert.equal(result.kind === 'found' && result.path, expanded);
  });

  it('falls back to $TONO_LSP', () => {
    const fromEnv = p('srv', 'tono_lsp');
    const ctx = context([fromEnv], { env: { PATH: USR_BIN, TONO_LSP: fromEnv } });
    assert.deepEqual(resolveLanguageServer('', undefined, ctx), {
      kind: 'found',
      path: fromEnv,
      source: '$TONO_LSP',
    });
  });

  it('looks next to the tono CLI before $PATH', () => {
    const sibling = p('opt', 'tono', 'bin', 'tono_lsp');
    const ctx = context([sibling, path.join(USR_BIN, 'tono_lsp')]);
    const result = resolveLanguageServer('', p('opt', 'tono', 'bin', 'tono'), ctx);
    assert.equal(result.kind === 'found' && result.path, sibling);
  });

  it('searches $PATH in order and accepts the hyphenated name', () => {
    const hyphenated = path.join(USR_BIN, 'tono-lsp');
    const ctx = context([hyphenated]);
    assert.deepEqual(resolveLanguageServer('', undefined, ctx), {
      kind: 'found',
      path: hyphenated,
      source: '$PATH',
    });
  });

  it('finds a dune executable, which keeps its .exe suffix', () => {
    const dune = path.join(LOCAL_BIN, 'tono_lsp.exe');
    const ctx = context([dune]);
    assert.equal(resolveLanguageServer('', undefined, ctx).kind === 'found', true);
  });

  it('finds the server in a dune build tree above the workspace folder', () => {
    // A checkout of the tono repository should need no configuration.
    const repo = p('repo');
    const built = path.join(repo, '_build', 'default', 'lsp', 'tono_lsp.exe');
    const ctx = context([built], { workspaceFolders: [path.join(repo, 'examples', 'nested')] });
    assert.deepEqual(resolveLanguageServer('', undefined, ctx), {
      kind: 'found',
      path: built,
      source: 'local build tree',
    });
  });

  it('lists what it searched when nothing is found', () => {
    const ctx = context([], { workspaceFolders: [p('repo')] });
    const result = resolveLanguageServer('', undefined, ctx);
    assert.equal(result.kind, 'not-found');
    assert.ok(
      result.kind === 'not-found' &&
        result.searched.some((entry) => entry.includes(path.join('_build', 'default', 'lsp')))
    );
  });

  it('appends the platform executable suffix', () => {
    // On Windows the bare name never exists, so only tono_lsp.exe is found.
    const withSuffix = path.join(LOCAL_BIN, 'tono_lsp.exe');
    const ctx = context([withSuffix], { exeSuffix: '.exe', env: { PATH: LOCAL_BIN } });
    assert.deepEqual(resolveLanguageServer('', undefined, ctx), {
      kind: 'found',
      path: withSuffix,
      source: '$PATH',
    });
  });

  it('finds a windows shim, which is how package managers install binaries', () => {
    const shim = path.join(LOCAL_BIN, 'tono_lsp.cmd');
    const ctx = context([shim], { exeSuffix: '.exe', env: { PATH: LOCAL_BIN } });
    assert.equal(resolveLanguageServer('', undefined, ctx).kind === 'found', true);
  });

  it('stops climbing at the project root instead of reaching into a parent', () => {
    // A build tree above the project belongs to something else.
    const project = path.join(HOME, 'work', 'api');
    const outside = path.join(HOME, '_build', 'default', 'lsp', 'tono_lsp.exe');
    const ctx = context([outside], { workspaceFolders: [project] }, [
      path.join(project, 'tono.toml'),
    ]);
    assert.equal(resolveLanguageServer('', undefined, ctx).kind, 'not-found');
  });

  it('still searches the project root itself', () => {
    const repo = p('repo');
    const inside = path.join(repo, '_build', 'default', 'lsp', 'tono_lsp.exe');
    const ctx = context([inside], { workspaceFolders: [repo] }, [
      path.join(repo, 'dune-project'),
    ]);
    assert.equal(resolveLanguageServer('', undefined, ctx).kind === 'found', true);
  });
});

describe('resolveCli', () => {
  it('finds tono on $PATH', () => {
    const onPath = path.join(USR_BIN, 'tono');
    assert.deepEqual(resolveCli('', context([onPath])), {
      kind: 'found',
      path: onPath,
      source: '$PATH',
    });
  });

  it('falls back to a cargo target directory, release before debug', () => {
    const repo = p('repo');
    const release = path.join(repo, 'target', 'release', 'tono');
    const debug = path.join(repo, 'target', 'debug', 'tono');
    const ctx = context([release, debug], { workspaceFolders: [repo] });
    const result = resolveCli('', ctx);
    assert.equal(result.kind === 'found' && result.path, release);
  });

  it('reads $TONO_CLI', () => {
    const fromEnv = p('srv', 'tono');
    const ctx = context([fromEnv], { env: { PATH: USR_BIN, TONO_CLI: fromEnv } });
    assert.equal(resolveCli('', ctx).kind === 'found', true);
  });
});

describe('describeFailure', () => {
  it('names the offending setting', () => {
    const message = describeFailure('tono CLI', {
      kind: 'invalid-setting',
      path: '/nope',
      setting: 'tono.cli.path',
    });
    assert.match(message, /tono\.cli\.path/);
    assert.match(message, /\/nope/);
  });

  it('tells the user what to do when nothing was found', () => {
    const message = describeFailure('tono CLI', { kind: 'not-found', searched: [] });
    assert.match(message, /tono CLI/);
    assert.match(message, /PATH/);
  });
});
