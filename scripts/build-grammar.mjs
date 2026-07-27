// Builds the grammar assets the extension ships: the tree-sitter parser compiled
// to wasm, plus the grammar's own highlight query.
//
// The query is copied verbatim rather than rewritten: the tree-sitter grammar is
// the single source of truth for Tono highlighting, so the extension must never
// carry a second, drifting copy of it.

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'grammar');
const pin = JSON.parse(readFileSync(path.join(root, 'grammar-pin.json'), 'utf8'));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with ${result.status}`);
  }
}

function capture(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function isGrammarCheckout(dir) {
  return existsSync(path.join(dir, 'grammar.js')) && existsSync(path.join(dir, 'queries', 'highlights.scm'));
}

// Prefer a checkout the developer already has, so grammar changes can be tried
// out without pushing them first. Fall back to a pinned clone for clean builds.
function resolveGrammarDir() {
  const fromEnv = process.env.TREE_SITTER_TONO_DIR;
  if (fromEnv) {
    const dir = path.resolve(fromEnv);
    if (!isGrammarCheckout(dir)) {
      throw new Error(`TREE_SITTER_TONO_DIR=${dir} is not a tree-sitter-tono checkout`);
    }
    return { dir, pinned: false };
  }

  for (const candidate of ['../tree-sitter-tono', '../../tree-sitter-tono']) {
    const dir = path.resolve(root, candidate);
    if (isGrammarCheckout(dir)) {
      return { dir, pinned: false };
    }
  }

  const cache = path.join(root, '.grammar-cache', 'tree-sitter-tono');
  if (!isGrammarCheckout(cache)) {
    mkdirSync(path.dirname(cache), { recursive: true });
    run('git', ['clone', '--quiet', pin.repository, cache]);
  }
  // Only reach for the network when the pinned commit is genuinely missing, so a
  // warm cache builds offline. Fetching a bare SHA also needs the remote to allow
  // it, which a corporate mirror may not.
  if (!capture('git', ['rev-parse', '--verify', `${pin.rev}^{commit}`], { cwd: cache })) {
    run('git', ['fetch', '--quiet', 'origin', pin.rev], { cwd: cache });
  }
  run('git', ['checkout', '--quiet', pin.rev], { cwd: cache });
  return { dir: cache, pinned: true };
}

// The CLI comes from devDependencies rather than from $PATH, because the CLI
// version decides the parser ABI: a mismatch with web-tree-sitter yields a wasm
// that only fails at runtime, surfacing as highlighting that never starts.
//
// Its native binary is invoked directly rather than through the `tree-sitter` bin
// shim. On Windows that shim is a .cmd, which Node refuses to spawn without a
// shell, and going through a shell would mean quoting every path by hand.
function resolveTreeSitterCli() {
  const packageDir = path.dirname(require.resolve('tree-sitter-cli/package.json'));
  const binary = path.join(packageDir, process.platform === 'win32' ? 'tree-sitter.exe' : 'tree-sitter');
  if (!existsSync(binary)) {
    throw new Error(`tree-sitter-cli is installed but its binary is missing at ${binary}. Run npm install.`);
  }
  return binary;
}

const { dir: grammarDir, pinned } = resolveGrammarDir();

if (!pinned) {
  const head = capture('git', ['rev-parse', 'HEAD'], { cwd: grammarDir });
  if (head && head !== pin.rev) {
    console.warn(
      `warning: ${grammarDir} is at ${head.slice(0, 12)} but grammar-pin.json pins ${pin.rev.slice(0, 12)}.\n` +
        'warning: building from the local checkout. Update grammar-pin.json before releasing.'
    );
  }
}

const cli = resolveTreeSitterCli();
const wasmOut = path.join(outDir, 'tono.wasm');
const queryOut = path.join(outDir, 'highlights.scm');

mkdirSync(outDir, { recursive: true });

console.log(`building grammar from ${grammarDir}`);
run(cli, ['build', '--wasm', '-o', wasmOut, grammarDir]);
copyFileSync(path.join(grammarDir, 'queries', 'highlights.scm'), queryOut);

for (const asset of [wasmOut, queryOut]) {
  if (!existsSync(asset) || statSync(asset).size === 0) {
    throw new Error(`grammar asset was not produced: ${asset}`);
  }
  console.log(`  ${path.relative(root, asset)} (${statSync(asset).size} bytes)`);
}
