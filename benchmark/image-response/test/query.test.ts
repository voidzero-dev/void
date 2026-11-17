import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseImageQuery } from '../src/query.ts';

test('defaults to a single Inter/twemoji render', () => {
  assert.deepEqual(parseImageQuery(new URLSearchParams()), {
    text: 'TEST_TEXT',
    emoji: 'twemoji',
    defaultFont: 'Inter',
    fallbackFonts: true,
    width: 1200,
    height: 630,
    iterations: 1,
  });
});

test('accepts every emoji style and both fonts', () => {
  for (const emoji of ['twemoji', 'blobmoji', 'noto', 'openmoji', 'fluent', 'fluentFlat']) {
    for (const defaultFont of ['Inter', 'Geist']) {
      const result = parseImageQuery(new URLSearchParams({ emoji, defaultFont }));
      assert.equal(result.emoji, emoji);
      assert.equal(result.defaultFont, defaultFont);
    }
  }
});

test('preserves decoded text verbatim, including empty text and markup', () => {
  for (const text of [
    '',
    'こんにちは 🌍',
    '<img src="https://example.com/unwanted.png">',
    'A&B+C',
  ]) {
    assert.equal(parseImageQuery(new URLSearchParams({ text })).text, text);
  }
});

test('accepts bounded stress controls and disabling font downloads', () => {
  const result = parseImageQuery(
    new URLSearchParams('width=4096&height=1&iterations=100&fallbackFonts=false'),
  );
  assert.equal(result.width, 4096);
  assert.equal(result.height, 1);
  assert.equal(result.iterations, 100);
  assert.equal(result.fallbackFonts, false);
});

test('accepts zero iterations without changing the image options', () => {
  const result = parseImageQuery(
    new URLSearchParams('iterations=0&width=4096&height=4096&fallbackFonts=false'),
  );
  assert.equal(result.iterations, 0);
  assert.equal(result.width, 4096);
  assert.equal(result.height, 4096);
  assert.equal(result.fallbackFonts, false);
});

test('rejects invalid enums, dimensions, render counts, and excessive text', () => {
  for (const query of [
    'emoji=unknown',
    'emoji=',
    'defaultFont=inter',
    'fallbackFonts=0',
    'width=0',
    'width=4097',
    'height=-1',
    'height=NaN',
    'height=Infinity',
    'iterations=',
    'iterations=-1',
    'iterations=1.5',
    'iterations=1e2',
    'iterations=101',
    'text=' + 'x'.repeat(4097),
    'iterations=0&width=0',
  ]) {
    assert.throws(() => parseImageQuery(new URLSearchParams(query)), TypeError, query);
  }
});
