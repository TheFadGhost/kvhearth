import { integer, bulk, simple, array, nilArray } from '../proto/serializer.mjs';
import { errCmd, errRange } from '../server/errors.mjs';
import { define, guardTypes, parseIntArg, requireArgCount, ReplySignal, bulkArray } from './util.mjs';
import { latin } from './strings.mjs';
import { parseScore } from '../store/store.mjs';
import { formatScore } from '../persist/snapshot.mjs';

export function registerZsetCommands(add) {
  add(define('ZADD', { min: 3, max: -1, write: true }, (ctx, conn, args) =>
    guardTypes('zadd', args, () => zaddCommand(ctx, args))));

  add(define('ZSCORE', { min: 2, max: 2 }, (ctx, conn, args) =>
    guardTypes('zscore', args, () => {
      const score = ctx.store.zsetScore(latin(args[1]), latin(args[2]));
      return { reply: score === undefined ? bulk(null) : bulk(Buffer.from(formatScore(score), 'latin1')) };
    })));

  add(define('ZINCRBY', { min: 3, max: 3, write: true }, (ctx, conn, args) =>
    guardTypes('zincrby', args, () => {
      const delta = parseScore(latin(args[2]));
      if (delta === null) throw new ReplySignal(errCmd('ZINCRBY', `value is not a valid float (${latin(args[2])})`));
      const member = latin(args[3]);
      const next = ctx.store.zsetIncrementBy(latin(args[1]), member, delta);
      if (next === undefined) {
        throw new ReplySignal(errCmd('ZINCRBY', 'increment would produce a non-finite score'));
      }
      return {
        reply: bulk(Buffer.from(formatScore(next), 'latin1')),
        mutations: [['ZINCRBY', args[1], args[2], args[3]]],
      };
    })));

  add(define('ZCARD', { min: 1, max: 1 }, (ctx, conn, args) =>
    guardTypes('zcard', args, () => ({ reply: integer(ctx.store.zsetCard(latin(args[1]))) }))));

  add(define('ZCOUNT', { min: 3, max: 3 }, (ctx, conn, args) =>
    guardTypes('zcount', args, () => {
      const min = parseBound('ZCOUNT', 'min', args[2]);
      const max = parseBound('ZCOUNT', 'max', args[3]);
      const view = ctx.store.zsetSortedView(latin(args[1]));
      let count = 0;
      if (view !== null) {
        for (const [, score] of view) {
          if (boundContains(min, score) && boundContains(max, score, true)) count++;
        }
      }
      return { reply: integer(count) };
    })));

  for (const [verb, reverse] of [['ZRANK', false], ['ZREVRANK', true]]) {
    add(define(verb, { min: 2, max: 2 }, (ctx, conn, args) =>
      guardTypes(verb.toLowerCase(), args, () => {
        const view = ctx.store.zsetSortedView(latin(args[1]));
        const member = latin(args[2]);
        if (view === null) return { reply: bulk(null) };
        const ordered = reverse ? [...view].reverse() : view;
        const index = ordered.findIndex(([m]) => m === member);
        return { reply: index === -1 ? bulk(null) : integer(index) };
      })));
  }

  add(define('ZRANGE', { min: 3, max: 4 }, (ctx, conn, args) =>
    guardTypes('zrange', args, () => {
      const start = parseIntArg('ZRANGE', args, 2, 'start');
      const stop = parseIntArg('ZRANGE', args, 3, 'stop');
      const withScores = hasFlag(args, 4, 'WITHSCORES');
      const view = ctx.store.zsetSortedView(latin(args[1]));
      if (view === null) return { reply: array([]) };
      const ordered = view;
      const length = ordered.length;
      let s = start < 0 ? length + start : start;
      let e = stop < 0 ? length + stop : stop;
      if (s < 0) s = 0;
      if (e >= length) e = length - 1;
      if (s > e || length === 0) return { reply: array([]) };
      return { reply: renderSlice(ordered.slice(s, e + 1), withScores) };
    })));

  add(define('ZRANGEBYSCORE', { min: 3, max: 7 }, (ctx, conn, args) =>
    guardTypes('zrangebyscore', args, () => zrangeByScore(ctx, args, false))));
  add(define('ZREVRANGEBYSCORE', { min: 3, max: 7 }, (ctx, conn, args) =>
    guardTypes('zrevrangebyscore', args, () => zrangeByScore(ctx, args, true))));

  add(define('ZREM', { min: 2, max: -1, write: true }, (ctx, conn, args) =>
    guardTypes('zrem', args, () => {
      const members = args.slice(2).map(latin);
      const removed = ctx.store.zsetRemove(latin(args[1]), members);
      if (removed === 0) return { reply: integer(0) };
      return { reply: integer(removed), mutations: [['ZREM', args[1], ...args.slice(2)]] };
    })));
}

