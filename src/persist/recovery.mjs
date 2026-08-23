import fs from 'node:fs';
import { RequestParser } from '../proto/parser.mjs';
import { AOF_HEADER } from './aof.mjs';
import { parseSnapshotFile } from './snapshot.mjs';
import { applyRestore } from './restore.mjs';

export class RecoveryResult {
  constructor() {
    this.snapshotKeys = 0;
    this.aofCommands = 0;
    this.truncatedTailBytes = 0;
  }
}

export function cleanStaleTemporaries(paths, log) {
  for (const candidate of [`${paths.aof}.rewrite`, `${paths.aof}.tmp`, `${paths.snap}.tmp`]) {
    try {
      fs.unlinkSync(candidate);
      log.warn('removed stale temporary persistence file', { file: candidate });
    } catch (err) {
      if (err.code !== 'ENOENT') {
        log.warn('could not remove temporary file', { file: candidate, error: err.code ?? String(err) });
      }
    }
  }
}

export function recover({ store, aofPath, snapPath, applyCommand, log }) {
  const result = new RecoveryResult();

  const aofStat = safeStat(aofPath);
  const aofHasContent = aofStat.size > 0;
  let replayableBytes = 0;

  if (aofHasContent) {
    const raw = fs.readFileSync(aofPath);
    const firstNewline = raw.indexOf(0x0a);
    const header = firstNewline === -1 ? '' : raw.toString('latin1', 0, firstNewline).trim();
    if (header !== '' && header !== AOF_HEADER) {
      const err = new Error(`append log '${aofPath}' has unrecognized header '${header}'`);
      err.exitCode = 11;
      throw err;
    }
    const startOffset = header === AOF_HEADER ? firstNewline + 1 : 0;
    replayableBytes = raw.length - startOffset;
    if (replayableBytes > 0) {
      if (fs.existsSync(snapPath)) {
        log.warn('snapshot present but ignored: the append log is authoritative', { file: snapPath });
      }
      const droppedTail = replayAofBytes(store, raw.subarray(startOffset), applyCommand, result);
      result.truncatedTailBytes = droppedTail;
      return result;
    }
    log.info('append log contains no records; checking for a snapshot', { file: aofPath });
  }

  if (fs.existsSync(snapPath)) {
    const { body, declaredKeys } = parseSnapshotFile(snapPath);
    const parsedCount = replaySnapshotBody(store, body);
    if (parsedCount !== declaredKeys) {
      log.warn('snapshot key count differs from footer', { declared: declaredKeys, applied: parsedCount });
    }
    result.snapshotKeys = parsedCount;
    log.info('snapshot loaded', { file: snapPath, keys: parsedCount });
  }

  return result;
}

const REPLAY_PARSER_LIMITS = {
  maxArgs: Number.MAX_SAFE_INTEGER,
  maxBulk: Number.MAX_SAFE_INTEGER,
  maxRequest: Number.MAX_SAFE_INTEGER,
};

function replaySnapshotBody(store, body) {
  const parser = new RequestParser(REPLAY_PARSER_LIMITS);
  const chunks = splitForParser(body);
  let count = 0;
  for (const chunk of chunks) {
    const { requests, fatal } = parser.feed(chunk);
    if (fatal !== null) {
      throw new SnapshotError(`snapshot body is corrupt at record ${count}: ${fatal.message}`, 12);
    }
    for (const request of requests) {
      if (request === null) continue;
      expectRestore(request.args);
      applyRestore(store, request.args);
      count++;
    }
  }
  return count;
}

function replayAofBytes(store, bytes, applyCommand, result) {
  const parser = new RequestParser(REPLAY_PARSER_LIMITS);
  let consumed = 0;
  const CHUNK = 1 << 16;
  while (consumed < bytes.length) {
    const end = Math.min(consumed + CHUNK, bytes.length);
    const { requests, fatal } = parser.feed(bytes.subarray(consumed, end));
    consumed = end;
    if (fatal !== null) {
      const err = new Error(`append log is corrupt mid-file: ${fatal.message}`);
      err.exitCode = 11;
      throw err;
    }
    for (const request of requests) {
      if (request === null) continue;
      applyCommand(request.args);
      result.aofCommands += 1;
    }
  }
  void store;
  return parser.buffer.length - parser.offset;
}

function expectRestore(args) {
  if (args.length < 4 || args[0].toString('latin1').toUpperCase() !== 'RESTORE') {
    throw new SnapshotError(`unexpected non-RESTORE record in snapshot: '${args[0].toString('latin1')}'`, 12);
  }
}

function splitForParser(buffer) {
  const chunks = [];
  const CHUNK = 1 << 16;
  for (let i = 0; i < buffer.length; i += CHUNK) {
    chunks.push(buffer.subarray(i, Math.min(i + CHUNK, buffer.length)));
  }
  return chunks.length > 0 ? chunks : [Buffer.alloc(0)];
}

function safeStat(path) {
  try {
    return fs.statSync(path);
  } catch {
    return { size: 0 };
  }
}
