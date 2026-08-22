import net from 'node:net';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_BIN = path.join(REPO_ROOT, 'bin', 'kvhearth.mjs');
const MAX_REPLY_BULK = 64 * 1024 * 1024;
const MAX_REPLY_LINE = 1024 * 1024;
const MAX_ARRAY = 1000000;
const PING_WINDOW_MS = 5000;

const USAGE =
  'usage: node tools/live-fuzz.mjs --host H --port P [--seconds 20] [--seed 1]\n' +
  '       node tools/live-fuzz.mjs --spawn [--seconds 20] [--seed 1] [--append-fsync always|everysec|never]';

class XorShift {
  constructor(seed) {
    let s = seed >>> 0;
    if (s === 0) s = 0x9e3779b9;
    this.s = s;
  }
  next() {
    let s = this.s;
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    this.s = s;
    return s;
  }
  range(n) {
    return n <= 0 ? 0 : this.next() % n;
  }
  pick(arr) {
    return arr[this.range(arr.length)];
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      throw new Error('unexpected argument: ' + a);
    }
    const key = a.slice(2);
    if (key === 'spawn') {
      out.spawn = true;
      continue;
    }
    const val = argv[i + 1];
    if (val === undefined || val.startsWith('--')) {
      throw new Error('missing value for --' + key);
    }
    out[key] = val;
    i++;
  }
  return out;
}

function sleep(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

function connect(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port });
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error('connect timeout'));
    }, timeoutMs);
    sock.once('connect', () => {
      clearTimeout(timer);
      resolve(sock);
    });
    sock.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

class ReplyError extends Error {
  constructor(detail) {
    super(detail);
    this.detail = detail;
  }
}

class ReplyStream {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.off = 0;
    this.closed = false;
    this.waiter = null;
    socket.on('data', (chunk) => {
      this.buffer =
        this.buffer.length - this.off > 0
          ? Buffer.concat([this.buffer.subarray(this.off), chunk])
          : Buffer.concat([this.buffer, chunk]);
      this.off = 0;
      this.#wake();
    });
    socket.on('close', () => {
      this.closed = true;
      this.#wake();
    });
    socket.on('error', () => {});
  }
  #wake() {
    const w = this.waiter;
    if (w) {
      this.waiter = null;
      clearTimeout(w.timer);
      w.resolve();
    }
  }
  #wait(msLeft) {
    return new Promise((resolve, reject) => {
      const w = { resolve, timer: null };
      w.timer = setTimeout(() => {
        if (this.waiter === w) this.waiter = null;
        reject(new ReplyError('timeout'));
      }, msLeft);
      this.waiter = w;
    });
  }
  #line(limit) {
    const nl = this.buffer.indexOf(10, this.off);
    if (nl === -1) {
      if (this.buffer.length - this.off > limit) {
        throw new ReplyError('reply line exceeds ' + limit + ' bytes');
      }
      return null;
    }
    let end = nl;
    if (end > this.off && this.buffer[end - 1] === 13) end--;
    const text = this.buffer.toString('utf8', this.off, end);
    this.off = nl + 1;
    return text;
  }
  #extractHead() {
    const save = this.off;
    const text = this.#line(MAX_REPLY_LINE);
    if (text === null) return null;
    if (!/^-?\d+$/.test(text)) {
      this.off = save;
      throw new ReplyError('malformed length header: ' + JSON.stringify(text.slice(0, 40)));
    }
    return parseInt(text, 10);
  }
  #extract() {
    if (this.off >= this.buffer.length) return null;
    const t = String.fromCharCode(this.buffer[this.off]);
    if (t === '+' || t === '-' || t === ':') {
      this.off += 1;
      const line = this.#line(MAX_REPLY_LINE);
      if (line === null) {
        this.off -= 1;
        return null;
      }
      return { type: t, line };
    }
    if (t === '$') {
      const startOff = this.off;
      this.off += 1;
      const n = this.#extractHead();
      if (n === null) {
        this.off = startOff;
        return null;
      }
      if (n === -1) return { type: '$', bytes: null };
      if (n < 0) throw new ReplyError('negative bulk length ' + n);
      if (n > MAX_REPLY_BULK) throw new ReplyError('bulk length ' + n + ' exceeds limit');
      if (this.buffer.length - this.off < n + 1) return null;
      if (this.buffer[this.off + n] !== 10) {
        throw new ReplyError('bulk missing terminating LF');
      }
      const bytes = Buffer.from(this.buffer.subarray(this.off, this.off + n));
      this.off += n + 1;
      return { type: '$', bytes };
    }
    if (t === '*') {
      const startOff = this.off;
      this.off += 1;
      const n = this.#extractHead();
      if (n === null) {
        this.off = startOff;
        return null;
      }
      if (n === -1) return { type: '*', items: null };
      if (n < 0) throw new ReplyError('negative array count ' + n);
      if (n > MAX_ARRAY) throw new ReplyError('array count ' + n + ' exceeds limit');
      const items = [];
      for (let i = 0; i < n; i++) {
        const item = this.#extract();
        if (item === null) {
          this.off = startOff;
          return null;
        }
        items.push(item);
      }
      return { type: '*', items };
    }
    throw new ReplyError('unknown reply type byte 0x' + this.buffer[this.off].toString(16));
  }
  async readReply(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const frame = this.#extract();
      if (frame) return frame;
      if (this.off > 0) {
        this.buffer = this.buffer.subarray(this.off);
        this.off = 0;
      }
      const msLeft = deadline - Date.now();
      if (msLeft <= 0) throw new ReplyError('timeout');
      if (this.closed) throw new ReplyError('eof');
      await this.#wait(msLeft);
    }
  }
  async waitForClose(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (!this.closed) {
      const msLeft = deadline - Date.now();
      if (msLeft <= 0) throw new ReplyError('close-timeout');
      await this.#wait(msLeft);
    }
  }
}

