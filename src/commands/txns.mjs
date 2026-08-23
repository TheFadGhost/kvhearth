import { simple, array, nilArray } from '../proto/serializer.mjs';
import { errCmd, ok, errSrv } from '../server/errors.mjs';
import { define } from './util.mjs';
import { latin } from './strings.mjs';

const TXN_CONTROL = new Set(['MULTI', 'EXEC', 'DISCARD', 'WATCH', 'UNWATCH', 'RESET']);

export function isTxnControl(name) {
  return TXN_CONTROL.has(name);
}

export function registerTransactionCommands(add) {
  add(define('MULTI', { min: 0, max: 0 }, (ctx, conn) => {
    if (conn.multi !== null) {
      return { reply: errCmd('MULTI', 'MULTI calls can not be nested') };
    }
    conn.multi = { queue: [], aborted: null };
    return { reply: ok() };
  }));

  add(define('EXEC', { min: 0, max: 0 }, (ctx, conn) => {
    if (conn.multi === null) {
      return { reply: errCmd('EXEC', 'EXEC without MULTI') };
    }
    const txn = conn.multi;
    conn.multi = null;
    if (txn.aborted !== null) {
      clearWatches(ctx, conn);
      return { reply: errCmd('EXEC', `aborted (queued error: ${txn.aborted})`) };
    }
    if (isWatchDirty(ctx, conn)) {
      clearWatches(ctx, conn);
      return { reply: nilArray(), mutations: [] };
    }
    const collected = [];
    const replies = [];
    for (const queuedArgs of txn.queue) {
      let outcome;
      try {
        outcome = ctx.executeCommand(conn, queuedArgs);
      } catch (err) {
        if (err.reply) outcome = { reply: err.reply };
        else {
          ctx.log.error('transaction element failed unexpectedly', {
            command: queuedArgs[0]?.toString('latin1'),
            error: err.stack ?? String(err),
          });
          outcome = { reply: errSrv('internal error executing command') };
        }
      }
      replies.push(outcome.reply);
      if (outcome.mutations && outcome.mutations.length > 0) collected.push(...outcome.mutations);
    }
    clearWatches(ctx, conn);
    return { reply: array(replies), mutations: collected };
  }));

  add(define('DISCARD', { min: 0, max: 0 }, (ctx, conn) => {
    if (conn.multi === null) {
      return { reply: errCmd('DISCARD', 'DISCARD without MULTI') };
    }
    conn.multi = null;
    clearWatches(ctx, conn);
    return { reply: ok() };
  }));

  add(define('WATCH', { min: 1, max: 129 }, (ctx, conn, args) => {
    if (conn.multi !== null) {
      return { reply: errCmd('WATCH', 'WATCH inside MULTI is not allowed') };
    }
    for (let i = 1; i < args.length; i++) {
      const key = latin(args[i]);
      const entry = ctx.store.getEntry(key);
      conn.watched.set(key, entry === null ? { ref: null, version: -1 } : { ref: entry, version: entry.version });
    }
    return { reply: ok() };
  }));

  add(define('UNWATCH', { min: 0, max: 0 }, (ctx, conn) => {
    clearWatches(ctx, conn);
    return { reply: ok() };
  }));
}

export function isWatchDirty(ctx, conn) {
  for (const [key, state] of conn.watched) {
    const current = ctx.store.getEntry(key);
    if (current === null && state.ref === null) continue;
    if (current === null || state.ref === null) return true;
    if (current !== state.ref || current.version !== state.version) return true;
  }
  return false;
}

export function clearWatches(ctx, conn) {
  void ctx;
  conn.watched.clear();
}
