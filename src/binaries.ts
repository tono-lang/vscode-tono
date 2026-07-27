import path from 'node:path';

export interface FsProbe {
  isExecutable(candidate: string): boolean;
}

export interface ResolveContext {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Workspace folder paths, used to find a local build tree. */
  readonly workspaceFolders: readonly string[];
  readonly home: string | undefined;
  /** '.exe' on Windows, empty elsewhere. */
  readonly exeSuffix: string;
  readonly probe: FsProbe;
}

export type Resolution =
  | { readonly kind: 'found'; readonly path: string; readonly source: string }
  | { readonly kind: 'invalid-setting'; readonly path: string; readonly setting: string }
  | { readonly kind: 'not-found'; readonly searched: readonly string[] };

function expandHome(candidate: string, home: string | undefined): string {
  if (home && (candidate === '~' || candidate.startsWith(`~${path.sep}`) || candidate.startsWith('~/'))) {
    return path.join(home, candidate.slice(1));
  }
  return candidate;
}

function ancestors(from: string): string[] {
  const result: string[] = [];
  let current = path.resolve(from);
  for (;;) {
    result.push(current);
    const parent = path.dirname(current);
    if (parent === current) {
      return result;
    }
    current = parent;
  }
}

function pathDirs(env: ResolveContext['env']): string[] {
  return (env['PATH'] ?? env['Path'] ?? '')
    .split(path.delimiter)
    .filter((entry) => entry.length > 0);
}

interface Cascade {
  /** Value of the explicit setting, empty when unset. */
  readonly configured: string;
  /** Name of the setting, used in the error message. */
  readonly setting: string;
  /** Environment variable that may hold an explicit path. */
  readonly envVar: string;
  /** Executable base names to look for, without extension. */
  readonly names: readonly string[];
  /** Directories searched before $PATH, relative to each workspace ancestor. */
  readonly buildDirs: readonly string[];
  /** Extra directories searched after $PATH is exhausted. */
  readonly siblingDirs?: readonly string[];
}

function resolve(cascade: Cascade, ctx: ResolveContext): Resolution {
  const searched: string[] = [];

  const tryFile = (candidate: string, source: string): Resolution | undefined => {
    searched.push(candidate);
    return ctx.probe.isExecutable(candidate) ? { kind: 'found', path: candidate, source } : undefined;
  };

  const tryDir = (dir: string, source: string): Resolution | undefined => {
    for (const name of cascade.names) {
      const found = tryFile(path.join(dir, name + ctx.exeSuffix), source);
      if (found) {
        return found;
      }
      // A dune executable keeps its .exe suffix even on Unix.
      if (ctx.exeSuffix !== '.exe') {
        const dune = tryFile(path.join(dir, `${name}.exe`), source);
        if (dune) {
          return dune;
        }
      }
    }
    return undefined;
  };

  // An explicit setting is never silently ignored: a wrong path is reported as a
  // configuration error rather than falling through to some other binary.
  if (cascade.configured.trim().length > 0) {
    const configured = expandHome(cascade.configured.trim(), ctx.home);
    return ctx.probe.isExecutable(configured)
      ? { kind: 'found', path: configured, source: `${cascade.setting} setting` }
      : { kind: 'invalid-setting', path: configured, setting: cascade.setting };
  }

  const fromEnv = ctx.env[cascade.envVar];
  if (fromEnv && fromEnv.trim().length > 0) {
    const found = tryFile(expandHome(fromEnv.trim(), ctx.home), `$${cascade.envVar}`);
    if (found) {
      return found;
    }
  }

  for (const dir of cascade.siblingDirs ?? []) {
    const found = tryDir(dir, 'directory next to the tono CLI');
    if (found) {
      return found;
    }
  }

  for (const dir of pathDirs(ctx.env)) {
    const found = tryDir(dir, '$PATH');
    if (found) {
      return found;
    }
  }

  // Last resort so a checkout of the tono repository works with no setup.
  for (const folder of ctx.workspaceFolders) {
    for (const ancestor of ancestors(folder)) {
      for (const buildDir of cascade.buildDirs) {
        const found = tryDir(path.join(ancestor, buildDir), 'local build tree');
        if (found) {
          return found;
        }
      }
    }
  }

  return { kind: 'not-found', searched };
}

/**
 * Finds the `tono_lsp` executable.
 *
 * The cascade mirrors how the tono CLI already locates its OCaml frontend, so a
 * developer working in the tono repository needs no configuration at all.
 */
export function resolveLanguageServer(
  configured: string,
  cliPath: string | undefined,
  ctx: ResolveContext
): Resolution {
  return resolve(
    {
      configured,
      setting: 'tono.server.path',
      envVar: 'TONO_LSP',
      names: ['tono_lsp', 'tono-lsp'],
      buildDirs: [path.join('_build', 'default', 'lsp')],
      siblingDirs: cliPath ? [path.dirname(cliPath)] : [],
    },
    ctx
  );
}

/** Finds the `tono` CLI used by the format and preview commands. */
export function resolveCli(configured: string, ctx: ResolveContext): Resolution {
  return resolve(
    {
      configured,
      setting: 'tono.cli.path',
      envVar: 'TONO_CLI',
      names: ['tono'],
      buildDirs: [path.join('target', 'release'), path.join('target', 'debug')],
    },
    ctx
  );
}

export function describeFailure(what: string, resolution: Resolution): string {
  if (resolution.kind === 'invalid-setting') {
    return `${resolution.setting} points to ${resolution.path}, which is not an executable file.`;
  }
  if (resolution.kind === 'not-found') {
    return `Could not find the ${what}. Set its path in the settings, or put it on $PATH.`;
  }
  return '';
}
