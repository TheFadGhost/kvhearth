import { integer, simple, bulk, array } from '../proto/serializer.mjs';
import { errCmd, errRange } from '../server/errors.mjs';
import { define, parseIntArg, ReplySignal, bulkArray } from './util.mjs';
import { latin } from './strings.mjs';

export function registerKeyCommands(add) {
  add(define('DEL', { min: 1, max: -1, write: true }, (ctx, conn, args) => {
    let removed = 0;
    const touchedKeys = [];
    for (let i = 1; i < args.length; i++) {
      if (ctx.store.deleteKey(latin(args[i]))) {
        removed++;
        touchedKeys.push(args[i]);
      }
    }
    const mutations = touchedKeys.map((key) => ['DEL', key]);
    return { reply: integer(removed), mutations };
  }));

  add(define('EXISTS', { min: 1, max: -1 }, (ctx, conn, args) => {
    let count = 0;
    for (let i = 1; i < args.length; i++) {
      if (ctx.store.typeOf(latin(args[i])) !== 'none') count++;
    }
    return { reply: integer(count) };
  }));

  add(define('TYPE', { min: 1, max: 1 }, (ctx, conn, args) => ({
    reply: simple(ctx.store.typeOf(latin(args[1]))),
  })));

  for (const [verb, unit] of [['EXPIRE', 1000], ['PEXPIRE', 1]]) {
    add(define(verb, { min: 2, max: 2, write: true }, (ctx, conn, args) =>
      expireRelative(ctx, args, verb, unit)));
  }

  for (const [verb, unit] of [['EXPIREAT', 1000], ['PEXPIREAT', 1]]) {
    add(define(verb, { min: 2, max: 2, write: true }, (ctx, conn, args) =>
      expireAbsolute(ctx, args, verb, unit)));
  }

  add(define('TTL', { min: 1, max: 1 }, (ctx, conn, args) => {
    const msLeft = ctx.store.ttlOf(latin(args[1]));
    return { reply: integer(msLeft <= -2 ? msLeft : msLeft === -1 ? -1 : Math.ceil(msLeft / 1000)) };
  }));

  add(define('PTTL', { min: 1, max: 1 }, (ctx, conn, args) => ({
    reply: integer(ctx.store.ttlOf(latin(args[1]))),
  })));

  add(define('PERSIST', { min: 1, max: 1, write: true }, (ctx, conn, args) => {
    const cleared = ctx.store.persistExpire(latin(args[1]));
    return { reply: integer(cleared ? 1 : 0), mutations: cleared ? [['PERSIST', args[1]]] : [] };
  }));

  add(define('RENAME', { min: 2, max: 2, write: true }, (ctx, conn, args) => {
    const source = latin(args[1]);
    const target = latin(args[2]);
    const entryBefore = ctx.store.getEntry(source);
    if (entryBefore === null) {
      throw new ReplySignal(errCmd('RENAME', `no such key '${args[1].toString('latin1')}'`));
    }
    ctx.store.renameKey(source, target);
    return { reply: simple('OK'), mutations: [], renameRecord: [args[1], args[2]] };
  }));

  add(define('RENAMENX', { min: 2, max: 2, write: true }, (ctx, conn, args) => {
    const source = latin(args[1]);
    const target = latin(args[2]);
    if (ctx.store.getEntry(source) === null) {
      throw new ReplySignal(errCmd('RENAMENX', `no such key '${source}'`));
    }
    if (ctx.store.typeOf(target) !== 'none') return { reply: integer(0) };
    ctx.store.renameKey(source, target);
    return { reply: integer(1), mutations: [], renameRecord: [args[1], args[2]] };
  }));

  add(define('DBSIZE', { min: 0, max: 0 }, ctx => ({ reply: integer(ctx.store.logicalCount()) })));

  add(define('SCAN', { min: 1, max: -1 }, (ctx, conn, args) => scanCommand(ctx, conn, args)));

  add(define('MEMORY', { min: 2, max: 2 }, (ctx, conn, args) => {
    const sub = latin(args[1]).toUpperCase();
    if (sub !== 'USAGE') {
      throw new ReplySignal(errCmd('MEMORY', `unsupported subcommand '${latin(args[1])}'`));
    }
    const entry = ctx.store.getEntry(latin(args[2]));
    if (entry === null) return { reply: bulk(null) };
    return { reply: integer(entry.bytes) };
  }));
}

