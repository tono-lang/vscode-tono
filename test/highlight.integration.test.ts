import assert from 'node:assert/strict';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { TonoHighlighter } from '../src/highlight/grammar';
import type { TokenSpan } from '../src/highlight/tokenize';

// Exercises the real artefacts the extension ships: the Tono parser compiled to
// wasm and the grammar's own highlights.scm. A regression here means the shipped
// highlighting is wrong, not just the mapping table.
const root = path.resolve(__dirname, '..', '..');
const runtimeDir = path.dirname(require.resolve('web-tree-sitter/web-tree-sitter.wasm'));

let highlighter: TonoHighlighter;

interface Painted {
  readonly text: string;
  readonly type: string;
  readonly modifiers?: readonly string[];
}

function paint(source: string): Painted[] {
  const lines = source.split('\n');
  return highlighter.highlight(source).map((span) => {
    const line = lines[span.line] ?? '';
    const painted: Painted = {
      text: line.slice(span.startChar, span.startChar + span.length),
      type: span.tokenType,
    };
    return span.modifiers.length > 0 ? { ...painted, modifiers: [...span.modifiers] } : painted;
  });
}

before(async () => {
  highlighter = await TonoHighlighter.load({
    runtimeDir,
    parserWasmPath: path.join(root, 'grammar', 'tono.wasm'),
    queryPath: path.join(root, 'grammar', 'highlights.scm'),
  });
});

after(() => highlighter.dispose());

describe('highlighting real Tono source', () => {
  it('paints a struct declaration', () => {
    const source = [
      '// a comment',
      '@doc("hi")',
      'pub struct charge {',
      '  amount: i64',
      '  label: string?',
      '  meta: map[string]string',
      '}',
    ].join('\n');

    assert.deepEqual(paint(source), [
      { text: '// a comment', type: 'comment' },
      // The `@` and the trait name are adjacent decorators, so they coalesce.
      { text: '@doc', type: 'decorator' },
      { text: '"hi"', type: 'string' },
      { text: 'pub', type: 'keyword' },
      { text: 'struct', type: 'keyword' },
      { text: 'charge', type: 'type', modifiers: ['declaration'] },
      { text: 'amount', type: 'property' },
      { text: 'i64', type: 'type', modifiers: ['builtin'] },
      { text: 'label', type: 'property' },
      { text: 'string', type: 'type', modifiers: ['builtin'] },
      { text: '?', type: 'operator' },
      { text: 'meta', type: 'property' },
      { text: 'map', type: 'keyword' },
      { text: 'string', type: 'type', modifiers: ['builtin'] },
      { text: 'string', type: 'type', modifiers: ['builtin'] },
    ]);
  });

  it('paints imports, operations and extensions', () => {
    const source = [
      'import payments.common as common',
      '',
      'op create_charge(charge): charge @http(method: "POST")',
      '',
      'ext hook sign(request) -> request {',
      '  ts: "ext/ts/sign.ts#sign"',
      '}',
    ].join('\n');

    assert.deepEqual(paint(source), [
      { text: 'import', type: 'keyword' },
      { text: 'payments', type: 'namespace' },
      { text: 'common', type: 'namespace' },
      { text: 'as', type: 'keyword' },
      { text: 'common', type: 'namespace' },
      { text: 'op', type: 'keyword' },
      { text: 'create_charge', type: 'function', modifiers: ['declaration'] },
      { text: 'charge', type: 'type' },
      { text: 'charge', type: 'type' },
      { text: '@http', type: 'decorator' },
      { text: 'method', type: 'property' },
      { text: '"POST"', type: 'string' },
      { text: 'ext', type: 'keyword' },
      { text: 'hook', type: 'keyword' },
      { text: 'sign', type: 'function', modifiers: ['declaration'] },
      { text: 'request', type: 'type' },
      { text: '->', type: 'operator' },
      { text: 'request', type: 'type' },
      { text: 'ts', type: 'property' },
      { text: '"ext/ts/sign.ts#sign"', type: 'string' },
    ]);
  });

  it('paints enum cases and union variants as members', () => {
    const source = ['enum status {', '  ok = 1', '}', '', 'pub union result[T] {', '  hit(T)', '}'].join(
      '\n'
    );

    assert.deepEqual(paint(source), [
      { text: 'enum', type: 'keyword' },
      { text: 'status', type: 'type', modifiers: ['declaration'] },
      { text: 'ok', type: 'enumMember' },
      { text: '1', type: 'number' },
      { text: 'pub', type: 'keyword' },
      { text: 'union', type: 'keyword' },
      { text: 'result', type: 'type', modifiers: ['declaration'] },
      { text: 'T', type: 'typeParameter' },
      { text: 'hit', type: 'enumMember' },
      { text: 'T', type: 'type' },
    ]);
  });

  it('breaks a block string into one token per line', () => {
    const source = ['ext hook s(a) -> b {', '  ts: """first', 'second', 'third"""', '}'].join('\n');
    const strings = highlighter.highlight(source).filter((span) => span.tokenType === 'string');

    assert.deepEqual(
      strings.map((span) => [span.line, span.startChar, span.length]),
      [
        [1, 6, 8],
        [2, 0, 6],
        [3, 0, 8],
      ]
    );
  });

  it('paints escape sequences over the enclosing string', () => {
    const source = 'ext hook s(a) -> b {\n  ts: "a\\nb"\n}';
    const painted = paint(source).filter(
      (token) => token.type === 'string' || token.type === 'escapeSequence'
    );

    assert.deepEqual(painted, [
      { text: '"a', type: 'string' },
      { text: '\\n', type: 'escapeSequence' },
      { text: 'b"', type: 'string' },
    ]);
  });

  it('keeps highlighting a file that does not parse', () => {
    // The editor must stay usable while a declaration is half-typed. Recovery is
    // partial: a member with no type yet collapses the whole struct match, so
    // only the keywords survive until the type name starts to appear.
    assert.deepEqual(paint('pub struct charge {\n  amount: '), [
      { text: 'pub', type: 'keyword' },
      { text: 'struct', type: 'keyword' },
    ]);

    assert.deepEqual(paint('pub struct charge {\n  amount: i6'), [
      { text: 'pub', type: 'keyword' },
      { text: 'struct', type: 'keyword' },
      { text: 'charge', type: 'type', modifiers: ['declaration'] },
      { text: 'amount', type: 'property' },
      { text: 'i6', type: 'type' },
    ]);
  });

  it('produces only single-line, non-overlapping, ordered tokens', () => {
    // These are hard requirements of the VS Code semantic tokens builder.
    const source = [
      '@doc("çé🎵")',
      'pub struct a {',
      '  b: map[string]list[i64]',
      '  c: """x',
      'y"""',
      '}',
    ].join('\n');
    const spans: TokenSpan[] = highlighter.highlight(source);
    const lines = source.split('\n');

    assert.ok(spans.length > 0);
    let previous: TokenSpan | undefined;
    for (const span of spans) {
      assert.ok(span.length > 0, 'zero length token');
      const line = lines[span.line];
      assert.ok(line !== undefined, `token on line ${span.line} which does not exist`);
      assert.ok(
        span.startChar + span.length <= line.length,
        `token exceeds line ${span.line}: ${JSON.stringify(span)}`
      );
      if (previous) {
        const ordered =
          span.line > previous.line ||
          (span.line === previous.line && span.startChar >= previous.startChar + previous.length);
        assert.ok(ordered, `token out of order or overlapping: ${JSON.stringify(span)}`);
      }
      previous = span;
    }
  });
});