function encTyped(args) {
  const parts = [Buffer.from('%' + args.length + '\n')];
  for (const a of args) {
    const b = Buffer.isBuffer(a) ? a : Buffer.from(a);
    parts.push(Buffer.from(b.length + ' '));
    parts.push(b);
    parts.push(Buffer.from('\n'));
  }
  return Buffer.concat(parts);
}

function inlineReq(text) {
  return Buffer.from(text + '\n');
}

function buildCorpus() {
  const binaryValue = Buffer.concat([
    Buffer.from('b'),
    Buffer.from([0]),
    Buffer.from('x'),
    Buffer.from([10]),
    Buffer.from('y'),
    Buffer.from([1]),
    Buffer.from('z'),
  ]);
  return [
    { name: 'inline-ping', data: inlineReq('PING') },
    { name: 'inline-set', data: inlineReq('SET fuzz:string alpha42') },
    { name: 'inline-set-quoted', data: inlineReq('SET fuzz:quoted "hello fuzz world"') },
    { name: 'inline-get', data: inlineReq('GET fuzz:string') },
    { name: 'inline-append', data: inlineReq('APPEND fuzz:string tail99') },
    { name: 'typed-ping', data: encTyped(['PING']) },
    { name: 'typed-set-binary', data: encTyped(['SET', 'fuzz:bin', binaryValue]) },
    { name: 'typed-hset', data: encTyped(['HSET', 'fuzz:hash', 'f1', 'v1']) },
    { name: 'typed-rpush', data: encTyped(['RPUSH', 'fuzz:list', 'a', 'b', 'c']) },
    { name: 'inline-lrange', data: inlineReq('LRANGE fuzz:list 0 -1') },
    { name: 'inline-hgetall', data: inlineReq('HGETALL fuzz:hash') },
    { name: 'inline-sadd', data: inlineReq('SADD fuzz:set m1 m2') },
    { name: 'inline-smembers', data: inlineReq('SMEMBERS fuzz:set') },
    { name: 'inline-zadd', data: inlineReq('ZADD fuzz:zset 1 one 2 two') },
    { name: 'inline-zrange', data: inlineReq('ZRANGE fuzz:zset 0 -1') },
    { name: 'inline-multi-exec', data: inlineReq('MULTI\nSET fuzz:tx held\nEXEC') },
    { name: 'inline-comment', data: inlineReq('# fuzz comment line') },
    { name: 'inline-subscribe', data: inlineReq('SUBSCRIBE fuzz:ch') },
    { name: 'inline-publish', data: inlineReq('PUBLISH fuzz:ch payload1') },
  ];
}

