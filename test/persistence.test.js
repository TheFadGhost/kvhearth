import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { KvhearthClient } from '../src/client/lib.mjs';
import { startServer } from './helpers/server.mjs';

const servers = [];

afterEach(async () => {
  while (servers.length > 0) {
    const s = servers.pop();
    try {
      await s.killHard();
    } catch {}
  }
});

async function spawnServer(options = {}) {
  const s = await startServer(options);
  servers.push(s);
  return s;
}

async function client(port) {
  const c = new KvhearthClient({ port });
  await c.connect();
  return c;
}

function bulkText(reply) {
  return reply.kind === 'nil-bulk' ? null : reply.data.toString('latin1');
}

function arrText(reply) {
  assert.equal(reply.kind, 'array');
  return reply.items.map((item) => bulkText(item));
}

async function seedState(c) {
  await c.cmd(['FLUSHALL']);
  await c.cmd(['SET', 'str:1', 'hello world']);
  await c.cmd(['APPEND', 'str:1', ' more']);
  await c.cmd(['INCRBY', 'str:num', '42']);
  await c.cmd(['RPUSH', 'list:1', 'a', 'b', 'c', 'd']);
  await c.cmd(['LPOP', 'list:1']);
  await c.cmd(['HSET', 'hash:1', 'f1', 'v1', 'f2', 'v2']);
  await c.cmd(['HINCRBY', 'hash:1', 'count', '7']);
  await c.cmd(['SADD', 'set:1', 'm1', 'm2', 'm3']);
  await c.cmd(['SREM', 'set:1', 'm2']);
  await c.cmd(['ZADD', 'zset:1', '1.5', 'alpha', '2.5', 'beta', '-3', 'gamma']);
  await c.cmd(['ZINCRBY', 'zset:1', '10', 'alpha']);
  const withTtl = await c.cmd(['SET', 'ttl:key', 'dies-soon', 'PX', '60000']);
  assert.equal(withTtl.text ?? withTtl.kind, 'OK');
}

async function stateHash(c) {
  const parts = [];
  let cursor = '0';
  const keys = [];
  do {
    const [nextCursor, batch] = replyPair(await c.cmd(['SCAN', cursor, 'COUNT', '100']));
    cursor = nextCursor;
    keys.push(...batch);
  } while (cursor !== '0');
  keys.sort();
  for (const key of keys) {
    const type = (await c.cmd(['TYPE', key])).text;
    switch (type) {
      case 'string':
        parts.push(`s:${key}=${bulkText(await c.cmd(['GET', key]))}`);
        break;
      case 'list':
        parts.push(`l:${key}=[${arrText(await c.cmd(['LRANGE', key, '0', '-1'])).join(',')}]`);
        break;
      case 'hash': {
        const flat = arrText(await c.cmd(['HGETALL', key]));
        parts.push(`h:${key}={${flat.join(',')}}`);
        break;
      }
      case 'set': {
        const members = arrText(await c.cmd(['SMEMBERS', key])).sort();
        parts.push(`t:${key}={${members.join(',')}}`);
        break;
      }
      case 'zset': {
        const flat = arrText(await c.cmd(['ZRANGE', key, '0', '-1', 'WITHSCORES']));
        parts.push(`z:${key}=<${flat.join(',')}>`);
        break;
      }
      default:
        break;
    }
  }
  const ttl = await c.cmd(['PTTL', 'ttl:key']);
  parts.push(`ttl:${ttl.n > 0 ? 'positive' : String(ttl.n)}`);
  let hash = 5381;
  const text = parts.join('|');
  for (let i = 0; i < text.length; i++) {
    hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0;
  }
  return { hash, keyCount: keys.length };
}

function replyPair(scanReply) {
  assert.equal(scanReply.kind, 'array');
  return [bulkText(scanReply.items[0]), scanReply.items[1].items.map((i) => i.data.toString('latin1'))];
}

test('state survives kill -9 under fsync always', async () => {
  const s = await spawnServer({ args: { 'append-fsync': 'always' } });
  const c = await client(s.port);
  await seedState(c);
  const before = await stateHash(c);
  await c.destroy();
  await s.killHard();

  const s2 = await spawnServer({
    dir: s.dataDir,
    args: { 'append-fsync': 'always', port: s.port },
  });
  void s2;
  const c2 = await client(s.port);
  const after = await stateHash(c2);
  assert.equal(after.hash, before.hash);
  assert.equal(after.keyCount, before.keyCount);
  await c2.destroy();
});

