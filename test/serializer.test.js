import test from 'node:test';
import assert from 'node:assert/strict';

import {
  simple,
  error,
  integer,
  bulk,
  array,
  nilArray,
  encodeTypedRequest,
} from '../src/proto/serializer.mjs';

function utf8(text) {
  return Buffer.from(text, 'utf8');
}

test('simple frames plus-prefixed text terminated by bare LF', () => {
  assert.deepEqual(simple('OK'), utf8('+OK\n'));
  assert.deepEqual(simple('PONG'), utf8('+PONG\n'));
  assert.deepEqual(simple(''), utf8('+\n'));
});

test('simple refuses text that would break single-line framing', () => {
  assert.throws(() => simple('PO\rNG'), RangeError);
  assert.throws(() => simple('a\nb'), RangeError);
});

test('error frames dash-CODE space message terminated by bare LF', () => {
  assert.deepEqual(
    error('WRONGTYPE', "lpush key 'greeting' holds string, expected list"),
    utf8("-WRONGTYPE lpush key 'greeting' holds string, expected list\n")
  );
});

test('error accepts every code in the fixed taxonomy', () => {
  for (const code of ['PROTO', 'ERR', 'WRONGTYPE', 'RANGE', 'OOM', 'SRV']) {
    assert.deepEqual(error(code, 'boom'), utf8('-' + code + ' boom\n'));
  }
});

test('error rejects codes outside the fixed taxonomy as programmer error', () => {
  assert.throws(() => error('NOPE', 'boom'), RangeError);
  assert.throws(() => error('', 'boom'), RangeError);
  assert.throws(() => error(undefined, 'boom'), RangeError);
});

test('error requires a non-empty single-line message string', () => {
  assert.throws(() => error('ERR'), TypeError);
  assert.throws(() => error('ERR', ''), TypeError);
  assert.throws(() => error('ERR', 'boom\n'), RangeError);
  assert.throws(() => error('ERR', 'boom\r'), RangeError);
});

test('integer frames colon-prefixed plain decimal terminated by bare LF', () => {
  assert.deepEqual(integer(0), utf8(':0\n'));
  assert.deepEqual(integer(-1), utf8(':-1\n'));
  assert.deepEqual(integer(42), utf8(':42\n'));
  assert.deepEqual(integer(2 ** 53), utf8(':9007199254740992\n'));
  assert.deepEqual(integer(-(2 ** 53)), utf8(':-9007199254740992\n'));
  assert.deepEqual(integer(2n ** 62n), utf8(':4611686018427387904\n'));
});

test('integer spans the full signed 64-bit range with BigInt input', () => {
  assert.deepEqual(integer(-(2n ** 63n)), utf8(':-9223372036854775808\n'));
  assert.deepEqual(integer(2n ** 63n - 1n), utf8(':9223372036854775807\n'));
});

test('integer throws RangeError beyond signed 64-bit bounds', () => {
  assert.throws(() => integer(2 ** 63), RangeError);
  assert.throws(() => integer(-(2 ** 64)), RangeError);
  assert.throws(() => integer(2 ** 64), RangeError);
  assert.throws(() => integer(2n ** 63n), RangeError);
  assert.throws(() => integer(-(2n ** 63n) - 1n), RangeError);
});

test('integer rejects non-integral and non-numeric input', () => {
  assert.throws(() => integer(1.5), RangeError);
  assert.throws(() => integer('7'), TypeError);
  assert.throws(() => integer(null), TypeError);
});

test('null bulk frames the nil marker dollar-minus-one', () => {
  assert.deepEqual(bulk(null), utf8('$-1\n'));
});

test('bulk frames byte length then raw bytes then bare LF', () => {
  assert.deepEqual(bulk('hello'), utf8('$5\nhello\n'));
  assert.deepEqual(bulk(''), utf8('$0\n\n'));
});

