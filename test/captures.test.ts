import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LEGEND, styleForCapture } from '../src/highlight/captures';

describe('styleForCapture', () => {
  it('maps the captures the grammar query emits', () => {
    assert.deepEqual(styleForCapture('keyword'), { tokenType: 'keyword', modifiers: [] });
    assert.deepEqual(styleForCapture('type.definition'), {
      tokenType: 'type',
      modifiers: ['declaration'],
    });
    assert.deepEqual(styleForCapture('type.builtin'), { tokenType: 'type', modifiers: ['builtin'] });
    assert.deepEqual(styleForCapture('module'), { tokenType: 'namespace', modifiers: [] });
    assert.deepEqual(styleForCapture('attribute'), { tokenType: 'decorator', modifiers: [] });
    assert.deepEqual(styleForCapture('string.escape'), {
      tokenType: 'escapeSequence',
      modifiers: [],
    });
  });

  it('treats enum cases and union variants as members of a closed type', () => {
    assert.equal(styleForCapture('constant')?.tokenType, 'enumMember');
    assert.equal(styleForCapture('constructor')?.tokenType, 'enumMember');
  });

  it('degrades an unknown sub-capture to its parent', () => {
    // The grammar may narrow a capture before this table learns about it.
    assert.deepEqual(styleForCapture('keyword.import'), styleForCapture('keyword'));
    assert.deepEqual(styleForCapture('number.float'), styleForCapture('number'));
    assert.deepEqual(styleForCapture('comment.documentation.tono'), styleForCapture('comment'));
  });

  it('drops captures that should not be coloured by semantic tokens', () => {
    assert.equal(styleForCapture('punctuation.bracket'), undefined);
    assert.equal(styleForCapture('punctuation.delimiter'), undefined);
    assert.equal(styleForCapture('spell'), undefined);
    assert.equal(styleForCapture('totally.unknown'), undefined);
  });

  it('keeps the nullable marker, which carries type meaning', () => {
    assert.deepEqual(styleForCapture('punctuation.special'), {
      tokenType: 'operator',
      modifiers: [],
    });
  });
});

describe('LEGEND', () => {
  it('lists every token type and modifier the mapping can produce', () => {
    assert.deepEqual(
      [...LEGEND.tokenTypes].sort(),
      [
        'comment',
        'decorator',
        'enumMember',
        'escapeSequence',
        'function',
        'keyword',
        'namespace',
        'number',
        'operator',
        'property',
        'string',
        'type',
        'typeParameter',
      ]
    );
    assert.deepEqual([...LEGEND.tokenModifiers].sort(), ['builtin', 'declaration']);
  });

  it('has no duplicates, since VS Code indexes the legend by position', () => {
    assert.equal(new Set(LEGEND.tokenTypes).size, LEGEND.tokenTypes.length);
    assert.equal(new Set(LEGEND.tokenModifiers).size, LEGEND.tokenModifiers.length);
  });
});
