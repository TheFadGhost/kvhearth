import fs from 'node:fs';
import crypto from 'node:crypto';
import { encodeTypedRequest } from '../proto/serializer.mjs';
import { encodeEntryRecord, SNAP_HEADER } from './snapshot.mjs';

const CHUNK_KEYS = 512;

export class SnapshotWriter {
  constructor({ store, log, snapPath }) {
    this.store = store;
    this.log = log;
    this.snapPath = snapPath;
    this.running = false;
    this.fd = null;
    this.tmpPath = null;
    this.cursor = 0;
    this.keysWritten = 0;
    this.startedAtMs = 0;
    this.timer = null;
  }

  start() {
    if (this.running) return { ok: false, reason: 'busy' };
    this.running = true;
    this.startedAtMs = Date.now();
    this.cursor = 0;
    this.keysWritten = 0;
    this.tmpPath = `${this.snapPath}.tmp`;
    try {
      this.fd = fs.openSync(this.tmpPath, 'w');
      fs.writeSync(this.fd, Buffer.from(`${SNAP_HEADER}\n`, 'latin1'));
    } catch (err) {
      this.running = false;
      this.fd = null;
      throw err;
    }
    this.log.info('background snapshot started', { file: this.snapPath });
    this.schedule();
    return { ok: true };
  }

  schedule() {
    this.timer = setTimeout(() => this.tick(), 0);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  tick() {
    if (!this.running) return;
    try {
      const page = this.store.iterateFrom(this.cursor, CHUNK_KEYS);
      const frames = [];
      for (const [key, entry] of page.items) {
        frames.push(encodeTypedRequest(encodeEntryRecord(key, entry, this.store.nowMs())));
        this.keysWritten += 1;
      }
      if (frames.length > 0) fs.writeSync(this.fd, Buffer.concat(frames));
      if (page.nextIndex === 0) {
        this.finish();
        return;
      }
      this.cursor = page.nextIndex;
      this.schedule();
    } catch (err) {
      this.abort(`snapshot failed mid-write: ${err.code ?? err.message}`);
    }
  }

  finish() {
    try {
      const raw = fs.readFileSync(this.tmpPath);
      const bodyStart = SNAP_HEADER.length + 1;
      const digest = crypto.createHash('sha256').update(raw.subarray(bodyStart)).digest('hex');
      const footer = Buffer.from(`#END sha256=${digest} keys=${this.keysWritten}\n`, 'latin1');
      fs.writeSync(this.fd, footer);
      fs.fsyncSync(this.fd);
      fs.closeSync(this.fd);
      this.fd = null;
      fs.renameSync(this.tmpPath, this.snapPath);
      this.running = false;
      this.log.info('background snapshot finished', {
        keys: this.keysWritten,
        duration_ms: Date.now() - this.startedAtMs,
      });
    } catch (err) {
      this.abort(`snapshot finalization failed: ${err.code ?? err.message}`);
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
    try {
      fs.unlinkSync(this.tmpPath);
    } catch {}
    this.log.warn('background snapshot aborted', { reason });
  }

  writeSyncNow() {
    const wasRunning = this.running;
    if (wasRunning) {
      throw new Error('a background snapshot is already running');
    }
    const tmpPath = `${this.snapPath}.tmp`;
    const fd = fs.openSync(tmpPath, 'w');
    try {
      fs.writeSync(fd, Buffer.from(`${SNAP_HEADER}\n`, 'latin1'));
      let cursor = 0;
      let keys = 0;
      for (;;) {
        const page = this.store.iterateFrom(cursor, CHUNK_KEYS * 4);
        if (page.items.length > 0) {
          const frames = [];
          for (const [key, entry] of page.items) {
            frames.push(encodeTypedRequest(encodeEntryRecord(key, entry, this.store.nowMs())));
            keys += 1;
          }
          fs.writeSync(fd, Buffer.concat(frames));
        }
        if (page.nextIndex === 0) break;
        cursor = page.nextIndex;
      }
      const raw = fs.readFileSync(tmpPath);
      const digest = crypto.createHash('sha256').update(raw.subarray(SNAP_HEADER.length + 1)).digest('hex');
      fs.writeSync(fd, Buffer.from(`#END sha256=${digest} keys=${keys}\n`, 'latin1'));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, this.snapPath);
  }
}