function randomBytesFrom(prng, n) {
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) b[i] = prng.range(256);
  return b;
}

function mutTruncate(buf, prng) {
  if (buf.length === 0) return buf;
  return Buffer.from(buf.subarray(0, prng.range(buf.length + 1)));
}

function mutPrematureEof(buf, prng) {
  if (buf.length < 2) return Buffer.alloc(0);
  return Buffer.from(buf.subarray(0, 1 + prng.range(buf.length - 1)));
}

function mutFlipBytes(buf, prng) {
  if (buf.length === 0) return buf;
  const out = Buffer.from(buf);
  const flips = 1 + prng.range(6);
  for (let i = 0; i < flips; i++) {
    const pos = prng.range(out.length);
    out[pos] = out[pos] ^ (1 + prng.range(255));
  }
  return out;
}

function mutSpliceGarbage(buf, prng) {
  const pos = prng.range(buf.length + 1);
  const junk = randomBytesFrom(prng, 1 + prng.range(64));
  return Buffer.concat([buf.subarray(0, pos), junk, buf.subarray(pos)]);
}

function mutHeaderCount(buf, prng) {
  void prng;
  if (buf.length > 1 && buf[0] === 0x25) {
    const nl = buf.indexOf(10);
    if (nl > 0) {
      return Buffer.concat([Buffer.from('%999999999999\n'), buf.subarray(nl + 1)]);
    }
  }
  return Buffer.concat([Buffer.from('%999999999999\n'), buf]);
}

function mutLengthField(buf, prng) {
  const s = buf.toString('latin1');
  const matches = [];
  const re = /(?:^|\n)(\d+)(?= )/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    matches.push({
      numStart: m.index + m[0].length - m[1].length,
      num: m[1],
    });
  }
  if (matches.length === 0) {
    return Buffer.concat([Buffer.from('%1\n999999999999 '), buf]);
  }
  const target = matches[prng.range(matches.length)];
  const choices = ['0', '-1', '1000000000000000'];
  const n = parseInt(target.num, 10);
  if (n > 1) {
    choices.push(String(n - 1), String(n + 1), String(n + 1 + prng.range(1000)));
  }
  const replacement = choices[prng.range(choices.length)];
  const mutated =
    s.slice(0, target.numStart) +
    replacement +
    s.slice(target.numStart + target.num.length);
  return Buffer.from(mutated, 'latin1');
}

function mutJunkBetweenFrames(buf, prng) {
  const nl = buf.indexOf(10);
  const pos = nl >= 0 && nl < buf.length ? nl + 1 : prng.range(buf.length + 1);
  const junk = randomBytesFrom(prng, 1 + prng.range(32));
  return Buffer.concat([buf.subarray(0, pos), junk, buf.subarray(pos)]);
}

function mutInterleave(a, b, prng) {
  const parts = [];
  let ia = 0;
  let ib = 0;
  let turn = 0;
  while (ia < a.length || ib < b.length) {
    const n = 1 + prng.range(16);
    if (turn % 2 === 0 && ia < a.length) {
      const take = Math.min(n, a.length - ia);
      parts.push(a.subarray(ia, ia + take));
      ia += take;
    } else if (ib < b.length) {
      const take = Math.min(n, b.length - ib);
      parts.push(b.subarray(ib, ib + take));
      ib += take;
    } else {
      const take = Math.min(n, a.length - ia);
      parts.push(a.subarray(ia, ia + take));
      ia += take;
    }
    turn++;
  }
  return Buffer.concat(parts);
}