function expireRelative(ctx, args, verb, unitMultiplier) {
  const seconds = parseIntArg(verb.toUpperCase(), args, 2, 'seconds');
  const key = latin(args[1]);
  let reply;
  let mutations = [];
  if (seconds <= 0) {
    const deleted = ctx.store.deleteKey(key);
    reply = integer(deleted ? 1 : 0);
    if (deleted) mutations = [['DEL', args[1]]];
  } else if (seconds > Number.MAX_SAFE_INTEGER / unitMultiplier) {
    throw new ReplySignal(errCmd(verb.toUpperCase(), 'value is out of supported range'));
  } else {
    const deadline = ctx.store.nowMs() + seconds * unitMultiplier;
    const applied = ctx.store.setExpireMs(key, deadline);
    reply = integer(applied ? 1 : 0);
    if (applied) mutations = [[verb.toUpperCase(), args[1], String(seconds)]];
  }
  return { reply, mutations };
}

function expireAbsolute(ctx, args, verb, unitMultiplier) {
  const whenText = latin(args[2]);
  if (!/^\d+$/.test(whenText)) {
    throw new ReplySignal(errRange(verb.toUpperCase(), 'timestamp', 'must be a non-negative integer'));
  }
  const whenMs = Number(whenText) * unitMultiplier;
  if (!Number.isSafeInteger(whenMs)) {
    throw new ReplySignal(errCmd(verb.toUpperCase(), 'timestamp out of supported range'));
  }
  const applied = ctx.store.setExpireMs(latin(args[1]), whenMs);
  return {
    reply: integer(applied ? 1 : 0),
    mutations: applied ? [[verb.toUpperCase(), args[1], String(Number(whenText))]] : [],
  };
}

function scanCommand(ctx, conn, args) {
  const cursorText = latin(args[1]);
  if (!/^\d+$/.test(cursorText)) {
    throw new ReplySignal(errCmd('SCAN', `invalid cursor '${cursorText}'`));
  }
  let matchPattern = null;
  let typeFilter = null;
  let countHint = 64;
  let position = 2;
  while (position < args.length) {
    const flag = latin(args[position]).toUpperCase();
    if (flag === 'MATCH' && position + 1 < args.length) {
      matchPattern = latin(args[position + 1]);
      position += 2;
    } else if (flag === 'COUNT' && position + 1 < args.length) {
      countHint = parseIntArg('SCAN', args, position + 1, 'count');
      if (countHint <= 0) countHint = 1;
      if (countHint > 1000) countHint = 1000;
      position += 2;
    } else if (flag === 'TYPE' && position + 1 < args.length) {
      typeFilter = latin(args[position + 1]).toLowerCase();
      position += 2;
    } else {
      throw new ReplySignal(errCmd('SCAN', `unsupported or incomplete option '${latin(args[position])}'`));
    }
  }
  const startIndex = Number(cursorText);
  if (!Number.isSafeInteger(startIndex)) {
    throw new ReplySignal(errCmd('SCAN', `cursor out of range '${cursorText}'`));
  }
  void conn;
  const glob = ctx.glob;
  const collected = [];
  let index = startIndex;
  let nextIndex = 0;
  let scanned = 0;
  const scanBudget = Math.max(countHint * 8, countHint);
  for (;;) {
    const page = ctx.store.iterateFrom(index, countHint);
    let offset = 0;
    for (; offset < page.items.length; offset++) {
      scanned++;
      const [key, entry] = page.items[offset];
      if (typeFilter !== null && entry.type !== typeFilter) continue;
      if (matchPattern !== null && !glob(matchPattern, key)) continue;
      collected.push(Buffer.from(key, 'latin1'));
      if (collected.length >= countHint) break;
    }
    if (offset < page.items.length) {
      nextIndex = index + offset + 1;
      break;
    }
    if (page.nextIndex === 0) {
      nextIndex = 0;
      break;
    }
    if (scanned >= scanBudget) {
      nextIndex = page.nextIndex;
      break;
    }
    index = page.nextIndex;
    nextIndex = index;
  }
  return {
    reply: array([bulk(Buffer.from(String(nextIndex), 'latin1')), bulkArray(collected)]),
  };
}
