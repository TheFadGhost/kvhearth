import net from 'node:net';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_BIN = path.join(REPO_ROOT, 'bin', 'kvhearth.mjs');
const MAX_REPLY_BULK = 64 * 1024 * 1024;

const USAGE =
  'usage: node tools/crash-harness.mjs --dir-root <parentDir> [--rounds 25] [--fsync always|everysec|never]\n' +
  '                                   [--base-port 7790] [--kill-min-ms 200] [--kill-max-ms 2500] [--seed 1]';

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
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      throw new Error('unexpected argument: ' + a);
    }
    const key = a.slice(2);
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

function token(prng) {
  let s = '';
  for (let i = 0; i < 12; i++) s += '0123456789abcdef'[prng.range(16)];
  return s;
}

function describeFrame(f) {
  if (f.type === '*') {
    if (f.items === null) return '*-1';
    return '*' + f.items.length;
  }
  if (f.type === '$') {
    if (f.bytes === null) return '$-1';
    return '$' + f.bytes.length + ':' + JSON.stringify(f.bytes.toString('utf8').slice(0, 32));
  }
  return f.type + f.line.slice(0, 80);
}

function logTail(buf) {
  const text = buf.join('');
  const lines = text.split('\n').filter((l) => l.trim().length > 0);
  return lines.slice(-6).join(' | ').slice(0, 600);
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

class ReplyError extends Error {
  constructor(detail) {
    super(detail);
    this.detail = detail;
  }
}

class ReplyReader {
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
        throw new ReplyError('reply line exceeds limit');
      }
      return null;
    }
    let end = nl;
    if (end > this.off && this.buffer[end - 1] === 13) end--;
    const text = this.buffer.toString('utf8', this.off, end);
    this.off = nl + 1;
    return text;
  }
  #head() {
    const save = this.off;
    const text = this.#line(4096);
    if (text === null) return null;
    if (!/^-?\d+$/.test(text)) {
      this.off = save;
      throw new ReplyError('malformed length header');
    }
    return parseInt(text, 10);
  }
  #extract() {
    if (this.off >= this.buffer.length) return null;
    const t = String.fromCharCode(this.buffer[this.off]);
    if (t === '+' || t === '-' || t === ':') {
      this.off += 1;
      const line = this.#line(MAX_REPLY_BULK);
      if (line === null) {
        this.off -= 1;
        return null;
      }
      return { type: t, line };
    }
    if (t === '$') {
      const startOff = this.off;
      this.off += 1;
      const n = this.#head();
      if (n === null) {
        this.off = startOff;
        return null;
      }
      if (n === -1) return { type: '$', bytes: null };
      if (n < 0) throw new ReplyError('negative bulk length ' + n);
      if (n > MAX_REPLY_BULK) throw new ReplyError('bulk length exceeds limit');
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
      const n = this.#head();
      if (n === null) {
        this.off = startOff;
        return null;
      }
      if (n === -1) return { type: '*', items: null };
      if (n < 0) throw new ReplyError('negative array count ' + n);
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

async function waitReady(host, port, child, timeoutMs, tail) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        'server refused to start code=' +
          child.exitCode +
          ' signal=' +
          child.signalCode +
          (tail ? ' output: ' + tail : '')
      );
    }
    try {
      return await connect(host, port, 1000);
    } catch (err) {
      if (Date.now() > deadline) {
        throw new Error(
          'server not reachable within ' +
            timeoutMs +
            'ms (' +
            err.message +
            ')' +
            (tail ? ' output: ' + tail : '')
        );
      }
      await sleep(100);
    }
  }
}

function attachLogs(child, logBuf) {
  child.stdout.on('data', (d) => {
    logBuf.push(d.toString());
    if (logBuf.length > 400) logBuf.splice(0, logBuf.length - 400);
  });
  child.stderr.on('data', (d) => {
    logBuf.push(d.toString());
    if (logBuf.length > 400) logBuf.splice(0, logBuf.length - 400);
  });
}

