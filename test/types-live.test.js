import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { KvhearthClient } from '../src/client/lib.mjs';
import { startServer, sleep } from './helpers/server.mjs';

let server;
let client;

before(async () => {
  server = await startServer({ args: { 'append-fsync': 'never' } });
  client = new KvhearthClient({ port: server.port });
  await client.connect();
});

after(async () => {
  if (client) client.destroy();
  if (server) await server.killHard();
});

function bulkText(reply) {
  assert.equal(reply.kind, 'bulk', `expected bulk, got ${reply.kind}`);
  return reply.data.toString('utf8');
}

function bulkBytes(reply) {
  assert.equal(reply.kind, 'bulk', `expected bulk, got ${reply.kind}`);
  return reply.data;
}

function items(reply) {
  assert.equal(reply.kind, 'array', `expected array, got ${reply.kind}`);
  return reply.items;
}

function texts(reply) {
  return items(reply).map((item) => bulkText(item));
}

function intVal(reply) {
  assert.equal(reply.kind, 'integer', `expected integer, got ${reply.kind}`);
  return reply.n;
}

function simpleText(reply) {
  assert.equal(reply.kind, 'simple', `expected simple string, got ${reply.kind}`);
  return reply.text;
}

function nilBulk(reply) {
  assert.equal(reply.kind, 'nil-bulk', `expected nil-bulk, got ${reply.kind}`);
}

function checkError(reply, code, expectedText) {
  assert.equal(reply.kind, 'error', `expected error, got ${JSON.stringify(reply)}`);
  assert.equal(reply.code, code, `expected ${code}, got ${reply.code}: ${reply.text}`);
  if (expectedText !== undefined) {
    assert.equal(reply.text, expectedText);
  }
  return reply.text;
}

async function run(args) {
  return client.cmd(args);
}

async function pollUntilNil(key, timeoutMs = 3000) {
  const started = Date.now();
  for (;;) {
    const reply = await run(['GET', key]);
    if (reply.kind === 'nil-bulk') return true;
    assert.ok(Date.now() - started < timeoutMs, `key ${key} never expired`);
    await sleep(15);
  }
}

test('strings set get append strlen', async () => {
  nilBulk(await run(['GET', 'st:base']));
  assert.equal(intVal(await run(['STRLEN', 'st:base'])), 0);
  assert.equal(simpleText(await run(['SET', 'st:base', 'v1'])), 'OK');
  assert.equal(bulkText(await run(['GET', 'st:base'])), 'v1');
  assert.equal(intVal(await run(['APPEND', 'st:base', '23'])), 4);
  assert.equal(bulkText(await run(['GET', 'st:base'])), 'v123');
  assert.equal(intVal(await run(['STRLEN', 'st:base'])), 4);
  assert.equal(intVal(await run(['APPEND', 'st:fresh', 'x'])), 1);
  assert.equal(bulkText(await run(['GET', 'st:fresh'])), 'x');
});

test('counters incr decr incrby decrby basics', async () => {
  await run(['DEL', 'st:c']);
  assert.equal(intVal(await run(['INCR', 'st:c'])), 1);
  assert.equal(intVal(await run(['INCR', 'st:c'])), 2);
  assert.equal(intVal(await run(['DECR', 'st:c'])), 1);
  assert.equal(intVal(await run(['INCRBY', 'st:c', '40'])), 41);
  assert.equal(intVal(await run(['DECRBY', 'st:c', '1'])), 40);
  assert.equal(intVal(await run(['INCRBY', 'st:c', '-5'])), 35);
  assert.equal(intVal(await run(['DECRBY', 'st:c', '-5'])), 40);
  await run(['DEL', 'st:c2']);
  assert.equal(intVal(await run(['DECR', 'st:c2'])), -1);
});

test('counter overflow at signed 64-bit bounds', async () => {
  assert.equal(simpleText(await run(['SET', 'st:max', '9223372036854775807'])), 'OK');
  assert.equal(simpleText(await run(['SET', 'st:min', '-9223372036854775808'])), 'OK');
  checkError(
    await run(['INCR', 'st:max']),
    'ERR',
    "INCR increment would overflow 64-bit integer (key 'st:max')",
  );
  checkError(
    await run(['DECR', 'st:min']),
    'ERR',
    "DECR increment would overflow 64-bit integer (key 'st:min')",
  );
  checkError(
    await run(['INCRBY', 'st:max', '1']),
    'ERR',
    "INCRBY increment would overflow 64-bit integer (key 'st:max')",
  );
  checkError(
    await run(['DECRBY', 'st:min', '1']),
    'ERR',
    "DECRBY increment would overflow 64-bit integer (key 'st:min')",
  );
  assert.equal(bulkText(await run(['GET', 'st:max'])), '9223372036854775807');
});

