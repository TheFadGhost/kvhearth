import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  startServer,
  connectRaw,
  encodeRequest,
  sleep,
} from './helpers/server.mjs';

let server;

before(async () => {
  server = await startServer({ args: { 'append-fsync': 'never' } });
});

after(async () => {
  await server.killHard();
});

function latin(buf) {
  return buf.toString('latin1');
}

function typedFrame(args) {
  const parts = [Buffer.from(`%${args.length}\n`)];
  for (const arg of args) {
    const bytes = Buffer.isBuffer(arg) ? arg : Buffer.from(arg, 'latin1');
    parts.push(Buffer.from(`${bytes.length} `, 'latin1'));
    parts.push(bytes);
    parts.push(Buffer.from('\n', 'latin1'));
  }
  return Buffer.concat(parts);
}

async function readReply(raw) {
  const head = await raw.readLine();
  const marker = String.fromCharCode(head[0]);
  if (marker === '$') {
    const len = Number(latin(head.subarray(1)).trim());
    if (len === -1) return head;
    const body = await raw.readBytes(len + 1);
    return Buffer.concat([head, body]);
  }
  if (marker === '*') {
    const n = Number(latin(head.subarray(1)).trim());
    if (n === -1) return head;
    const parts = [head];
    for (let i = 0; i < n; i++) {
      parts.push(await readReply(raw));
    }
    return Buffer.concat(parts);
  }
  return head;
}

async function expectClosed(raw, label) {
  const outcome = await Promise.race([
    raw.closed.then(() => 'closed'),
    sleep(3000).then(() => 'timeout'),
  ]);
  assert.equal(outcome, 'closed', label ?? 'connection should have closed');
}

test('inline form request gets simple reply', async () => {
  const raw = await connectRaw(server.port);
  try {
    raw.write('PING\n');
    assert.equal(latin(await readReply(raw)), '+PONG\n');
  } finally {
    raw.destroy();
  }
});

test('inline quoted argument carries spaces', async () => {
  const raw = await connectRaw(server.port);
  try {
    raw.write('SET gk "hello world"\n');
    assert.equal(latin(await readReply(raw)), '+OK\n');
    raw.write('GET gk\n');
    assert.equal(latin(await readReply(raw)), '$11\nhello world\n');
  } finally {
    raw.destroy();
  }
});

test('comment lines and blank lines produce no reply', async () => {
  const raw = await connectRaw(server.port);
  try {
    raw.write('# annotated netcat session\n\nPING\n');
    assert.equal(latin(await readReply(raw)), '+PONG\n');
    const extra = await raw.readAll(250);
    assert.equal(extra.length, 0, `expected silence, got ${latin(extra)}`);
    raw.write('PING\n');
    assert.equal(latin(await readReply(raw)), '+PONG\n');
  } finally {
    raw.destroy();
  }
});

test('CRLF line endings accepted on inline and typed frames', async () => {
  const raw = await connectRaw(server.port);
  try {
    raw.write('PING\r\n');
    assert.equal(latin(await readReply(raw)), '+PONG\n');
    raw.write(Buffer.from('%2\r\n4 ECHO\r\n2 hi\r\n'));
    assert.equal(latin(await readReply(raw)), '$2\nhi\n');
    raw.write('SET crlfk ok\r\nGET crlfk\r\n');
    assert.equal(latin(await readReply(raw)), '+OK\n');
    assert.equal(latin(await readReply(raw)), '$2\nok\n');
  } finally {
    raw.destroy();
  }
});

test('typed form round-trips binary key and value byte-identically', async () => {
  const raw = await connectRaw(server.port);
  try {
    const key = Buffer.from([0x62, 0x0a, 0x0d, 0x00]);
    const value = Buffer.from([0x76, 0x00, 0x0a, 0x0d, 0x21, 0xff]);
    raw.write(typedFrame(['SET', key, value]));
    assert.equal(latin(await readReply(raw)), '+OK\n');
    raw.write(typedFrame(['GET', key]));
    const head = await raw.readLine();
    assert.equal(latin(head), `$${value.length}\n`);
    const body = await raw.readBytes(value.length + 1);
    assert.deepEqual([...body], [...value, 0x0a]);
  } finally {
    raw.destroy();
  }
});