function zaddCommand(ctx, args) {
  let nx = false;
  let xx = false;
  let ch = false;
  let position = 2;
  for (;;) {
    const flag = latin(args[position]).toUpperCase();
    if (flag === 'NX') nx = true;
    else if (flag === 'XX') xx = true;
    else if (flag === 'CH') ch = true;
    else break;
    position++;
    if (position >= args.length) {
      throw new ReplySignal(errCmd('ZADD', 'wrong number of arguments (no score member pairs after flags)'));
    }
  }
  const rest = args.slice(position);
  if (rest.length < 2 || rest.length % 2 !== 0) {
    throw new ReplySignal(requireArityError('ZADD'));
  }
  const pairs = [];
  for (let i = 0; i < rest.length; i += 2) {
    const score = parseScore(latin(rest[i]));
    if (score === null) {
      throw new ReplySignal(errRange('ZADD', 'score', `not a valid float (${latin(rest[i])})`));
    }
    pairs.push([latin(rest[i + 1]), score]);
  }
  const { added, changed } = ctx.store.zsetAdd(latin(args[1]), pairs, { nx, xx, ch });
  const record = ['ZADD', args[1]];
  for (const [member, score] of pairs) {
    record.push(Buffer.from(formatScore(score), 'latin1'), Buffer.from(member, 'latin1'));
  }
  return { reply: integer(ch ? changed : added), mutations: [record] };
}

function requireArityError(cmd) {
  return errCmd(cmd, 'wrong number of arguments (expected score member pairs)');
}

function zrangeByScore(ctx, args, reverse) {
  const cmd = reverse ? 'ZREVRANGEBYSCORE' : 'ZRANGEBYSCORE';
  const first = parseBound(cmd, reverse ? 'max' : 'min', args[2]);
  const second = parseBound(cmd, reverse ? 'min' : 'max', args[3]);
  const min = reverse ? second : first;
  const max = reverse ? first : second;
  let withScores = false;
  let offset = 0;
  let count = Infinity;
  let position = 4;
  while (position < args.length) {
    const flag = latin(args[position]).toUpperCase();
    if (flag === 'WITHSCORES') {
      withScores = true;
    } else if (flag === 'LIMIT') {
      if (position + 2 >= args.length) {
        throw new ReplySignal(errRange(cmd, 'LIMIT', 'requires an offset and a count'));
      }
      offset = parseIntArg(cmd, args, position + 1, 'offset');
      count = parseIntArg(cmd, args, position + 2, 'count');
      if (offset < 0) throw new ReplySignal(errRange(cmd, 'offset', 'must be non-negative'));
      position += 2;
    } else {
      throw new ReplySignal(errCmd(cmd, `unsupported option '${latin(args[position])}'`));
    }
    position++;
  }
  const view = ctx.store.zsetSortedView(latin(args[1]));
  if (view === null) return { reply: array([]) };
  const matched = [];
  for (const [member, score] of view) {
    if (boundContains(min, score) && boundContains(max, score, true)) matched.push([member, score]);
  }
  const ordered = reverse ? [...matched].reverse() : matched;
  const slice = count < 0 ? ordered.slice(offset) : ordered.slice(offset, offset + Math.max(count, 0));
  return { reply: renderSlice(slice, withScores) };
}

function renderSlice(slice, withScores) {
  if (!withScores) return bulkArray(slice.map(([member]) => Buffer.from(member, 'latin1')));
  const flat = [];
  for (const [member, score] of slice) {
    flat.push(Buffer.from(member, 'latin1'), Buffer.from(formatScore(score), 'latin1'));
  }
  return bulkArray(flat);
}


export function parseBound(cmd, name, argBuffer) {
  const text = latin(argBuffer);
  let exclusive = false;
  let body = text;
  if (body.startsWith('(')) {
    exclusive = true;
    body = body.slice(1);
  }
  const value = parseScore(body);
  if (value === null) {
    throw new ReplySignal(errRange(cmd, name, `not a valid float or inf (${text})`));
  }
  return { value, exclusive };
}

export function boundContains(bound, score, isMax = false) {
  if (isMax) {
    if (bound.exclusive) return score < bound.value;
    return score <= bound.value;
  }
  if (bound.exclusive) return score > bound.value;
  return score >= bound.value;
}

function hasFlag(args, from, flagName) {
  for (let i = from; i < args.length; i++) {
    if (latin(args[i]).toUpperCase() === flagName) return true;
  }
  return false;
}
