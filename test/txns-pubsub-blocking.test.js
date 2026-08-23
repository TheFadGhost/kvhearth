import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { KvhearthClient } from '../src/client/lib.mjs';
import { startServer, sleep } from './helpers/server.mjs';

let server;
const clients = [];

before(async () => {
  server = await startServer({ args: { 'append-fsync': 'never' } });
});

after(async () => {
  for (const client of clients) client.destroy();
  if (server) await server.killHard();
});

async function newClient() {
  const client = new KvhearthClient({ port: server.port });
  clients.push(client);
  await client.connect();
  return client;
}

function describeReply(reply) {
  if (reply.kind === 'bulk') return `bulk(${reply.data.toString('utf8')})`;
  if (reply.kind === 'simple') return `simple(${reply.text})`;
  if (reply.kind === 'error') return `error ${reply.code} ${reply.text}`;
  if (reply.kind === 'integer') return `integer(${reply.n})`;
  if (reply.kind === 'array') return `array(${reply.items.length})`;
  return reply.kind;
}

function bulkText(reply) {
  assert.equal(reply.kind, 'bulk', `expected bulk, got ${describeReply(reply)}`);
  return reply.data.toString('utf8');
}

function items(reply) {
  assert.equal(reply.kind, 'array', `expected array, got ${describeReply(reply)}`);
  return reply.items;
}

function simpleText(reply) {
  assert.equal(reply.kind, 'simple', `expected simple, got ${describeReply(reply)}`);
  return reply.text;
}

function intVal(reply) {
  assert.equal(reply.kind, 'integer', `expected integer, got ${describeReply(reply)}`);
  return reply.n;
}

function nilBulk(reply) {
  assert.equal(reply.kind, 'nil-bulk', `expected nil-bulk, got ${describeReply(reply)}`);
}

function nilArrayReply(reply) {
  assert.equal(reply.kind, 'nil-array', `expected nil-array, got ${describeReply(reply)}`);
}

function expectError(reply, code, fragment) {
  assert.equal(reply.kind, 'error', `expected error, got ${describeReply(reply)}`);
  assert.equal(reply.code, code, `expected ${code}, got ${reply.code}: ${reply.text}`);
  if (fragment !== undefined) {
    assert.ok(
      reply.text.includes(fragment),
      `expected error text to include '${fragment}', got '${reply.text}'`,
    );
  }
  return reply.text;
}

function checkSubscriptionConfirmation(reply, verb, channel, count) {
  const parts = items(reply);
  assert.equal(parts.length, 3, `expected *3 confirmation, got ${parts.length} parts`);
  assert.equal(simpleText(parts[0]), verb);
  assert.equal(bulkText(parts[1]), channel);
  assert.equal(intVal(parts[2]), count);
}

function collectPushes(client) {
  const seen = [];
  const listener = (reply) => seen.push(reply);
  client.on('push', listener);
  let scanFrom = 0;
  return {
    seen,
    async next(matcher, timeoutMs = 500) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        while (scanFrom < seen.length) {
          const reply = seen[scanFrom];
          scanFrom += 1;
          if (matcher(reply)) return reply;
        }
        if (Date.now() >= deadline) return null;
        await sleep(10);
      }
    },
    release() {
      client.removeListener('push', listener);
    },
  };
}

async function expectNoPush(collector, matcher, quietMs = 400) {
  const found = await collector.next(matcher, quietMs);
  assert.equal(found, null, `received an unexpected push: ${found === null ? '' : describeReply(found)}`);
}

const anyFrame = () => true;

function isDeliverFrame(kindName, channel, payload) {
  return (reply) => {
    if (reply.kind !== 'array') return false;
    const expectedLength = kindName === 'pmessage' ? 4 : 3;
    if (reply.items.length !== expectedLength) return false;
    if (reply.items[0].kind !== 'simple' || reply.items[0].text !== kindName) return false;
    const channelPart = kindName === 'pmessage' ? reply.items[2] : reply.items[1];
    if (channelPart.kind !== 'bulk' || channelPart.data.toString('utf8') !== channel) return false;
    const payloadPart = reply.items[reply.items.length - 1];
    if (payloadPart.kind !== 'bulk' || payloadPart.data.toString('utf8') !== payload) return false;
    return true;
  };
}