function mutate(entry, corpus, prng) {
  const mutators = [
    mutTruncate,
    mutPrematureEof,
    mutFlipBytes,
    mutSpliceGarbage,
    mutHeaderCount,
    mutLengthField,
    mutJunkBetweenFrames,
  ];
  let buf = entry.data;
  const count = prng.range(10) < 3 ? 2 : 1;
  for (let i = 0; i < count; i++) {
    const fn = mutators[prng.range(mutators.length)];
    buf = fn(Buffer.from(buf), prng);
    if (buf.length > 4096) buf = buf.subarray(0, 4096);
  }
  if (prng.range(10) < 2) {
    const other = corpus[prng.range(corpus.length)];
    buf = mutInterleave(Buffer.from(buf), other.data, prng);
    if (buf.length > 4096) buf = buf.subarray(0, 4096);
  }
  return buf;
}

function splitPayload(buf, prng) {
  const chunks = [];
  let off = 0;
  while (off < buf.length) {
    let size = 1 + prng.range(Math.min(64, buf.length - off));
    if (prng.range(10) === 0) size = 1;
    chunks.push(buf.subarray(off, off + size));
    off += size;
  }
  if (chunks.length === 0) chunks.push(Buffer.alloc(0));
  return chunks;
}

function describeFrame(f) {
  if (f.type === '*') {
    if (f.items === null) return '*-1';
    return '*' + f.items.length + '[...]';
  }
  if (f.type === '$') {
    if (f.bytes === null) return '$-1';
    return '$' + f.bytes.length + ' bytes';
  }
  return f.type + f.line.slice(0, 80);
}

async function healthProbe(cfg) {
  let sock;
  try {
    sock = await connect(cfg.host, cfg.port, 3000);
  } catch (err) {
    return { ok: false, detail: 'health-probe connect failed: ' + err.message };
  }
  const stream = new ReplyStream(sock);
  try {
    sock.write('PING\n');
    const frame = await stream.readReply(2000);
    if (frame.type === '+' && frame.line === 'PONG') {
      return { ok: true, detail: '' };
    }
    if (frame.type === '-' && frame.line.startsWith('PROTO')) {
      await stream.waitForClose(2000).catch(() => {});
      return { ok: true, detail: '' };
    }
    return { ok: false, detail: 'health-probe got unexpected reply ' + describeFrame(frame) };
  } catch (err) {
    return { ok: false, detail: 'health-probe failed: ' + err.detail };
  } finally {
    sock.destroy();
  }
}

