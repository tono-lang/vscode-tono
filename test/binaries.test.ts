import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  describeFailure,
  resolveCli,
  resolveLanguageServer,
  type ResolveContext,
} from '../src/binaries';

function context(
  executables: readonly string[],
  overrides: Partial<ResolveContext> = {},
  markers: readonly string[] = []
): ResolveContext {
  const present = new Set(executables);
  const existing = new Set([...executables, ...markers]);
  return {
    env: { PATH: ['/usr/local/bin', '/usr/bin'].join(path.delimiter) },
    workspaceFolders: [],
    home: '/home/dev',
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
    const ctx = context(['/opt/tono_lsp', '/usr/bin/tono_lsp']);
    const result = resolveLanguageServer('/opt/tono_lsp', undefined, ctx);
    assert.deepEqual(result, {
      kind: 'found',
      path: '/opt/tono_lsp',
      source: 'tono.server.path setting',
    });
  });

  it('reports a wrong setting instead of quietly using another binary', () => {
    // Falling through would run a different server than the user asked for.
    const ctx = context(['/usr/bin/tono_lsp']);
    const result = resolveLanguageServer('/opt/missing', undefined, ctx);
    assert.deepEqual(result, {
      kind: 'invalid-setting',
      path: '/opt/missing',
      setting: 'tono.server.path',
    });
  });

  it('expands ~ in the setting', () => {
    const ctx = context(['/home/dev/bin/tono_lsp']);
    const result = resolveLanguageServer('~/bin/tono_lsp', undefined, ctx);
    assert.equal(result.kind === 'found' && result.path, '/home/dev/bin/tono_lsp');
  });

  it('falls back to $TONO_LSP', () => {
    const ctx = context(['/srv/tono_lsp'], {
      env: { PATH: '/usr/bin', TONO_LSP: '/srv/tono_lsp' },
    });
    const result = resolveLanguageServer('', undefined, ctx);
    assert.deepEqual(result, { kind: 'found', path: '/srv/tono_lsp', source: '$TONO_LSP' });
  });

  it('looks next to the tono CLI before $PATH', () => {
    const ctx = context(['/opt/tono/bin/tono_lsp', '/usr/bin/tono_lsp']);
    const result = resolveLanguageServer('', '/opt/tono/bin/tono', ctx);
    assert.equal(result.kind === 'found' && result.path, '/opt/tono/bin/tono_lsp');
  });

  it('searches $PATH in order and accepts the hyphenated name', () => {
    const ctx = context(['/usr/bin/tono-lsp']);
    const result = resolveLanguageServer('', undefined, ctx);
    assert.deepEqual(result, { kind: 'found', path: '/usr/bin/tono-lsp', source: '$PATH' });
  });

  it('finds a dune executable, which keeps its .exe suffix on unix', () => {
    const ctx = context(['/usr/local/bin/tono_lsp.exe']);
    const result = resolveLanguageServer('', undefined, ctx);
    assert.equal(result.kind === 'found' && result.path, '/usr/local/bin/tono_lsp.exe');
  });

  it('finds the server in a dune build tree above the workspace folder', () => {
    // A checkout of the tono repository should need no configuration.
    const built = path.join('/repo', '_build', 'default', 'lsp', 'tono_lsp.exe');
    const ctx = context([built], { workspaceFolders: [path.join('/repo', 'examples', 'nested')] });
    const result = resolveLanguageServer('', undefined, ctx);
    assert.deepEqual(result, { kind: 'found', path: built, source: 'local build tree' });
  });

  it('lists what it searched when nothing is found', () => {
    const ctx = context([], { workspaceFolders: ['/repo'] });
    const result = resolveLanguageServer('', undefined, ctx);
    assert.equal(result.kind, 'not-found');
    assert.ok(result.kind === 'not-found' && result.searched.length > 0);
    assert.ok(
      result.kind === 'not-found' &&
        result.searched.some((entry) => entry.includes(path.join('_build', 'default', 'lsp')))
    );
  });

  it('appends the platform executable suffix', () => {
    // On Windows the bare name never exists, so only tono_lsp.exe is found.
    const withSuffix = path.join('/tools', 'tono_lsp.exe');
    const ctx = context([withSuffix], { exeSuffix: '.exe', env: { PATH: '/tools' } });
    const result = resolveLanguageServer('', undefined, ctx);
    assert.deepEqual(result, { kind: 'found', path: withSuffix, source: '$PATH' });
  });

  it('finds a windows shim, which is how package managers install binaries', () => {
    const shim = path.join('/tools', 'tono_lsp.cmd');
    const ctx = context([shim], { exeSuffix: '.exe', env: { PATH: '/tools' } });
    assert.equal(resolveLanguageServer('', undefined, ctx).kind === 'found', true);
  });

  it('stops climbing at the project root instead of reaching into a parent', () => {
    // A build tree above the project belongs to something else.
    const outside = path.join('/home/dev', '_build', 'default', 'lsp', 'tono_lsp.exe');
    const ctx = context(
      [outside],
      { workspaceFolders: [path.join('/home/dev', 'work', 'api')] },
      [path.join('/home/dev', 'work', 'api', 'tono.toml')]
    );
    const result = resolveLanguageServer('', undefined, ctx);
    assert.equal(result.kind, 'not-found');
  });

  it('still searches the project root itself', () => {
    const inside = path.join('/repo', '_build', 'default', 'lsp', 'tono_lsp.exe');
    const ctx = context([inside], { workspaceFolders: ['/repo'] }, [
      path.join('/repo', 'dune-project'),
    ]);
    assert.equal(resolveLanguageServer('', undefined, ctx).kind === 'found', true);
  });
});

describe('resolveCli', () => {
  it('finds tono on $PATH', () => {
    const ctx = context(['/usr/bin/tono']);
    assert.deepEqual(resolveCli('', ctx), { kind: 'found', path: '/usr/bin/tono', source: '$PATH' });
  });

  it('falls back to a cargo target directory, release before debug', () => {
    const release = path.join('/repo', 'target', 'release', 'tono');
    const debug = path.join('/repo', 'target', 'debug', 'tono');
    const ctx = context([release, debug], { workspaceFolders: ['/repo'] });
    const result = resolveCli('', ctx);
    assert.equal(result.kind === 'found' && result.path, release);
  });

  it('reads $TONO_CLI', () => {
    const ctx = context(['/srv/tono'], { env: { PATH: '/usr/bin', TONO_CLI: '/srv/tono' } });
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
