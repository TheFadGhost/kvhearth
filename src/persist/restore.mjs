import { parseScore } from '../store/store.mjs';

export function applyRestore(store, args) {
  const key = latin1(args[1]);
  const type = latin1(args[2]);
  const ttlText = latin1(args[3]);
  let payload = args.slice(4);
  let value;
  switch (type) {
    case 'string':
      value = payload.length > 0 ? latin1(payload[0]) : '';
      payload = [];
      break;
    case 'list':
      value = payload.map(latin1);
      payload = [];
      break;
    case 'hash': {
      const map = new Map();
      for (let i = 0; i + 1 < payload.length; i += 2) map.set(latin1(payload[i]), latin1(payload[i + 1]));
      value = map;
      payload = [];
      break;
    }
    case 'set':
      value = new Set(payload.map(latin1));
      payload = [];
      break;
    case 'zset': {
      const members = new Map();
      for (let i = 0; i + 1 < payload.length; i += 2) {
        const member = latin1(payload[i]);
        const score = parseScore(latin1(payload[i + 1]));
        if (score === null) throw new Error(`restore: invalid score '${latin1(payload[i + 1])}'`);
        members.set(member, score);
      }
      value = { members, sorted: null };
      payload = [];
      break;
    }
    default:
      throw new Error(`restore: unknown type '${type}'`);
  }
  void payload;
  const entry = store.install(key, type, value);
  const ttl = Number(ttlText);
  if (Number.isFinite(ttl) && ttl > 0) entry.expireAtMs = Math.floor(ttl);
  return entry;
}

function latin1(value) {
  return Buffer.isBuffer(value) ? value.toString('latin1') : String(value);
}
