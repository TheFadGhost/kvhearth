import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LIMIT_DEFAULTS,
  RequestParser,
  parseInlineLine,
  escapeInline,
  encodeInlineLine,
} from '../src/proto/parser.mjs';

function bytes(text) {
  return Buffer.from(text, 'latin1');
}

function typedFrame(args) {
  const parts = [bytes('%' + args.length + '\n')];
  for (const arg of args) {
    parts.push(bytes(arg.length + ' '));
    parts.push(arg);
    parts.push(bytes('\n'));
  }
  return Buffer.concat(parts);
}

function feedBytes(parser, chunk) {
  const results = [];
  for (const byte of chunk) results.push(parser.feed(Buffer.from([byte])));
  return results;
}

function allRequests(results) {
  return results.flatMap((r) => r.requests);
}

function assertNoFatal(results) {
  for (const r of results) assert.equal(r.fatal, null);
}

test('limit defaults match the contract', () => {
  assert.deepEqual({ ...LIMIT_DEFAULTS }, { maxArgs: 1024, maxBulk: 67108864, maxRequest: 134217728 });
});

test('typed request parses correctly when delivered one byte at a time', () => {
  const frame = typedFrame([bytes('SET'), bytes('greeting'), bytes('hello world')]);
  const parser = new RequestParser();
  const results = feedBytes(parser, frame);
  assertNoFatal(results);
  for (let i = 0; i < results.length - 1; i++) {
    assert.equal(results[i].requests.length, 0);
  }
  assert.equal(results[results.length - 1].requests.length, 1);
  const requests = allRequests(results);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].args, [bytes('SET'), bytes('greeting'), bytes('hello world')]);
});

test('inline request with quoted space parses one byte at a time', () => {
  const frame = bytes('SET greeting "hello world"\n');
  const parser = new RequestParser();
  const results = feedBytes(parser, frame);
  assertNoFatal(results);
  for (let i = 0; i < results.length - 1; i++) {
    assert.equal(results[i].requests.length, 0);
  }
  const requests = allRequests(results);
  assert.deepEqual(requests, [{ args: [bytes('SET'), bytes('greeting'), bytes('hello world')] }]);
});

test('CRLF and mixed line endings are accepted everywhere', () => {
  const parser = new RequestParser();
  const first = parser.feed(bytes('PING\r\n'));
  const second = parser.feed(bytes('%2\r\n1 a\r\n1 b\r\n'));
  const third = parser.feed(bytes('GET k\r\n%1\n1 z\r\nSET x y\n'));
  assertNoFatal([first, second, third]);
  assert.deepEqual(first.requests.map((r) => r.args), [[bytes('PING')]]);
  assert.deepEqual(second.requests.map((r) => r.args), [[bytes('a'), bytes('b')]]);
  assert.equal(third.requests.length, 3);
  assert.deepEqual(third.requests[0].args, [bytes('GET'), bytes('k')]);
  assert.deepEqual(third.requests[1].args, [bytes('z')]);
  assert.deepEqual(third.requests[2].args, [bytes('SET'), bytes('x'), bytes('y')]);
});

test('comments and blank lines yield null entries and no errors', () => {
  const parser = new RequestParser();
  const result = parser.feed(bytes('# hello\n\n   \n\t\nPING\n# tail comment\n'));
  assert.equal(result.fatal, null);
  assert.deepEqual(result.requests, [
    null,
    null,
    null,
    null,
    { args: [bytes('PING')] },
    null,
  ]);
});

test('typed payload containing LF CR and NUL survives byte-exact', () => {
  const payload = bytes('a\nb\r\nc\0d\xff');
  const frame = Buffer.concat([
    bytes('%2\n' + payload.length + ' '),
    payload,
    bytes('\n1 k\n'),
  ]);
  const parser = new RequestParser();
  const result = parser.feed(frame);
  assert.equal(result.fatal, null);
  assert.equal(result.requests.length, 1);
  const args = result.requests[0].args;
  assert.equal(args.length, 2);
  assert.ok(args[0].equals(payload));
  assert.ok(args[1].equals(bytes('k')));
});

test('partial typed record waits and completes when remaining bytes arrive', () => {
  const parser = new RequestParser();
  const first = parser.feed(bytes('%1\n6 abc'));
  assert.equal(first.fatal, null);
  assert.equal(first.requests.length, 0);
  const second = parser.feed(bytes('def\n'));
  assert.equal(second.fatal, null);
  assert.deepEqual(second.requests, [{ args: [bytes('abcdef')] }]);
});

test('declared bulk length beyond maxBulk fatals synchronously without allocating', () => {
  const parser = new RequestParser({ maxBulk: 64 });
  const before = process.memoryUsage().heapUsed;
  const result = parser.feed(bytes('%1\n1000000000000 x\n'));
  const after = process.memoryUsage().heapUsed;
  assert.notEqual(result.fatal, null);
  assert.match(result.fatal.message, /proto-max-bulk/);
  assert.equal(result.requests.length, 0);
  assert.ok(after - before < 16 * 1024 * 1024);
  const again = parser.feed(bytes('more junk\n'));
  assert.equal(again.fatal, result.fatal);
  assert.deepEqual(again.requests, []);
});