test('multi queues sets and exec applies them atomically', async () => {
  const c = await newClient();
  await c.cmd(['DEL', 'tx:a', 'tx:b']);
  assert.equal(simpleText(await c.cmd(['MULTI'])), 'OK');
  assert.equal(simpleText(await c.cmd(['SET', 'tx:a', 'v1'])), 'QUEUED');
  assert.equal(simpleText(await c.cmd(['SET', 'tx:b', 'v2'])), 'QUEUED');
  const exec = await c.cmd(['EXEC']);
  const replies = items(exec);
  assert.equal(replies.length, 2);
  assert.equal(replies[0].kind, 'simple');
  assert.equal(replies[0].text, 'OK');
  assert.equal(replies[1].kind, 'simple');
  assert.equal(replies[1].text, 'OK');
  assert.equal(bulkText(await c.cmd(['GET', 'tx:a'])), 'v1');
  assert.equal(bulkText(await c.cmd(['GET', 'tx:b'])), 'v2');
});

test('runtime error inside exec does not abort siblings', async () => {
  const c = await newClient();
  await c.cmd(['DEL', 'tx:e-a', 'tx:e-c']);
  assert.equal(simpleText(await c.cmd(['SET', 'tx:e-a', '1'])), 'OK');
  assert.equal(simpleText(await c.cmd(['MULTI'])), 'OK');
  assert.equal(simpleText(await c.cmd(['SET', 'tx:e-a', '1'])), 'QUEUED');
  assert.equal(simpleText(await c.cmd(['LPUSH', 'tx:e-a', 'x'])), 'QUEUED');
  assert.equal(simpleText(await c.cmd(['SET', 'tx:e-c', '3'])), 'QUEUED');
  const exec = await c.cmd(['EXEC']);
  const replies = items(exec);
  assert.equal(replies.length, 3);
  assert.equal(replies[0].kind, 'simple');
  assert.equal(replies[0].text, 'OK');
  expectError(replies[1], 'WRONGTYPE', 'holds string, expected list');
  assert.equal(replies[2].kind, 'simple');
  assert.equal(replies[2].text, 'OK');
  assert.equal(bulkText(await c.cmd(['GET', 'tx:e-a'])), '1');
  assert.equal(bulkText(await c.cmd(['GET', 'tx:e-c'])), '3');
});

test(
  'unknown command while multi marks exec aborted and applies nothing',
   async () => {
  const c = await newClient();
  await c.cmd(['DEL', 'tx:u-a', 'tx:u-b']);
  assert.equal(simpleText(await c.cmd(['MULTI'])), 'OK');
  assert.equal(simpleText(await c.cmd(['SET', 'tx:u-a', 'v1'])), 'QUEUED');
  const unknown = await c.cmd(['DEFINITELY_NOT_A_COMMAND', 'x']);
  expectError(unknown, 'ERR', 'unknown command');
  assert.equal(simpleText(await c.cmd(['SET', 'tx:u-b', 'v2'])), 'QUEUED');
  const exec = await c.cmd(['EXEC']);
  expectError(exec, 'ERR', 'aborted');
  nilBulk(await c.cmd(['GET', 'tx:u-a']));
  nilBulk(await c.cmd(['GET', 'tx:u-b']));
});

test('discard then exec errors and exec without multi errors', async () => {
  const c = await newClient();
  expectError(await c.cmd(['DISCARD']), 'ERR', 'DISCARD without MULTI');
  expectError(await c.cmd(['EXEC']), 'ERR', 'EXEC without MULTI');
  assert.equal(simpleText(await c.cmd(['MULTI'])), 'OK');
  assert.equal(simpleText(await c.cmd(['DISCARD'])), 'OK');
  expectError(await c.cmd(['EXEC']), 'ERR', 'EXEC without MULTI');
});

test('empty transaction exec returns empty array', async () => {
  const c = await newClient();
  assert.equal(simpleText(await c.cmd(['MULTI'])), 'OK');
  const exec = await c.cmd(['EXEC']);
  assert.deepEqual(items(exec), []);
});

