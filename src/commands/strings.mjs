import { integer, bulk, simple } from '../proto/serializer.mjs';
import { errCmd, errRange, errOom } from '../server/errors.mjs';
import { parseSignedInt64, IntOverflowSignal } from '../store/store.mjs';
import {
  define,
  requireArgCount,
  guardTypes,
  parseIntArg,
  ReplySignal,
  keyLabel,
} from './util.mjs';

export function registerStringCommands(add) {
  add(define('GET', { min: 1, max: 1 }, (ctx, conn, args) =>
    guardTypes('get', args, () => {
      const value = ctx.store.stringGet(latin(args[1]));
      return { reply: bulk(value === null ? null : Buffer.from(value, 'latin1')) };
    })));

  add(define('SET', { min: 2, max: -1, write: true }, (ctx, conn, args) => handleSet(ctx, args)));

  add(define('APPEND', { min: 2, max: 2, write: true }, (ctx, conn, args) =>
    guardTypes('append', args, () => {
      const newLength = ctx.store.stringAppend(latin(args[1]), latin(args[2]));
      return { reply: integer(newLength), mutations: [['APPEND', args[1], args[2]]] };
    })));

  add(define('STRLEN', { min: 1, max: 1 }, (ctx, conn, args) =>
    guardTypes('strlen', args, () => {
      const value = ctx.store.stringGet(latin(args[1]));
      return { reply: integer(value === null ? 0 : Buffer.byteLength(value, 'latin1')) };
    })));

  for (const [verb, deltaSign] of [['INCR', 1n], ['DECR', -1n]]) {
    add(define(verb, { min: 1, max: 1, write: true }, (ctx, conn, args) =>
      counterOp(ctx, args, deltaSign)));
  }
  for (const [verb, deltaSign] of [['INCRBY', 1n], ['DECRBY', -1n]]) {
    add(define(verb, { min: 2, max: 2, write: true }, (ctx, conn, args) => {
      const parsed = parseSignedInt64(latin(args[2]));
      if (parsed === null || parsed === undefined) {
        return { reply: errCmd('INCRBY', `value is not an integer or out of range (${latin(args[2])})`) };
      }
      return counterOp(ctx, args, deltaSign * parsed);
    }));
  }

  add(define('GETRANGE', { min: 3, max: 3 }, (ctx, conn, args) =>
    guardTypes('getrange', args, () => {
      const start = parseIntArg('GETRANGE', args, 2, 'start');
      const end = parseIntArg('GETRANGE', args, 3, 'end');
      const value = ctx.store.stringGet(latin(args[1]));
      if (value === null) return { reply: bulk(Buffer.alloc(0)) };
      const bytes = Buffer.from(value, 'latin1');
      let s = start < 0 ? bytes.length + start : start;
      let e = end < 0 ? bytes.length + end : end;
      if (s < 0) s = 0;
      if (e >= bytes.length) e = bytes.length - 1;
      if (s > e || bytes.length === 0) return { reply: bulk(Buffer.alloc(0)) };
      return { reply: bulk(bytes.subarray(s, e + 1)) };
    })));

  add(define('SETRANGE', { min: 3, max: 3, write: true }, (ctx, conn, args) =>
    guardTypes('setrange', args, () => {
      const offset = parseIntArg('SETRANGE', args, 2, 'offset');
      if (offset < 0) throw new ReplySignal(errRange('SETRANGE', 'offset', 'must be non-negative'));
      if (offset > 512 * 1024 * 1024) throw new ReplySignal(errRange('SETRANGE', 'offset', 'exceeds maximum of 536870912'));
      const patch = args[3];
      const current = ctx.store.stringGet(latin(args[1]));
      const base = current === null ? Buffer.alloc(0) : Buffer.from(current, 'latin1');
      if (base.length === 0 && patch.length === 0) {
        return { reply: integer(0), mutations: [] };
      }
      const needed = offset + patch.length;
      const out = needed > base.length ? Buffer.alloc(needed) : Buffer.from(base);
      if (needed > base.length) base.copy(out);
      patch.copy(out, offset);
      ctx.store.stringSet(latin(args[1]), out.toString('latin1'), { expireMode: 'keep' });
      return { reply: integer(out.length), mutations: [['SETRANGE', args[1], String(offset), patch]] };
    })));
}

