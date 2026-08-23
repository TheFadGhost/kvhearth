export const LIMIT_DEFAULTS = Object.freeze({
  maxArgs: 1024,
  maxBulk: 67108864,
  maxRequest: 134217728,
});

const LF = 10;
const CR = 13;
const TAB = 9;
const SPACE = 32;
const PERCENT = 37;
const HASH = 35;
const QUOTE = 34;
const BACKSLASH = 92;
const DIGIT_LOW = 48;
const DIGIT_HIGH = 57;
const EMPTY_BUFFER = Buffer.alloc(0);
const COUNT_LINE_PATTERN = /^%([0-9]+)$/;
const BLANK_LINE_PATTERN = /^[ \t]*$/;
const BARE_TOKEN_PATTERN = /^[\x21\x23-\x5B\x5D-\x7E]+$/;

const HEX_VALUES = buildHexValues();

function buildHexValues() {
  const lower = '0123456789abcdef';
  const upper = '0123456789ABCDEF';
  const table = {};
  for (let i = 0; i < 16; i++) {
    table[lower[i]] = i;
    table[upper[i]] = i;
  }
  return table;
}

export function parseInlineLine(lineText) {
  const args = [];
  let current = [];
  let started = false;
  let quoted = false;
  for (let i = 0; i < lineText.length; i++) {
    const code = lineText.charCodeAt(i);
    if (quoted) {
      if (code === QUOTE) {
        quoted = false;
      } else if (code === BACKSLASH) {
        i += 1;
        if (i >= lineText.length) return null;
        const escape = lineText.charCodeAt(i);
        if (escape === 110) {
          current.push(10);
        } else if (escape === 114) {
          current.push(13);
        } else if (escape === 116) {
          current.push(TAB);
        } else if (escape === 48) {
          current.push(0);
        } else if (escape === QUOTE) {
          current.push(QUOTE);
        } else if (escape === BACKSLASH) {
          current.push(BACKSLASH);
        } else if (escape === 120 || escape === 88) {
          if (i + 2 >= lineText.length) return null;
          const high = HEX_VALUES[lineText[i + 1]];
          const low = HEX_VALUES[lineText[i + 2]];
          if (high === undefined || low === undefined) return null;
          current.push(high * 16 + low);
          i += 2;
        } else {
          return null;
        }
      } else {
        current.push(code & 255);
      }
    } else if (code === SPACE || code === TAB) {
      if (started) {
        args.push(Buffer.from(current));
        current = [];
        started = false;
      }
    } else if (code === QUOTE) {
      quoted = true;
      started = true;
    } else {
      current.push(code & 255);
      started = true;
    }
  }
  if (quoted) return null;
  if (started) args.push(Buffer.from(current));
  return args;
}

export function escapeInline(value) {
  if (value.length > 0) {
    const text = value.toString('latin1');
    if (BARE_TOKEN_PATTERN.test(text)) return text;
  }
  let out = '"';
  for (const byte of value) {
    if (byte === QUOTE) {
      out += '\\"';
    } else if (byte === BACKSLASH) {
      out += '\\\\';
    } else if (byte === LF) {
      out += '\\n';
    } else if (byte === CR) {
      out += '\\r';
    } else if (byte === TAB) {
      out += '\\t';
    } else if (byte === 0) {
      out += '\\0';
    } else if (byte >= 32 && byte <= 126) {
      out += String.fromCharCode(byte);
    } else {
      out += '\\x' + byte.toString(16).padStart(2, '0');
    }
  }
  return out + '"';
}

export function encodeInlineLine(argsBuffers) {
  const tokens = [];
  for (const arg of argsBuffers) tokens.push(escapeInline(arg));
  return tokens.join(' ');
}

export class RequestParser {
  constructor(opts = {}) {
    const limits = { ...LIMIT_DEFAULTS, ...opts };
    this.maxArgs = limits.maxArgs;
    this.maxBulk = limits.maxBulk;
    this.maxRequest = limits.maxRequest;
    this.buffer = EMPTY_BUFFER;
    this.offset = 0;
    this.pendingRecords = 0;
    this.currentArgs = [];
    this.fatal = null;
  }

