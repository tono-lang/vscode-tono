import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, 'dist');
const production = process.argv.includes('--production');
const require = createRequire(import.meta.url);

mkdirSync(outDir, { recursive: true });

// web-tree-sitter ships an ESM and a CommonJS build of the same emscripten glue.
// The ESM one finds the runtime through `createRequire(import.meta.url)`, which has
// no meaning once esbuild has rewritten it into a CommonJS bundle, so the parser
// throws on init. Only the CommonJS build, which uses __dirname, survives
// bundling. esbuild picks the ESM build for an `import` statement regardless of
// the output format and of `conditions`, so point it at the file directly.
const runtimeWasm = require.resolve('web-tree-sitter/web-tree-sitter.wasm');
const runtimeDir = path.dirname(runtimeWasm);

await build({
  entryPoints: [path.join(root, 'src', 'extension.ts')],
  bundle: true,
  outfile: path.join(outDir, 'extension.js'),
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  // Provided by the extension host, never bundled.
  external: ['vscode'],
  alias: {
    'web-tree-sitter': path.join(runtimeDir, 'web-tree-sitter.cjs'),
  },
  sourcemap: !production,
  minify: production,
  logLevel: 'info',
});

// Parser.init is given an explicit locateFile pointing here, next to the bundle.
copyFileSync(runtimeWasm, path.join(outDir, path.basename(runtimeWasm)));
console.log(`copied ${path.basename(runtimeWasm)} to dist/`);