test('argument count beyond maxArgs fatals for both request forms', () => {
  const typedParser = new RequestParser({ maxArgs: 2 });
  const typedResult = typedParser.feed(bytes('%3\n1 a\n1 b\n1 c\n'));
  assert.notEqual(typedResult.fatal, null);
  assert.match(typedResult.fatal.message, /proto-max-args/);

  const inlineParser = new RequestParser({ maxArgs: 2 });
  const inlineResult = inlineParser.feed(bytes('A B C\n'));
  assert.notEqual(inlineResult.fatal, null);
  assert.match(inlineResult.fatal.message, /proto-max-args/);

  const boundaryParser = new RequestParser({ maxArgs: 2 });
  const ok = boundaryParser.feed(bytes('A B\n%2\n1 a\n1 b\n'));
  assert.equal(ok.fatal, null);
  assert.equal(ok.requests.length, 2);
});

test('accumulated buffer beyond maxRequest fatals', () => {
  const parser = new RequestParser({ maxRequest: 16 });
  const first = parser.feed(bytes('%1\n100 '));
  assert.equal(first.fatal, null);
  const second = parser.feed(bytes('012345678901234567890123456789'));
  assert.notEqual(second.fatal, null);
  assert.match(second.fatal.message, /proto-max-request/);
  assert.equal(second.requests.length, 0);
  const third = parser.feed(bytes('x\n'));
  assert.equal(third.fatal, second.fatal);
  assert.deepEqual(third.requests, []);
});

test('unterminated inline quote waits then fatals once the line closes', () => {
  const parser = new RequestParser();
  const first = parser.feed(bytes('SET k "unfinished quote'));
  assert.equal(first.fatal, null);
  assert.equal(first.requests.length, 0);
  const second = parser.feed(bytes('\n'));
  assert.notEqual(second.fatal, null);
  assert.match(second.fatal.message, /inline/);
  const third = parser.feed(bytes('PING\n'));
  assert.equal(third.fatal, second.fatal);
  assert.deepEqual(third.requests, []);
});

test('invalid escape sequences fatal', () => {
  const hexParser = new RequestParser();
  const hexResult = hexParser.feed(bytes('SET k "bad\\xZZ escape"\n'));
  assert.notEqual(hexResult.fatal, null);
  assert.match(hexResult.fatal.message, /inline/);

  const shortHexParser = new RequestParser();
  assert.notEqual(shortHexParser.feed(bytes('SET k "\\xa"\n')).fatal, null);

  const unknownParser = new RequestParser();
  assert.notEqual(unknownParser.feed(bytes('SET k "a\\qb"\n')).fatal, null);

  const danglingParser = new RequestParser();
  assert.notEqual(danglingParser.feed(bytes('SET k "a\\\n')).fatal, null);
});

test('percent-zero request is a framing violation per the contract', () => {
  const parser = new RequestParser();
  const result = parser.feed(bytes('%0\n'));
  assert.notEqual(result.fatal, null);
  assert.match(result.fatal.message, /at least one argument/);
});

test('parser frames many sequential commands independently in one stream', () => {
  const parser = new RequestParser();
  const stream = bytes(
    'PING\n%2\n1 a\n1 b\nSET x "q q"\n# note\n\nGET x\n%3\n3 SET\n1 y\n6 va\nlue\n',
  );
  const result = parser.feed(stream);
  assert.equal(result.fatal, null);
  assert.deepEqual(result.requests, [
    { args: [bytes('PING')] },
    { args: [bytes('a'), bytes('b')] },
    { args: [bytes('SET'), bytes('x'), bytes('q q')] },
    null,
    null,
    { args: [bytes('GET'), bytes('x')] },
    { args: [bytes('SET'), bytes('y'), bytes('va\nlue')] },
  ]);
});

test('parseInlineLine splits tokens and honours the escape set', () => {
  assert.deepEqual(parseInlineLine('SET  \t a  b'), [bytes('SET'), bytes('a'), bytes('b')]);
  assert.deepEqual(parseInlineLine('K ""'), [bytes('K'), Buffer.alloc(0)]);
  assert.deepEqual(parseInlineLine('"a\\tb\\xc3\\xa9"'), [bytes('a\tb\xc3\xa9')]);
  assert.deepEqual(parseInlineLine('a"b c"d e'), [bytes('ab cd'), bytes('e')]);
  assert.deepEqual(parseInlineLine('\\ backslash outside quotes'), [
    bytes('\\'),
    bytes('backslash'),
    bytes('outside'),
    bytes('quotes'),
  ]);
  assert.deepEqual(parseInlineLine('   '), []);
  assert.deepEqual(parseInlineLine(''), []);
  assert.equal(parseInlineLine('"never ends'), null);
  assert.equal(parseInlineLine('"trailing\\'), null);
});

