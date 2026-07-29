/** Arguments for `tono fmt`, which prints the formatted source on stdout. */
export function formatArgs(file: string): string[] {
  return ['fmt', file];
}

/** Arguments for `tono preview`, which renders and compile-checks generated code. */
export function previewArgs(file: string, targets: readonly string[], watch: boolean): string[] {
  const cleaned = [...new Set(targets.map((target) => target.trim()).filter((target) => target.length > 0))];
  if (cleaned.length === 0) {
    throw new Error('tono.preview.targets is empty. Add at least one target to preview.');
  }
  return ['preview', file, '--target', cleaned.join(','), watch ? '--watch' : '--once'];
}
