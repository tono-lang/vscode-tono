# vscode-tono

Tono language support for VS Code. The extension bundles the tree-sitter grammar
for syntax highlighting and drives the Tono language server for diagnostics,
hover and formatting.

## Features

**Syntax highlighting** comes from the [tree-sitter-tono][grammar] grammar. The
extension compiles the grammar to wasm at build time and runs the grammar's own
`queries/highlights.scm` on every edit, so highlighting in the editor is produced
by the same grammar that highlights Tono on GitHub, in Neovim, Zed and Helix.

**Language server features** come from `tono_lsp`, which is built on the same
OCaml frontend as the `tono` CLI:

- diagnostics, published as you type
- hover
- go to definition, find references
- document and workspace symbols
- rename
- formatting
- quick fixes
- signature help

**Commands** run the `tono` CLI directly:

| Command | Title |
| --- | --- |
| `tono.format` | Tono: Format File |
| `tono.preview` | Tono: Preview Generated Code |
| `tono.restartServer` | Tono: Restart Language Server |
| `tono.showServerOutput` | Tono: Show Language Server Output |

`Tono: Preview Generated Code` runs `tono preview` as a task, so watch mode keeps
streaming into the terminal until you stop it.

## Requirements

Highlighting works on its own. The language server and the commands need the Tono
binaries, which are not bundled: neither `tono` nor `tono_lsp` publishes release
artefacts yet, so build them from the [tono repository][tono]:

```bash
dune build            # produces _build/default/lsp/tono_lsp.exe
cargo build --release # produces target/release/tono
```

The extension finds them without configuration when you have the tono repository
open, because it searches the local build tree. Otherwise put them on `$PATH` or
set `tono.server.path` and `tono.cli.path`.

Resolution order for `tono_lsp`:

1. the `tono.server.path` setting
2. `$TONO_LSP`
3. the directory holding the `tono` CLI
4. `$PATH`
5. `_build/default/lsp/tono_lsp.exe` in the workspace folder or any parent

`tono` is resolved the same way, using `tono.cli.path`, `$TONO_CLI`, `$PATH` and
then `target/release` or `target/debug`.

## Installing

Download the `.vsix` from the releases page, or build it yourself, then:

```bash
code --install-extension vscode-tono-0.1.0.vsix
```

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `tono.server.enabled` | `true` | Run the language server. |
| `tono.server.path` | `""` | Absolute path to `tono_lsp`. |
| `tono.server.trace.server` | `"off"` | Trace JSON-RPC traffic into the Tono output channel. |
| `tono.cli.path` | `""` | Absolute path to the `tono` CLI. |
| `tono.highlight.enabled` | `true` | Highlight using the tree-sitter grammar. |
| `tono.preview.targets` | `["ts"]` | Targets passed to `tono preview --target`. |
| `tono.preview.watch` | `true` | Run the preview in watch mode. |

### Highlighting and your colour theme

The extension ships no TextMate grammar. Duplicating the grammar into a second
syntax definition would create a copy that silently drifts from the real one, so
highlighting is delivered entirely through the semantic tokens API instead.

The practical consequence is that Tono files are highlighted only when semantic
highlighting is on. It is on by default and every built-in theme supports it, but
a third-party theme that does not opt in will show Tono files unhighlighted. Force
it on for those themes:

```json
"editor.semanticHighlighting.enabled": true
```

### Diagnostics and `tono check`

Editor diagnostics and `tono check` share the OCaml frontend, so they agree about
any single file. They are not interchangeable at project level: the language
server resolves imports across the whole source root, while `tono check` takes one
file at a time. Cross-module errors therefore show up in the editor before they
show up in `tono check`.

## Development

```bash
npm install
npm run build:grammar   # compile the grammar to grammar/tono.wasm
npm test                # build, typecheck and run the test suite
npm run package         # produce the .vsix
```

Press `F5` in VS Code to launch an extension host with the extension loaded.

### How the grammar stays in sync

`grammar-pin.json` records the grammar revision the extension is built against.
`npm run build:grammar` compiles the parser to `grammar/tono.wasm` and copies
`queries/highlights.scm` verbatim into `grammar/`. Neither file is committed: they
are build outputs of the grammar repository, which stays the single source of
truth for Tono syntax.

The `tree-sitter` CLI is a devDependency pinned to an exact version rather than
something you install yourself. That version decides the parser ABI, and a
mismatch with `web-tree-sitter` produces a wasm that only fails once the editor
tries to load it.

The script builds from a sibling `tree-sitter-tono` checkout when it finds one, or
from `$TREE_SITTER_TONO_DIR`, and otherwise clones the pinned revision. When a
local checkout is ahead of the pin it builds anyway and warns, so grammar changes
can be tried out before they are pinned. Update `grammar-pin.json` before
releasing.

New capture names are picked up automatically as long as they refine an existing
one: an unmapped `keyword.coeffect` falls back to `keyword`. A genuinely new
concept needs an entry in `src/highlight/captures.ts`.

## Publishing

The extension is not on any marketplace yet. Both registries are independent, so
publish to both.

### VS Code Marketplace

1. Create an Azure DevOps organisation and a Personal Access Token with
   Organization set to *All accessible organizations* and the scope
   **Marketplace > Manage**.
2. Create the `tono-lang` publisher at
   <https://marketplace.visualstudio.com/manage>.
3. Publish:

```bash
npx vsce login tono-lang     # paste the PAT
npm run package
npx vsce publish
```

### Open VSX

Used by VSCodium, Gitpod and Cursor. Create a token at <https://open-vsx.org>
under Settings > Access Tokens.

```bash
npx ovsx create-namespace tono-lang -p "$OVSX_PAT"   # once
npx ovsx publish vscode-tono-0.1.0.vsix -p "$OVSX_PAT"
```

Before the first publish, add an `icon` field pointing at a 128x128 PNG. Both
marketplaces render the extension without one, but neither looks finished.

[grammar]: https://github.com/tono-lang/tree-sitter-tono
[tono]: https://github.com/tono-lang/tono