test('non-integer counter value error names the command', async () => {
  await run(['SET', 'st:text', 'abc']);
  checkError(
    await run(['INCR', 'st:text']),
    'ERR',
    'INCR value is not an integer or out of range (abc)',
  );
  checkError(
    await run(['INCRBY', 'st:text', '2']),
    'ERR',
    'INCRBY value is not an integer or out of range (abc)',
  );
  checkError(
    await run(['DECRBY', 'st:text', '2']),
    'ERR',
    'DECRBY value is not an integer or out of range (abc)',
  );
  checkError(
    await run(['INCRBY', 'st:c', 'xyz']),
    'ERR',
    'INCRBY value is not an integer or out of range (xyz)',
  );
});

test('getrange negative indices and clamping', async () => {
  await run(['SET', 'st:gr', 'hello world']);
  assert.equal(bulkText(await run(['GETRANGE', 'st:gr', '-5', '-1'])), 'world');
  assert.equal(bulkText(await run(['GETRANGE', 'st:gr', '0', '-1'])), 'hello world');
  assert.equal(bulkText(await run(['GETRANGE', 'st:gr', '-100', '100'])), 'hello world');
  assert.equal(bulkText(await run(['GETRANGE', 'st:gr', '6', '5'])), '');
  assert.equal(bulkText(await run(['GETRANGE', 'st:missing', '0', '3'])), '');
});

test('setrange pads gaps with zero bytes', async () => {
  await run(['DEL', 'st:sr']);
  assert.equal(intVal(await run(['SETRANGE', 'st:sr', '5', 'x'])), 6);
  assert.deepEqual([...bulkBytes(await run(['GET', 'st:sr']))], [0, 0, 0, 0, 0, 120]);
  assert.equal(simpleText(await run(['SET', 'st:sr2', 'hello'])), 'OK');
  assert.equal(intVal(await run(['SETRANGE', 'st:sr2', '6', '!'])), 7);
  assert.deepEqual([...bulkBytes(await run(['GET', 'st:sr2']))], [104, 101, 108, 108, 111, 0, 33]);
  assert.equal(intVal(await run(['SETRANGE', 'st:sr2', '0', 'J'])), 7);
  assert.deepEqual([...bulkBytes(await run(['GET', 'st:sr2']))], [74, 101, 108, 108, 111, 0, 33]);
});

test('set nx xx semantics', async () => {
  await run(['DEL', 'st:nx']);
  assert.equal(simpleText(await run(['SET', 'st:nx', 'one', 'NX'])), 'OK');
  nilBulk(await run(['SET', 'st:nx', 'two', 'NX']));
  assert.equal(bulkText(await run(['GET', 'st:nx'])), 'one');
  assert.equal(simpleText(await run(['SET', 'st:nx', 'three', 'XX'])), 'OK');
  assert.equal(bulkText(await run(['GET', 'st:nx'])), 'three');
  await run(['DEL', 'st:xx-missing']);
  nilBulk(await run(['SET', 'st:xx-missing', 'v', 'XX']));
  assert.equal(intVal(await run(['EXISTS', 'st:xx-missing'])), 0);
});

test('set ex px keepttl ttl semantics', async () => {
  assert.equal(simpleText(await run(['SET', 'st:tt', 'v', 'EX', '100'])), 'OK');
  let pttl = intVal(await run(['PTTL', 'st:tt']));
  assert.ok(pttl > 98000 && pttl <= 100000, `EX ttl out of range: ${pttl}`);
  assert.equal(simpleText(await run(['SET', 'st:tt', 'v2', 'PX', '5000'])), 'OK');
  pttl = intVal(await run(['PTTL', 'st:tt']));
  assert.ok(pttl > 4800 && pttl <= 5000, `PX ttl out of range: ${pttl}`);
  assert.equal(simpleText(await run(['SET', 'st:tt', 'v3', 'KEEPTTL'])), 'OK');
  pttl = intVal(await run(['PTTL', 'st:tt']));
  assert.ok(pttl > 4500 && pttl <= 5000, `KEEPTTL lost the deadline: ${pttl}`);
  assert.equal(bulkText(await run(['GET', 'st:tt'])), 'v3');
  await run(['SET', 'st:tt', 'v4']);
  assert.equal(intVal(await run(['PTTL', 'st:tt'])), -1);
  checkError(
    await run(['SET', 'st:tt', 'v5', 'KEEPTTL', 'EX', '10']),
    'ERR',
    'SET syntax error: KEEPTTL cannot be combined with EX or PX',
  );
});

test('lpush rpush ordering', async () => {
  await run(['DEL', 'ls:r', 'ls:l1', 'ls:head']);
  assert.equal(intVal(await run(['RPUSH', 'ls:r', 'a', 'b', 'c'])), 3);
  assert.deepEqual(texts(await run(['LRANGE', 'ls:r', '0', '-1'])), ['a', 'b', 'c']);
  assert.equal(intVal(await run(['LPUSH', 'ls:head', 'solo'])), 1);
  assert.deepEqual(texts(await run(['LRANGE', 'ls:head', '0', '-1'])), ['solo']);
  assert.equal(bulkText(await run(['LINDEX', 'ls:r', '-1'])), 'c');
});

