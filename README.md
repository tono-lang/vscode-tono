# vscode-tono

Tono editor extension (bundles the LSP + the tree-sitter grammar). To be started.

## Publishing

`.github/workflows/release.yml` publishes to the VS Code Marketplace on tag
push. It has nothing to package until the extension itself exists (this repo
is still just a scaffold), and needs a `VSCE_PAT` secret configured once the
extension ships.

## Update

Once published, the extension updates like any other: `code --install-
extension tono-lang.tono`, or automatically through the Marketplace's
built-in extension updates.
