export const TYPE_STRING = 'string';
export const TYPE_LIST = 'list';
export const TYPE_HASH = 'hash';
export const TYPE_SET = 'set';
export const TYPE_ZSET = 'zset';

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

let ENTRY_SEQ = 0;

export class WrongTypeSignal extends Error {
  constructor(actual, expected) {
    super(`holds ${actual}, expected ${expected}`);
    this.actual = actual;
    this.expected = expected;
  }
}

export class NotIntegerSignal extends Error {
  constructor(valueText) {
    super(`not an integer: '${valueText}'`);
    this.valueText = valueText;
  }
}

export class IntOverflowSignal extends Error {}

function makeZset() {
  return { members: new Map(), sorted: null };
}

function zsetInvalidate(zs) {
  zs.sorted = null;
}

function zsetEnsureSorted(zs) {
  if (zs.sorted === null) {
    zs.sorted = Array.from(zs.members, ([member, score]) => [member, score]);
    zs.sorted.sort(comparePairs);
  }
  return zs.sorted;
}

function comparePairs(a, b) {
  if (a[1] !== b[1]) return a[1] - b[1];
  if (a[0] < b[0]) return -1;
  if (a[0] > b[0]) return 1;
  return 0;
}

function estimateBytes(type, value, keyLen) {
  let total = 96 + keyLen * 2;
  switch (type) {
    case TYPE_STRING:
      total += value.length;
      break;
    case TYPE_LIST: {
      total += 24 * value.length;
      for (const item of value) total += item.length;
      break;
    }
    case TYPE_HASH: {
      total += 80 * value.size;
      for (const [f, v] of value) total += f.length + v.length;
      break;
    }
    case TYPE_SET: {
      total += 72 * value.size;
      for (const m of value) total += m.length;
      break;
    }
    case TYPE_ZSET: {
      total += 72 * value.members.size;
      for (const m of value.members.keys()) total += m.length;
      break;
    }
    default:
      break;
  }
  return total;
}

function isExpiredAt(entry, nowMs) {
  return entry.expireAtMs !== -1 && nowMs >= entry.expireAtMs;
}

export function clampRange(length, start, stop) {
  let s = start < 0 ? length + start : start;
  let e = stop < 0 ? length + stop : stop;
  if (s < 0) s = 0;
  if (e >= length) e = length - 1;
  if (length === 0 || s > e) return null;
  return { start: s, end: e };
}

export function parseSignedInt64(text) {
  if (!/^[+-]?\d+$/.test(text)) return null;
  const big = BigInt(text);
  if (big < INT64_MIN || big > INT64_MAX) return undefined;
  return big;
}

export function parseScore(text) {
  const lower = text.toLowerCase();
  if (lower === '+inf') return Infinity;
  if (lower === '-inf') return -Infinity;
  if (/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(text)) {
    const n = Number(text);
    if (Number.isNaN(n)) return null;
    return n;
  }
  return null;
}

export class Store {
  constructor(clock) {
    this.clock = clock;
    this.map = new Map();
    this.usedBytes = 0;
    this.accessCounter = 0;
    this.expirerCursor = 0;
    this.stats = { expired: 0, evicted: 0 };
    this.onExpire = null;
    this.onEvict = null;
  }

  nowMs() {
    return this.clock.nowMs();
  }

  storedCount() {
    return this.map.size;
  }

  logicalCount() {
    const now = this.nowMs();
    let count = 0;
    for (const entry of this.map.values()) {
      if (!isExpiredAt(entry, now)) count++;
    }
    return count;
  }

  keysWithExpiry() {
    const now = this.nowMs();
    let count = 0;
    for (const entry of this.map.values()) {
      if (entry.expireAtMs !== -1) count++;
    }
    void now;
    return count;
  }

  getEntry(key) {
    const entry = this.map.get(key);
    if (entry === undefined) return null;
    if (isExpiredAt(entry, this.nowMs())) {
      this.removeEntry(key, entry);
      this.stats.expired += 1;
      if (this.onExpire) this.onExpire(key);
      return null;
    }
    return entry;
  }

