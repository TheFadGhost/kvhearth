import { integer, bulk } from '../proto/serializer.mjs';
import { errCmd, errArity } from '../server/errors.mjs';
import { IntOverflowSignal } from '../store/store.mjs';
import { define, guardTypes, ReplySignal, bulkArray } from './util.mjs';
import { latin } from './strings.mjs';

export function registerHashCommands(add) {
  add(define('HSET', { min: 3, max: -1, write: true }, (ctx, conn, args) =>
    guardTypes('hset', args, () => {
      const pairs = collectPairs('HSET', args);
      const added = ctx.store.hashSet(latin(args[1]), pairs.map(([f, v]) => [latin(f), latin(v)]));
      const record = ['HSET', args[1]];
      for (const [field, value] of pairs) record.push(field, value);
      return { reply: integer(added), mutations: [record] };
    })));

  add(define('HGET', { min: 2, max: 2 }, (ctx, conn, args) =>
    guardTypes('hget', args, () => {
      const value = ctx.store.hashGet(latin(args[1]), latin(args[2]));
      return { reply: bulk(value === null ? null : Buffer.from(value, 'latin1')) };
    })));

  add(define('HEXISTS', { min: 2, max: 2 }, (ctx, conn, args) =>
    guardTypes('hexists', args, () => ({ reply: integer(ctx.store.hashExists(latin(args[1]), latin(args[2])) ? 1 : 0) }))));

  add(define('HDEL', { min: 2, max: -1, write: true }, (ctx, conn, args) =>
    guardTypes('hdel', args, () => {
      const fields = args.slice(2).map(latin);
      const removed = ctx.store.hashDelete(latin(args[1]), fields);
      if (removed === 0) return { reply: integer(0) };
      return { reply: integer(removed), mutations: [['HDEL', args[1], ...args.slice(2)]] };
    })));

  add(define('HLEN', { min: 1, max: 1 }, (ctx, conn, args) =>
    guardTypes('hlen', args, () => ({ reply: integer(ctx.store.hashLen(latin(args[1]))) }))));

  add(define('HKEYS', { min: 1, max: 1 }, (ctx, conn, args) =>
    guardTypes('hkeys', args, () => {
      const entries = ctx.store.hashEntries(latin(args[1]));
      return { reply: bulkArray(entries.map(([field]) => Buffer.from(field, 'latin1'))) };
    })));

  add(define('HVALS', { min: 1, max: 1 }, (ctx, conn, args) =>
    guardTypes('hvals', args, () => {
      const entries = ctx.store.hashEntries(latin(args[1]));
      return { reply: bulkArray(entries.map(([, value]) => Buffer.from(value, 'latin1'))) };
    })));

  add(define('HGETALL', { min: 1, max: 1 }, (ctx, conn, args) =>
    guardTypes('hgetall', args, () => {
      const entries = ctx.store.hashEntries(latin(args[1]));
      const flat = [];
      for (const [field, value] of entries) flat.push(Buffer.from(field, 'latin1'), Buffer.from(value, 'latin1'));
      return { reply: bulkArray(flat) };
    })));

  add(define('HINCRBY', { min: 3, max: 3, write: true }, (ctx, conn, args) =>
    guardTypes('hincrby', args, () => {
      const deltaText = latin(args[3]);
      let delta = null;
      if (/^[+-]?\d+$/.test(deltaText)) {
        try {
          delta = BigInt(deltaText);
        } catch {
          delta = null;
        }
      }
      if (delta === null || delta < -(2n ** 63n) || delta > 2n ** 63n - 1n) {
        return { reply: errCmd('HINCRBY', `value is not an integer or out of range (${deltaText})`) };
      }
      try {
        const next = ctx.store.hashIncrementBy(latin(args[1]), latin(args[2]), delta);
        return { reply: integer(next), mutations: [['HINCRBY', args[1], args[2], args[3]]] };
      } catch (err) {
        if (err instanceof IntOverflowSignal) {
          return { reply: errCmd('HINCRBY', 'increment would overflow 64-bit integer') };
        }
        throw err;
      }
    })));
}

function collectPairs(cmd, args) {
  const rest = args.slice(2);
  if (rest.length % 2 !== 0) {
    throw new ReplySignal(errArity(cmd, 'field value pairs (even count)', rest.length));
  }
  const pairs = [];
  for (let i = 0; i < rest.length; i += 2) pairs.push([rest[i], rest[i + 1]]);
  return pairs;
}