test('bulk header counts UTF-8 bytes not characters', () => {
  const value = 'h\u00e9llo';
  assert.equal(value.length, 5);
  assert.equal(Buffer.byteLength(value, 'utf8'), 6);
  assert.deepEqual(bulk(value), Buffer.concat([utf8('$6\n'), utf8(value), utf8('\n')]));
});

test('binary bulk encodes newline and NUL verbatim and round-trips identically', () => {
  const payload = Buffer.from([0x61, 0x0a, 0x00, 0x62]);
  const framed = bulk(payload);
  assert.deepEqual(framed, Buffer.concat([utf8('$4\n'), payload, utf8('\n')]));
  assert.deepEqual(framed.subarray(3, 3 + payload.length), payload);
});

test('bulk rejects values that are neither null nor string nor Buffer', () => {
  assert.throws(() => bulk(undefined), TypeError);
  assert.throws(() => bulk(7), TypeError);
});

test('array frames count then concatenates already-encoded replies', () => {
  assert.deepEqual(array([]), utf8('*0\n'));
  assert.deepEqual(array([bulk('a'), bulk('b')]), utf8('*2\n$1\na\n$1\nb\n'));
});

test('nested arrays compose recursively from innermost frames', () => {
  const nested = array([bulk('a'), array([bulk('b'), integer(2)]), nilArray()]);
  assert.deepEqual(nested, utf8('*3\n$1\na\n*2\n$1\nb\n:2\n*-1\n'));
});

test('array rejects missing or non-Buffer elements', () => {
  assert.throws(() => array(null), TypeError);
  assert.throws(() => array(['$1\na\n']), TypeError);
});

test('nil array frames star-minus-one', () => {
  assert.deepEqual(nilArray(), utf8('*-1\n'));
});

test('worked session replies from DESIGN 1.4 reproduce byte for byte', () => {
  assert.deepEqual(simple('PONG'), utf8('+PONG\n'));
  assert.deepEqual(bulk('hello'), utf8('$5\nhello\n'));
  assert.deepEqual(integer(1), utf8(':1\n'));
  assert.deepEqual(integer(3), utf8(':3\n'));
  assert.deepEqual(array([bulk('1'), bulk('2'), bulk('3')]), utf8('*3\n$1\n1\n$1\n2\n$1\n3\n'));
  assert.deepEqual(integer(1), utf8(':1\n'));
});

test('typed request frames percent-argcount then length-prefixed records', () => {
  assert.deepEqual(
    encodeTypedRequest(['SET', 'k', 'hello']),
    utf8('%3\n3 SET\n1 k\n5 hello\n')
  );
});

test('typed request carries raw Buffer bytes with byte-accurate length headers', () => {
  const payload = Buffer.from([0x61, 0x0a, 0x00, 0x62]);
  const framed = encodeTypedRequest(['SET', 'k', payload]);
  const head = utf8('%3\n3 SET\n1 k\n4 ');
  assert.deepEqual(framed, Buffer.concat([head, payload, utf8('\n')]));
  assert.deepEqual(framed.subarray(head.length, head.length + payload.length), payload);
});

test('typed request encodes one argument and rejects invalid argument lists', () => {
  assert.deepEqual(encodeTypedRequest(['PING']), utf8('%1\n4 PING\n'));
  assert.deepEqual(encodeTypedRequest(['']), utf8('%1\n0 \n'));
  assert.throws(() => encodeTypedRequest([]), RangeError);
  assert.throws(() => encodeTypedRequest(['SET', 7]), TypeError);
  assert.throws(() => encodeTypedRequest(null), TypeError);
});

test('structural reply and request bytes never contain carriage returns', () => {
  const frames = [
    simple('PONG'),
    error('ERR', 'unknown command'),
    integer(7),
    bulk('plain'),
    bulk(null),
    array([bulk('a')]),
    nilArray(),
    encodeTypedRequest(['GET', 'k']),
  ];
  for (const frame of frames) {
    assert.equal(frame.includes(0x0d), false);
  }
});