  feed(chunk) {
    if (this.fatal !== null) return { requests: [], fatal: this.fatal };
    this.append(chunk);
    if (this.buffer.length - this.offset > this.maxRequest) {
      this.fail('buffered request exceeds proto-max-request (' + this.maxRequest + ' bytes)');
      return { requests: [], fatal: this.fatal };
    }
    const requests = [];
    while (this.fatal === null) {
      const progressed = this.pendingRecords > 0 ? this.readRecord(requests) : this.readLine(requests);
      if (!progressed) break;
    }
    if (this.fatal !== null) {
      this.reset();
      return { requests, fatal: this.fatal };
    }
    if (this.offset > 0) {
      this.buffer = Buffer.from(this.buffer.subarray(this.offset));
      this.offset = 0;
    }
    return { requests, fatal: null };
  }

  append(chunk) {
    if (this.offset > 0) {
      this.buffer = this.buffer.subarray(this.offset);
      this.offset = 0;
    }
    this.buffer = this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk]);
  }

  reset() {
    this.buffer = EMPTY_BUFFER;
    this.offset = 0;
    this.pendingRecords = 0;
    this.currentArgs = [];
  }

  fail(message) {
    this.fatal = { message };
    return false;
  }

  readLine(requests) {
    const buffer = this.buffer;
    const start = this.offset;
    if (start >= buffer.length) return false;
    const newline = buffer.indexOf(LF, start);
    if (newline === -1) return false;
    const textEnd = newline > start && buffer[newline - 1] === CR ? newline - 1 : newline;
    const text = buffer.toString('latin1', start, textEnd);
    this.offset = newline + 1;
    if (BLANK_LINE_PATTERN.test(text)) {
      requests.push(null);
      return true;
    }
    const head = text.charCodeAt(0);
    if (head === HASH) {
      requests.push(null);
      return true;
    }
    if (head === PERCENT) {
      const match = COUNT_LINE_PATTERN.exec(text);
      if (match === null) return this.fail('malformed argument count line');
      const count = Number(match[1]);
      if (count > this.maxArgs) {
        return this.fail('argument count exceeds proto-max-args (' + this.maxArgs + ')');
      }
      if (count < 1 || !Number.isInteger(count)) {
        return this.fail('typed request must declare at least one argument');
      }
      this.pendingRecords = count;
      this.currentArgs = [];
      return true;
    }
    const args = parseInlineLine(text);
    if (args === null) return this.fail('malformed inline command line');
    if (args.length > this.maxArgs) {
      return this.fail('argument count exceeds proto-max-args (' + this.maxArgs + ')');
    }
    requests.push({ args });
    return true;
  }

  readRecord(requests) {
    const buffer = this.buffer;
    const start = this.offset;
    let cursor = start;
    while (cursor < buffer.length && buffer[cursor] >= DIGIT_LOW && buffer[cursor] <= DIGIT_HIGH) cursor++;
    if (cursor >= buffer.length) return false;
    if (cursor === start || buffer[cursor] !== SPACE) return this.fail('malformed bulk length line');
    const declared = Number(buffer.toString('latin1', start, cursor));
    if (declared > this.maxBulk) {
      return this.fail('bulk length exceeds proto-max-bulk (' + this.maxBulk + ' bytes)');
    }
    const payloadStart = cursor + 1;
    const payloadEnd = payloadStart + declared;
    if (buffer.length <= payloadEnd) return false;
    const terminator = buffer[payloadEnd];
    let nextOffset;
    if (terminator === LF) {
      nextOffset = payloadEnd + 1;
    } else if (terminator === CR) {
      if (buffer.length < payloadEnd + 2) return false;
      if (buffer[payloadEnd + 1] !== LF) return this.fail('missing LF after bulk payload');
      nextOffset = payloadEnd + 2;
    } else {
      return this.fail('missing LF after bulk payload');
    }
    this.currentArgs.push(Buffer.from(buffer.subarray(payloadStart, payloadEnd)));
    this.offset = nextOffset;
    this.pendingRecords -= 1;
    if (this.pendingRecords === 0) {
      requests.push({ args: this.currentArgs });
      this.currentArgs = [];
    }
    return true;
  }
}