test('lpop rpop single and counted pops', async () => {
  await run(['DEL', 'ls:p', 'ls:p2', 'ls:p3', 'ls:absent']);
  await run(['RPUSH', 'ls:p', '1', '2', '3', '4']);
  assert.equal(bulkText(await run(['LPOP', 'ls:p'])), '1');
  assert.equal(bulkText(await run(['RPOP', 'ls:p'])), '4');
  assert.equal(intVal(await run(['LLEN', 'ls:p'])), 2);
  assert.deepEqual(texts(await run(['LPOP', 'ls:p', '2'])), ['2', '3']);
  assert.equal(intVal(await run(['EXISTS', 'ls:p'])), 0);
  await run(['RPUSH', 'ls:p2', 'a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(texts(await run(['LPOP', 'ls:p2', '99'])), ['a', 'b', 'c', 'd', 'e']);
  nilBulk(await run(['LPOP', 'ls:absent']));
  assert.deepEqual(items(await run(['LPOP', 'ls:absent', '3'])), []);
  await run(['RPUSH', 'ls:p3', 'only']);
  assert.equal(bulkText(await run(['RPOP', 'ls:p3'])), 'only');
  assert.equal(simpleText(await run(['TYPE', 'ls:p3'])), 'none');
});

test('negative pop counts take from the opposite end', async () => {
  await run(['DEL', 'ls:neg']);
  await run(['RPUSH', 'ls:neg', 'a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(texts(await run(['LPOP', 'ls:neg', '-2'])), ['e', 'd']);
  assert.equal(intVal(await run(['LLEN', 'ls:neg'])), 3);
  assert.deepEqual(texts(await run(['RPOP', 'ls:neg', '-2'])), ['a', 'b']);
  assert.deepEqual(texts(await run(['LRANGE', 'ls:neg', '0', '-1'])), ['c']);
  assert.deepEqual(texts(await run(['LPOP', 'ls:neg', '-99'])), ['c']);
  assert.equal(simpleText(await run(['TYPE', 'ls:neg'])), 'none');
});

test('llen lrange clamps lindex nil', async () => {
  await run(['DEL', 'ls:cl']);
  await run(['RPUSH', 'ls:cl', '1', '2', '3', '4']);
  assert.equal(intVal(await run(['LLEN', 'ls:cl'])), 4);
  assert.equal(intVal(await run(['LLEN', 'ls:no-such-list'])), 0);
  assert.deepEqual(texts(await run(['LRANGE', 'ls:cl', '0', '-1'])), ['1', '2', '3', '4']);
  assert.deepEqual(texts(await run(['LRANGE', 'ls:cl', '-100', '100'])), ['1', '2', '3', '4']);
  assert.deepEqual(texts(await run(['LRANGE', 'ls:cl', '2', '-2'])), ['3']);
  assert.deepEqual(items(await run(['LRANGE', 'ls:cl', '4', '9'])), []);
  assert.equal(bulkText(await run(['LINDEX', 'ls:cl', '0'])), '1');
  assert.equal(bulkText(await run(['LINDEX', 'ls:cl', '-1'])), '4');
  nilBulk(await run(['LINDEX', 'ls:cl', '99']));
  nilBulk(await run(['LINDEX', 'ls:cl', '-99']));
});

test('lset ok range error missing key', async () => {
  await run(['DEL', 'ls:set']);
  await run(['RPUSH', 'ls:set', 'x', 'y', 'z']);
  assert.equal(simpleText(await run(['LSET', 'ls:set', '1', 'yy'])), 'OK');
  assert.equal(bulkText(await run(['LINDEX', 'ls:set', '1'])), 'yy');
  checkError(await run(['LSET', 'ls:set', '50', 'bad']), 'RANGE', 'LSET index: out of range');
  assert.deepEqual(texts(await run(['LRANGE', 'ls:set', '0', '-1'])), ['x', 'yy', 'z']);
  checkError(await run(['LSET', 'ls:absent', '0', 'bad']), 'ERR', 'LSET no such key');
});

test('ltrim to empty deletes the key', async () => {
  await run(['DEL', 'ls:tr', 'ls:tr-empty']);
  await run(['RPUSH', 'ls:tr', 'a', 'b', 'c', 'd', 'e']);
  assert.equal(simpleText(await run(['LTRIM', 'ls:tr', '1', '3'])), 'OK');
  assert.deepEqual(texts(await run(['LRANGE', 'ls:tr', '0', '-1'])), ['b', 'c', 'd']);
  await run(['RPUSH', 'ls:tr-empty', 'a', 'b', 'c']);
  assert.equal(simpleText(await run(['LTRIM', 'ls:tr-empty', '5', '9'])), 'OK');
  assert.equal(simpleText(await run(['TYPE', 'ls:tr-empty'])), 'none');
  assert.equal(simpleText(await run(['LTRIM', 'ls:absent', '0', '1'])), 'OK');
});

test('hset multi-pair counts hget hexists', async () => {
  await run(['DEL', 'hs:h']);
  assert.equal(intVal(await run(['HSET', 'hs:h', 'f1', 'v1', 'f2', 'v2'])), 2);
  assert.equal(intVal(await run(['HSET', 'hs:h', 'f1', 'v1b', 'f3', 'v3'])), 1);
  assert.equal(bulkText(await run(['HGET', 'hs:h', 'f1'])), 'v1b');
  nilBulk(await run(['HGET', 'hs:h', 'nope']));
  nilBulk(await run(['HGET', 'hs:missing', 'f1']));
  assert.equal(intVal(await run(['HEXISTS', 'hs:h', 'f2'])), 1);
  assert.equal(intVal(await run(['HEXISTS', 'hs:h', 'nope'])), 0);
  assert.equal(intVal(await run(['HEXISTS', 'hs:missing', 'f1'])), 0);
});

test('hdel partial counts and delete-on-empty', async () => {
  assert.equal(intVal(await run(['HDEL', 'hs:h', 'f1', 'zz'])), 1);
  assert.equal(intVal(await run(['HDEL', 'hs:h', 'zz', 'qq'])), 0);
  assert.equal(intVal(await run(['HDEL', 'hs:h', 'f2', 'f3'])), 2);
  assert.equal(simpleText(await run(['TYPE', 'hs:h'])), 'none');
  assert.equal(intVal(await run(['HDEL', 'hs:missing', 'f1'])), 0);
});

test('hkeys hvals hgetall insertion order hlen', async () => {
  await run(['DEL', 'hs:o']);
  assert.equal(intVal(await run(['HSET', 'hs:o', 'f2', 'b', 'f1', 'a', 'f3', 'c'])), 3);
  assert.deepEqual(texts(await run(['HKEYS', 'hs:o'])), ['f2', 'f1', 'f3']);
  assert.deepEqual(texts(await run(['HVALS', 'hs:o'])), ['b', 'a', 'c']);
  assert.deepEqual(texts(await run(['HGETALL', 'hs:o'])), ['f2', 'b', 'f1', 'a', 'f3', 'c']);
  assert.equal(intVal(await run(['HLEN', 'hs:o'])), 3);
  assert.equal(intVal(await run(['HSET', 'hs:o', 'f1', 'a2'])), 0);
  assert.deepEqual(texts(await run(['HVALS', 'hs:o'])), ['b', 'a2', 'c']);
  assert.deepEqual(items(await run(['HKEYS', 'hs:missing'])), []);
  assert.deepEqual(items(await run(['HGETALL', 'hs:missing'])), []);
});

test('hincrby success and error cases', async () => {
  await run(['DEL', 'hs:i']);
  assert.equal(intVal(await run(['HINCRBY', 'hs:i', 'cnt', '5'])), 5);
  assert.equal(intVal(await run(['HINCRBY', 'hs:i', 'cnt', '-7'])), -2);
  assert.equal(intVal(await run(['HSET', 'hs:i', 'txt', 'abc'])), 1);
  checkError(
    await run(['HINCRBY', 'hs:i', 'txt', '1']),
    'ERR',
    'HINCRBY value is not an integer or out of range (abc)',
  );
  checkError(
    await run(['HINCRBY', 'hs:i', 'cnt', 'xyz']),
    'ERR',
    'HINCRBY value is not an integer or out of range (xyz)',
  );
  await run(['HSET', 'hs:i', 'big', '9223372036854775807']);
  checkError(
    await run(['HINCRBY', 'hs:i', 'big', '1']),
    'ERR',
    'HINCRBY increment would overflow 64-bit integer',
  );
  assert.equal(bulkText(await run(['HGET', 'hs:i', 'big'])), '9223372036854775807');
});

test('sadd dupes srem sismember scard smembers order', async () => {
  await run(['DEL', 'se:s']);
  assert.equal(intVal(await run(['SADD', 'se:s', 'a', 'b', 'c'])), 3);
  assert.equal(intVal(await run(['SADD', 'se:s', 'a', 'b'])), 0);
  assert.equal(intVal(await run(['SADD', 'se:s', 'd'])), 1);
  assert.equal(intVal(await run(['SCARD', 'se:s'])), 4);
  assert.equal(intVal(await run(['SISMEMBER', 'se:s', 'a'])), 1);
  assert.equal(intVal(await run(['SISMEMBER', 'se:s', 'zz'])), 0);
  assert.equal(intVal(await run(['SISMEMBER', 'se:missing', 'a'])), 0);
  assert.deepEqual(texts(await run(['SMEMBERS', 'se:s'])), ['a', 'b', 'c', 'd']);
  assert.equal(intVal(await run(['SREM', 'se:s', 'a', 'qq'])), 1);
  assert.equal(intVal(await run(['SCARD', 'se:s'])), 3);
  assert.equal(intVal(await run(['SREM', 'se:s', 'zz'])), 0);
  assert.equal(intVal(await run(['SREM', 'se:missing', 'zz'])), 0);
  assert.equal(intVal(await run(['SREM', 'se:s', 'b', 'c', 'd'])), 3);
  assert.equal(simpleText(await run(['TYPE', 'se:s'])), 'none');
});

test('set algebra with missing keys as empty sets', async () => {
  await run(['DEL', 'se:a', 'se:b', 'se:none-here']);
  await run(['SADD', 'se:a', 'a1', 'a2', 'a3']);
  await run(['SADD', 'se:b', 'a2', 'a3', 'a4']);
  assert.deepEqual(texts(await run(['SINTER', 'se:a', 'se:b'])), ['a2', 'a3']);
  assert.deepEqual(items(await run(['SINTER', 'se:a', 'se:none-here'])), []);
  assert.deepEqual(texts(await run(['SUNION', 'se:a', 'se:b'])), ['a1', 'a2', 'a3', 'a4']);
  assert.deepEqual(texts(await run(['SUNION', 'se:b', 'se:none-here'])), ['a2', 'a3', 'a4']);
  assert.deepEqual(texts(await run(['SDIFF', 'se:a', 'se:b'])), ['a1']);
  assert.deepEqual(texts(await run(['SDIFF', 'se:b', 'se:a'])), ['a4']);
  assert.deepEqual(items(await run(['SDIFF', 'se:none-here', 'se:a'])), []);
  assert.deepEqual(texts(await run(['SINTER', 'se:b'])), ['a2', 'a3', 'a4']);
});

test('stored set algebra and empty-result deletes destination', async () => {
  await run(['DEL', 'se:d', 'se:a2', 'se:b2', 'se:none-store']);
  await run(['SADD', 'se:a2', 'a1', 'a2', 'a3']);
  await run(['SADD', 'se:b2', 'a2', 'a3', 'a4']);
  await run(['SADD', 'se:d', 'tmp']);
  assert.equal(intVal(await run(['SINTERSTORE', 'se:d', 'se:a2', 'se:b2'])), 2);
  assert.deepEqual(texts(await run(['SMEMBERS', 'se:d'])), ['a2', 'a3']);
  assert.equal(intVal(await run(['SDIFFSTORE', 'se:d', 'se:a2', 'se:none-store'])), 3);
  assert.deepEqual(texts(await run(['SMEMBERS', 'se:d'])), ['a1', 'a2', 'a3']);
  assert.equal(intVal(await run(['SINTERSTORE', 'se:d', 'se:a2', 'se:none-store'])), 0);
  assert.equal(intVal(await run(['EXISTS', 'se:d'])), 0);
  assert.equal(intVal(await run(['SUNIONSTORE', 'se:d', 'se:a2', 'se:b2'])), 4);
  assert.equal(intVal(await run(['SUNIONSTORE', 'se:empty-out', 'se:none-store', 'se:none-2'])), 0);
  assert.equal(intVal(await run(['EXISTS', 'se:empty-out'])), 0);
  await run(['DEL', 'se:d', 'se:a2', 'se:b2']);
});

test('zadd flag combos nx xx ch counts', async () => {
  await run(['DEL', 'zs:f']);
  assert.equal(intVal(await run(['ZADD', 'zs:f', '1', 'm1', '2', 'm2'])), 2);
  assert.equal(intVal(await run(['ZADD', 'zs:f', '10', 'm1'])), 0);
  assert.equal(bulkText(await run(['ZSCORE', 'zs:f', 'm1'])), '10');
  assert.equal(intVal(await run(['ZADD', 'zs:f', 'NX', '20', 'm1'])), 0);
  assert.equal(bulkText(await run(['ZSCORE', 'zs:f', 'm1'])), '10');
  assert.equal(intVal(await run(['ZADD', 'zs:f', 'XX', '50', 'brand-new'])), 0);
  nilBulk(await run(['ZSCORE', 'zs:f', 'brand-new']));
  assert.equal(intVal(await run(['ZADD', 'zs:f', 'XX', '11', 'm1'])), 0);
  assert.equal(bulkText(await run(['ZSCORE', 'zs:f', 'm1'])), '11');
});

test('ch flag updates score without adding', async () => {
  await run(['DEL', 'zs:ch']);
  await run(['ZADD', 'zs:ch', '1', 'a']);
  const changed = await run(['ZADD', 'zs:ch', 'CH', '7', 'a']);
  assert.equal(changed.kind, 'integer');
  assert.equal(changed.n, 1);
  assert.equal(bulkText(await run(['ZSCORE', 'zs:ch', 'a'])), '7');
  const blocked = await run(['ZADD', 'zs:ch', 'CH', 'NX', '8', 'a']);
  assert.equal(blocked.kind, 'integer');
  assert.equal(blocked.n, 0);
  assert.equal(bulkText(await run(['ZSCORE', 'zs:ch', 'a'])), '7');
  assert.equal(intVal(await run(['ZADD', 'zs:ch', 'CH', '9', 'fresh'])), 1);
  assert.equal(bulkText(await run(['ZSCORE', 'zs:ch', 'fresh'])), '9');
});

test('zscore nil and zincrby including infinity', async () => {
  await run(['DEL', 'zs:i']);
  assert.equal(bulkText(await run(['ZINCRBY', 'zs:i', '2.5', 'm'])), '2.5');
  assert.equal(bulkText(await run(['ZINCRBY', 'zs:i', '2.5', 'm'])), '5');
  assert.equal(bulkText(await run(['ZINCRBY', 'zs:i', '-1', 'm'])), '4');
  assert.equal(bulkText(await run(['ZSCORE', 'zs:i', 'm'])), '4');
  nilBulk(await run(['ZSCORE', 'zs:i', 'ghost']));
  nilBulk(await run(['ZSCORE', 'zs:missing', 'm']));
  assert.equal(bulkText(await run(['ZINCRBY', 'zs:i', '+inf', 'pin'])), '+inf');
  assert.equal(bulkText(await run(['ZSCORE', 'zs:i', 'pin'])), '+inf');
  assert.equal(bulkText(await run(['ZINCRBY', 'zs:i', '1', 'pin'])), '+inf');
  assert.equal(bulkText(await run(['ZINCRBY', 'zs:i', '-inf', 'ninf'])), '-inf');
  checkError(
    await run(['ZINCRBY', 'zs:i', 'abc', 'm']),
    'ERR',
    'ZINCRBY value is not a valid float (abc)',
  );
});

test('zcard counts members', async () => {
  await run(['DEL', 'zs:c']);
  await run(['ZADD', 'zs:c', '1', 'a', '2', 'b', '3', 'c']);
  assert.equal(intVal(await run(['ZCARD', 'zs:c'])), 3);
  assert.equal(intVal(await run(['ZCARD', 'zs:no-card'])), 0);
});

test('zrank zrevrank ranks nil for absent members', async () => {
  await run(['DEL', 'zs:r']);
  await run(['ZADD', 'zs:r', '1', 'a', '2', 'b', '3', 'c', '4', 'd', '5', 'e']);
  assert.equal(intVal(await run(['ZRANK', 'zs:r', 'c'])), 2);
  assert.equal(intVal(await run(['ZREVRANK', 'zs:r', 'c'])), 2);
  assert.equal(intVal(await run(['ZRANK', 'zs:r', 'a'])), 0);
  assert.equal(intVal(await run(['ZREVRANK', 'zs:r', 'e'])), 0);
  nilBulk(await run(['ZRANK', 'zs:r', 'ghost']));
  nilBulk(await run(['ZREVRANK', 'zs:r', 'ghost']));
  await run(['DEL', 'zs:tie']);
  await run(['ZADD', 'zs:tie', '1', 'bb', '1', 'aa', '1', 'cc']);
  assert.deepEqual(texts(await run(['ZRANGE', 'zs:tie', '0', '-1'])), ['aa', 'bb', 'cc']);
  assert.equal(intVal(await run(['ZRANK', 'zs:tie', 'cc'])), 2);
  assert.equal(intVal(await run(['ZREVRANK', 'zs:tie', 'aa'])), 2);
});

test('zrange negative indices withscores score formatting', async () => {
  await run(['DEL', 'zs:g']);
  await run(['ZADD', 'zs:g', '1', 'a', '2', 'b', '3', 'c', '4', 'd', '5', 'e']);
  assert.deepEqual(texts(await run(['ZRANGE', 'zs:g', '0', '-1'])), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(texts(await run(['ZRANGE', 'zs:g', '-2', '-1'])), ['d', 'e']);
  assert.deepEqual(
    texts(await run(['ZRANGE', 'zs:g', '0', '-1', 'WITHSCORES'])),
    ['a', '1', 'b', '2', 'c', '3', 'd', '4', 'e', '5'],
  );
  assert.deepEqual(texts(await run(['ZRANGE', 'zs:g', '2', '99'])), ['c', 'd', 'e']);
  assert.deepEqual(items(await run(['ZRANGE', 'zs:g', '5', '9'])), []);
  await run(['DEL', 'zs:fmt']);
  await run(['ZADD', 'zs:fmt', '1', 'one', '1.5', 'half', '-2.25', 'low', '+inf', 'top']);
  assert.deepEqual(
    texts(await run(['ZRANGE', 'zs:fmt', '0', '-1', 'WITHSCORES'])),
    ['low', '-2.25', 'one', '1', 'half', '1.5', 'top', '+inf'],
  );
  assert.deepEqual(texts(await run(['ZRANGE', 'zs:fmt', '1', '1', 'WITHSCORES'])), ['one', '1']);
});

test('zrem partial removal and delete-on-empty', async () => {
  await run(['DEL', 'zs:rm', 'zs:absent-rem']);
  await run(['ZADD', 'zs:rm', '1', 'a', '2', 'b', '3', 'c']);
  assert.equal(intVal(await run(['ZREM', 'zs:rm', 'a', 'ghost'])), 1);
  assert.equal(intVal(await run(['ZCARD', 'zs:rm'])), 2);
  assert.equal(intVal(await run(['ZREM', 'zs:rm', 'ghost'])), 0);
  assert.equal(intVal(await run(['ZREM', 'zs:absent-rem', 'a'])), 0);
  assert.equal(intVal(await run(['ZREM', 'zs:rm', 'b', 'c'])), 2);
  assert.equal(simpleText(await run(['TYPE', 'zs:rm'])), 'none');
});

test('wrong-type matrix names key actual expected and never mutates', async () => {
  const setup = [
    ['SET', 'wt:string', 'sv'],
    ['RPUSH', 'wt:list', 'lv'],
    ['HSET', 'wt:hash', 'hf', 'hv'],
    ['SADD', 'wt:set', 'smv'],
    ['ZADD', 'wt:zset', '1', 'zm'],
  ];
  assert.equal(simpleText(await run(setup[0])), 'OK');
  for (const args of setup.slice(1)) {
    assert.equal(intVal(await run(args)), 1);
  }
  const matrix = [
    { type: 'string', writer: ['APPEND', '@', 'zz'], reader: ['GET', '@'] },
    { type: 'list', writer: ['LPUSH', '@', 'zz'], reader: ['LRANGE', '@', '0', '-1'] },
    { type: 'hash', writer: ['HSET', '@', 'zzf', 'zzv'], reader: ['HGETALL', '@'] },
    { type: 'set', writer: ['SADD', '@', 'zzm'], reader: ['SMEMBERS', '@'] },
    { type: 'zset', writer: ['ZADD', '@', '99', 'zzm'], reader: ['ZRANGE', '@', '0', '-1'] },
  ];
  const substitute = (template, key) =>
    template.map((part) => (part === '@' ? key : part));
  const fingerprint = async (key, reader) =>
    JSON.stringify(await run(substitute(reader, key)));
  const baselines = {};
  for (const target of matrix) {
    baselines[target.type] = await fingerprint(`wt:${target.type}`, target.reader);
  }
  for (const op of matrix) {
    for (const target of matrix) {
      if (op.type === target.type) continue;
      const key = `wt:${target.type}`;
      const reply = await run(substitute(op.writer, key));
      checkError(
        reply,
        'WRONGTYPE',
        `${op.writer[0]} key '${key}' holds ${target.type}, expected ${op.type}`,
      );
      assert.equal(
        await fingerprint(key, target.reader),
        baselines[target.type],
        `failed ${op.writer[0]} mutated ${key}`,
      );
    }
  }
});

test('pexpire makes the key invisible at its deadline', async () => {
  await run(['SET', 'xp:live', 'here']);
  const started = Date.now();
  assert.equal(intVal(await run(['PEXPIRE', 'xp:live', '80'])), 1);
  await pollUntilNil('xp:live');
  assert.ok(Date.now() - started >= 70, 'key vanished before its deadline');
});

test('ttl pttl ranges and sentinel values', async () => {
  await run(['SET', 'xp:r', 'v']);
  assert.equal(intVal(await run(['TTL', 'xp:r'])), -1);
  assert.equal(intVal(await run(['PTTL', 'xp:r'])), -1);
  assert.equal(intVal(await run(['PEXPIRE', 'xp:r', '5000'])), 1);
  const ttl = intVal(await run(['TTL', 'xp:r']));
  assert.ok(ttl >= 1 && ttl <= 5, `TTL out of range: ${ttl}`);
  const pttl = intVal(await run(['PTTL', 'xp:r']));
  assert.ok(pttl > 4000 && pttl <= 5000, `PTTL out of range: ${pttl}`);
  assert.equal(intVal(await run(['TTL', 'xp:none'])), -2);
  assert.equal(intVal(await run(['PTTL', 'xp:none'])), -2);
});

test('persist stops expiry entirely', async () => {
  await run(['SET', 'xp:p', 'v']);
  assert.equal(intVal(await run(['PEXPIRE', 'xp:p', '150'])), 1);
  assert.equal(intVal(await run(['PERSIST', 'xp:p'])), 1);
  assert.equal(intVal(await run(['PTTL', 'xp:p'])), -1);
  await sleep(220);
  assert.equal(bulkText(await run(['GET', 'xp:p'])), 'v');
  assert.equal(intVal(await run(['PERSIST', 'xp:p'])), 0);
});

test('plain set clears an existing ttl', async () => {
  assert.equal(simpleText(await run(['SET', 'xp:s', 'v', 'PX', '9000'])), 'OK');
  assert.ok(intVal(await run(['PTTL', 'xp:s'])) > 0);
  assert.equal(simpleText(await run(['SET', 'xp:s', 'v2'])), 'OK');
  assert.equal(intVal(await run(['PTTL', 'xp:s'])), -1);
});

test('expire on missing key returns zero; expired keys read as gone', async () => {
  assert.equal(intVal(await run(['EXPIRE', 'xp:never-existed', '60'])), 0);
  await run(['SET', 'xp:gone', 'v']);
  assert.equal(intVal(await run(['PEXPIRE', 'xp:gone', '30'])), 1);
  await pollUntilNil('xp:gone');
  assert.equal(simpleText(await run(['TYPE', 'xp:gone'])), 'none');
  assert.equal(intVal(await run(['DEL', 'xp:gone'])), 0);
  assert.equal(intVal(await run(['EXISTS', 'xp:gone'])), 0);
});

test('del multi-key count and exists multiple count', async () => {
  await run(['SET', 'ks:d1', 'a']);
  await run(['SET', 'ks:d2', 'b']);
  assert.equal(intVal(await run(['DEL', 'ks:d1', 'ks:d2', 'ks:absent'])), 2);
  assert.equal(intVal(await run(['DEL', 'ks:absent'])), 0);
  await run(['SET', 'ks:e1', 'a']);
  await run(['SET', 'ks:e2', 'b']);
  assert.equal(intVal(await run(['EXISTS', 'ks:e1', 'ks:e2', 'ks:absent', 'ks:e1'])), 3);
});

test('type reports every family name', async () => {
  await run(['SET', 'ks:str', 'v']);
  await run(['RPUSH', 'ks:list', 'v']);
  await run(['HSET', 'ks:hash', 'f', 'v']);
  await run(['SADD', 'ks:set', 'v']);
  await run(['ZADD', 'ks:zset', '1', 'v']);
  const expectations = [
    ['ks:str', 'string'],
    ['ks:list', 'list'],
    ['ks:hash', 'hash'],
    ['ks:set', 'set'],
    ['ks:zset', 'zset'],
    ['ks:never-was', 'none'],
  ];
  for (const [key, want] of expectations) {
    assert.equal(simpleText(await run(['TYPE', key])), want);
  }
});

test('rename moves value and ttl leaving source gone', async () => {
  await run(['DEL', 'ks:r1', 'ks:r2']);
  assert.equal(simpleText(await run(['SET', 'ks:r1', 'payload', 'PX', '9000'])), 'OK');
  assert.equal(simpleText(await run(['RENAME', 'ks:r1', 'ks:r2'])), 'OK');
  assert.equal(simpleText(await run(['TYPE', 'ks:r1'])), 'none');
  assert.equal(bulkText(await run(['GET', 'ks:r2'])), 'payload');
  const left = intVal(await run(['PTTL', 'ks:r2']));
  assert.ok(left > 8000 && left <= 9000, `RENAME lost the deadline: ${left}`);
  checkError(
    await run(['RENAME', 'ks:r1', 'ks:elsewhere']),
    'ERR',
    "RENAME no such key 'ks:r1'",
  );
});

test('renamenx refuses existing targets succeeds on fresh ones', async () => {
  await run(['DEL', 'ks:nx-src', 'ks:nx-dst', 'ks:nx-fresh']);
  await run(['SET', 'ks:nx-src', 'sa']);
  await run(['SET', 'ks:nx-dst', 'sb']);
  assert.equal(intVal(await run(['RENAMENX', 'ks:nx-src', 'ks:nx-dst'])), 0);
  assert.equal(bulkText(await run(['GET', 'ks:nx-src'])), 'sa');
  assert.equal(bulkText(await run(['GET', 'ks:nx-dst'])), 'sb');
  assert.equal(intVal(await run(['RENAMENX', 'ks:nx-src', 'ks:nx-fresh'])), 1);
  assert.equal(simpleText(await run(['TYPE', 'ks:nx-src'])), 'none');
  assert.equal(bulkText(await run(['GET', 'ks:nx-fresh'])), 'sa');
});

test('dbsize tracks changes memory usage shapes', async () => {
  const base = intVal(await run(['DBSIZE']));
  await run(['SET', 'ks:size', 'v']);
  assert.equal(intVal(await run(['DBSIZE'])), base + 1);
  await run(['DEL', 'ks:size']);
  assert.equal(intVal(await run(['DBSIZE'])), base);
  await run(['SET', 'ks:mem', 'hello']);
  const usage = intVal(await run(['MEMORY', 'USAGE', 'ks:mem']));
  assert.ok(Number.isInteger(usage) && usage > 0, `usage must be positive: ${usage}`);
  nilBulk(await run(['MEMORY', 'USAGE', 'ks:mem-absent']));
});

test('scan pages return matching subset with valid cursor protocol', async () => {
  for (let i = 1; i <= 70; i++) {
    await run(['SET', `scan:key:${String(i).padStart(3, '0')}`, 'v']);
  }
  for (let i = 1; i <= 30; i++) {
    await run(['SET', `decoy:${String(i).padStart(3, '0')}`, 'v']);
  }
  const seen = new Set();
  let cursor = '0';
  for (let round = 0; round < 500; round++) {
    const reply = await run(['SCAN', cursor, 'MATCH', 'scan:key:*', 'COUNT', '10']);
    assert.equal(reply.kind, 'array');
    assert.equal(reply.items.length, 2);
    cursor = bulkText(reply.items[0]);
    assert.match(cursor, /^\d+$/);
    for (const item of items(reply.items[1])) {
      const key = bulkText(item);
      assert.match(key, /^scan:key:/, `MATCH leaked a non-matching key: ${key}`);
      seen.add(key);
    }
    if (cursor === '0') break;
  }
  assert.equal(cursor, '0');
  assert.ok(seen.size > 0, 'scan must surface at least some matching keys');
});