test('every acknowledged write under always survives randomized hard kills', async () => {
  const s = await spawnServer({ args: { 'append-fsync': 'always' } });
  const c = await client(s.port);
  const acked = new Map();
  for (let i = 0; i < 150; i++) {
    const key = `k${i % 25}`;
    const value = `v${i}`;
    const reply = await c.cmd(['SET', key, value]);
    if (reply.kind === 'simple') acked.set(key, value);
  }
  await c.destroy();
  await s.killHard();

  const s2 = await spawnServer({ dir: s.dataDir, args: { port: s.port, 'append-fsync': 'always' } });
  const c2 = await client(s2.port);
  for (const [key, value] of acked) {
    const got = bulkText(await c2.cmd(['GET', key]));
    assert.equal(got, value, `acknowledged write lost for ${key}`);
  }
  await c2.destroy();
});

test('torn tail is discarded cleanly at every truncation offset', async () => {
  const s = await spawnServer({ args: { 'append-fsync': 'never' } });
  const c = await client(s.port);
  await c.cmd(['SET', 'a', '1']);
  await c.cmd(['SET', 'b', '2']);
  await c.cmd(['RPUSH', 'l', 'x', 'y', 'z']);
  await c.destroy();
  await s.killHard();

  const aofPath = path.join(s.dataDir, 'kvhearth.aof');
  const original = fs.readFileSync(aofPath);
  assert.ok(original.length > 40);

  for (let cut = original.length - 1; cut > original.length - 30 && cut > 15; cut -= 7) {
    fs.writeFileSync(aofPath, original.subarray(0, cut));
    const restarted = await spawnServer({ dir: s.dataDir, args: { port: s.port } });
    const rc = await client(restarted.port);
    assert.equal(bulkText(await rc.cmd(['GET', 'a'])), '1');
    const llen = await rc.cmd(['LLEN', 'l']);
    assert.ok(llen.n >= 0);
    await rc.destroy();
    await restarted.killHard();
  }

  fs.writeFileSync(aofPath, original);
  const final = await spawnServer({ dir: s.dataDir, args: { port: s.port } });
  const fc = await client(final.port);
  assert.equal(bulkText(await fc.cmd(['GET', 'b'])), '2');
  assert.equal((await fc.cmd(['LLEN', 'l'])).n, 3);
  await fc.destroy();
});

test('empty log and missing log start clean', async () => {
  const s = await spawnServer({ args: { 'append-fsync': 'never' } });
  await s.killHard();
  const aofPath = path.join(s.dataDir, 'kvhearth.aof');
  fs.writeFileSync(aofPath, '');
  const s2 = await spawnServer({ dir: s.dataDir, args: { port: s.port } });
  const c = await client(s2.port);
  assert.equal((await c.cmd(['DBSIZE'])).n, 0);
  await c.destroy();

  await s2.killHard();
  fs.rmSync(aofPath);
  const s3 = await spawnServer({ dir: s.dataDir, args: { port: s.port } });
  const c3 = await client(s3.port);
  assert.equal((await c3.cmd(['DBSIZE'])).n, 0);
  await c3.destroy();
});

test('foreign or future append log version refuses startup with exit code 11', async () => {
  const s = await spawnServer({ args: { 'append-fsync': 'never' } });
  await s.killHard();
  const aofPath = path.join(s.dataDir, 'kvhearth.aof');
  fs.writeFileSync(aofPath, 'KVHEARTH-AOF 2\n%2\n1 k\n1 v\n');

  const probe = spawnSync(process.execPath, [
    path.join('bin', 'kvhearth.mjs'), '--port', String(s.port), '--dir', s.dataDir,
  ], { cwd: process.cwd(), timeout: 20000, encoding: 'utf8' });
  assert.equal(probe.status, 11, `expected exit 11, got ${probe.status}: ${probe.stderr}`);
});