async function stopHard(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGKILL');
  const deadline = Date.now() + 5000;
  while (
    child.exitCode === null &&
    child.signalCode === null &&
    Date.now() < deadline
  ) {
    await sleep(20);
  }
}

async function issue(reader, sock, args, timeoutMs) {
  sock.write(encTyped(args));
  return reader.readReply(timeoutMs);
}

async function main() {
  const argv = parseArgs(process.argv.slice(2));
  const cfg = {
    rounds: argv.rounds !== undefined ? parseInt(argv.rounds, 10) : 25,
    fsync: argv.fsync !== undefined ? argv.fsync : 'always',
    basePort: argv['base-port'] !== undefined ? parseInt(argv['base-port'], 10) : 7790,
    killMinMs: argv['kill-min-ms'] !== undefined ? parseInt(argv['kill-min-ms'], 10) : 200,
    killMaxMs: argv['kill-max-ms'] !== undefined ? parseInt(argv['kill-max-ms'], 10) : 2500,
    seed: argv.seed !== undefined ? parseInt(argv.seed, 10) : 1,
    root: argv['dir-root'],
  };
  if (!cfg.root) throw new Error('--dir-root is required');
  if (isNaN(cfg.rounds) || cfg.rounds < 1) throw new Error('--rounds must be >= 1');
  if (!['always', 'everysec', 'never'].includes(cfg.fsync)) {
    throw new Error('--fsync must be always, everysec or never');
  }
  if (isNaN(cfg.basePort) || cfg.basePort < 1 || cfg.basePort > 65535) {
    throw new Error('--base-port out of range');
  }
  if (
    isNaN(cfg.killMinMs) ||
    isNaN(cfg.killMaxMs) ||
    cfg.killMinMs < 0 ||
    cfg.killMaxMs < cfg.killMinMs
  ) {
    throw new Error('--kill-min-ms/--kill-max-ms invalid');
  }
  if (isNaN(cfg.seed)) throw new Error('--seed must be an integer');
  if (!fs.existsSync(SERVER_BIN)) {
    throw new Error('server binary not found at ' + SERVER_BIN);
  }

  const prng = new XorShift(cfg.seed);
  fs.mkdirSync(cfg.root, { recursive: true });

  const violations = [];
  let totalAcked = 0;
  let totalVerified = 0;

  for (let r = 0; r < cfg.rounds; r++) {
    const dir = path.join(cfg.root, 'crash-r' + r);
    const port = cfg.basePort + r;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      violations.push('round=' + r + ' cannot prepare data dir: ' + err.message);
      continue;
    }

    let child = null;
    let sock = null;
    let logBuf = [];
    const launch = () => {
      logBuf = [];
      const c = spawn(
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
      attachLogs(c, logBuf);
      c.on('error', (err) => {
        logBuf.push('spawn error: ' + err.message + '\n');
      });
      return c;
    };

    try {
      child = launch();
      sock = await waitReady('127.0.0.1', port, child, 10000, logTail(logBuf));
      let reader = new ReplyReader(sock);

      const pong = await issue(reader, sock, ['PING'], 5000);
      if (!(pong.type === '+' && pong.line === 'PONG')) {
        violations.push('round=' + r + ' PING handshake got ' + describeFrame(pong));
      }

      const latestSet = new Map();
      const setAcks = new Map();
      const latestHash = new Map();
      const hashAcks = new Map();
      const incrMin = new Map();
      const incrAcks = new Map();
      const listTokens = new Map();
      let ackedThisRound = 0;

      const killAt =
        Date.now() +
        cfg.killMinMs +
        prng.range(cfg.killMaxMs - cfg.killMinMs + 1);

      let stormBroken = false;
      for (;;) {
        const op = prng.range(4);
        let req;
        let check;
        if (op === 0) {
          const key = 'ck:' + prng.range(50);
          const tok = token(prng);
          req = ['SET', key, tok];
          check = { kind: 'set', key, tok };
        } else if (op === 1) {
          const key = 'ci:' + prng.range(30);
          req = ['INCR', key];
          check = { kind: 'incr', key };
        } else if (op === 2) {
          const key = 'ch:' + prng.range(20);
          const field = 'f:' + prng.range(10);
          const tok = token(prng);
          req = ['HSET', key, field, tok];
          check = { kind: 'hset', key, field, tok };
        } else {
          const key = 'cl:' + prng.range(20);
          const tok = token(prng);
          req = ['RPUSH', key, tok];
          check = { kind: 'rpush', key, tok };
        }

        let reply;
        try {
          reply = await issue(reader, sock, req, 5000);
        } catch (err) {
          violations.push(
            'round=' +
              r +
              ' storm interrupted waiting for ack (' +
              err.detail +
              ') after ' +
              ackedThisRound +
              ' acks'
          );
          stormBroken = true;
          break;
        }

        let ok = false;
        if (check.kind === 'set') ok = reply.type === '+' && reply.line === 'OK';
        else if (check.kind === 'incr')
          ok = reply.type === ':' && /^-?\d+$/.test(reply.line);
        else if (check.kind === 'hset')
          ok =
            reply.type === ':' &&
            /^-?\d+$/.test(reply.line) &&
            parseInt(reply.line, 10) >= 0;
        else ok = reply.type === ':' && parseInt(reply.line, 10) >= 1;

        if (!ok) {
          violations.push(
            'round=' +
              r +
              ' storm mutation rejected: ' +
              check.kind +
              ' replied ' +
              describeFrame(reply)
          );
          stormBroken = true;
          break;
        }

        ackedThisRound++;
        totalAcked++;
        if (check.kind === 'set') {
          latestSet.set(check.key, check.tok);
          setAcks.set(check.key, (setAcks.get(check.key) || 0) + 1);
        } else if (check.kind === 'incr') {
          const v = parseInt(reply.line, 10);
          incrMin.set(check.key, Math.max(v, incrMin.has(check.key) ? incrMin.get(check.key) : v));
          incrAcks.set(check.key, (incrAcks.get(check.key) || 0) + 1);
        } else if (check.kind === 'hset') {
          const mapKey = check.key + '|' + check.field;
          latestHash.set(mapKey, check.tok);
          hashAcks.set(mapKey, (hashAcks.get(mapKey) || 0) + 1);
        } else {
          if (!listTokens.has(check.key)) listTokens.set(check.key, []);
          listTokens.get(check.key).push(check.tok);
        }

        if (Date.now() >= killAt) break;
      }

      if (stormBroken && ackedThisRound === 0) {
        continue;
      }

      child.kill('SIGKILL');
      await stopHard(child);
      if (sock) {
        sock.destroy();
        sock = null;
      }

      child = launch();
      sock = await waitReady('127.0.0.1', port, child, 10000, logTail(logBuf));
      reader = new ReplyReader(sock);

      const durFail = (detail) => {
        console.log('DURABILITY VIOLATION: round=' + r + ' ' + detail);
        violations.push('round=' + r + ' durability: ' + detail);
      };

      for (const [key, tok] of latestSet) {
        let rep;
        try {
          rep = await issue(reader, sock, ['GET', key], 5000);
        } catch (err) {
          durFail('verify GET ' + key + ' failed: ' + err.detail);
          continue;
        }
        if (rep.type === '$' && rep.bytes !== null && rep.bytes.equals(Buffer.from(tok))) {
          totalVerified += setAcks.get(key) || 0;
        } else if (rep.type === '$' && rep.bytes === null) {
          durFail('acked SET lost: GET ' + key + ' returned nil, expected ' + tok);
        } else {
          durFail('acked SET wrong value: GET ' + key + ' got ' + describeFrame(rep));
        }
      }

      for (const [key, minVal] of incrMin) {
        let rep;
        try {
          rep = await issue(reader, sock, ['GET', key], 5000);
        } catch (err) {
          durFail('verify GET ' + key + ' failed: ' + err.detail);
          continue;
        }
        let v = null;
        if (rep.type === '$' && rep.bytes !== null && /^-?\d+$/.test(rep.bytes.toString())) {
          v = parseInt(rep.bytes.toString(), 10);
        } else if (rep.type === ':' && /^-?\d+$/.test(rep.line)) {
          v = parseInt(rep.line, 10);
        }
        if (v === null) {
          durFail(
            'acked INCR lost: GET ' + key + ' returned ' + describeFrame(rep)
          );
        } else if (v >= minVal) {
          totalVerified += incrAcks.get(key) || 0;
        } else {
          durFail(
            'acked INCR regressed: GET ' +
              key +
              '=' +
              v +
              ' below last acked ' +
              minVal
          );
        }
      }

      for (const [mapKey, tok] of latestHash) {
        const sep = mapKey.indexOf('|');
        const key = mapKey.slice(0, sep);
        const field = mapKey.slice(sep + 1);
        let rep;
        try {
          rep = await issue(reader, sock, ['HGET', key, field], 5000);
        } catch (err) {
          durFail('verify HGET ' + key + ' ' + field + ' failed: ' + err.detail);
          continue;
        }
        if (rep.type === '$' && rep.bytes !== null && rep.bytes.equals(Buffer.from(tok))) {
          totalVerified += hashAcks.get(mapKey) || 0;
        } else if (rep.type === '$' && rep.bytes === null) {
          durFail(
            'acked HSET lost: HGET ' + key + ' ' + field + ' nil, expected ' + tok
          );
        } else {
          durFail(
            'acked HSET wrong value: HGET ' +
              key +
              ' ' +
              field +
              ' got ' +
              describeFrame(rep)
          );
        }
      }

      for (const [key, toks] of listTokens) {
        let rep;
        try {
          rep = await issue(reader, sock, ['LRANGE', key, '0', '-1'], 30000);
        } catch (err) {
          durFail('verify LRANGE ' + key + ' failed: ' + err.detail);
          continue;
        }
        if (rep.type !== '*' || rep.items === null) {
          durFail('acked RPUSH unreadable: LRANGE ' + key + ' got ' + describeFrame(rep));
          continue;
        }
        const present = new Set(
          rep.items.filter((it) => it.type === '$' && it.bytes !== null).map((it) =>
            it.bytes.toString()
          )
        );
        let missing = 0;
        for (const tok of toks) {
          if (present.has(tok)) {
            totalVerified++;
          } else {
            missing++;
          }
        }
        if (missing > 0) {
          durFail(
            'acked RPUSH lost: LRANGE ' +
              key +
              ' missing ' +
              missing +
              ' of ' +
              toks.length +
              ' pushed tokens'
          );
        }
      }
    } catch (err) {
      violations.push('round=' + r + ' ' + err.message);
    } finally {
      if (sock) sock.destroy();
      await stopHard(child);
    }
  }

  if (violations.length === 0) {
    console.log(
      'CRASH-HARNESS OK rounds=' +
        cfg.rounds +
        ' fsync=' +
        cfg.fsync +
        ' acked=' +
        totalAcked +
        ' verified=' +
        totalVerified
    );
  } else {
    console.log(
      'CRASH-HARNESS FAIL rounds=' +
        cfg.rounds +
        ' fsync=' +
        cfg.fsync +
        ' violations=[' +
        violations.join('; ') +
        ']'
    );
    process.exitCode = 1;
  }

  if (cfg.fsync !== 'always') {
    process.stderr.write(
      'note: process-kill durability holds for every policy; power-loss guarantees differ per DESIGN 4.3\n'
    );
  }
}

main().catch((err) => {
  process.stderr.write('error: ' + err.message + '\n');
  process.stderr.write(USAGE + '\n');
  process.exitCode = 2;
});