function counterOp(ctx, args, delta) {
  return guardTypes(args[0].toString('latin1').toLowerCase(), args, () => {
    try {
      const read = ctx.store.counterRead(latin(args[1]));
      const current = read.missing ? 0n : read.value;
      const next = current + delta;
      if (next > 2n ** 63n - 1n || next < -(2n ** 63n)) {
        return {
          reply: errCmd(
            args[0].toString('latin1').toUpperCase(),
            `increment would overflow 64-bit integer (key '${keyLabel(args[1])}')`,
          ),
        };
      }
      ctx.store.counterWrite(latin(args[1]), next);
      const canonical = args[0].toString('latin1').toUpperCase();
      const mutations = [[canonical, args[1]]];
      if (args.length === 3) mutations[0].push(args[2]);
      return { reply: integer(next), mutations };
    } catch (err) {
      if (err instanceof IntOverflowSignal) {
        return { reply: errCmd(args[0].toString('latin1').toUpperCase(), 'value is not an integer or out of range') };
      }
      throw err;
    }
  });
}

function handleSet(ctx, args) {
  requireArgCount('SET', args, 2, 8);
  const options = parseSetOptions(args);
  if (options.errorReply) return { reply: options.errorReply };
  const expireAtMs = resolveExpireAt(ctx, options);
  const result = ctx.store.stringSet(latin(args[1]), latin(args[2]), {
    expireMode: options.keepttl && expireAtMs === null ? 'keep' : expireAtMs ?? 'none',
    nx: options.nx,
    xx: options.xx,
  });
  if (result === 'skipped') return { reply: bulk(null) };
  const record = ['SET', args[1], args[2]];
  if (options.expireSeconds !== undefined) record.push(options.expireFlag, args[options.expireValueIndex]);
  if (options.nx) record.push('NX');
  if (options.xx) record.push('XX');
  if (options.keepttl) record.push('KEEPTTL');
  return { reply: simple('OK'), mutations: [record] };
}

function parseSetOptions(args) {
  const options = { nx: false, xx: false, keepttl: false, expireSeconds: undefined, expireFlag: null, expireValueIndex: -1 };
  let position = 3;
  while (position < args.length) {
    const flag = latin(args[position]).toUpperCase();
    switch (flag) {
      case 'NX':
        options.nx = true;
        break;
      case 'XX':
        options.xx = true;
        break;
      case 'KEEPTTL':
        options.keepttl = true;
        break;
      case 'EX':
      case 'PX': {
        if (position + 1 >= args.length) {
          return { errorReply: errCmd('SET', `option ${flag} requires a value`) };
        }
        const raw = latin(args[position + 1]);
        if (!/^\d+$/.test(raw)) {
          return { errorReply: errRange('SET', flag.toLowerCase(), 'must be a positive integer') };
        }
        const magnitude = Number(raw);
        if (!Number.isSafeInteger(magnitude)) {
          return { errorReply: errRange('SET', flag.toLowerCase(), 'value out of supported range') };
        }
        options.expireSeconds = flag === 'EX' ? magnitude * 1000 : magnitude;
        options.expireFlag = flag;
        options.expireValueIndex = position + 1;
        position++;
        break;
      }
      default:
        return { errorReply: errCmd('SET', `unsupported option '${latin(args[position])}'`) };
    }
    position++;
  }
  if (options.nx && options.xx) {
    return { errorReply: errCmd('SET', 'syntax error: NX and XX are mutually exclusive') };
  }
  if (options.keepttl && options.expireSeconds !== undefined) {
    return { errorReply: errCmd('SET', 'syntax error: KEEPTTL cannot be combined with EX or PX') };
  }
  return options;
}

function resolveExpireAt(ctx, options) {
  if (options.expireSeconds === undefined) return null;
  return ctx.store.nowMs() + options.expireSeconds;
}

export function latin(buffer) {
  return buffer.toString('latin1');
}

export function oomIfLimited(ctx, cmd) {
  if (ctx.evictor.limit > 0 && !ctx.evictor.enforce()) {
    return errOom(cmd.toUpperCase(), ctx.evictor.limit);
  }
  return null;
}