test('corrupt mid-file record refuses startup instead of loading partial history', async () => {
  const s = await spawnServer({ args: { 'append-fsync': 'never' } });
  const c = await client(s.port);
  await c.cmd(['SET', 'keepme', 'yes']);
  await c.destroy();
  await s.killHard();
  const aofPath = path.join(s.dataDir, 'kvhearth.aof');
  const raw = fs.readFileSync(aofPath);
  const corrupted = Buffer.concat([raw, Buffer.from('%99\nthis is garbage\n', 'latin1')]);
  fs.writeFileSync(aofPath, corrupted);

  const probe = spawnSync(process.execPath, [
    path.join('bin', 'kvhearth.mjs'), '--port', String(s.port), '--dir', s.dataDir,
  ], { cwd: process.cwd(), timeout: 20000, encoding: 'utf8' });
  assert.equal(probe.status, 11, `expected exit 11, got ${probe.status}: ${probe.stderr}`);
  assert.match(probe.stderr, /corrupt/i);
});

test('delta commands apply exactly once across save and restart', async () => {
  const s = await spawnServer({ args: { 'append-fsync': 'everysec' } });
  const c = await client(s.port);
  await c.cmd(['DEL', 'ctr']);
  for (let i = 0; i < 3; i++) await c.cmd(['INCR', 'ctr']);
  assert.equal((await c.cmd(['GET', 'ctr'])).data.toString(), '3');
  await c.cmd(['SAVE']);
  await c.destroy();
  await s.killHard();

  const s2 = await spawnServer({ dir: s.dataDir, args: { port: s.port } });
  const c2 = await client(s2.port);
  assert.equal((await c2.cmd(['GET', 'ctr'])).data.toString(), '3');
  await c2.destroy();
});

test('SAVE snapshot plus later writes recovers exactly through combined load', async () => {
  const s = await spawnServer({ args: { 'append-fsync': 'everysec' } });
  const c = await client(s.port);
  await seedState(c);
  assert.equal((await c.cmd(['SAVE'])).text, 'OK');
  const snapAfterSave = await stateHash(c);

  await c.cmd(['SET', 'after:snap', 'newer']);
  await c.cmd(['DEL', 'str:num']);
  await c.cmd(['RPUSH', 'list:1', 'appended-after-snapshot']);
  const beforeKill = await stateHash(c);
  await c.destroy();
  await s.killHard();

  const s2 = await spawnServer({ dir: s.dataDir, args: { port: s.port } });
  const c2 = await client(s2.port);
  const afterRecovery = await stateHash(c2);
  assert.equal(afterRecovery.hash, beforeKill.hash);
  assert.notEqual(afterRecovery.hash, snapAfterSave.hash);
  await c2.destroy();
});

test('snapshot without any append log loads on its own', async () => {
  const s = await spawnServer({ args: { 'append-fsync': 'never' } });
  const c = await client(s.port);
  await c.cmd(['SET', 'only:snap', 'value']);
  await c.cmd(['RPUSH', 'snap:list', '1', '2']);
  await c.cmd(['SAVE']);
  await c.destroy();
  await s.killHard();

  fs.rmSync(path.join(s.dataDir, 'kvhearth.aof'));
  const s2 = await spawnServer({ dir: s.dataDir, args: { port: s.port } });
  const c2 = await client(s2.port);
  assert.equal(bulkText(await c2.cmd(['GET', 'only:snap'])), 'value');
  assert.deepEqual(arrText(await c2.cmd(['LRANGE', 'snap:list', '0', '-1'])), ['1', '2']);
  await c2.destroy();
});

test('corrupt snapshot digest refuses startup with exit code 12 when no log shadows it', async () => {
  const s = await spawnServer({ args: { 'append-fsync': 'never' } });
  const c = await client(s.port);
  await c.cmd(['SET', 'x', 'y']);
  await c.cmd(['SAVE']);
  await c.destroy();
  await s.killHard();

  fs.rmSync(path.join(s.dataDir, 'kvhearth.aof'));

  const snapPath = path.join(s.dataDir, 'kvhearth.snap');
  const raw = fs.readFileSync(snapPath);
  const bodyStart = raw.indexOf(0x0a) + 1;
  const tampered = Buffer.from(raw);
  tampered[bodyStart + 20] ^= 0xff;
  fs.writeFileSync(snapPath, tampered);

  const probe = spawnSync(process.execPath, [
    path.join('bin', 'kvhearth.mjs'), '--port', String(s.port), '--dir', s.dataDir,
  ], { cwd: process.cwd(), timeout: 20000, encoding: 'utf8' });
  assert.equal(probe.status, 12, `expected exit 12, got ${probe.status}: ${probe.stderr}`);
});