test('escapeInline picks bare or quoted form and encodeInlineLine round-trips', () => {
  assert.equal(escapeInline(bytes('PLAIN-token9')), 'PLAIN-token9');
  assert.equal(escapeInline(bytes('has space')), '"has space"');
  assert.equal(escapeInline(bytes('q"uote')), '"q\\"uote"');
  assert.equal(escapeInline(bytes('back\\slash')), '"back\\\\slash"');
  assert.equal(escapeInline(Buffer.alloc(0)), '""');
  assert.equal(escapeInline(bytes('tab\there')), '"tab\\there"');
  assert.equal(escapeInline(bytes('nl\nhere')), '"nl\\nhere"');
  assert.equal(escapeInline(bytes('cr\rhere')), '"cr\\rhere"');
  assert.equal(escapeInline(bytes('nul\0here')), '"nul\\0here"');
  assert.equal(escapeInline(bytes('\x01\x7f\x80\xff')), '"\\x01\\x7f\\x80\\xff"');

  const samples = [
    [bytes('SET'), bytes('plain-key'), bytes('value with spaces')],
    [bytes('ECHO'), Buffer.from([0, 10, 13, 9, 34, 92, 127, 128, 255])],
    [Buffer.alloc(0)],
    [bytes('TABS\tAND CAPS')],
  ];
  for (const sample of samples) {
    const line = encodeInlineLine(sample);
    const parser = new RequestParser();
    const result = parser.feed(Buffer.from(line + '\n', 'latin1'));
    assert.equal(result.fatal, null);
    assert.equal(result.requests.length, 1);
    const parsed = result.requests[0].args;
    assert.equal(parsed.length, sample.length);
    for (let i = 0; i < sample.length; i++) {
      assert.ok(parsed[i].equals(sample[i]), 'round-trip mismatch for token ' + i);
    }
  }
});

function mulberry32(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mutate(input, rand) {
  const arr = Array.from(input);
  const rounds = 1 + Math.floor(rand() * 4);
  for (let round = 0; round < rounds; round++) {
    const kind = rand();
    if (kind < 0.35 && arr.length > 0) {
      arr.length = Math.floor(rand() * arr.length);
    } else if (kind < 0.7 && arr.length > 0) {
      const flips = 1 + Math.floor(rand() * 4);
      for (let f = 0; f < flips && arr.length > 0; f++) {
        arr[Math.floor(rand() * arr.length)] = Math.floor(rand() * 256);
      }
    } else if (rand() < 0.5) {
      const at = Math.floor(rand() * (arr.length + 1));
      arr.splice(at, 0, Math.floor(rand() * 256), Math.floor(rand() * 256));
    } else if (arr.length > 0) {
      arr.splice(Math.floor(rand() * arr.length), 1);
    }
  }
  return Buffer.from(arr);
}

function feedRandomChunks(parser, chunk, rand) {
  const results = [];
  let at = 0;
  while (at < chunk.length) {
    const span = 1 + Math.floor(rand() * 24);
    const end = Math.min(chunk.length, at + span);
    results.push(parser.feed(chunk.subarray(at, end)));
    at = end;
  }
  if (results.length === 0) results.push(parser.feed(chunk));
  return results;
}

test('seeded mutation fuzz never throws and yields only requests or fatal', () => {
  const rand = mulberry32(0x5eed1234);
  const bases = [
    typedFrame([bytes('SET'), bytes('key with space'), bytes('v\n\0\r\xffue')]),
    bytes('LPUSH list "a b" "c\\nd" plain\n'),
    typedFrame([bytes('GET'), bytes('k')]),
    bytes('# comment\n\nPING\n'),
    typedFrame([]),
    bytes('MSET a 1 b 2 "c 3"\n'),
  ];
  for (let iteration = 0; iteration < 2000; iteration++) {
    const base = bases[Math.floor(rand() * bases.length)];
    const mutated = mutate(base, rand);
    const parser = new RequestParser({
      maxArgs: 8,
      maxBulk: 256,
      maxRequest: 4096,
    });
    const results = feedRandomChunks(parser, mutated, rand);
    let sticky = null;
    for (const result of results) {
      assert.ok(Array.isArray(result.requests));
      if (sticky !== null) {
        assert.equal(result.fatal, sticky);
        assert.equal(result.requests.length, 0);
      } else if (result.fatal !== null) {
        sticky = result.fatal;
        assert.equal(typeof sticky.message, 'string');
        assert.ok(sticky.message.length > 0);
      }
      for (const entry of result.requests) {
        if (entry === null) continue;
        assert.equal(typeof entry, 'object');
        assert.ok(Array.isArray(entry.args));
        assert.ok(entry.args.length >= 0 && entry.args.length <= 8);
        for (const arg of entry.args) assert.ok(Buffer.isBuffer(arg));
      }
    }
  }
});
