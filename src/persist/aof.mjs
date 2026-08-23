import fs from 'node:fs';
import { encodeTypedRequest } from '../proto/serializer.mjs';

export const AOF_HEADER = 'KVHEARTH-AOF 1';
export const AOF_MAGIC = 'KVHEARTH-AOF ';
export const AOF_VERSION = 1;

export class PersistenceError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

export class AppendLog {
  constructor({ filePath, fsyncPolicy, log }) {
    this.filePath = filePath;
    this.fsyncPolicy = fsyncPolicy;
    this.log = log;
    this.fd = null;
    this.bytesOnDisk = 0;
    this.dirtySinceFsync = false;
    this.rewriteBuffer = null;
    this.degraded = false;
  }

  open() {
    let existed = false;
    let size = 0;
    try {
      const stat = fs.statSync(this.filePath);
      existed = true;
      size = stat.size;
    } catch {
      existed = false;
    }
    if (!existed || size === 0) {
      this.fd = fs.openSync(this.filePath, 'a');
      fs.writeSync(this.fd, Buffer.from(`${AOF_HEADER}\n`, 'latin1'));
      fs.fsyncSync(this.fd);
      this.bytesOnDisk = AOF_HEADER.length + 1;
      return { replayableBytes: 0 };
    }
    const raw = fs.readFileSync(this.filePath);
    const newlineAt = raw.indexOf(0x0a);
    if (newlineAt === -1) {
      throw new PersistenceError(`append log '${this.filePath}' has no readable header`, 11);
    }
    const header = raw.toString('latin1', 0, newlineAt).trim();
    if (header !== AOF_HEADER) {
      if (header.startsWith(AOF_MAGIC)) {
        const foundVersion = Number(header.slice(AOF_MAGIC.length));
        throw new PersistenceError(
          `append log version mismatch in '${this.filePath}': found ${foundVersion}, supported ${AOF_VERSION}`,
          11,
        );
      }
      throw new PersistenceError(`append log '${this.filePath}' has unrecognized header`, 11);
    }
    this.fd = fs.openSync(this.filePath, 'a');
    this.bytesOnDisk = size;
    return { replayableBytes: size - newlineAt - 1 };
  }

  get active() {
    return this.fd !== null;
  }

  appendRecord(args) {
    return this.appendBatch([args]);
  }

  appendBatch(batchArgs) {
    if (this.fd === null) throw new PersistenceError('append log is not open', 11);
    const frames = [];
    let total = 0;
    for (const args of batchArgs) {
      const frame = encodeTypedRequest(args);
      frames.push(frame);
      total += frame.length;
    }
    const payload = Buffer.concat(frames);
    try {
      fs.writeSync(this.fd, payload);
    } catch (err) {
      this.degraded = true;
      throw new PersistenceError(`append write failed: ${err.code ?? err.message}`, 13);
    }
    this.bytesOnDisk += payload.length;
    if (this.rewriteBuffer !== null) {
      for (const args of batchArgs) this.rewriteBuffer.push(args);
      if (this.rewriteBufferSize > REWRITE_ABORT_BYTES) {
        return { status: 'rewrite-overflow' };
      }
    }
    if (this.fsyncPolicy === 'always') {
      try {
        fs.fsyncSync(this.fd);
      } catch (err) {
        this.degraded = true;
        throw new PersistenceError(`fsync failed: ${err.code ?? err.message}`, 13);
      }
    } else {
      this.dirtySinceFsync = true;
    }
    return { status: 'ok' };
  }

  get rewriteBufferSize() {
    if (this.rewriteBuffer === null) return 0;
    let size = 0;
    for (const args of this.rewriteBuffer) {
      size += 32;
      for (const arg of args) size += arg.length + 12;
    }
    return size;
  }

  beginRewrite() {
    this.rewriteBuffer = [];
  }

  takeRewriteBuffer() {
    const buffer = this.rewriteBuffer;
    this.rewriteBuffer = null;
    return buffer;
  }

  cancelRewriteBuffer() {
    this.rewriteBuffer = null;
  }

  flushPeriodic() {
    if (this.fd === null || !this.dirtySinceFsync) return true;
    try {
      fs.fsyncSync(this.fd);
      this.dirtySinceFsync = false;
      return true;
    } catch (err) {
      this.degraded = true;
      this.log.error('fsync failed during periodic flush', { error: err.code ?? String(err), file: this.filePath });
      return false;
    }
  }

  close() {
    if (this.fd === null) return;
    if (this.dirtySinceFsync) this.flushPeriodic();
    try {
      fs.closeSync(this.fd);
    } finally {
      this.fd = null;
    }
  }
}

const REWRITE_ABORT_BYTES = 32 * 1024 * 1024;

export class NullAppendLog {
  constructor() {
    this.filePath = null;
    this.fsyncPolicy = 'never';
    this.fd = null;
    this.bytesOnDisk = 0;
    this.dirtySinceFsync = false;
    this.rewriteBuffer = null;
    this.degraded = false;
  }

  get active() {
    return false;
  }

  open() {
    return { replayableBytes: 0 };
  }

  appendRecord() {
    return { status: 'ok' };
  }

  appendBatch() {
    return { status: 'ok' };
  }

  beginRewrite() {}

  takeRewriteBuffer() {
    return [];
  }

  cancelRewriteBuffer() {
    this.rewriteBuffer = null;
  }

  get rewriteBufferSize() {
    return 0;
  }

  flushPeriodic() {
    return true;
  }

  close() {}
}
