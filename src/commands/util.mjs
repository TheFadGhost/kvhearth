import {
  errArity,
  errCmd,
  errRange,
  errWrongType,
} from '../server/errors.mjs';
import { WrongTypeSignal, NotIntegerSignal } from '../store/store.mjs';
import { escapeInline } from '../proto/parser.mjs';
import { array as encodeArray, bulk as encodeBulk } from '../proto/serializer.mjs';

export function bulkArray(values) {
  return encodeArray(values.map((value) => encodeBulk(value)));
}

export const NO_REPLY = Symbol('no-reply');

export function keyLabel(argBuffer) {
  return escapeInline(argBuffer);
}

export function requireArgCount(cmd, args, min, max = Infinity) {
  const n = args.length - 1;
  if (n < min || n > max) {
    const expectation = max === Infinity ? `${min} or more` : min === max ? min : `${min}..${max}`;
    throw new AritySignal(errArity(cmd.toUpperCase(), expectation, n));
  }
}

export class AritySignal extends Error {
  constructor(reply) {
    super('arity');
    this.reply = reply;
  }
}

export function parseIntArg(cmd, args, position, name) {
  const text = args[position].toString('latin1');
  if (!/^[+-]?\d+$/.test(text)) {
    throw new ReplySignal(errRange(cmd.toUpperCase(), name, 'must be an integer'));
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value)) {
    throw new ReplySignal(errRange(cmd.toUpperCase(), name, 'integer out of supported range'));
  }
  return value;
}

export function parseFloatArg(cmd, args, position, name) {
  const text = args[position].toString('latin1');
  const value = Number(text);
  if (!Number.isFinite(value)) {
    throw new ReplySignal(errRange(cmd.toUpperCase(), name, 'must be a number'));
  }
  return value;
}

export class ReplySignal extends Error {
  constructor(reply) {
    super('reply');
    this.reply = reply;
  }
}

export function wrongTypeReply(cmd, args, signal) {
  const label = args.length > 1 ? keyLabel(args[1]) : '?';
  return errWrongType(cmd.toUpperCase(), label, signal.actual, signal.expected);
}

export function guardTypes(cmd, args, fn) {
  try {
    return fn();
  } catch (err) {
    if (err instanceof WrongTypeSignal) return { reply: wrongTypeReply(cmd, args, err) };
    if (err instanceof NotIntegerSignal) {
      return { reply: errCmd(cmd.toUpperCase(), `value is not an integer or out of range (${err.valueText})`) };
    }
    throw err;
  }
}

export function bulkFromText(text) {
  return Buffer.from(text, 'latin1');
}

export function define(name, meta, handler) {
  return { name, meta, handler };
}
