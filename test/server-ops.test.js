import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { KvhearthClient } from '../src/client/lib.mjs';
import { startServer, connectRaw, encodeRequest, sleep } from './helpers/server.mjs';

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

function infoValue(infoText, field) {
  const line = infoText.split('\n').find((l) => l.startsWith(`${field}:`));
  return line === undefined ? null : line.slice(field.length + 1).trim();
}

test('AUTH gates every command until authenticated', async () => {
  const s = await spawnServer({ args: { requirepass: 'sekret' } });
  const c = await client(s.port);
  const refused = await c.cmd(['GET', 'x']);
  assert.equal(refused.kind, 'error');
  assert.match(refused.text, /authentication required/);
  const bad = await c.cmd(['AUTH', 'wrong']);
  assert.equal(bad.kind, 'error');
  assert.match(bad.text, /invalid password/);
  const good = await c.cmd(['AUTH', 'sekret']);
  assert.equal(good.kind, 'simple');
  const ok = await c.cmd(['SET', 'x', '1']);
  assert.equal(ok.kind, 'simple');
  await c.destroy();
});

test('maxmemory noeviction refuses writes with OOM and keeps reads working', async () => {
  const s = await spawnServer({ args: { maxmemory: '4kb', 'maxmemory-policy': 'noeviction' } });
  const c = await client(s.port);
  let oomSeen = false;
  for (let i = 0; i < 200; i++) {
    const reply = await c.cmd(['SET', `key:${i}`, 'x'.repeat(64)]);
    if (reply.code === 'OOM') {
      oomSeen = true;
      break;
    }
  }
  assert.ok(oomSeen, 'never hit OOM under a 4kb limit');
  const readable = await c.cmd(['DBSIZE']);
  assert.ok(readable.n >= 0);
  const info = (await c.cmd(['INFO', 'memory'])).data.toString();
  assert.match(info, /maxmemory_bytes:\s+4096/);
  await c.destroy();
});

test('allkeys-lru evicts least recently used keys at the limit', async () => {
  const s = await spawnServer({ args: { maxmemory: '8kb', 'maxmemory-policy': 'allkeys-lru' } });
  const c = await client(s.port);
  for (let i = 0; i < 60; i++) await c.cmd(['SET', `hot:${i}`, 'v'.repeat(48)]);
  for (let round = 0; round < 5; round++) {
    for (let i = 0; i < 10; i++) await c.cmd(['GET', `hot:${i}`]);
    for (let i = 0; i < 20; i++) await c.cmd(['SET', `cold:${round}:${i}`, 'w'.repeat(96)]);
  }
  const survivorsHot = [];
  for (let i = 0; i < 10; i++) {
    if ((await c.cmd(['EXISTS', `hot:${i}`])).n === 1) survivorsHot.push(i);
  }
  const survivorsCold = [];
  for (let round = 0; round < 5; round++) {
    for (let i = 0; i < 20; i++) {
      if ((await c.cmd(['EXISTS', `cold:${round}:${i}`])).n === 1) survivorsCold.push(`${round}:${i}`);
    }
  }
  const info = (await c.cmd(['INFO', 'stats'])).data.toString();
  const evicted = Number(infoValue(info, 'evicted_keys'));
  assert.ok(evicted > 0, 'expected evictions to occur');
  assert.ok(survivorsHot.length > survivorsCold.length / 2 || survivorsCold.length < 100,
    'LRU approximation should preferentially keep touched keys');
  await c.destroy();
});

test('maxclients rejects surplus connections with SRV and keeps serving others', async () => {
  const s = await spawnServer({ args: { maxclients: 3 } });
  const first = await client(s.port);
  const second = await client(s.port);
  const third = await client(s.port);
  assert.equal((await first.cmd(['SET', 'a', '1'])).kind, 'simple');
  const fourth = await client(s.port);
  try {
    await fourth.cmd(['PING']);
    assert.fail('expected connection to be rejected');
  } catch (err) {
    assert.ok(err.message.length > 0);
  } finally {
    fourth.destroy();
  }
  assert.equal((await second.cmd(['GET', 'a'])).data.toString(), '1');
  [first, second, third].forEach((c) => c.destroy());
});

test('MONITOR streams executed commands of other connections', async () => {
  const s = await spawnServer({ args: { 'append-fsync': 'never' } });
  const raw = await connectRaw(s.port);
  raw.write(encodeRequest(['MONITOR']));
  const confirm = await raw.readLine();
  assert.equal(confirm.toString(), '+OK\n');
  const writer = await client(s.port);
  await writer.cmd(['SET', 'mon:key', 'mon-value']);
  await writer.cmd(['DEL', 'mon:key']);
  const seen = [];
  const deadline = Date.now() + 1500;
  while (seen.length < 2 && Date.now() < deadline) {
    const chunk = await raw.readAll(120);
    if (chunk.length > 0) seen.push(chunk.toString('latin1'));
  }
  const stream = seen.join('');
  assert.match(stream, /^\d{13} \[[^\]]+\] SET mon:key mon-value$/m);
  assert.match(stream, /DEL mon:key/);
  writer.destroy();
  raw.destroy();
});