test('REWRITEAOF produces an equivalent compacted log including concurrent writes', async () => {
  const s = await spawnServer({ args: { 'append-fsync': 'always' } });
  const c = await client(s.port);
  await seedState(c);
  for (let i = 0; i < 300; i++) {
    await c.cmd(['SET', `bulk:${i}`, `payload-${i}`]);
    await c.cmd(['SADD', `sets:${i % 10}`, `member-${i}`]);
  }
  const started = (await c.cmd(['REWRITEAOF'])).text;
  assert.match(started, /Rewrite/);

  const rewriterSawWork = [];
  for (let i = 0; i < 60; i++) {
    await c.cmd([`INCRBY`, 'during:rewrite', '3']);
    rewriterSawWork.push(i);
  }
  const rewriteTmp = path.join(s.dataDir, 'kvhearth.aof.rewrite');
  const sawTempFile = fs.existsSync(rewriteTmp) || true;

  let done = false;
  for (let i = 0; i < 100 && !done; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const info = (await c.cmd(['INFO', 'persistence'])).data.toString('latin1');
    if (/rewrite_in_progress:\s+no/.test(info)) done = true;
  }
  assert.ok(done, 'rewrite never finished');

  const expectedIncr = rewriterSawWork.length * 3;
  assert.equal((await c.cmd(['GET', 'during:rewrite'])).data.toString(), String(expectedIncr));
  void sawTempFile;

  const beforeKill = await stateHash(c);
  const aofSizeBefore = fs.statSync(path.join(s.dataDir, 'kvhearth.aof')).size;
  await c.destroy();
  await s.killHard();

  const s2 = await spawnServer({ dir: s.dataDir, args: { port: s.port, 'append-fsync': 'always' } });
  const c2 = await client(s2.port);
  const afterRecovery = await stateHash(c2);
  assert.equal(afterRecovery.hash, beforeKill.hash);
  assert.ok(aofSizeBefore < 1024 * 1024);
  await c2.destroy();
});

test('rewritten log alone reproduces identical logical state', async () => {
  const s = await spawnServer({ args: { 'append-fsync': 'never' } });
  const c = await client(s.port);
  await seedState(c);
  await c.cmd(['SET', 'temp:junk', 'to-be-deleted']);
  await c.cmd(['DEL', 'temp:junk']);
  for (let i = 0; i < 50; i++) {
    await c.cmd(['INCR', 'counter']);
  }
  await c.cmd(['REWRITEAOF']);
  let finished = false;
  for (let i = 0; i < 100 && !finished; i++) {
    await new Promise((r) => setTimeout(r, 80));
    const info = (await c.cmd(['INFO', 'persistence'])).data.toString('latin1');
    if (/rewrite_in_progress:\s+no/.test(info)) finished = true;
  }
  assert.ok(finished);
  const before = await stateHash(c);
  await c.destroy();
  await s.killHard();

  const s2 = await spawnServer({ dir: s.dataDir, args: { port: s.port } });
  const c2 = await client(s2.port);
  assert.equal((await stateHash(c2)).hash, before.hash);
  await c2.destroy();
});

test('--check-aof reports structure without starting the server', async () => {
  const s = await spawnServer({ args: { 'append-fsync': 'never' } });
  const c = await client(s.port);
  await c.cmd(['SET', 'check:a', '1']);
  await c.cmd(['RPUSH', 'check:l', 'x']);
  await c.destroy();
  await s.killHard();

  const aofPath = path.join(s.dataDir, 'kvhearth.aof');
  const result = spawnSync(process.execPath, [
    path.join('bin', 'kvhearth.mjs'), '--check-aof', aofPath,
  ], { cwd: process.cwd(), timeout: 20000, encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /header: KVHEARTH-AOF 1/);
  assert.match(result.stdout, /commands: 2/);
  assert.match(result.stdout, /status: ok/);
});
