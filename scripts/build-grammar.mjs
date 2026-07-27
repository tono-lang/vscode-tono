// Builds the grammar assets the extension ships: the tree-sitter parser compiled
// to wasm, plus the grammar's own highlight query.
//
// The query is copied verbatim rather than rewritten: the tree-sitter grammar is
// the single source of truth for Tono highlighting, so the extension must never
// carry a second, drifting copy of it.

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  run('git', ['fetch', '--quiet', 'origin', pin.rev], { cwd: cache });
  run('git', ['checkout', '--quiet', pin.rev], { cwd: cache });
  return { dir: cache, pinned: true };
}

// A globally installed CLI wins so contributors control the ABI they generate
// with; otherwise pull the exact version the grammar itself is developed against.
function resolveTreeSitterCli() {
  if (capture('tree-sitter', ['--version'])) {
    return { command: 'tree-sitter', args: [] };
  }
  return { command: 'npx', args: ['--yes', `tree-sitter-cli@${pin.treeSitterCli}`] };
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
run(cli.command, [...cli.args, 'build', '--wasm', '-o', wasmOut, grammarDir]);
copyFileSync(path.join(grammarDir, 'queries', 'highlights.scm'), queryOut);

for (const asset of [wasmOut, queryOut]) {
  if (!existsSync(asset) || statSync(asset).size === 0) {
    throw new Error(`grammar asset was not produced: ${asset}`);
  }
  console.log(`  ${path.relative(root, asset)} (${statSync(asset).size} bytes)`);
}
