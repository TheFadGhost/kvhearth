import fs from 'node:fs';
import crypto from 'node:crypto';
import { encodeTypedRequest } from '../proto/serializer.mjs';

export const SNAP_HEADER = 'KVHEARTH-SNAP 1';
export const SNAP_MAGIC = 'KVHEARTH-SNAP ';
export const SNAP_VERSION = 1;
const FOOTER_PREFIX = '#END ';

export class SnapshotError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
    this.exitCode = code;
  }
}

export function encodeEntryRecord(key, entry, nowMs) {
  const type = entry.type;
  let payloadArgs;
  switch (type) {
    case 'string':
      payloadArgs = [entry.value];
      break;
    case 'list':
      payloadArgs = entry.value;
      break;
    case 'hash':
      payloadArgs = [];
      for (const [field, value] of entry.value) payloadArgs.push(field, value);
      break;
    case 'set':
      payloadArgs = Array.from(entry.value);
      break;
    case 'zset':
      payloadArgs = [];
      for (const [member, score] of entry.value.members) {
        payloadArgs.push(member, formatScore(score));
      }
      break;
    default:
      throw new SnapshotError(`unknown entry type '${type}'`, 12);
  }
  const ttl = entry.expireAtMs === -1 ? '-1' : String(Math.max(entry.expireAtMs - nowMs, 1) + nowMs);
  return ['RESTORE', key, type, ttl, ...payloadArgs];
}

export function formatScore(score) {
  if (score === Infinity) return '+inf';
  if (score === -Infinity) return '-inf';
  return String(score);
}

export function serializeSnapshot(store, { chunkSize = 512, onChunk } = {}) {
  const header = Buffer.from(`${SNAP_HEADER}\n`, 'latin1');
  const bodyChunks = [];
  const hash = crypto.createHash('sha256');
  let keys = 0;
  let index = 0;
  for (;;) {
    const { items, nextIndex } = store.iterateFrom(index, chunkSize);
    if (items.length > 0) {
      const frames = [];
      for (const [key, entry] of items) {
        frames.push(encodeTypedRequest(encodeEntryRecord(key, entry, store.nowMs())));
        keys++;
      }
      const chunkBuffer = Buffer.concat(frames);
      hash.update(chunkBuffer);
      bodyChunks.push(chunkBuffer);
      if (onChunk) onChunk();
    }
    if (nextIndex === 0) break;
    index = nextIndex;
  }
  const footer = Buffer.from(`${FOOTER_PREFIX}sha256=${hash.digest('hex')} keys=${keys}\n`, 'latin1');
  return { header, bodyChunks, footer, keys };
}

export function writeSnapshotSync(store, filePath, log) {
  const tmpPath = `${filePath}.tmp`;
  const { header, bodyChunks, footer } = serializeSnapshot(store);
  const fd = fs.openSync(tmpPath, 'w');
  try {
    fs.writeSync(fd, header);
    for (const chunk of bodyChunks) fs.writeSync(fd, chunk);
    fs.writeSync(fd, footer);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, filePath);
  if (log) log.info('snapshot written', { file: filePath, bytes: header.length + footer.length });
}

export function parseSnapshotFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath);
  } catch (err) {
    throw new SnapshotError(`cannot read snapshot '${filePath}': ${err.code ?? err.message}`, 12);
  }
  const newlineAt = raw.indexOf(0x0a);
  if (newlineAt === -1) throw new SnapshotError(`snapshot '${filePath}' has no readable header`, 11);
  const header = raw.toString('latin1', 0, newlineAt).trim();
  if (header !== SNAP_HEADER) {
    if (header.startsWith(SNAP_MAGIC)) {
      throw new SnapshotError(
        `snapshot version mismatch in '${filePath}': found ${header.slice(SNAP_MAGIC.length)}, supported ${SNAP_VERSION}`,
        11,
      );
    }
    throw new SnapshotError(`snapshot '${filePath}' has unrecognized header`, 11);
  }
  const lastNewline = raw.lastIndexOf(0x0a);
  if (lastNewline === -1 || lastNewline === newlineAt) {
    throw new SnapshotError(`snapshot '${filePath}' is missing its footer`, 12);
  }
  const footerStart = findFooterStart(raw);
  const footerText = raw.toString('latin1', footerStart, raw.length).trimEnd();
  if (!footerText.startsWith(FOOTER_PREFIX)) {
    throw new SnapshotError(`snapshot '${filePath}' has a corrupt footer`, 12);
  }
  const digestMatch = /sha256=([0-9a-f]{64})/.exec(footerText);
  const countMatch = /keys=(\d+)/.exec(footerText);
  if (!digestMatch || !countMatch) throw new SnapshotError(`snapshot '${filePath}' footer missing fields`, 12);
  const expectedDigest = digestMatch[1];
  const expectedKeys = Number(countMatch[1]);
  const body = raw.subarray(newlineAt + 1, footerStart);
  const actualDigest = crypto.createHash('sha256').update(body).digest('hex');
  if (actualDigest !== expectedDigest) {
    throw new SnapshotError(`snapshot '${filePath}' failed integrity check`, 12);
  }
  return { body, declaredKeys: expectedKeys };
}

function findFooterStart(raw) {
  const marker = Buffer.from(`\n${FOOTER_PREFIX}`, 'latin1');
  const at = raw.lastIndexOf(marker);
  if (at === -1) throw new SnapshotError('footer not found', 12);
  return at + 1;
}
