import { Buffer } from 'node:buffer';

const ERROR_CODES = new Set(['PROTO', 'ERR', 'WRONGTYPE', 'RANGE', 'OOM', 'SRV']);
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;
const LF = Buffer.from('\n', 'ascii');

function asciiBytes(text) {
  return Buffer.from(text, 'ascii');
}

function rejectLineBreaks(text, label) {
  if (/[\r\n]/.test(text)) throw new RangeError(label + ' must not contain CR or LF');
}

function argBytes(value) {
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (Buffer.isBuffer(value)) return value;
  throw new TypeError('expected a string or a Buffer');
}

export function simple(text) {
  if (typeof text !== 'string') throw new TypeError('simple expects a string');
  rejectLineBreaks(text, 'simple text');
  return asciiBytes('+' + text + '\n');
}

export function error(code, message) {
  if (!ERROR_CODES.has(code)) throw new RangeError('unknown error code: ' + String(code));
  if (typeof message !== 'string' || message.length === 0) {
    throw new TypeError('error expects a non-empty message string');
  }
  rejectLineBreaks(message, 'error message');
  return asciiBytes('-' + code + ' ' + message + '\n');
}

export function integer(value) {
  let int64;
  if (typeof value === 'bigint') {
    int64 = value;
  } else if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw new RangeError('integer expects an integral number');
    int64 = BigInt(value);
  } else {
    throw new TypeError('integer expects a Number or a BigInt');
  }
  if (int64 < INT64_MIN || int64 > INT64_MAX) {
    throw new RangeError('integer outside signed 64-bit range: ' + int64.toString());
  }
  return asciiBytes(':' + int64.toString() + '\n');
}

export function bulk(value) {
  if (value === null) return asciiBytes('$-1\n');
  const bytes = argBytes(value);
  return Buffer.concat([asciiBytes('$' + bytes.length + '\n'), bytes, LF]);
}

export function array(items) {
  if (!Array.isArray(items)) throw new TypeError('array expects an Array of reply Buffers');
  for (const item of items) {
    if (!Buffer.isBuffer(item)) throw new TypeError('array expects an Array of reply Buffers');
  }
  return Buffer.concat([asciiBytes('*' + items.length + '\n')].concat(items));
}

export function nilArray() {
  return asciiBytes('*-1\n');
}

export function encodeTypedRequest(args) {
  if (!Array.isArray(args)) throw new TypeError('encodeTypedRequest expects an Array of strings or Buffers');
  if (args.length < 1) throw new RangeError('typed request needs at least one argument');
  const parts = [asciiBytes('%' + args.length + '\n')];
  for (const arg of args) {
    const bytes = argBytes(arg);
    parts.push(asciiBytes(bytes.length + ' '), bytes, LF);
  }
  return Buffer.concat(parts);
}
