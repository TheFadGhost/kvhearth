import fs from 'node:fs';
import { encodeTypedRequest } from '../proto/serializer.mjs';
import { encodeEntryRecord } from './snapshot.mjs';
import { AOF_HEADER } from './aof.mjs';

const CHUNK_KEYS = 512;
const PENDING_ABORT_BYTES = 32 * 1024 * 1024;

export class AofRewriter {
  constructor({ store, aof, log, aofPath }) {
    this.store = store;
    this.aof = aof;
    this.log = log;
    this.aofPath = aofPath;
    this.running = false;
    this.fd = null;
    this.tmpPath = null;
    this.cursor = 0;
    this.serializedKeys = new Set();
    this.keysWritten = 0;
    this.startedAt = 0;
    this.timer = null;
  }

  start() {
    if (this.running) return { ok: false, reason: 'busy' };
    if (!this.aof.active) return { ok: false, reason: 'inactive' };
    this.running = true;
    this.startedAt = Date.now();
    this.cursor = 0;
    this.keysWritten = 0;
    this.serializedKeys.clear();
    this.tmpPath = `${this.aofPath}.rewrite`;
    try {
      this.fd = fs.openSync(this.tmpPath, 'w');
      fs.writeSync(this.fd, Buffer.from(`${AOF_HEADER}\n`, 'latin1'));
    } catch (err) {
      this.running = false;
      this.fd = null;
      throw err;
    }
    this.aof.beginRewrite();
    this.log.info('aof rewrite started', { file: this.aofPath });
    this.schedule();
    return { ok: true };
  }

  schedule() {
    this.timer = setTimeout(() => this.tick(), 0);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  pendingBytesEstimate() {
    let total = 0;
    for (const args of this.aof.rewriteBuffer ?? []) {
      total += 24;
      for (const arg of args) total += arg.length + 12;
    }
    return total;
  }

  tick() {
    if (!this.running) return;
    try {
      const { items, nextIndex } = this.store.iterateFrom(this.cursor, CHUNK_KEYS);
      const frames = [];
      for (const [key, entry] of items) {
        const record = encodeEntryRecord(key, entry, this.store.nowMs());
        frames.push(encodeTypedRequest(record));
        this.serializedKeys.add(key);
        this.keysWritten++;
      }
      if (frames.length > 0) fs.writeSync(this.fd, Buffer.concat(frames));
      const drained = this.drainPending();
      if (drained.aborted) return;
      if (nextIndex === 0) {
        this.finish();
        return;
      }
      this.cursor = nextIndex;
      this.schedule();
    } catch (err) {
      this.abort(`error during rewrite: ${err.code ?? err.message}`);
    }
  }

  drainPending() {
    const buffer = this.aof.rewriteBuffer;
    if (buffer === null || buffer.length === 0) return { aborted: false };
    if (this.pendingBytesEstimate() > PENDING_ABORT_BYTES) {
      this.abort('pending change buffer exceeded limit');
      return { aborted: true };
    }
    const frames = [];
    for (const args of buffer) {
      if (isFlushAll(args)) {
        this.restartFromScratch(args);
        return { aborted: false };
      }
      const key = keyOfRecord(args);
      if (key !== null && this.serializedKeys.has(key)) {
        frames.push(encodeTypedRequest(args));
      }
    }
    buffer.length = 0;
    if (frames.length > 0) fs.writeSync(this.fd, Buffer.concat(frames));
    return { aborted: false };
  }

  restartFromScratch(flushArgs) {
    const markerFrames = [encodeTypedRequest(flushArgs)];
    fs.writeSync(this.fd, Buffer.concat(markerFrames));
    this.serializedKeys.clear();
    this.keysWritten = 0;
    this.cursor = 0;
    this.log.warn('aof rewrite restarted due to FLUSHALL during rewrite');
  }

  finish() {
    const drained = this.drainPending();
    if (drained.aborted) return;
    try {
      fs.fsyncSync(this.fd);
      fs.closeSync(this.fd);
      this.fd = null;
      this.aof.cancelRewriteBuffer();
      this.aof.close();
      fs.renameSync(this.tmpPath, this.aofPath);
      this.aof.open();
      this.aof.dirtySinceFsync = false;
      this.running = false;
      this.log.info('aof rewrite finished', {
        keys: this.keysWritten,
        duration_ms: Date.now() - this.startedAt,
        bytes: this.aof.bytesOnDisk,
      });
    } catch (err) {
      this.abort(`finalization failed: ${err.code ?? err.message}`);
    }
  }

  abort(reason) {
    if (!this.running) return;
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
      } catch {}
      this.fd = null;
    }
    this.aof.cancelRewriteBuffer();
    try {
      fs.unlinkSync(this.tmpPath);
    } catch {}
    this.log.warn('aof rewrite aborted', { reason });
  }
}

function keyOfRecord(args) {
  if (args.length < 2) return null;
  return args[1];
}

function isFlushAll(args) {
  const verb = args[0].toString('latin1').toUpperCase();
  return verb === 'FLUSHALL' || verb === 'FLUSHDB';
}