test('watch happy path exec succeeds when key untouched', async () => {
  const c = await newClient();
  await c.cmd(['DEL', 'tx:w-k']);
  assert.equal(simpleText(await c.cmd(['WATCH', 'tx:w-k'])), 'OK');
  assert.equal(simpleText(await c.cmd(['MULTI'])), 'OK');
  assert.equal(simpleText(await c.cmd(['SET', 'tx:w-k', 'wv'])), 'QUEUED');
  const exec = await c.cmd(['EXEC']);
  const replies = items(exec);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].kind, 'simple');
  assert.equal(replies[0].text, 'OK');
  assert.equal(bulkText(await c.cmd(['GET', 'tx:w-k'])), 'wv');
});

test('concurrent write by another client invalidates watch', async () => {
  const watcher = await newClient();
  const writer = await newClient();
  await writer.cmd(['SET', 'tx:c-k', 'first']);
  assert.equal(simpleText(await watcher.cmd(['WATCH', 'tx:c-k'])), 'OK');
  assert.equal(simpleText(await writer.cmd(['SET', 'tx:c-k', 'second'])), 'OK');
  assert.equal(simpleText(await watcher.cmd(['MULTI'])), 'OK');
  assert.equal(simpleText(await watcher.cmd(['SET', 'tx:c-k', 'mine'])), 'QUEUED');
  nilArrayReply(await watcher.cmd(['EXEC']));
  assert.equal(bulkText(await writer.cmd(['GET', 'tx:c-k'])), 'second');
});

test('expiry between watch and exec invalidates watch', async () => {
  const c = await newClient();
  await c.cmd(['DEL', 'tx:x-k']);
  assert.equal(simpleText(await c.cmd(['SET', 'tx:x-k', 'v'])), 'OK');
  assert.equal(intVal(await c.cmd(['PEXPIRE', 'tx:x-k', '150'])), 1);
  assert.equal(simpleText(await c.cmd(['WATCH', 'tx:x-k'])), 'OK');
  assert.ok(intVal(await c.cmd(['PTTL', 'tx:x-k'])) > 0, 'key must be alive when watched');
  await sleep(450);
  assert.equal(simpleText(await c.cmd(['MULTI'])), 'OK');
  assert.equal(simpleText(await c.cmd(['SET', 'tx:x-k', 'v2'])), 'QUEUED');
  nilArrayReply(await c.cmd(['EXEC']));
  nilBulk(await c.cmd(['GET', 'tx:x-k']));
});

test('unwatch clears watches so later writes do not invalidate exec', async () => {
  const watcher = await newClient();
  const writer = await newClient();
  await writer.cmd(['DEL', 'tx:n-k']);
  assert.equal(simpleText(await watcher.cmd(['WATCH', 'tx:n-k'])), 'OK');
  assert.equal(simpleText(await watcher.cmd(['UNWATCH'])), 'OK');
  assert.equal(simpleText(await writer.cmd(['SET', 'tx:n-k', 'other'])), 'OK');
  assert.equal(simpleText(await watcher.cmd(['MULTI'])), 'OK');
  assert.equal(simpleText(await watcher.cmd(['SET', 'tx:n-k', 'mine'])), 'QUEUED');
  const exec = await watcher.cmd(['EXEC']);
  const replies = items(exec);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].kind, 'simple');
  assert.equal(replies[0].text, 'OK');
  assert.equal(bulkText(await watcher.cmd(['GET', 'tx:n-k'])), 'mine');
});

test('creation of watched missing key invalidates watch', async () => {
  const watcher = await newClient();
  const writer = await newClient();
  await writer.cmd(['DEL', 'tx:m-k']);
  assert.equal(simpleText(await watcher.cmd(['WATCH', 'tx:m-k'])), 'OK');
  assert.equal(simpleText(await writer.cmd(['SET', 'tx:m-k', 'created'])), 'OK');
  assert.equal(simpleText(await watcher.cmd(['MULTI'])), 'OK');
  assert.equal(simpleText(await watcher.cmd(['SET', 'tx:m-k', 'mine'])), 'QUEUED');
  nilArrayReply(await watcher.cmd(['EXEC']));
  assert.equal(bulkText(await writer.cmd(['GET', 'tx:m-k'])), 'created');
});

