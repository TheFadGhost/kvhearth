import { integer, array } from '../proto/serializer.mjs';
import { define, guardTypes, requireArgCount, bulkArray } from './util.mjs';
import { latin } from './strings.mjs';

export function registerSetCommands(add) {
  add(define('SADD', { min: 2, max: -1, write: true }, (ctx, conn, args) =>
    guardTypes('sadd', args, () => {
      const members = args.slice(2).map(latin);
      const added = ctx.store.setAdd(latin(args[1]), members);
      if (added === 0) return { reply: integer(0) };
      return { reply: integer(added), mutations: [['SADD', args[1], ...args.slice(2)]] };
    })));

  add(define('SREM', { min: 2, max: -1, write: true }, (ctx, conn, args) =>
    guardTypes('srem', args, () => {
      const removed = ctx.store.setRemove(latin(args[1]), args.slice(2).map(latin));
      if (removed === 0) return { reply: integer(0) };
      return { reply: integer(removed), mutations: [['SREM', args[1], ...args.slice(2)]] };
    })));

  add(define('SISMEMBER', { min: 2, max: 2 }, (ctx, conn, args) =>
    guardTypes('sismember', args, () => ({
      reply: integer(ctx.store.setIsMember(latin(args[1]), latin(args[2])) ? 1 : 0),
    }))));

  add(define('SMEMBERS', { min: 1, max: 1 }, (ctx, conn, args) =>
    guardTypes('smembers', args, () => ({
      reply: bulkArray(ctx.store.setMembers(latin(args[1])).map((m) => Buffer.from(m, 'latin1'))),
    }))));

  add(define('SCARD', { min: 1, max: 1 }, (ctx, conn, args) =>
    guardTypes('scard', args, () => ({ reply: integer(ctx.store.setCard(latin(args[1]))) }))));

  for (const [verb, op] of [['SINTER', intersect], ['SUNION', union], ['SDIFF', difference]]) {
    add(define(verb, { min: 1, max: -1 }, (ctx, conn, args) =>
      guardTypes(verb.toLowerCase(), args, () => {
        requireArgCount(verb, args, 1);
        const sets = ctx.store.readSetsForAlgebra(args.slice(1).map(latin));
        return { reply: bulkArray(Array.from(op(sets)).map((m) => Buffer.from(m, 'latin1'))) };
      })));
  }

  for (const [verb, op] of [['SINTERSTORE', intersect], ['SUNIONSTORE', union], ['SDIFFSTORE', difference]]) {
    add(define(verb, { min: 2, max: -1, write: true }, (ctx, conn, args) =>
      guardTypes(verb.toLowerCase(), args, () => storeAlgebra(ctx, args, verb, op))));
  }
}

function storeAlgebra(ctx, args, verb, op) {
  requireArgCount(verb, args, 2);
  const destination = latin(args[1]);
  const sets = ctx.store.readSetsForAlgebra(args.slice(2).map(latin));
  const result = Array.from(op(sets));
  ctx.store.storeSet(destination, result);
  return { reply: integer(result.length), mutations: [], restoreRecord: [args[1]] };
}

function intersect(sets) {
  const base = sets[0];
  const result = new Set();
  outer: for (const member of base) {
    for (let i = 1; i < sets.length; i++) {
      if (!sets[i].has(member)) continue outer;
    }
    result.add(member);
  }
  return result;
}

function union(sets) {
  const result = new Set();
  for (const set of sets) {
    for (const member of set) result.add(member);
  }
  return result;
}

function difference(sets) {
  const result = new Set();
  const rest = sets.slice(1);
  for (const member of sets[0]) {
    if (!rest.some((s) => s.has(member))) result.add(member);
  }
  return result;
}
