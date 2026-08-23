import fs from 'node:fs';
import path from 'node:path';

const SUFFIXES = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 };
const TIME_SUFFIXES = { us: 1 / 1000, ms: 1, s: 1000, m: 60000, h: 3600000 };

export const CONFIG_DEFAULTS = {
  bind: '127.0.0.1',
  port: 7379,
  dir: './data',
  'aof-file': 'kvhearth.aof',
  'snap-file': 'kvhearth.snap',
  appendonly: true,
  'append-fsync': 'everysec',
  'save-on-shutdown': true,
  'save-interval': 0,
  maxclients: 1024,
  timeout: 0,
  maxmemory: 0,
  'maxmemory-policy': 'noeviction',
  'proto-max-args': 1024,
  'proto-max-bulk': 67108864,
  'proto-max-request': 134217728,
  'slowlog-slower-than': 10000,
  'slowlog-max-len': 128,
  'log-level': 'info',
  'log-format': 'text',
  theme: 'dark',
  requirepass: '',
  'notify-keyspace-events': '',
  'enable-debug-commands': false,
};

const SPEC = {
  bind: { type: 'string' },
  port: { type: 'int', min: 1, max: 65535 },
  dir: { type: 'string' },
  'aof-file': { type: 'string' },
  'snap-file': { type: 'string' },
  appendonly: { type: 'bool' },
  'append-fsync': { type: 'enum', values: ['always', 'everysec', 'never'] },
  'save-on-shutdown': { type: 'bool' },
  'save-interval': { type: 'seconds', min: 0 },
  maxclients: { type: 'int', min: 1, max: 1000000 },
  timeout: { type: 'seconds', min: 0 },
  maxmemory: { type: 'bytes', min: 0 },
  'maxmemory-policy': { type: 'enum', values: ['noeviction', 'allkeys-lru'] },
  'proto-max-args': { type: 'int', min: 1, max: 1000000 },
  'proto-max-bulk': { type: 'bytes', min: 1, max: 1073741824 },
  'proto-max-request': { type: 'bytes', min: 1, max: 2147483648 },
  'slowlog-slower-than': { type: 'micros', min: 0 },
  'slowlog-max-len': { type: 'int', min: 0, max: 100000 },
  'log-level': { type: 'enum', values: ['debug', 'info', 'warn', 'error'] },
  'log-format': { type: 'enum', values: ['text', 'json'] },
  theme: { type: 'enum', values: ['dark', 'light', 'plain'] },
  requirepass: { type: 'raw' },
  'notify-keyspace-events': { type: 'notifyflags' },
  'enable-debug-commands': { type: 'bool' },
};

export const CONFIG_KEYS = Object.keys(SPEC);

export class ConfigError extends Error {}

export function resolveConfig({ fileText = null, flags = {} } = {}) {
  const values = { ...CONFIG_DEFAULTS };
  const sources = {};
  if (fileText !== null && fileText !== '') {
    applyFile(values, sources, fileText);
  }
  for (const key of Object.keys(flags)) {
    setFromValue(values, sources, key, String(flags[key]), 'flag');
  }
  return finalize(values, sources);
}

export function parseConfigFile(text) {
  const lines = String(text).split(/\r?\n/);
  const entries = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const hashAt = findCommentStart(line);
    let body = line;
    if (hashAt !== -1) body = line.slice(0, hashAt).trim();
    const spaceAt = body.search(/\s/);
    let key;
    let value;
    if (spaceAt === -1) {
      key = body.toLowerCase();
      value = '';
    } else {
      key = body.slice(0, spaceAt).toLowerCase();
      value = body.slice(spaceAt + 1).trim();
    }
    entries.push({ key, value, line: i + 1 });
  }
  return entries;
}

function findCommentStart(line) {
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && (i === 0 || line[i - 1] !== '\\')) inQuote = !inQuote;
    else if (ch === '#' && !inQuote) return i;
  }
  return -1;
}

function applyFile(values, sources, text) {
  for (const entry of parseConfigFile(text)) {
    setFromValue(values, sources, entry.key, entry.value, `file line ${entry.line}`);
  }
}

function setFromValue(values, sources, key, value, source) {
  const spec = SPEC[key];
  if (!spec) throw new ConfigError(`unknown configuration key '${key}' (${source})`);
  values[key] = coerce(key, spec, value, source);
  sources[key] = source;
}

function coerce(key, spec, value, source) {
  switch (spec.type) {
    case 'string':
      return value;
    case 'raw':
      return value;
    case 'bool':
      return parseBool(key, value, source);
    case 'int':
      return parseIntRange(key, stripUnit(value), spec.min, spec.max, source, 1);
    case 'bytes':
      return parseIntRange(key, value, spec.min, spec.max, source, SUFFIXES.b);
    case 'seconds': {
      const secondsValue = parseDurationToMs(value, key, source) / 1000;
      if (secondsValue < spec.min) {
        throw new ConfigError(`value out of range for '${key}': ${secondsValue} (allowed >= ${spec.min}; ${source})`);
      }
      return secondsValue;
    }
    case 'micros': {
      const us = parseMicros(value, key, source);
      if (us < spec.min) {
        throw new ConfigError(`value out of range for '${key}': ${us} (allowed >= ${spec.min}; ${source})`);
      }
      return us;
    }
    case 'enum':
      return parseEnum(key, value, spec.values, source);
    case 'notifyflags':
      return parseNotifyFlags(key, value, source);
    default:
      throw new ConfigError(`internal: unhandled spec type for '${key}'`);
  }
}

