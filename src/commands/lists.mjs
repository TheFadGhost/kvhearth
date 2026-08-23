import { integer, bulk, simple } from '../proto/serializer.mjs';
import { errRange, errCmd } from '../server/errors.mjs';
import { define, parseIntArg, guardTypes, ReplySignal, requireArgCount, bulkArray } from './util.mjs';
import { latin } from './strings.mjs';

export function registerListCommands(add) {
  add(define('LPUSH', { min: 2, max: -1, write: true }, (ctx, conn, args) =>
    guardTypes('lpush', args, () => pushCommand(ctx, args, 'LPUSH', true))));

  add(define('RPUSH', { min: 2, max: -1, write: true }, (ctx, conn, args) =>
    guardTypes('rpush', args, () => pushCommand(ctx, args, 'RPUSH', false))));

  for (const [verb, front] of [['LPOP', true], ['RPOP', false]]) {
    add(define(verb, { min: 1, max: 2, write: true }, (ctx, conn, args) =>
      guardTypes(verb.toLowerCase(), args, () => popCommand(ctx, args, verb, front))));
  }

  add(define('LLEN', { min: 1, max: 1 }, (ctx, conn, args) =>
    guardTypes('llen', args, () => ({ reply: integer(ctx.store.listLen(latin(args[1]))) }))));

  add(define('LRANGE', { min: 3, max: 3 }, (ctx, conn, args) =>
    guardTypes('lrange', args, () => {
      const start = parseIntArg('LRANGE', args, 2, 'start');
      const stop = parseIntArg('LRANGE', args, 3, 'stop');
      const items = ctx.store.listRange(latin(args[1]), start, stop);
      return { reply: bulkArray(items.map((v) => Buffer.from(v, 'latin1'))) };
    })));

  add(define('LINDEX', { min: 2, max: 2 }, (ctx, conn, args) =>
    guardTypes('lindex', args, () => {
      const index = parseIntArg('LINDEX', args, 2, 'index');
      const found = ctx.store.listIndex(latin(args[1]), index);
      return { reply: bulk(found === undefined ? null : Buffer.from(found, 'latin1')) };
    })));

  add(define('LSET', { min: 3, max: 3, write: true }, (ctx, conn, args) =>
    guardTypes('lset', args, () => {
      const index = parseIntArg('LSET', args, 2, 'index');
      const outcome = ctx.store.listSet(latin(args[1]), index, latin(args[3]));
      if (outcome === 'nokey') throw new ReplySignal(errCmd('LSET', 'no such key'));
      if (outcome === 'range') throw new ReplySignal(errRange('LSET', 'index', 'out of range'));
      return { reply: simple('OK'), mutations: [['LSET', args[1], String(index), args[3]]] };
    })));

  add(define('LTRIM', { min: 3, max: 3, write: true }, (ctx, conn, args) =>
    guardTypes('ltrim', args, () => {
      const start = parseIntArg('LTRIM', args, 2, 'start');
      const stop = parseIntArg('LTRIM', args, 3, 'stop');
      ctx.store.listTrim(latin(args[1]), start, stop);
      return { reply: simple('OK'), mutations: [['LTRIM', args[1], String(start), String(stop)]] };
    })));
}

function pushCommand(ctx, args, verb, front) {
  requireArgCount(verb, args, 2);
  const key = latin(args[1]);
  const newLength = ctx.store.listPush(key, args.slice(2).map(latin), front);
  const positional = args.slice(2);
  const canonicalItems = front ? [...positional].reverse() : positional;
  return {
    reply: integer(newLength),
    mutations: [[verb, args[1], ...canonicalItems]],
    pushedKey: args[1],
    pushedSide: front ? 'left' : 'right',
  };
}

function popCommand(ctx, args, verb, front) {
  let count = null;
  if (args.length === 3) count = parseIntArg(verb, args, 2, 'count');
  const key = latin(args[1]);
  const popped = ctx.store.listPop(key, front, count);
  if (count === null) {
    if (popped === null) return { reply: bulk(null) };
    return {
      reply: bulk(Buffer.from(popped, 'latin1')),
      mutations: [[verb, args[1]]],
      poppedKey: args[1],
    };
  }
  if (popped.length === 0) return { reply: bulkArray([]) };
  return {
    reply: bulkArray(popped.map((v) => Buffer.from(v, 'latin1'))),
    mutations: [[verb, args[1]]],
    poppedKey: args[1],
  };
}
