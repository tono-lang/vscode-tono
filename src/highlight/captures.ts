export interface TokenStyle {
  readonly tokenType: string;
  readonly modifiers: readonly string[];
}

const NONE: readonly string[] = [];

// Capture names are owned by the grammar's queries/highlights.scm, which follows
// the nvim-treesitter convention. VS Code renders only its own semantic token
// types, so every capture is projected onto the closest standard type. The two
// concepts with no standard equivalent, escape sequences and builtin names, are
// contributed by package.json as `escapeSequence` and the `builtin` modifier.
//
// Captures absent from this table are dropped. That is deliberate for the
// punctuation and @spell captures: colouring brackets and delimiters through
// semantic tokens fights the theme instead of helping it.
const STYLES = new Map<string, TokenStyle>([
  ['keyword', { tokenType: 'keyword', modifiers: NONE }],
  ['type.definition', { tokenType: 'type', modifiers: ['declaration'] }],
  ['type.builtin', { tokenType: 'type', modifiers: ['builtin'] }],
  ['type.parameter', { tokenType: 'typeParameter', modifiers: NONE }],
  ['type', { tokenType: 'type', modifiers: NONE }],
  ['function', { tokenType: 'function', modifiers: ['declaration'] }],
  ['module', { tokenType: 'namespace', modifiers: NONE }],
  ['property', { tokenType: 'property', modifiers: NONE }],
  // Enum cases and union variants are both named alternatives of a closed type.
  ['constant', { tokenType: 'enumMember', modifiers: NONE }],
  ['constructor', { tokenType: 'enumMember', modifiers: NONE }],
  ['attribute', { tokenType: 'decorator', modifiers: NONE }],
  ['string.escape', { tokenType: 'escapeSequence', modifiers: NONE }],
  ['string', { tokenType: 'string', modifiers: NONE }],
  ['number', { tokenType: 'number', modifiers: NONE }],
  ['comment', { tokenType: 'comment', modifiers: NONE }],
  ['operator', { tokenType: 'operator', modifiers: NONE }],
  // The `?` nullable marker carries type meaning, unlike the other punctuation.
  ['punctuation.special', { tokenType: 'operator', modifiers: NONE }],
]);

/**
 * Resolves a tree-sitter capture name to a semantic token style.
 *
 * Capture names are hierarchical, so an unknown `a.b.c` degrades to `a.b` and
 * then `a`. That keeps highlighting working when the grammar introduces a more
 * specific capture than this table knows about.
 */
export function styleForCapture(name: string): TokenStyle | undefined {
  let key = name;
  for (;;) {
    const style = STYLES.get(key);
    if (style) {
      return style;
    }
    const cut = key.lastIndexOf('.');
    if (cut < 0) {
      return undefined;
    }
    key = key.slice(0, cut);
  }
}

function legend(): { tokenTypes: string[]; tokenModifiers: string[] } {
  const tokenTypes: string[] = [];
  const tokenModifiers: string[] = [];
  for (const style of STYLES.values()) {
    if (!tokenTypes.includes(style.tokenType)) {
      tokenTypes.push(style.tokenType);
    }
    for (const modifier of style.modifiers) {
      if (!tokenModifiers.includes(modifier)) {
        tokenModifiers.push(modifier);
      }
    }
  }
  return { tokenTypes, tokenModifiers };
}

export const LEGEND = legend();
