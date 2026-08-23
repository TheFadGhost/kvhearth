import { bulk, array, nilArray } from '../proto/serializer.mjs';
import { errRange } from '../server/errors.mjs';
import { define, guardTypes, ReplySignal } from './util.mjs';
import { latin } from './strings.mjs';

const POP_VERB = { left: 'LPOP', right: 'RPOP' };

export function registerBlockingListCommands(add) {
  for (const [verb, side] of [['BLPOP', 'left'], ['BRPOP', 'right']]) {
    add(define(verb, { min: 2, max: -1, blocking: true }, (ctx, conn, args) =>
      guardTypes(verb.toLowerCase(), args, () => blockingPop(ctx, conn, args, verb, side))));
  }
}

function blockingPop(ctx, conn, args, verb, side) {
  const timeoutText = latin(args[args.length - 1]);
  const timeoutSeconds = Number(timeoutText);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0 || !/^\d+(\.\d+)?$/.test(timeoutText)) {
    throw new ReplySignal(errRange(verb, 'timeout', 'must be a non-negative number'));
  }
  const keys = [];
  for (let i = 1; i < args.length - 1; i++) keys.push(latin(args[i]));
  for (const key of keys) {
    const entry = ctx.store.getTyped(key, 'list');
    if (entry !== null && entry.value.length > 0) {
      const value = ctx.store.listPop(key, side === 'left', null);
      if (value !== null) {
        return {
          reply: array([bulk(Buffer.from(key, 'latin1')), bulk(Buffer.from(value, 'latin1'))]),
          mutations: [[POP_VERB[side], Buffer.from(key, 'latin1')]],
        };
      }
    }
  }
  const waiter = ctx.blocking.register(conn, keys, side);
  const MAX_TIMEOUT_MS = 2147483647;
  const timeoutMs = timeoutSeconds === 0
    ? null
    : Math.min(Math.max(Math.round(timeoutSeconds * 1000), 1), MAX_TIMEOUT_MS);
  if (timeoutMs !== null) {
    ctx.blocking.attachTimer(waiter, timeoutMs, (timedOut) => {
      deliverTimeout(ctx, timedOut);
    });
  }
  return { blocked: true };
}

export function deliverTimeout(ctx, waiter) {
  ctx.blocking.release(waiter);
  const conn = waiter.conn;
  conn.outbox.push(nilArray());
  ctx.server.flushConn(conn);
  ctx.server.resumeConnection(conn);
}

export function wakeListWaiters(ctx, key) {
  let wokeAny = false;
  for (;;) {
    const waiter = ctx.blocking.nextWaiterForKey(key);
    if (waiter === null) return wokeAny;
    const entry = ctx.store.getTyped(key, 'list');
    if (entry === null || entry.value.length === 0) return wokeAny;
    const value = ctx.store.listPop(key, waiter.side === 'left', null);
    if (value === null) return wokeAny;
    ctx.emitMutations([[POP_VERB[waiter.side], Buffer.from(key, 'latin1')]]);
    ctx.blocking.release(waiter);
    const conn = waiter.conn;
    conn.outbox.push(array([
      bulk(Buffer.from(key, 'latin1')),
      bulk(Buffer.from(value, 'latin1')),
    ]));
    ctx.server.flushConn(conn);
    ctx.server.resumeConnection(conn);
    wokeAny = true;
  }
}
