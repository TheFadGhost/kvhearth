import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, sleep } from './helpers/server.mjs';
import { KvhearthClient } from '../src/client/lib.mjs';

const SLOTS = 50;
const WORKERS = 8;

let coreServer = null;
let churnServer = null;
let expiryServer = null;

before(async () => {
  const args = { 'append-fsync': 'never' };
  coreServer = await startServer({ args });
  churnServer = await startServer({ args });
  expiryServer = await startServer({ args });
});

after(async () => {
  if (coreServer !== null) await coreServer.stopGracefully();
  if (churnServer !== null) await churnServer.stopGracefully();
  if (expiryServer !== null) await expiryServer.stopGracefully();
});

function latin(value) {
  return value.toString('latin1');
}

async function makeClient(port) {
  const client = new KvhearthClient({ port });
  client.on('error', () => {});
  await client.connect();
  return client;
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function freshEpoch() {
  return { pushes: new Map(), pops: new Map() };
}

function bump(map, item) {
  map.set(item, (map.get(item) ?? 0) + 1);
}

function multisetMinus(pushes, pops, key) {
  const out = new Map();
  for (const [item, count] of pushes) out.set(item, count);
  for (const [item, count] of pops) {
    const have = out.get(item) ?? 0;
    assert.ok(
      have >= count,
      `phantom pop on ${key}: ${count}x '${item}' popped but only ${have}x acked`,
    );
    out.set(item, have - count);
  }
  return out;
}

function multisetToSorted(items) {
  const flat = [];
  for (const [item, count] of items) {
    for (let i = 0; i < count; i++) flat.push(item);
  }
  return flat.sort();
}

function freshModel() {
  return {
    strs: new Map(),
    counters: new Map(),
    lists: new Map(),
    hashes: new Map(),
    sets: new Map(),
  };
}

const FAMILY_PREFIXES = ['str', 'counter', 'list', 'hash', 'set'];

function clearModelKey(model, prefix, slot) {
  const key = `${prefix}:${slot}`;
  model.strs.delete(key);
  model.counters.delete(key);
  model.lists.delete(key);
  model.hashes.delete(key);
  model.sets.delete(key);
}

async function stormRun(client, workerId, model, opsCount, rng) {
  for (let op = 0; op < opsCount; op++) {
    const tag = `w${workerId}-o${op}`;
    const roll = rng();
    const slot = Math.floor(rng() * SLOTS);
    if (roll < 0.22) {
      const key = `str:${slot}`;
      const value = `v:${tag}`;
      const reply = await client.cmd(['SET', key, value]);
      assert.equal(reply.kind, 'simple', `SET ${key} (${tag}) must answer OK`);
      assert.equal(reply.text, 'OK');
      const log = model.strs.get(key) ?? [];
      log.push(value);
      model.strs.set(key, log);
    } else if (roll < 0.42) {
      const key = `counter:${slot}`;
      const reply = await client.cmd(['INCR', key]);
      assert.equal(reply.kind, 'integer', `INCR ${key} (${tag}) must answer integer`);
      const values = model.counters.get(key) ?? [];
      values.push(reply.n);
      model.counters.set(key, values);
    } else if (roll < 0.58) {
      const key = `list:${slot}`;
      const item = `i:${tag}`;
      const reply = await client.cmd(['RPUSH', key, item]);
      assert.equal(reply.kind, 'integer', `RPUSH ${key} (${tag}) must answer integer`);
      assert.ok(reply.n >= 1, `RPUSH ${key} (${tag}) answered length ${reply.n}`);
      const epoch = model.lists.get(key) ?? freshEpoch();
      bump(epoch.pushes, item);
      model.lists.set(key, epoch);
    } else if (roll < 0.7) {
      const key = `list:${slot}`;
      const reply = await client.cmd(['LPOP', key]);
      assert.ok(
        reply.kind === 'bulk' || reply.kind === 'nil-bulk',
        `LPOP ${key} (w${workerId}-o${op}) answered ${reply.kind}`,
      );
      if (reply.kind === 'bulk') {
        const epoch = model.lists.get(key) ?? freshEpoch();
        bump(epoch.pops, latin(reply.data));
        model.lists.set(key, epoch);
      }
    } else if (roll < 0.82) {
      const key = `hash:${slot}`;
      const field = `f${workerId}:${Math.floor(rng() * 8)}`;
      const value = `h:${tag}`;
      const reply = await client.cmd(['HSET', key, field, value]);
      assert.equal(reply.kind, 'integer', `HSET ${key} (${tag}) must answer integer`);
      assert.ok(reply.n === 0 || reply.n === 1, `HSET ${key} (${tag}) answered ${reply.n}`);
      const map = model.hashes.get(key) ?? new Map();
      map.set(field, value);
      model.hashes.set(key, map);
    } else if (roll < 0.88) {
      const key = `hash:${slot}`;
      const field = `f${workerId}:${Math.floor(rng() * 8)}`;
      const reply = await client.cmd(['HDEL', key, field]);
      assert.equal(reply.kind, 'integer', `HDEL ${key} (${tag}) must answer integer`);
      const map = model.hashes.get(key);
      if (map !== undefined && map.has(field)) {
        map.delete(field);
        if (map.size === 0) model.hashes.delete(key);
      }
    } else if (roll < 0.96) {
      const key = `set:${slot}`;
      const member = `m${workerId}:${Math.floor(rng() * 16)}`;
      const reply = await client.cmd(['SADD', key, member]);
      assert.equal(reply.kind, 'integer', `SADD ${key} (${tag}) must answer integer`);
      assert.ok(reply.n === 0 || reply.n === 1, `SADD ${key} (${tag}) answered ${reply.n}`);
      const set = model.sets.get(key) ?? new Set();
      set.add(member);
      model.sets.set(key, set);
    } else {
      const key = `set:${slot}`;
      const member = `m${workerId}:${Math.floor(rng() * 16)}`;
      const reply = await client.cmd(['SREM', key, member]);
      assert.equal(reply.kind, 'integer', `SREM ${key} (${tag}) must answer integer`);
      const set = model.sets.get(key);
      if (set !== undefined && set.has(member)) {
        set.delete(member);
        if (set.size === 0) model.sets.delete(key);
      }
    }
  }
}

function validateCounterKey(key, values) {
  const sorted = [...values].sort((a, b) => a - b);
  for (let i = 0; i < sorted.length; i++) {
    assert.equal(
      sorted[i],
      i + 1,
      `zero-lost-update violation on ${key}: INCR replies were ${JSON.stringify(sorted)}`,
    );
  }
}

async function runListOrderProbe(client) {
  for (let slot = 0; slot < 8; slot++) {
    const key = `olist:${slot}`;
    const seq = ['a', 'b', 'c'];
    const pushReply = await client.cmd(['RPUSH', key, ...seq]);
    assert.equal(pushReply.kind, 'integer', `RPUSH ${key} must answer integer`);
    assert.equal(pushReply.n, 3, `RPUSH ${key} length must be 3`);
    let lrange = await client.cmd(['LRANGE', key, '0', '-1']);
    assert.deepEqual(
      lrange.items.map((item) => latin(item.data)),
      seq,
      `${key} LRANGE order mismatch after RPUSH`,
    );
    for (const expected of seq) {
      const pop = await client.cmd(['LPOP', key]);
      assert.equal(pop.kind, 'bulk', `LPOP ${key} must answer bulk`);
      assert.equal(latin(pop.data), expected, `LPOP ${key} FIFO order violated`);
    }
    const empty = await client.cmd(['LPOP', key]);
    assert.equal(empty.kind, 'nil-bulk', `LPOP ${key} on empty must answer nil-bulk`);
    const tail = await client.cmd(['RPUSH', key, 'z']);
    assert.equal(tail.n, 1, `RPUSH ${key} after drain must restart at length 1`);
    lrange = await client.cmd(['LRANGE', key, '0', '-1']);
    assert.deepEqual(
      lrange.items.map((item) => latin(item.data)),
      ['z'],
      `${key} LRANGE after recreate mismatch`,
    );
    const del = await client.cmd(['DEL', key]);
    assert.equal(del.n, 1, `DEL ${key} must remove existing list`);
  }
}

async function verifyExactState(client, model, checkStrings) {
  for (let slot = 0; slot < SLOTS; slot++) {
    const strKey = `str:${slot}`;
    const gotStr = await client.cmd(['GET', strKey]);
    if (checkStrings && model.strs.has(strKey)) {
      assert.equal(gotStr.kind, 'bulk', `${strKey} should exist`);
      assert.equal(latin(gotStr.data), model.strs.get(strKey), `${strKey} value mismatch`);
    }

    const counterKey = `counter:${slot}`;
    const gotCounter = await client.cmd(['GET', counterKey]);
    const counterLog = model.counters.get(counterKey);
    if (counterLog === undefined) {
      assert.equal(gotCounter.kind, 'nil-bulk', `${counterKey} should be absent`);
    } else {
      validateCounterKey(counterKey, counterLog);
      assert.equal(gotCounter.kind, 'bulk', `${counterKey} should exist`);
      assert.equal(
        Number(latin(gotCounter.data)),
        counterLog.length,
        `INCR total for ${counterKey}: server ${Number(latin(gotCounter.data))}, model ${counterLog.length}`,
      );
    }

    const listKey = `list:${slot}`;
    const gotList = await client.cmd(['LRANGE', listKey, '0', '-1']);
    assert.equal(gotList.kind, 'array', `LRANGE ${listKey} must answer array`);
    const actualItems = gotList.items.map((item) => latin(item.data));
    const epoch = model.lists.get(listKey);
    if (epoch === undefined) {
      assert.deepEqual(actualItems, [], `${listKey} should be empty`);
    } else {
      const expected = multisetToSorted(multisetMinus(epoch.pushes, epoch.pops, listKey));
      assert.deepEqual(
        [...actualItems].sort(),
        expected,
        `${listKey} content mismatch (acked pushes minus acked pops)`,
      );
      assert.equal(
        new Set(actualItems).size,
        actualItems.length,
        `${listKey} returned duplicate items`,
      );
    }

    const hashKey = `hash:${slot}`;
    const gotHash = await client.cmd(['HGETALL', hashKey]);
    assert.equal(gotHash.kind, 'array', `HGETALL ${hashKey} must answer array`);
    assert.equal(gotHash.items.length % 2, 0, `HGETALL ${hashKey} must be flat pairs`);
    const actualPairs = [];
    for (let i = 0; i < gotHash.items.length; i += 2) {
      actualPairs.push([latin(gotHash.items[i].data), latin(gotHash.items[i + 1].data)]);
    }
    actualPairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const expectedPairs = [...(model.hashes.get(hashKey) ?? new Map())];
    expectedPairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    assert.deepEqual(
      actualPairs,
      expectedPairs,
      `HGETALL ${hashKey} field/value mismatch`,
    );

    const setKey = `set:${slot}`;
    const gotSet = await client.cmd(['SMEMBERS', setKey]);
    assert.equal(gotSet.kind, 'array', `SMEMBERS ${setKey} must answer array`);
    const actualMembers = gotSet.items.map((item) => latin(item.data));
    const expectedMembers = [...(model.sets.get(setKey) ?? new Set())];
    actualMembers.sort();
    expectedMembers.sort();
    assert.deepEqual(actualMembers, expectedMembers, `SMEMBERS ${setKey} membership mismatch`);
    assert.equal(
      new Set(actualMembers).size,
      actualMembers.length,
      `SMEMBERS ${setKey} returned duplicate members`,
    );
  }
}

test('interleaved ops from 8 clients match sequential reference model', async () => {
  const model = freshModel();
  const clients = [];
  try {
    for (let w = 0; w < WORKERS; w++) clients.push(await makeClient(coreServer.port));

    const phase1Seeds = Array.from({ length: WORKERS }, (_, w) =>
      mulberry32((0x9e3779b9 ^ Math.imul(w + 1, 2654435761)) >>> 0),
    );
    await Promise.all(
      clients.map((client, w) => stormRun(client, w, model, 240, phase1Seeds[w])),
    );
    const verifier = await makeClient(coreServer.port);
    try {
      await verifyExactState(verifier, model, false);
      await runListOrderProbe(verifier);
    } finally {
      verifier.destroy();
    }

    const delSeeds = Array.from({ length: WORKERS }, (_, w) =>
      mulberry32((0x85ebca6b ^ Math.imul(w + 17, 40503)) >>> 0),
    );
    await Promise.all(
      clients.map(async (client, w) => {
        const rng = delSeeds[w];
        const family = w % FAMILY_PREFIXES.length;
        const delOne = async (slot) => {
          const key = `${FAMILY_PREFIXES[family]}:${slot}`;
          const reply = await client.cmd(['DEL', key]);
          assert.equal(reply.kind, 'integer', `DEL ${key} must answer integer`);
          assert.ok(reply.n === 0 || reply.n === 1, `DEL ${key} answered ${reply.n}`);
          if (reply.n === 1) clearModelKey(model, FAMILY_PREFIXES[family], slot);
        };
        for (let slot = 0; slot < SLOTS; slot++) await delOne(slot);
        for (let extra = 0; extra < 12; extra++) {
          await delOne(Math.floor(rng() * SLOTS));
        }
      }),
    );
    const wipeChecker = await makeClient(coreServer.port);
    try {
      for (let slot = 0; slot < SLOTS; slot++) {
        for (const prefix of FAMILY_PREFIXES) {
          const key = `${prefix}:${slot}`;
          const reply = await wipeChecker.cmd(['EXISTS', key]);
          assert.equal(reply.n, 0, `${key} must be gone after DEL storm`);
        }
      }
    } finally {
      wipeChecker.destroy();
    }

    const phase3Seeds = Array.from({ length: WORKERS }, (_, w) =>
      mulberry32((0xc2b2ae35 ^ Math.imul(w + 41, 668265263)) >>> 0),
    );
    const phase3Model = freshModel();
    await Promise.all(
      clients.map((client, w) => stormRun(client, w, phase3Model, 160, phase3Seeds[w])),
    );
    const verifier3 = await makeClient(coreServer.port);
    try {
      await verifyExactState(verifier3, phase3Model, false);
      for (let slot = 0; slot < SLOTS; slot++) {
        const key = `str:${slot}`;
        const sentinel = `sentinel:${slot}`;
        const setReply = await verifier3.cmd(['SET', key, sentinel]);
        assert.equal(setReply.kind, 'simple', `sentinel SET ${key} must answer OK`);
        phase3Model.strs.set(key, sentinel);
      }
      await verifyExactState(verifier3, phase3Model, true);
    } finally {
      verifier3.destroy();
    }
  } finally {
    for (const client of clients) client.destroy();
  }
});

async function casRunner(port, attempts) {
  const client = await makeClient(port);
  let commits = 0;
  try {
    for (let attempt = 0; attempt < attempts; attempt++) {
      await client.cmd(['WATCH', 'cas:c']);
      const current = await client.cmd(['GET', 'cas:c']);
      assert.ok(
        current.kind === 'bulk' || current.kind === 'nil-bulk',
        `GET cas:c answered unexpected kind ${current.kind}`,
      );
      const oldVal = current.kind === 'bulk' ? Number(latin(current.data)) : 0;
      await client.cmd(['MULTI']);
      await client.cmd(['SET', 'cas:c', String(oldVal + 1)]);
      const exec = await client.cmd(['EXEC']);
      assert.ok(
        exec.kind === 'array' || exec.kind === 'nil-array',
        `EXEC answered unexpected kind ${exec.kind}`,
      );
      if (exec.kind === 'array') commits += 1;
    }
  } finally {
    client.destroy();
  }
  return commits;
}

test('watch CAS contention under 6 clients loses no committed update', async () => {
  const ATTEMPTS = 200;
  const RIVALS = 6;
  const commitCounts = await Promise.all(
    Array.from({ length: RIVALS }, () => casRunner(coreServer.port, ATTEMPTS)),
  );
  const commits = commitCounts.reduce((sum, n) => sum + n, 0);
  assert.ok(commits > 0, 'at least one CAS transaction must have committed');
  const reader = await makeClient(coreServer.port);
  try {
    const final = await reader.cmd(['GET', 'cas:c']);
    assert.equal(final.kind, 'bulk', 'cas:c must exist after commits');
    assert.equal(
      Number(latin(final.data)),
      commits,
      `final value ${Number(latin(final.data))} != commits ${commits}: silent overwrite detected`,
    );
  } finally {
    reader.destroy();
  }
});

test('pipelined 500 echoes arrive strictly in submission order', async () => {
  const COUNT = 500;
  const client = await makeClient(coreServer.port);
  try {
    const cmds = [];
    for (let i = 0; i < COUNT; i++) cmds.push(['ECHO', `seq-${i}`]);
    const replies = await client.pipeline(cmds);
    assert.equal(replies.length, COUNT, 'pipeline must answer one reply per command');
    for (let i = 0; i < COUNT; i++) {
      const reply = replies[i];
      assert.equal(reply.kind, 'bulk', `reply ${i} must be bulk`);
      assert.equal(latin(reply.data), `seq-${i}`, `reply ${i} arrived out of order`);
    }
  } finally {
    client.destroy();
  }
});

async function readInfoNumber(client, section, field) {
  const reply = await client.cmd(['INFO', section]);
  assert.equal(reply.kind, 'bulk', `INFO ${section} must answer bulk`);
  const line = latin(reply.data).split('\n').find((text) => text.startsWith(`${field}:`));
  assert.ok(line !== undefined, `INFO ${section} must contain ${field}`);
  return Number(line.slice(field.length + 1).trim());
}

test('60 connection churns leave zero leaked clients', async () => {
  const ROUNDS = 60;
  for (let i = 0; i < ROUNDS; i++) {
    const client = await makeClient(churnServer.port);
    const setReply = await client.cmd(['SET', `churn:k${i}`, `v${i}`]);
    assert.equal(setReply.kind, 'simple', `SET churn:k${i} must answer OK`);
    const getReply = await client.cmd(['GET', `churn:k${i}`]);
    assert.equal(getReply.kind, 'bulk', `GET churn:k${i} must answer bulk`);
    assert.equal(latin(getReply.data), `v${i}`, `GET churn:k${i} value mismatch`);
    client.destroy();
  }
  const prober = await makeClient(churnServer.port);
  try {
    let reported = Number.MAX_SAFE_INTEGER;
    const deadline = Date.now() + 3000;
    for (;;) {
      reported = await readInfoNumber(prober, 'clients', 'connected_clients');
      if (reported <= 2 || Date.now() > deadline) break;
      await sleep(150);
    }
    assert.ok(reported <= 2, `connected_clients should settle <= 2, got ${reported}`);
  } finally {
    prober.destroy();
  }
});

async function createExpiringKeys(client, workerId, count) {
  for (let k = 0; k < count; k++) {
    const globalIndex = workerId * count + k;
    const ttlMs = 10 + (globalIndex % 30) * 10;
    const key = `exp:w${workerId}:k${k}`;
    const setReply = await client.cmd(['SET', key, `v${globalIndex}`]);
    assert.equal(setReply.kind, 'simple', `SET ${key} must answer OK`);
    const expireReply = await client.cmd(['PEXPIRE', key, String(ttlMs)]);
    assert.equal(expireReply.kind, 'integer', `PEXPIRE ${key} must answer integer`);
    assert.equal(expireReply.n, 1, `PEXPIRE ${key} must apply`);
  }
}

test('concurrent expiry storm drains dbsize to zero and bumps expired_keys', async () => {
  const WORKER_COUNT = 4;
  const PER_WORKER = 50;
  const clients = [];
  try {
    for (let w = 0; w < WORKER_COUNT; w++) clients.push(await makeClient(expiryServer.port));
    await Promise.all(clients.map((client, w) => createExpiringKeys(client, w, PER_WORKER)));

    let size = -1;
    const drainStart = Date.now();
    for (;;) {
      const reply = await clients[0].cmd(['DBSIZE']);
      assert.equal(reply.kind, 'integer', 'DBSIZE must answer integer');
      size = reply.n;
      if (size === 0 || Date.now() - drainStart > 3000) break;
      await sleep(100);
    }
    assert.equal(size, 0, `dbsize should reach 0 after staggered expiries, stuck at ${size}`);

    let expired = 0;
    const statDeadline = Date.now() + 2500;
    for (;;) {
      expired = await readInfoNumber(clients[0], 'stats', 'expired_keys');
      if (expired > 0 || Date.now() > statDeadline) break;
      await sleep(100);
    }
    assert.ok(expired > 0, `expired_keys should exceed 0, got ${expired}`);
  } finally {
    for (const client of clients) client.destroy();
  }
});
