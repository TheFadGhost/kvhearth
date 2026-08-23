import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderReply, renderBulkData, isPrintableText, escapeBytes, resolveTheme } from '../src/client/render.mjs';

const plain = resolveTheme({ noColor: true });

test('renders every reply kind per the documented rules', () => {
  assert.equal(renderReply({ kind: 'simple', text: 'OK' }, plain), 'OK');
  assert.equal(renderReply({ kind: 'integer', n: 42 }, plain), '(integer) 42');
  assert.equal(renderReply({ kind: 'nil-bulk' }, plain), '(nil)');
  assert.equal(renderReply({ kind: 'bulk', data: Buffer.from('hello') }, plain), 'hello');
  assert.equal(renderReply({ kind: 'nil-array' }, plain), '(nil array)');
  assert.equal(renderReply({ kind: 'array', items: [] }, plain), '(empty array)');
});

test('arrays are numbered recursively', () => {
  const nested = {
    kind: 'array',
    items: [
      { kind: 'bulk', data: Buffer.from('a') },
      { kind: 'array', items: [{ kind: 'bulk', data: Buffer.from('b') }, { kind: 'integer', n: 2 }] },
    ],
  };
  const out = renderReply(nested, plain);
  const lines = out.split('\n');
  assert.equal(lines[0], '1) a');
  assert.match(lines[1], /2\) +1\) b/);
  assert.match(lines[2], / +2\) \(integer\) 2/);
});

test('errors show code and message with severity word', () => {
  const out = renderReply({ kind: 'error', code: 'WRONGTYPE', text: 'LPUSH key x holds string' }, plain);
  assert.equal(out, '(error) WRONGTYPE LPUSH key x holds string');
});

test('binary values are escaped, never raw', () => {
  const binary = Buffer.from([0x68, 0x69, 0x00, 0xff, 0x0a]);
  assert.equal(isPrintableText(binary), false);
  assert.equal(escapeBytes(binary), '"hi\\0\\xff\\n"');
  assert.equal(renderBulkData(binary, plain), '"hi\\0\\xff\\n"');
});

test('printable utf-8 passes through unescaped', () => {
  const value = Buffer.from('héllo world');
  assert.equal(isPrintableText(value), true);
  assert.equal(renderBulkData(value, plain), 'héllo world');
});

test('control characters force escaping even in utf-8 range', () => {
  assert.equal(isPrintableText(Buffer.from([0x01])), false);
  assert.equal(isPrintableText(Buffer.from([0x7f])), false);
  assert.equal(escapeBytes(Buffer.from([0x01])), '"\\x01"');
});