  getTyped(key, expectedType) {
    const entry = this.getEntry(key);
    if (entry === null) return null;
    if (entry.type !== expectedType) throw new WrongTypeSignal(entry.type, expectedType);
    entry.lastAccess = ++this.accessCounter;
    return entry;
  }

  touchEntry(entry) {
    entry.lastAccess = ++this.accessCounter;
  }

  typeOf(key) {
    const entry = this.getEntry(key);
    return entry === null ? 'none' : entry.type;
  }

  install(key, type, value) {
    const entry = {
      seq: ++ENTRY_SEQ,
      type,
      value,
      expireAtMs: -1,
      version: 1,
      lastAccess: ++this.accessCounter,
      bytes: 0,
    };
    entry.bytes = estimateBytes(type, value, key.length);
    this.map.set(key, entry);
    this.usedBytes += entry.bytes;
    return entry;
  }

  replaceValue(key, entry, newValue) {
    this.usedBytes -= entry.bytes;
    entry.value = newValue;
    entry.version += 1;
    entry.bytes = estimateBytes(entry.type, newValue, key.length);
    this.usedBytes += entry.bytes;
  }

  bumpEntry(entry) {
    entry.version += 1;
  }

  removeEntry(key, entry) {
    this.map.delete(key);
    this.usedBytes -= entry.bytes;
  }

  deleteKey(key) {
    const entry = this.getEntry(key);
    if (entry === null) return false;
    this.removeEntry(key, entry);
    return true;
  }

  flushAll() {
    this.map.clear();
    this.usedBytes = 0;
  }

  renameKey(source, target) {
    const entry = this.getEntry(source);
    if (entry === null) return false;
    if (source === target) {
      entry.version += 1;
      return true;
    }
    const priorTarget = this.getEntry(target);
    if (priorTarget !== null) this.removeEntry(target, priorTarget);
    this.map.delete(source);
    this.usedBytes -= entry.bytes;
    this.map.set(target, entry);
    entry.bytes = estimateBytes(entry.type, entry.value, target.length);
    this.usedBytes += entry.bytes;
    entry.version += 1;
    return true;
  }

  setExpireMs(key, absMs) {
    const entry = this.getEntry(key);
    if (entry === null) return false;
    entry.expireAtMs = absMs;
    entry.version += 1;
    return true;
  }

  persistExpire(key) {
    const entry = this.getEntry(key);
    if (entry === null || entry.expireAtMs === -1) return false;
    entry.expireAtMs = -1;
    entry.version += 1;
    return true;
  }

  ttlOf(key) {
    const entry = this.getEntry(key);
    if (entry === null) return -2;
    if (entry.expireAtMs === -1) return -1;
    return entry.expireAtMs - this.nowMs();
  }

  activeExpireStep(maxSamples) {
    if (this.map.size === 0) return 0;
    const start = this.expirerCursor % this.map.size;
    let index = 0;
    let scanned = 0;
    let expired = 0;
    for (const [key, entry] of this.map) {
      if (index >= start) {
        scanned++;
        if (isExpiredAt(entry, this.nowMs())) {
          this.removeEntry(key, entry);
          this.stats.expired += 1;
          expired++;
          if (this.onExpire) this.onExpire(key);
        }
        if (scanned >= maxSamples) break;
      }
      index++;
    }
    const size = Math.max(this.map.size, 1);
    this.expirerCursor = (start + Math.max(scanned, 1)) % size;
    return expired;
  }

  iterateFrom(startIndex, limit) {
    const items = [];
    let index = 0;
    let exhausted = true;
    for (const [key, entry] of this.map) {
      if (index >= startIndex) {
        items.push([key, entry]);
        if (items.length >= limit) {
          exhausted = false;
          break;
        }
      }
      index++;
    }
    return { items, nextIndex: exhausted ? 0 : startIndex + items.length };
  }

