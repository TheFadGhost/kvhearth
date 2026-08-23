import { parseScore } from '../store/store.mjs';

export function applyRestore(store, args) {
  const key = args[1];
  const type = args[2];
  const ttlText = args[3];
  const payload = args.slice(4);
  let value;
  switch (type) {
    case 'string':
      value = payload.length > 0 ? payload[0] : '';
      break;
    case 'list':
      value = [...payload];
      break;
    case 'hash': {
      const map = new Map();
      for (let i = 0; i + 1 < payload.length; i += 2) map.set(payload[i], payload[i + 1]);
      value = map;
      break;
    }
    case 'set':
      value = new Set(payload);
      break;
    case 'zset': {
      const members = new Map();
      for (let i = 0; i + 1 < payload.length; i += 2) {
        const score = parseScore(payload[i + 1]);
        if (score === null) throw new Error(`restore: invalid score '${payload[i + 1]}'`);
        members.set(payload[i], score);
      }
      value = { members, sorted: null };
      break;
    }
    default:
      throw new Error(`restore: unknown type '${type}'`);
  }
  const entry = store.install(key, type, value);
  const ttl = Number(ttlText);
  if (Number.isFinite(ttl) && ttl > 0) entry.expireAtMs = Math.floor(ttl);
  return entry;
}