test(
  'blpop inside multi rejected at queue time and exec aborted',
   async () => {
  const c = await newClient();
  await c.cmd(['DEL', 'tx:bl']);
  assert.equal(simpleText(await c.cmd(['MULTI'])), 'OK');
  expectError(await c.cmd(['BLPOP', 'tx:bl', '0.2']), 'ERR', 'queued command failed');
  const exec = await c.cmd(['EXEC']);
  expectError(exec, 'ERR', 'aborted');
});

test(
  'subscribe confirmations accumulate counts and gate normal commands',
   async () => {
  const sub = await newClient();
  checkSubscriptionConfirmation(await sub.cmd(['SUBSCRIBE', 'ps:one']), 'subscribe', 'ps:one', 1);
  checkSubscriptionConfirmation(await sub.cmd(['SUBSCRIBE', 'ps:two']), 'subscribe', 'ps:two', 2);
  const refused = await sub.cmd(['GET', 'ps:one']);
  assert.equal(refused.kind, 'error');
  assert.equal(refused.code, 'ERR');
  assert.match(refused.text, /GET/);
  assert.match(refused.text, /not allowed in subscriber mode/);
});

test(
  'publish reaches every exact subscriber and reports the count',
   async () => {
  const s1 = await newClient();
  const s2 = await newClient();
  const publisher = await newClient();
  checkSubscriptionConfirmation(await s1.cmd(['SUBSCRIBE', 'ps:news']), 'subscribe', 'ps:news', 1);
  checkSubscriptionConfirmation(await s2.cmd(['SUBSCRIBE', 'ps:news']), 'subscribe', 'ps:news', 1);
  const col1 = collectPushes(s1);
  const col2 = collectPushes(s2);
  assert.equal(intVal(await publisher.cmd(['PUBLISH', 'ps:news', 'hello'])), 2);
  const f1 = await col1.next(isDeliverFrame('message', 'ps:news', 'hello'), 500);
  const f2 = await col2.next(isDeliverFrame('message', 'ps:news', 'hello'), 500);
  assert.notEqual(f1, null, 'subscriber 1 did not receive the message within 500ms');
  assert.notEqual(f2, null, 'subscriber 2 did not receive the message within 500ms');
  col1.release();
  col2.release();
});

test(
  'psubscribe pattern delivery with silence for non-matching channels',
   async () => {
  const sub = await newClient();
  const publisher = await newClient();
  checkSubscriptionConfirmation(await sub.cmd(['PSUBSCRIBE', 'news.*']), 'psubscribe', 'news.*', 1);
  const col = collectPushes(sub);
  assert.equal(intVal(await publisher.cmd(['PUBLISH', 'news.sports', 'goal'])), 1);
  const frame = await col.next(isDeliverFrame('pmessage', 'news.sports', 'goal'), 500);
  assert.notEqual(frame, null, 'pmessage not delivered within 500ms');
  const parts = items(frame);
  assert.equal(bulkText(parts[1]), 'news.*');
  assert.equal(intVal(await publisher.cmd(['PUBLISH', 'weather.sunny', 'mild'])), 0);
  await expectNoPush(col, anyFrame, 400);
  col.release();
});

test(
  'overlapping exact and pattern subscriptions deliver two pushes for one publish',
   async () => {
  const dual = await newClient();
  const publisher = await newClient();
  checkSubscriptionConfirmation(await dual.cmd(['SUBSCRIBE', 'ps:dual.x']), 'subscribe', 'ps:dual.x', 1);
  checkSubscriptionConfirmation(
    await dual.cmd(['PSUBSCRIBE', 'ps:dual.*']),
    'psubscribe',
    'ps:dual.*',
    2,
  );
  const col = collectPushes(dual);
  const receivers = intVal(await publisher.cmd(['PUBLISH', 'ps:dual.x', 'ping']));
  assert.ok(receivers >= 1, `expected at least one receiver, got ${receivers}`);
  const first = await col.next(anyFrame, 500);
  const second = await col.next(anyFrame, 500);
  assert.notEqual(first, null, 'first push missing');
  assert.notEqual(second, null, 'pattern push missing');
  const kinds = [first, second].map((frame) => simpleText(items(frame)[0])).sort();
  assert.deepEqual(kinds, ['message', 'pmessage']);
  for (const frame of [first, second]) {
    const parts = items(frame);
    assert.equal(bulkText(parts[parts.length - 2]), 'ps:dual.x');
    assert.equal(bulkText(parts[parts.length - 1]), 'ping');
  }
  if (simpleText(items(first)[0]) === 'pmessage') {
    assert.equal(bulkText(items(first)[1]), 'ps:dual.*');
  } else {
    assert.equal(bulkText(items(second)[1]), 'ps:dual.*');
  }
  col.release();
});