async function runIteration(iter, cfg, prng, corpus, state) {
  const entry = prng.pick(corpus);
  const useSeed = prng.range(4) === 0;
  let payload;
  let label;
  if (useSeed) {
    payload = Buffer.from(entry.data);
    label = 'seed:' + entry.name;
  } else {
    payload = mutate(entry, corpus, prng);
    label = 'mutant:' + entry.name;
  }

  let sock;
  try {
    sock = await connect(cfg.host, cfg.port, 5000);
  } catch (err) {
    if (state.childDead) return 'dead';
    return { kind: 'finding', detail: label + ' connect failed: ' + err.message };
  }
  const stream = new ReplyStream(sock);
  try {
    const chunks = splitPayload(payload, prng);
    for (let ci = 0; ci < chunks.length; ci++) {
      if (sock.destroyed || !sock.writable) break;
      sock.write(chunks[ci]);
      if (ci < 128 && prng.range(3) === 0) await sleep(prng.range(4));
    }
    if (!sock.destroyed && sock.writable) sock.write('PING\n');
    const pingDeadline = Date.now() + PING_WINDOW_MS;
    for (;;) {
      let frame;
      try {
        const msLeft = Math.max(pingDeadline - Date.now(), 100);
        frame = await stream.readReply(msLeft);
      } catch (err) {
        if (err.detail === 'timeout') {
          sock.destroy();
          const probe = await healthProbe(cfg);
          if (!probe.ok) {
            return {
              kind: 'finding',
              detail:
                label +
                ' no terminal reply to PING within ' +
                PING_WINDOW_MS +
                'ms and ' +
                probe.detail,
            };
          }
          return { kind: 'ok' };
        }
        if (err.detail === 'eof') {
          return { kind: 'ok' };
        }
        return { kind: 'finding', detail: label + ' malformed server reply: ' + err.detail };
      }
      if (frame.type === '+' && frame.line === 'PONG') {
        return { kind: 'ok' };
      }
      if (frame.type === '-' && frame.line.startsWith('PROTO')) {
        try {
          await stream.waitForClose(2000);
          return { kind: 'ok' };
        } catch (err) {
          return {
            kind: 'finding',
            detail: label + ' connection stayed open after -PROTO reply',
          };
        }
      }
    }
  } finally {
    sock.destroy();
  }
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

async function spawnServer(cfg, state) {
  const tmpRoot = path.join(REPO_ROOT, 'tmp');
  fs.mkdirSync(tmpRoot, { recursive: true });
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'live-fuzz-data-'));
  state.dataDir = dir;
  state.tmpRoot = tmpRoot;
  let port = 0;
  for (let attempt = 0; attempt < 5 && port === 0; attempt++) {
    try {
      port = await getFreePort();
    } catch (err) {
      port = 20000 + ((process.pid * 7919 + attempt * 104729) % 40000);
    }
  }
  const child = spawn(
    process.execPath,
    [
      SERVER_BIN,
      '--port',
      String(port),
      '--dir',
      dir,
      '--append-fsync',
      cfg.fsync,
      '--bind',
      '127.0.0.1',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  child.stdout.resume();
  child.stderr.on('data', (d) => {
    process.stderr.write('srv| ' + d.toString());
  });
  child.on('exit', (code, signal) => {
    state.childDead = { code, signal };
  });
  const deadline = Date.now() + 10000;
  for (;;) {
    if (state.childDead) {
      throw new Error(
        'server exited during startup code=' +
          state.childDead.code +
          ' signal=' +
          state.childDead.signal
      );
    }
    try {
      const sock = await connect('127.0.0.1', port, 1000);
      sock.destroy();
      cfg.host = '127.0.0.1';
      cfg.port = port;
      return child;
    } catch (err) {
      if (Date.now() > deadline) {
        throw new Error('server not reachable within 10s: ' + err.message);
      }
      await sleep(100);
    }
  }
}

async function gracefulShutdown(state) {
  let sock;
  try {
    sock = await connect(state.cfg.host, state.cfg.port, 3000);
  } catch (err) {
    state.findings++;
    console.log('FINDING: shutdown connect failed: ' + err.message);
    return;
  }
  const stream = new ReplyStream(sock);
  try {
    sock.write(encTyped(['FLUSHALL']));
    const flushReply = await stream.readReply(5000).catch(() => null);
    if (flushReply && flushReply.type === '-') {
      process.stderr.write('srv-note: FLUSHALL replied: ' + flushReply.line + '\n');
    }
    sock.write(encTyped(['SHUTDOWN', 'NOSAVE']));
    await stream.readReply(1000).catch(() => {});
    await stream.waitForClose(5000).catch(() => {
      state.findings++;
      console.log('FINDING: shutdown did not close connection');
      sock.destroy();
    });
    const exitDeadline = Date.now() + 5000;
    while (!state.childDead && Date.now() < exitDeadline) {
      await sleep(50);
    }
    if (!state.childDead) {
      state.findings++;
      console.log('FINDING: server did not exit after SHUTDOWN NOSAVE');
      state.child.kill('SIGKILL');
    }
  } finally {
    sock.destroy();
  }
}

async function main() {
  const argv = parseArgs(process.argv.slice(2));
  const cfg = {
    host: argv.host || '127.0.0.1',
    port: argv.port !== undefined ? parseInt(argv.port, 10) : 0,
    seconds: argv.seconds !== undefined ? parseFloat(argv.seconds) : 20,
    seed: argv.seed !== undefined ? parseInt(argv.seed, 10) : 1,
    fsync: argv['append-fsync'] !== undefined ? argv['append-fsync'] : 'always',
    spawn: !!argv.spawn,
  };
  if (isNaN(cfg.seconds) || cfg.seconds <= 0) throw new Error('--seconds must be positive');
  if (isNaN(cfg.seed)) throw new Error('--seed must be an integer');
  if (!['always', 'everysec', 'never'].includes(cfg.fsync)) {
    throw new Error('--append-fsync must be always, everysec or never');
  }
  if (!cfg.spawn) {
    if (!argv.port || isNaN(cfg.port)) throw new Error('--port is required without --spawn');
  } else if (!fs.existsSync(SERVER_BIN)) {
    throw new Error('server binary not found at ' + SERVER_BIN);
  }

  const prng = new XorShift(cfg.seed);
  const corpus = buildCorpus();
  const state = {
    findings: 0,
    iterations: 0,
    childDead: null,
    cfg,
    dataDir: null,
    tmpRoot: null,
  };

  let child = null;
  if (cfg.spawn) {
    child = await spawnServer(cfg, state);
    state.child = child;
    console.log('spawned pid=' + child.pid + ' port=' + cfg.port + ' dir=' + state.dataDir);
  }

  const deadline = Date.now() + cfg.seconds * 1000;
  let consecutiveConnectFails = 0;
  try {
    while (Date.now() < deadline && !state.childDead) {
      state.iterations++;
      const result = await runIteration(state.iterations, cfg, prng, corpus, state);
      if (result === 'dead') {
        state.findings++;
        console.log(
          'FINDING: iter=' +
            state.iterations +
            ' server process exited unexpectedly code=' +
            state.childDead.code +
            ' signal=' +
            state.childDead.signal
        );
        break;
      }
      if (result.kind === 'finding') {
        state.findings++;
        console.log('FINDING: iter=' + state.iterations + ' ' + result.detail);
        if (result.detail.includes('connect failed')) {
          consecutiveConnectFails++;
          if (consecutiveConnectFails >= 10) {
            console.log('stopping: endpoint unreachable after repeated connect failures');
            break;
          }
        } else {
          consecutiveConnectFails = 0;
        }
      }
    }
    if (cfg.spawn && !state.childDead) {
      await gracefulShutdown(state);
    } else if (cfg.spawn && state.childDead) {
      state.findings++;
      console.log('FINDING: skipped graceful shutdown because server already died');
    }
  } finally {
    if (child && !state.childDead) {
      child.kill('SIGKILL');
    }
    await sleep(100);
    if (state.dataDir) {
      try {
        fs.rmSync(state.dataDir, { recursive: true, force: true });
      } catch (err) {
        process.stderr.write('cleanup note: ' + err.message + '\n');
      }
    }
    if (state.tmpRoot) {
      try {
        fs.rmdirSync(state.tmpRoot);
      } catch (err) {
        void err;
      }
    }
  }

  if (state.findings > 0) {
    console.log(
      'LIVE-FUZZ FAIL iterations=' + state.iterations + ' findings=' + state.findings
    );
    process.exitCode = 1;
  } else {
    console.log('LIVE-FUZZ OK iterations=' + state.iterations + ' findings=0');
  }
}

main().catch((err) => {
  process.stderr.write('error: ' + err.message + '\n');
  process.stderr.write(USAGE + '\n');
  process.exitCode = 2;
});