  stringSet(key, valueText, { expireMode = 'none', nx = false, xx = false } = {}) {
    const existing = this.getEntry(key);
    if (existing !== null && existing.type !== TYPE_STRING) throw new WrongTypeSignal(existing.type, TYPE_STRING);
    if (nx && existing !== null) return 'skipped';
    if (xx && existing === null) return 'skipped';
    let expireAtMs = -1;
    if (expireMode === 'keep' && existing !== null) expireAtMs = existing.expireAtMs;
    else if (typeof expireMode === 'number') expireAtMs = expireMode;
    if (existing === null) {
      const entry = this.install(key, TYPE_STRING, valueText);
      if (expireAtMs !== -1) {
        entry.expireAtMs = expireAtMs;
        entry.version += 1;
      }
    } else {
      this.replaceValue(key, existing, valueText);
      existing.expireAtMs = expireAtMs;
      existing.version += 1;
    }
    return 'ok';
  }

  stringGet(key) {
    const entry = this.getTyped(key, TYPE_STRING);
    if (entry === null) return null;
    return entry.value;
  }

  stringAppend(key, suffixText) {
    const existing = this.getEntry(key);
    if (existing !== null && existing.type !== TYPE_STRING) throw new WrongTypeSignal(existing.type, TYPE_STRING);
    if (existing === null) {
      this.install(key, TYPE_STRING, suffixText);
      return suffixText.length;
    }
    const combined = existing.value + suffixText;
    this.replaceValue(key, existing, combined);
    return combined.length;
  }

  counterRead(key) {
    const text = this.stringGet(key);
    if (text === null) return { missing: true };
    const parsed = parseSignedInt64(text);
    if (parsed === null) throw new NotIntegerSignal(text);
    if (parsed === undefined) throw new IntOverflowSignal();
    return { value: parsed };
  }

  counterWrite(key, bigValue) {
    if (bigValue < INT64_MIN || bigValue > INT64_MAX) throw new IntOverflowSignal();
    const existing = this.getEntry(key);
    if (existing !== null && existing.type !== TYPE_STRING) throw new WrongTypeSignal(existing.type, TYPE_STRING);
    const text = bigValue.toString();
    if (existing === null) {
      this.install(key, TYPE_STRING, text);
    } else {
      this.replaceValue(key, existing, text);
    }
    return bigValue;
  }

  listPush(key, items, front) {
    const existing = this.getEntry(key);
    if (existing !== null && existing.type !== TYPE_LIST) throw new WrongTypeSignal(existing.type, TYPE_LIST);
    let entry = existing;
    if (entry === null) entry = this.install(key, TYPE_LIST, []);
    const list = entry.value;
    if (front) {
      for (let i = items.length - 1; i >= 0; i--) list.unshift(items[i]);
    } else {
      for (const item of items) list.push(item);
    }
    this.replaceValue(key, entry, list);
    return list.length;
  }

  listPop(key, front, count) {
    const entry = this.getTyped(key, TYPE_LIST);
    if (entry === null) return count === null ? null : [];
    const list = entry.value;
    const results = [];
    const take = count === null ? 1 : Math.min(Math.abs(count), list.length);
    const fromFront = count !== null && count < 0 ? !front : front;
    for (let i = 0; i < take; i++) {
      results.push(fromFront ? list.shift() : list.pop());
    }
    if (results.length > 0) {
      if (list.length === 0) this.removeEntry(key, entry);
      else this.replaceValue(key, entry, list);
    }
    return count === null ? (results.length > 0 ? results[0] : null) : results;
  }

  listLen(key) {
    const entry = this.getTyped(key, TYPE_LIST);
    return entry === null ? 0 : entry.value.length;
  }

  listRange(key, start, stop) {
    const entry = this.getTyped(key, TYPE_LIST);
    if (entry === null) return [];
    const list = entry.value;
    const span = clampRange(list.length, start, stop);
    if (span === null) return [];
    return list.slice(span.start, span.end + 1);
  }

  listIndex(key, index) {
    const entry = this.getTyped(key, TYPE_LIST);
    if (entry === null) return undefined;
    const list = entry.value;
    const real = normalizeIndex(list.length, index);
    if (real === null || real >= list.length) return undefined;
    return list[real];
  }