test(
  'unsubscribe stops delivery and pubsub introspection stays sane',
   async () => {
  const sub = await newClient();
  const publisher = await newClient();
  checkSubscriptionConfirmation(await sub.cmd(['SUBSCRIBE', 'ps:u-ch']), 'subscribe', 'ps:u-ch', 1);
  const channelsWhile = items(await publisher.cmd(['PUBSUB', 'CHANNELS', 'ps:u-*']));
  assert.deepEqual(channelsWhile.map(bulkText), ['ps:u-ch']);
  const numsubWhile = items(await publisher.cmd(['PUBSUB', 'NUMSUB', 'ps:u-ch', 'ps:never']));
  assert.equal(bulkText(numsubWhile[0]), 'ps:u-ch');
  assert.equal(intVal(numsubWhile[1]), 1);
  assert.equal(bulkText(numsubWhile[2]), 'ps:never');
  assert.equal(intVal(numsubWhile[3]), 0);
  const patternsBefore = intVal(await publisher.cmd(['PUBSUB', 'NUMPAT']));
  checkSubscriptionConfirmation(
    await sub.cmd(['PSUBSCRIBE', 'ps:pat.*']),
    'psubscribe',
    'ps:pat.*',
    2,
  );
  assert.equal(intVal(await publisher.cmd(['PUBSUB', 'NUMPAT'])), patternsBefore + 1);
  const col = collectPushes(sub);
  checkSubscriptionConfirmation(await sub.cmd(['UNSUBSCRIBE', 'ps:u-ch']), 'unsubscribe', 'ps:u-ch', 1);
  assert.deepEqual(items(await publisher.cmd(['PUBSUB', 'CHANNELS', 'ps:u-*'])), []);
  assert.equal(intVal(await publisher.cmd(['PUBLISH', 'ps:u-ch', 'ghost'])), 0);
  await expectNoPush(col, anyFrame, 400);
  col.release();
  await sub.cmd(['PUNSUBSCRIBE', 'ps:pat.*']);
  assert.equal(intVal(await publisher.cmd(['PUBSUB', 'NUMPAT'])), patternsBefore);
});

test(
  'no cross-talk between channels',
   async () => {
  const sub = await newClient();
  const publisher = await newClient();
  checkSubscriptionConfirmation(await sub.cmd(['SUBSCRIBE', 'ps:x-a']), 'subscribe', 'ps:x-a', 1);
  const col = collectPushes(sub);
  assert.equal(intVal(await publisher.cmd(['PUBLISH', 'ps:x-b', 'noise'])), 0);
  await expectNoPush(col, anyFrame, 350);
  assert.equal(intVal(await publisher.cmd(['PUBLISH', 'ps:x-a', 'real'])), 1);
  const frame = await col.next(isDeliverFrame('message', 'ps:x-a', 'real'), 500);
  assert.notEqual(frame, null, 'positive-control message missing');
  col.release();
});

test(
  'reset exits subscriber mode and restores normal commands',
   async () => {
  const sub = await newClient();
  const publisher = await newClient();
  const col = collectPushes(sub);
  checkSubscriptionConfirmation(await sub.cmd(['SUBSCRIBE', 'ps:r-ch']), 'subscribe', 'ps:r-ch', 1);
  assert.equal(simpleText(await sub.cmd(['RESET'])), 'RESET');
  nilBulk(await sub.cmd(['GET', 'ps:r-ch']));
  assert.equal(simpleText(await sub.cmd(['SET', 'ps:r-k', 'v'])), 'OK');
  assert.equal(bulkText(await sub.cmd(['GET', 'ps:r-k'])), 'v');
  assert.equal(intVal(await publisher.cmd(['PUBLISH', 'ps:r-ch', 'late'])), 0);
  await expectNoPush(col, anyFrame, 350);
  col.release();
});