function parseBool(key, value, source) {
  const lower = value.toLowerCase();
  if (['yes', 'true', '1', 'on'].includes(lower)) return true;
  if (['no', 'false', '0', 'off'].includes(lower)) return false;
  throw new ConfigError(`invalid boolean for '${key}': '${value}' (${source})`);
}

function stripUnit(value) {
  return value;
}

function parseIntRange(key, text, min, max, source, multiplier) {
  const match = /^([+-]?\d+)([a-z]*)$/i.exec(text.trim());
  if (!match) throw new ConfigError(`invalid integer for '${key}': '${text}' (${source})`);
  let unit = match[2].toLowerCase();
  if (multiplier === SUFFIXES.b) {
    if (unit === '') unit = 'b';
    if (!SUFFIXES.hasOwnProperty(unit)) {
      throw new ConfigError(`invalid size unit for '${key}': '${text}' (expected b, kb, mb or gb; ${source})`);
    }
  }
  const n = Number(match[1]) * (multiplier === SUFFIXES.b ? SUFFIXES[unit] : multiplier);
  if (!Number.isSafeInteger(n)) throw new ConfigError(`value out of range for '${key}': '${text}' (${source})`);
  if (n < min || n > max) {
    throw new ConfigError(`value out of range for '${key}': ${n} (allowed ${min}..${max === Infinity ? 'unbounded' : max}; ${source})`);
  }
  return n;
}

function convertTime(text) {
  const match = /^([+-]?\d+(?:\.\d+)?)(us|ms|s|m|h)?$/i.exec(text.trim());
  if (!match) return text;
  const unit = (match[2] || 'ms').toLowerCase();
  return String(Number(match[1]) * TIME_SUFFIXES[unit]);
}

function parseDurationToMs(text, key, source) {
  const trimmed = String(text).trim();
  const match = /^([+-]?\d+(?:\.\d+)?)(us|ms|s|m|h)?$/i.exec(trimmed);
  if (!match) {
    throw new ConfigError(`invalid duration for '${key}': '${text}' (${source})`);
  }
  const unit = (match[2] || 's').toLowerCase();
  const multiplier = unit === 'us' ? 1 / 1000 : TIME_SUFFIXES[unit];
  const ms = Number(match[1]) * multiplier;
  if (!Number.isFinite(ms)) {
    throw new ConfigError(`invalid duration for '${key}': '${text}' (${source})`);
  }
  return ms;
}

function parseMicros(text, key, source) {
  const trimmed = String(text).trim();
  const match = /^([+-]?\d+(?:\.\d+)?)(us|ms|s|m|h)?$/i.exec(trimmed);
  if (!match) {
    throw new ConfigError(`invalid duration for '${key}': '${text}' (${source})`);
  }
  const unit = (match[2] || 'us').toLowerCase();
  const us = Number(match[1]) * TIME_SUFFIXES[unit] * 1000;
  if (!Number.isSafeInteger(Math.round(us))) {
    throw new ConfigError(`value out of range for '${key}': '${text}' (${source})`);
  }
  return Math.round(us);
}

function parseEnum(key, value, allowed, source) {
  const lower = value.toLowerCase();
  if (!allowed.includes(lower)) {
    throw new ConfigError(`invalid value for '${key}': '${value}' (allowed: ${allowed.join(', ')}; ${source})`);
  }
  return lower;
}

function parseNotifyFlags(key, value, source) {
  if (value === '') return '';
  const upper = value.toUpperCase();
  for (const ch of upper) {
    if (!'KENG LHSZA'.replace(/ /g, '').includes(ch)) {
      throw new ConfigError(`invalid notification class '${ch}' for '${key}' (${source})`);
    }
  }
  return upper;
}

function finalize(values, sources) {
  return { values, sources };
}

export class Config {
  constructor(resolved) {
    this.values = resolved.values;
    this.sources = resolved.sources;
  }

  get(key) {
    if (!SPEC[key]) throw new ConfigError(`unknown configuration key '${key}'`);
    return this.values[key];
  }

  sourceOf(key) {
    return this.sources[key] ?? 'default';
  }

  aofPath() {
    return path.join(this.get('dir'), this.get('aof-file'));
  }

  snapPath() {
    return path.join(this.get('dir'), this.get('snap-file'));
  }
}

export function loadConfigFile(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new ConfigError(`cannot read config file '${filePath}': ${err.code ?? err.message}`);
  }
  return text;
}