  listSet(key, index, valueText) {
    const entry = this.getTyped(key, TYPE_LIST);
    if (entry === null) return 'nokey';
    const list = entry.value;
    const real = normalizeIndex(list.length, index);
    if (real === null || real >= list.length) return 'range';
    list[real] = valueText;
    this.replaceValue(key, entry, list);
    return 'ok';
  }

  listTrim(key, start, stop) {
    const entry = this.getTyped(key, TYPE_LIST);
    if (entry === null) return 'ok';
    const list = entry.value;
    const span = clampRange(list.length, start, stop);
    const kept = span === null ? [] : list.slice(span.start, span.end + 1);
    if (kept.length === 0) this.removeEntry(key, entry);
    else this.replaceValue(key, entry, kept);
    return 'ok';
  }

  hashSet(key, pairs) {
    const existing = this.getEntry(key);
    if (existing !== null && existing.type !== TYPE_HASH) throw new WrongTypeSignal(existing.type, TYPE_HASH);
    let map;
    let entry = existing;
    if (entry === null) {
      map = new Map();
      entry = this.install(key, TYPE_HASH, map);
    } else {
      map = entry.value;
    }
    let added = 0;
    for (const [field, value] of pairs) {
      if (!map.has(field)) added++;
      map.set(field, value);
    }
    this.replaceValue(key, entry, map);
    return added;
  }

  hashGet(key, field) {
    const entry = this.getTyped(key, TYPE_HASH);
    if (entry === null) return null;
    return entry.value.get(field) ?? null;
  }

  hashExists(key, field) {
    const entry = this.getTyped(key, TYPE_HASH);
    if (entry === null) return false;
    return entry.value.has(field);
  }

  hashDelete(key, fields) {
    const entry = this.getTyped(key, TYPE_HASH);
    if (entry === null) return 0;
    const map = entry.value;
    let removed = 0;
    for (const field of fields) {
      if (map.delete(field)) removed++;
    }
    if (removed > 0) {
      if (map.size === 0) this.removeEntry(key, entry);
      else this.replaceValue(key, entry, map);
    }
    return removed;
  }

  hashEntries(key) {
    const entry = this.getTyped(key, TYPE_HASH);
    if (entry === null) return [];
    return Array.from(entry.value);
  }

  hashLen(key) {
    const entry = this.getTyped(key, TYPE_HASH);
    return entry === null ? 0 : entry.value.size;
  }

  hashIncrementBy(key, field, deltaBig) {
    const existing = this.getEntry(key);
    if (existing !== null && existing.type !== TYPE_HASH) throw new WrongTypeSignal(existing.type, TYPE_HASH);
    let map;
    let entry = existing;
    if (entry === null) {
      map = new Map();
      entry = this.install(key, TYPE_HASH, map);
    } else {
      map = entry.value;
    }
    const currentText = map.get(field);
    let current = 0n;
    if (currentText !== undefined) {
      const parsed = parseSignedInt64(currentText);
      if (parsed === null) throw new NotIntegerSignal(currentText);
      if (parsed === undefined) throw new IntOverflowSignal();
      current = parsed;
    }
    const next = current + deltaBig;
    if (next < INT64_MIN || next > INT64_MAX) throw new IntOverflowSignal();
    map.set(field, next.toString());
    this.replaceValue(key, entry, map);
    return next;
  }

  setAdd(key, members) {
    const existing = this.getEntry(key);
    if (existing !== null && existing.type !== TYPE_SET) throw new WrongTypeSignal(existing.type, TYPE_SET);
    if (members.length === 0 && existing === null) return 0;
    let set;
    let entry = existing;
    if (entry === null) {
      set = new Set();
      entry = this.install(key, TYPE_SET, set);
    } else {
      set = entry.value;
    }
    let added = 0;
    for (const m of members) {
      if (!set.has(m)) {
        set.add(m);
        added++;
      }
    }
    this.replaceValue(key, entry, set);
    return added;
  }