test('blpop returns immediately when the list already has data', async () => {
  const c = await newClient();
  await c.cmd(['DEL', 'bl:imm']);
  assert.equal(intVal(await c.cmd(['RPUSH', 'bl:imm', 'v1'])), 1);
  const reply = await c.cmd(['BLPOP', 'bl:imm', '0']);
  const pair = items(reply);
  assert.equal(pair.length, 2);
  assert.equal(bulkText(pair[0]), 'bl:imm');
  assert.equal(bulkText(pair[1]), 'v1');
});

test('blpop blocks then wakes on push from another client', async () => {
  const waiter = await newClient();
  const pusher = await newClient();
  await pusher.cmd(['DEL', 'bl:wake']);
  const pending = waiter.cmd(['BLPOP', 'bl:wake', '2']);
  await sleep(150);
  const started = Date.now();
  assert.equal(intVal(await pusher.cmd(['RPUSH', 'bl:wake', 'hi'])), 1);
  const reply = await pending;
  const pair = items(reply);
  assert.equal(pair.length, 2);
  assert.equal(bulkText(pair[0]), 'bl:wake');
  assert.equal(bulkText(pair[1]), 'hi');
  const waitedMs = Date.now() - started;
  assert.ok(waitedMs < 1900, `wake took too long: ${waitedMs}ms`);
});

test('blpop timeout path returns nil array no earlier than its deadline', async () => {
  const c = await newClient();
  await c.cmd(['DEL', 'bl:to']);
  const started = Date.now();
  nilArrayReply(await c.cmd(['BLPOP', 'bl:to', '0.2']));
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 180, `returned too early after ${elapsed}ms`);
  assert.ok(elapsed < 2000, `timeout took too long: ${elapsed}ms`);
});

test('brpop pops the tail and serves keys in argument order', async () => {
  const c = await newClient();
  await c.cmd(['DEL', 'bl:r', 'bl:m1', 'bl:m2']);
  assert.equal(intVal(await c.cmd(['RPUSH', 'bl:r', 'v1', 'v2'])), 2);
  let pair = items(await c.cmd(['BRPOP', 'bl:r', '0']));
  assert.equal(bulkText(pair[0]), 'bl:r');
  assert.equal(bulkText(pair[1]), 'v2');
  assert.equal(intVal(await c.cmd(['RPUSH', 'bl:m1', 'a'])), 1);
  assert.equal(intVal(await c.cmd(['RPUSH', 'bl:m2', 'b'])), 1);
  pair = items(await c.cmd(['BLPOP', 'bl:m1', 'bl:m2', '0']));
  assert.equal(bulkText(pair[0]), 'bl:m1');
  assert.equal(bulkText(pair[1]), 'a');
  pair = items(await c.cmd(['BLPOP', 'bl:m1', 'bl:m2', '0']));
  assert.equal(bulkText(pair[0]), 'bl:m2');
  assert.equal(bulkText(pair[1]), 'b');
});

test('fifo fairness wakes only the first waiter per push', async () => {
  const w1 = await newClient();
  const w2 = await newClient();
  const pusher = await newClient();
  await pusher.cmd(['DEL', 'bl:fair']);
  const p1 = w1.cmd(['BLPOP', 'bl:fair', '3']);
  await sleep(80);
  const p2 = w2.cmd(['BLPOP', 'bl:fair', '3']);
  await sleep(80);
  assert.equal(intVal(await pusher.cmd(['RPUSH', 'bl:fair', 'first'])), 1);
  const r1 = items(await p1);
  assert.equal(bulkText(r1[0]), 'bl:fair');
  assert.equal(bulkText(r1[1]), 'first');
  let secondResolved = false;
  p2.then(() => {
    secondResolved = true;
  }, () => {});
  await sleep(300);
  assert.equal(secondResolved, false, 'second waiter was woken by a push meant for the first');
  assert.equal(intVal(await pusher.cmd(['RPUSH', 'bl:fair', 'second'])), 1);
  const r2 = items(await p2);
  assert.equal(bulkText(r2[0]), 'bl:fair');
  assert.equal(bulkText(r2[1]), 'second');
});





