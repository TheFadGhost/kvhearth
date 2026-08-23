import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function makeTempDir(label = 'kvtest') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  return dir;
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      srv.close(() => resolve(address.port));
    });
    srv.on('error', reject);
  });
}

export async function startServer(options = {}) {
  const port = options.port ?? (await freePort());
  const dataDir = options.dir ?? makeTempDir();
  const args = [path.join(root, 'bin', 'kvhearth.mjs'), '--port', String(port), '--dir', dataDir];
  for (const [key, value] of Object.entries(options.args ?? {})) {
    if (value === true) args.push(`--${key}`);
    else args.push(`--${key}`, String(value));
  }
  const proc = spawn(process.execPath, args, {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  let stdout = '';
  proc.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  proc.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });

  await waitForPort(port, options.readyTimeoutMs ?? 15000);

  return {
    port,
    dataDir,
    proc,
    getStderr: () => stderr,
    getStdout: () => stdout,
    killHard() {
      proc.kill('SIGKILL');
      return new Promise((resolve) => {
        proc.once('exit', resolve);
        setTimeout(resolve, 5000);
      });
    },
    stopGracefully() {
      proc.kill('SIGTERM');
      return new Promise((resolve) => {
        proc.once('exit', resolve);
        setTimeout(resolve, 10000);
      });
    },
  };
}

export async function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      await probe(port);
      return;
    } catch (err) {
      lastError = err;
      await sleep(120);
    }
  }
  throw new Error(`server did not become ready on port ${port}: ${lastError?.message ?? 'timeout'}`);
}

function probe(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => {
      socket.destroy();
      resolve();
    });
    socket.once('error', reject);
  });
}

export async function connectRaw(port) {
  const socket = net.connect(port, '127.0.0.1');
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  const chunks = [];
  let waiter = null;
  socket.on('data', (chunk) => {
    chunks.push(chunk);
    if (waiter !== null) {
      const w = waiter;
      waiter = null;
      w();
    }
  });
  const closed = new Promise((resolve) => socket.once('close', resolve));
  return {
    socket,
    closed,
    write(data) {
      socket.write(data);
    },
    async readBytes(count, timeoutMs = 3000) {
      const deadline = Date.now() + timeoutMs;
      while (Buffer.concat(chunks).length < count) {
        if (Date.now() > deadline) throw new Error(`read timeout waiting for ${count} bytes`);
        await new Promise((resolve) => {
          waiter = resolve;
          setTimeout(resolve, timeoutMs);
        });
      }
      const all = Buffer.concat(chunks);
      const out = all.subarray(0, count);
      chunks.length = 0;
      if (all.length > count) chunks.push(all.subarray(count));
      return out;
    },
    async readLine(timeoutMs = 3000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const all = Buffer.concat(chunks);
        const newlineAt = all.indexOf(0x0a);
        if (newlineAt !== -1) {
          const line = all.subarray(0, newlineAt + 1);
          chunks.length = 0;
          if (all.length > newlineAt + 1) chunks.push(all.subarray(newlineAt + 1));
          return line;
        }
        if (Date.now() > deadline) throw new Error('read line timeout');
        await new Promise((resolve) => {
          waiter = resolve;
          setTimeout(resolve, Math.min(timeoutMs, 200));
        });
      }
    },
    async readAll(timeoutMs = 1500) {
      const deadline = Date.now() + timeoutMs;
      let lastSize = -1;
      while (Date.now() < deadline) {
        const size = Buffer.concat(chunks).length;
        if (size === lastSize && size > 0) break;
        lastSize = size;
        await sleep(Math.min(80, Math.max(deadline - Date.now(), 1)));
      }
      const out = Buffer.concat(chunks);
      chunks.length = 0;
      return out;
    },
    end() {
      socket.end();
    },
    destroy() {
      socket.destroy();
    },
  };
}

export function encodeRequest(args) {
  const records = args.map((arg) => {
    const buffer = Buffer.isBuffer(arg) ? arg : Buffer.from(String(arg), 'latin1');
    return `${buffer.length} ${buffer.toString('latin1')}\n`;
  }).join('');
  return `%${args.length}\n${records}`;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