test('byte-by-byte delivery reassembles typed request', async () => {
  const raw = await connectRaw(server.port);
  try {
    raw.write(typedFrame(['SET', 'bbk', 'bv']));
    assert.equal(latin(await readReply(raw)), '+OK\n');
    const frame = Buffer.from(encodeRequest(['GET', 'bbk']), 'latin1');
    for (const byte of frame) {
      raw.write(Buffer.from([byte]));
      await sleep(5);
    }
    assert.equal(latin(await readReply(raw)), '$2\nbv\n');
  } finally {
    raw.destroy();
  }
});

test('request split mid-length-prefix parses once complete', async () => {
  const raw = await connectRaw(server.port);
  try {
    raw.write('%3\n3 SE');
    await sleep(40);
    raw.write('T\n3 spk\n5 hello\n');
    assert.equal(latin(await readReply(raw)), '+OK\n');
    raw.write('GET spk\n');
    assert.equal(latin(await readReply(raw)), '$5\nhello\n');
  } finally {
    raw.destroy();
  }
});

test('two pipelined commands in one write answer in order', async () => {
  const raw = await connectRaw(server.port);
  try {
    const batch = Buffer.concat([
      Buffer.from(encodeRequest(['PING']), 'latin1'),
      Buffer.from(encodeRequest(['ECHO', 'pip']), 'latin1'),
    ]);
    raw.write(batch);
    assert.equal(latin(await readReply(raw)), '+PONG\n');
    assert.equal(latin(await readReply(raw)), '$3\npip\n');
  } finally {
    raw.destroy();
  }
});

test('oversized declared bulk length yields PROTO reply then close', async () => {
  const raw = await connectRaw(server.port);
  try {
    raw.write('%2\n999999999999 x\nAAAA\n');
    const reply = latin(await readReply(raw));
    assert.ok(reply.startsWith('-PROTO '), `expected PROTO error, got ${reply}`);
    assert.ok(reply.includes('max-bulk'), `PROTO message should name the limit: ${reply}`);
    await expectClosed(raw);
  } finally {
    raw.destroy();
  }
});

test('new connection works after a PROTO close', async () => {
  const killer = await connectRaw(server.port);
  killer.write('%1\n99999999999 x\nA\n');
  const reply = latin(await readReply(killer));
  assert.ok(reply.startsWith('-PROTO '));
  await expectClosed(killer);
  killer.destroy();

  const fresh = await connectRaw(server.port);
  try {
    fresh.write('PING\n');
    assert.equal(latin(await readReply(fresh)), '+PONG\n');
  } finally {
    fresh.destroy();
  }
});

test('unknown command error shape is exact', async () => {
  const raw = await connectRaw(server.port);
  try {
    raw.write('whatever\n');
    assert.equal(latin(await readReply(raw)), `-ERR unknown command 'whatever'\n`);
  } finally {
    raw.destroy();
  }
});

test('arity error message shape is exact', async () => {
  const raw = await connectRaw(server.port);
  try {
    raw.write('GET\n');
    assert.equal(
      latin(await readReply(raw)),
      '-ERR GET wrong number of arguments (expected 1, got 0)\n',
    );
  } finally {
    raw.destroy();
  }
});

test('proto-max-args exceeded yields PROTO reply then close', async () => {
  let strictServer = null;
  let raw = null;
  try {
    strictServer = await startServer({
      args: { 'append-fsync': 'never', 'proto-max-args': '4' },
    });
    raw = await connectRaw(strictServer.port);
    raw.write('%5\n1 a\n1 b\n1 c\n1 d\n1 e\n');
    const reply = latin(await readReply(raw));
    assert.ok(reply.startsWith('-PROTO '), `expected PROTO error, got ${reply}`);
    assert.ok(reply.includes('max-args'), `PROTO message should name the limit: ${reply}`);
    await expectClosed(raw);

    const retry = await connectRaw(strictServer.port);
    try {
      retry.write('PING\n');
      assert.equal(latin(await readReply(retry)), '+PONG\n');
    } finally {
      retry.destroy();
    }
  } finally {
    if (raw !== null) raw.destroy();
    if (strictServer !== null) await strictServer.killHard();
  }
});
