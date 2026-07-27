import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatArgs, previewArgs } from '../src/cli/args';

describe('formatArgs', () => {
  it('asks the CLI to format a single file', () => {
    assert.deepEqual(formatArgs('/w/api.tono'), ['fmt', '/w/api.tono']);
  });
});

describe('previewArgs', () => {
  it('passes the targets as one comma separated list', () => {
    assert.deepEqual(previewArgs('/w/api.tono', ['ts', 'rust'], false), [
      'preview',
      '/w/api.tono',
      '--target',
      'ts,rust',
      '--once',
    ]);
  });

  it('selects watch mode explicitly', () => {
    assert.deepEqual(previewArgs('/w/api.tono', ['go'], true).at(-1), '--watch');
  });

  it('ignores blank entries and repeats in the setting', () => {
    assert.deepEqual(previewArgs('/w/api.tono', [' ts ', 'ts', '', 'go'], false)[3], 'ts,go');
  });

  it('refuses to run with no target rather than guessing one', () => {
    assert.throws(() => previewArgs('/w/api.tono', [], false), /at least one target/);
    assert.throws(() => previewArgs('/w/api.tono', ['  '], false), /at least one target/);
  });
});
