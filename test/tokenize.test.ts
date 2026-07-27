import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildTokenSpans, type RawCapture, type TokenSpan } from '../src/highlight/tokenize';

function capture(name: string, startIndex: number, endIndex: number, patternIndex = 0): RawCapture {
  return { name, patternIndex, startIndex, endIndex };
}

/** Renders spans compactly so assertions read like the source they describe. */
function sketch(spans: readonly TokenSpan[]): string[] {
  return spans.map(
    (span) =>
      `${span.line}:${span.startChar}+${span.length} ${span.tokenType}${
        span.modifiers.length > 0 ? `.${span.modifiers.join('.')}` : ''
      }`
  );
}

describe('buildTokenSpans', () => {
  it('emits one span per mapped capture', () => {
    const text = 'pub struct a';
    const spans = buildTokenSpans(text, [
      capture('keyword.modifier', 0, 3),
      capture('keyword', 4, 10),
      capture('type.definition', 11, 12),
    ]);
    assert.deepEqual(sketch(spans), [
      '0:0+3 keyword',
      '0:4+6 keyword',
      '0:11+1 type.declaration',
    ]);
  });

  it('drops unmapped captures instead of emitting untyped tokens', () => {
    const spans = buildTokenSpans('a { }', [
      capture('punctuation.bracket', 2, 3),
      capture('spell', 0, 1),
    ]);
    assert.deepEqual(spans, []);
  });

  it('lets a nested capture override its parent and resumes the parent after', () => {
    // (string) encloses (escape_sequence); the escape must win only on its range.
    const text = 'x: "a\\nb"';
    const spans = buildTokenSpans(text, [
      capture('string', 3, 9, 23),
      capture('string.escape', 5, 7, 25),
    ]);
    assert.deepEqual(sketch(spans), [
      '0:3+2 string',
      '0:5+2 escapeSequence',
      '0:7+2 string',
    ]);
  });

  it('splits a multi-line capture into one span per line', () => {
    // VS Code rejects tokens that span lines, but """ strings do.
    const text = 'ts: """raw\nmulti\nend"""';
    const spans = buildTokenSpans(text, [capture('string', 4, text.length)]);
    assert.deepEqual(sketch(spans), [
      '0:4+6 string',
      '1:0+5 string',
      '2:0+6 string',
    ]);
  });

  it('never includes the line terminator in a span', () => {
    const text = 'a\r\nb';
    const spans = buildTokenSpans(text, [capture('comment', 0, text.length)]);
    assert.deepEqual(sketch(spans), ['0:0+1 comment', '1:0+1 comment']);
  });

  it('resolves equal spans in favour of the earlier query pattern', () => {
    // tree-sitter highlighting gives precedence to the first matching pattern.
    const spans = buildTokenSpans('string', [
      capture('attribute', 0, 6, 21),
      capture('type.builtin', 0, 6, 17),
    ]);
    assert.deepEqual(sketch(spans), ['0:0+6 type.builtin']);
  });

  it('measures lengths in UTF-16 code units, as VS Code positions do', () => {
    // The emoji is one code point but two UTF-16 units.
    const text = '"aé🎵"';
    const spans = buildTokenSpans(text, [capture('string', 0, text.length)]);
    assert.deepEqual(sketch(spans), ['0:0+6 string']);
    assert.equal(text.length, 6);
  });

  it('returns spans ordered by position, which the builder requires', () => {
    const text = '// c\nop a(b): c';
    const spans = buildTokenSpans(text, [
      capture('type', 13, 14),
      capture('comment', 0, 4),
      capture('function', 8, 9),
      capture('keyword', 5, 7),
    ]);
    const positions = spans.map((span) => [span.line, span.startChar]);
    assert.deepEqual(positions, [...positions].sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]!));
    assert.deepEqual(sketch(spans), [
      '0:0+4 comment',
      '1:0+2 keyword',
      '1:3+1 function.declaration',
      '1:8+1 type',
    ]);
  });

  it('merges neighbouring captures that share a style', () => {
    const spans = buildTokenSpans('ab', [capture('keyword', 0, 1), capture('keyword', 1, 2)]);
    assert.deepEqual(sketch(spans), ['0:0+2 keyword']);
  });

  it('ignores empty and out-of-range captures', () => {
    const spans = buildTokenSpans('ab', [
      capture('keyword', 1, 1),
      capture('keyword', 2, 1),
      capture('comment', 0, 99),
    ]);
    assert.deepEqual(sketch(spans), ['0:0+2 comment']);
  });

  it('handles an empty document', () => {
    assert.deepEqual(buildTokenSpans('', []), []);
  });
});
