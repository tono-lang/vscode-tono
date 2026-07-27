# Changelog

## 0.1.0

First release.

- Syntax highlighting driven by the tree-sitter-tono grammar and its own
  `highlights.scm`, compiled to wasm and run in the extension.
- Language server integration over stdio: diagnostics, hover, go to definition,
  references, document and workspace symbols, rename, formatting, quick fixes and
  signature help.
- `Tono: Format File` and `Tono: Preview Generated Code` commands backed by the
  `tono` CLI.
- Server and CLI discovery through settings, environment variables, `$PATH` and a
  local build tree, so a checkout of the tono repository needs no configuration.