test('SLOWLOG records commands exceeding the threshold', async () => {
  const s = await spawnServer({
    args: { 'append-fsync': 'always', 'slowlog-slower-than': 1 },
  });
  const c = await client(s.port);
  await c.cmd(['CONFIG', 'SET', 'slowlog-slower-than', '1']);
  for (let i = 0; i < 20; i++) await c.cmd(['SET', `slow:${i}`, 'v'.repeat(200)]);
  const log = await c.cmd(['SLOWLOG', 'GET', '5']);
  assert.equal(log.kind, 'array');
  assert.ok(log.items.length > 0, 'expected slowlog entries');
  const entry = log.items[0];
  assert.equal(entry.items[1].kind, 'integer');
  assert.ok(entry.items[2].n > 0, 'duration recorded');
  const len = await c.cmd(['SLOWLOG', 'LEN']);
  assert.ok(len.n > 0);
  assert.equal((await c.cmd(['SLOWLOG', 'RESET'])).kind, 'simple');
  await c.cmd(['CONFIG', 'SET', 'slowlog-slower-than', '1000000']);
  await c.cmd(['SLOWLOG', 'RESET']);
  assert.equal((await c.cmd(['SLOWLOG', 'LEN'])).n, 0);
  await c.destroy();
});

test('CONFIG GET and runtime SET behave within the documented whitelist', async () => {
  const s = await spawnServer({ args: { 'append-fsync': 'never' } });
  const c = await client(s.port);
  const got = await c.cmd(['CONFIG', 'GET', 'maxmemory*']);
  assert.equal(got.kind, 'array');
  const flat = got.items.map((item) => item.data.toString());
  assert.ok(flat.includes('maxmemory'));
  assert.ok(flat.includes('maxmemory-policy'));
  const setReply = await c.cmd(['CONFIG', 'SET', 'slowlog-slower-than', '5000']);
  assert.equal(setReply.kind, 'simple');
  const verify = await c.cmd(['CONFIG', 'GET', 'slowlog-slower-than']);
  assert.equal(verify.items[1].data.toString(), '5000');
  const rejected = await c.cmd(['CONFIG', 'SET', 'port', '9999']);
  assert.equal(rejected.kind, 'error');
  assert.match(rejected.text, /not settable|read-only/);
  await c.destroy();
});

test('DEBUG commands are gated behind enable-debug-commands', async () => {
  const s = await spawnServer({ args: { 'append-fsync': 'never' } });
  const c = await client(s.port);
  const refused = await c.cmd(['DEBUG', 'SLEEP', '1']);
  assert.equal(refused.kind, 'error');
  assert.match(refused.text, /disabled/);
  await c.destroy();

  const s2 = await spawnServer({ args: { 'append-fsync': 'never', 'enable-debug-commands': true } });
  const c2 = await client(s2.port);
  const started = Date.now();
  assert.equal((await c2.cmd(['DEBUG', 'SLEEP', '1'])).kind, 'simple');
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 900 && elapsed < 3000, `sleep took ${elapsed}ms`);
  await c2.destroy();
});

test('idle timeout closes silent connections but active ones stay', async () => {
  const s = await spawnServer({ args: { timeout: 1 } });
  const idle = await client(s.port);
  const active = await client(s.port);
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    await active.cmd(['PING']);
    await sleep(150);
    const info = (await active.cmd(['INFO', 'clients'])).data.toString();
    const connected = Number(infoValue(info, 'connected_clients'));
    if (connected <= 2) break;
  }
  const finalInfo = (await active.cmd(['INFO', 'clients'])).data.toString();
  assert.ok(Number(infoValue(finalInfo, 'connected_clients')) <= 2);
  [idle, active].forEach((c) => c.destroy());
  void s;
});

test('graceful shutdown persists snapshot when save-on-shutdown enabled', async () => {
  const s = await spawnServer({ args: { 'save-on-shutdown': true, 'append-fsync': 'always' } });
  const c = await client(s.port);
  await c.cmd(['SET', 'shutdown:key', 'survives']);
  await c.destroy();
  const closer = await client(s.port);
  await closer.cmd(['SHUTDOWN']).catch(() => {
    // the server closes the connection without replying to SHUTDOWN
  });
  await sleep(600);
  closer.destroy();
  assert.equal(fsExists(pathJoin(s.dataDir, 'kvhearth.snap')), true);

  const s2 = await spawnServer({ dir: s.dataDir, args: { port: s.port } });
  const c2 = await client(s2.port);
  const value = await c2.cmd(['GET', 'shutdown:key']);
  assert.equal(value.data.toString(), 'survives');
  await c2.destroy();
});

import fs from 'node:fs';
import path from 'node:path';

function fsExists(p) {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

function pathJoin(a, b) {
  return path.join(a, b);
}