  setRemove(key, members) {
    const entry = this.getTyped(key, TYPE_SET);
    if (entry === null) return 0;
    const set = entry.value;
    let removed = 0;
    for (const m of members) {
      if (set.delete(m)) removed++;
    }
    if (removed > 0) {
      if (set.size === 0) this.removeEntry(key, entry);
      else this.replaceValue(key, entry, set);
    }
    return removed;
  }

  setIsMember(key, member) {
    const entry = this.getTyped(key, TYPE_SET);
    if (entry === null) return false;
    return entry.value.has(member);
  }

  setMembers(key) {
    const entry = this.getTyped(key, TYPE_SET);
    if (entry === null) return [];
    return Array.from(entry.value);
  }

  setCard(key) {
    const entry = this.getTyped(key, TYPE_SET);
    return entry === null ? 0 : entry.value.size;
  }

  readSetsForAlgebra(keys) {
    const sets = [];
    for (const key of keys) {
      const entry = this.getTyped(key, TYPE_SET);
      sets.push(entry === null ? new Set() : entry.value);
    }
    return sets;
  }

  storeSet(key, members) {
    const existing = this.getEntry(key);
    if (existing !== null && existing.type !== TYPE_SET) throw new WrongTypeSignal(existing.type, TYPE_SET);
    const set = new Set(members);
    if (set.size === 0) {
      if (existing !== null) this.removeEntry(key, existing);
      return 0;
    }
    if (existing === null) {
      this.install(key, TYPE_SET, set);
    } else {
      this.replaceValue(key, existing, set);
    }
    return set.size;
  }

  zsetAdd(key, pairs, { nx = false, xx = false, ch = false } = {}) {
    const existing = this.getEntry(key);
    if (existing !== null && existing.type !== TYPE_ZSET) throw new WrongTypeSignal(existing.type, TYPE_ZSET);
    let zs;
    let entry = existing;
    if (entry === null) {
      if (xx) return { added: 0, changed: 0 };
      zs = makeZset();
      entry = this.install(key, TYPE_ZSET, zs);
    } else {
      zs = entry.value;
    }
    let added = 0;
    let changed = 0;
    for (const [member, score] of pairs) {
      const has = zs.members.has(member);
      if (nx && has) continue;
      if (xx && !has) continue;
      if (!has) {
        zs.members.set(member, score);
        added++;
        changed++;
      } else {
        const old = zs.members.get(member);
        if (old !== score) {
          changed++;
          zs.members.set(member, score);
        } else {
          zs.members.set(member, score);
        }
      }
    }
    if (changed > 0 || added > 0) {
      zsetInvalidate(zs);
      this.replaceValue(key, entry, zs);
    }
    return { added, changed };
  }

  zsetScore(key, member) {
    const entry = this.getTyped(key, TYPE_ZSET);
    if (entry === null) return undefined;
    const score = entry.value.members.get(member);
    return score === undefined ? undefined : score;
  }

  zsetCard(key) {
    const entry = this.getTyped(key, TYPE_ZSET);
    return entry === null ? 0 : entry.value.members.size;
  }

  zsetRemove(key, members) {
    const entry = this.getTyped(key, TYPE_ZSET);
    if (entry === null) return 0;
    const zs = entry.value;
    let removed = 0;
    for (const m of members) {
      if (zs.members.delete(m)) removed++;
    }
    if (removed > 0) {
      if (zs.members.size === 0) this.removeEntry(key, entry);
      else {
        zsetInvalidate(zs);
        this.replaceValue(key, entry, zs);
      }
    }
    return removed;
  }

  zsetSortedView(key) {
    const entry = this.getTyped(key, TYPE_ZSET);
    if (entry === null) return null;
    return zsetEnsureSorted(entry.value);
  }

  zsetIncrementBy(key, member, delta) {
    const existingScore = this.zsetScore(key, member);
    if (existingScore === undefined) {
      this.zsetAdd(key, [[member, delta]], {});
      return delta;
    }
    const next = existingScore + delta;
    this.zsetAdd(key, [[member, next]], {});
    return next;
  }
}

export { INT64_MIN, INT64_MAX };

function normalizeIndex(length, index) {
  const real = index < 0 ? length + index : index;
  if (real < 0 || real >= length) return null;
  return real;
}
