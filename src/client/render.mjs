const THEMES = {
  dark: darkTheme,
  light: lightTheme,
  plain: plainTheme,
};

function identity(s) {
  return s;
}

function plainTheme() {
  return { ok: identity, error: identity, warn: identity, dim: identity, number: identity, prompt: identity };
}

function darkTheme() {
  return {
    ok: green,
    error: red,
    warn: yellow,
    dim: brightBlack,
    number: cyan,
    prompt: cyan,
  };
}

function lightTheme() {
  return {
    ok: green,
    error: red,
    warn: yellow,
    dim: faint,
    number: blue,
    prompt: blue,
  };
}

function wrap(code) {
  return (s) => `\x1b[${code}m${s}\x1b[0m`;
}

function green(s) { return wrap(32)(s); }
function red(s) { return wrap(31)(s); }
function yellow(s) { return wrap(33)(s); }
function brightBlack(s) { return wrap(90)(s); }
function cyan(s) { return wrap(36)(s); }
function blue(s) { return wrap(34)(s); }
function faint(s) { return wrap(2)(s); }

export function resolveTheme(options) {
  if (options && (options.noColor === true || process.env.NO_COLOR)) return THEMES.plain();
  if (!options || options.theme === 'plain') return THEMES.plain();
  const isTTY = process.stdout ? process.stdout.isTTY === true : false;
  if (!isTTY && !options.forceColor) return THEMES.plain();
  if (options.theme === 'dark') return THEMES.dark();
  if (options.theme === 'light') return THEMES.light();
  return THEMES.dark();
}

export function renderReply(reply, theme, depth = 0) {
  if (reply.kind !== 'array') return renderValue(reply, theme);
  if (reply.kind === 'array' && reply.items.length === 0) return theme.dim('(empty array)');
  const lines = renderArrayLines(reply.items, theme, depth);
  return lines.join('\n');
}

function renderArrayLines(items, theme, depth) {
  const lines = [];
  items.forEach((item, index) => {
    const prefix = `${' '.repeat(depth * 3)}${theme.number(`${index + 1})`)}`;
    if (item.kind === 'array' && item.items.length > 0) {
      const childLines = renderArrayLines(item.items, theme, depth + 1);
      lines.push(`${prefix} ${childLines[0].replace(/^ +/, '')}`);
      for (let i = 1; i < childLines.length; i++) {
        lines.push(` `.repeat(depth * 3 + 3) + childLines[i]);
      }
    } else {
      lines.push(`${prefix} ${renderValue(item, theme)}`);
    }
  });
  return lines;
}

function renderValue(reply, theme) {
  switch (reply.kind) {
    case 'simple':
      return reply.text;
    case 'integer':
      return theme.number(`(integer) ${reply.n}`);
    case 'nil-bulk':
      return theme.dim('(nil)');
    case 'bulk':
      return renderBulkData(reply.data, theme);
    case 'nil-array':
      return theme.dim('(nil array)');
    case 'error':
      return `${theme.error('(error)')} ${theme.error(reply.code)} ${reply.text}`;
    default:
      return theme.warn(`(unknown reply kind '${reply.kind}')`);
  }
}

export function renderBulkData(data, theme) {
  if (isPrintableText(data)) return data.toString('utf8');
  return theme.warn(escapeBytes(data));
}

export function isPrintableText(data) {
  if (data.length === 0) return true;
  try {
    const text = data.toString('utf8');
    if (Buffer.from(text, 'utf8').equals(data)) {
      for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (code < 0x20 && code !== 0x09) return false;
        if (code === 0x7f) return false;
      }
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

export function escapeBytes(data) {
  let out = '"';
  for (const byte of data) {
    switch (byte) {
      case 0x5c: out += '\\\\'; break;
      case 0x22: out += '\\"'; break;
      case 0x0a: out += '\\n'; break;
      case 0x0d: out += '\\r'; break;
      case 0x09: out += '\\t'; break;
      case 0x00: out += '\\0'; break;
      default:
        if (byte >= 0x20 && byte < 0x7f) out += String.fromCharCode(byte);
        else out += `\\x${byte.toString(16).padStart(2, '0')}`;
    }
  }
  return `${out}"`;
}
