import { isatty } from 'node:tty';

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const TAGS = { debug: 'DBG', info: 'INF', warn: 'WRN', error: 'ERR' };
const COLORS = {
  dark: { debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m' },
  light: { debug: '\x1b[90m', info: '\x1b[34m', warn: '\x1b[33m', error: '\x1b[31m' },
};

export class Logger {
  constructor({ level = 'info', format = 'text', theme = 'dark', stream = process.stderr } = {}) {
    this.levelName = LEVELS.hasOwnProperty(level) ? level : 'info';
    this.level = LEVELS[this.levelName];
    this.format = format === 'json' ? 'json' : 'text';
    this.theme = theme === 'light' ? 'light' : 'dark';
    this.stream = stream;
    const noColor = Boolean(process.env.NO_COLOR);
    this.colorEnabled = !noColor && stream.isTTY === true && isatty(stream.fd);
  }

  child(overrides) {
    return new Logger({
      level: overrides.level ?? this.levelName,
      format: overrides.format ?? this.format,
      theme: overrides.theme ?? this.theme,
      stream: this.stream,
    });
  }

  debug(msg, fields) { this.write('debug', msg, fields); }
  info(msg, fields) { this.write('info', msg, fields); }
  warn(msg, fields) { this.write('warn', msg, fields); }
  error(msg, fields) { this.write('error', msg, fields); }

  write(level, msg, fields) {
    if (LEVELS[level] < this.level) return;
    let line;
    if (this.format === 'json') {
      line = this.jsonLine(level, msg, fields);
    } else {
      line = this.textLine(level, msg, fields);
    }
    try {
      this.stream.write(line + '\n');
    } catch {
      this.stream.destroy?.();
    }
  }

  textLine(level, msg, fields) {
    const parts = [new Date().toISOString(), TAGS[level]];
    let out = null;
    if (this.colorEnabled) {
      out = `${COLORS[this.theme][level]}${TAGS[level]}\x1b[0m`;
      parts.length = 2;
      parts[1] = out;
    }
    parts.push(msg);
    if (fields) {
      for (const key of Object.keys(fields)) {
        const value = fields[key];
        parts.push(`${key}=${renderField(value)}`);
      }
    }
    return parts.join(' ');
  }

  jsonLine(level, msg, fields) {
    const record = { ts: new Date().toISOString(), level, msg };
    if (fields) {
      for (const key of Object.keys(fields)) record[key] = normalizeJson(fields[key]);
    }
    return JSON.stringify(record);
  }
}

function renderField(value) {
  if (value === null || value === undefined) return '-';
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  const text = String(value);
  if (/[\s"]/.test(text)) return JSON.stringify(text);
  return text;
}

function normalizeJson(value) {
  if (value === undefined) return null;
  if (typeof value === 'bigint') return Number(value);
  return value;
}
