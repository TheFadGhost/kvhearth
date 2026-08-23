import { simple } from '../proto/serializer.mjs';
import { errArity, errUnknownCommand, errCmd, errSrv, errOom } from './errors.mjs';
import { isTxnControl, isSubscriberAllowed, wakeListWaiters } from '../commands/registry.mjs';
import { encodeEntryRecord } from '../persist/snapshot.mjs';
import { escapeInline } from '../proto/parser.mjs';
import { publishMessage } from '../commands/pubsub-cmds.mjs';

export function installDispatcher(ctx) {
  ctx.executeCommand = (conn, args) => executeCommand(ctx, conn, args);
  ctx.dispatchCore = (conn, args) => dispatchOnce(ctx, conn, args, { tap: false });
  ctx.dispatch = (conn, args) => dispatchOnce(ctx, conn, args, { tap: true });
  ctx.emitMutations = (records) => emitMutations(ctx, records);
}

function canonicalName(args) {
  return args[0].toString('latin1').toUpperCase();
}

function executeCommand(ctx, conn, args) {
  const name = canonicalName(args);
  const command = ctx.registry.get(name);
  if (command === undefined) {
    if (conn.multi !== null && !isTxnControl(name)) {
      conn.multi.aborted = `unknown command '${name.toLowerCase()}'`;
      return { reply: errUnknownCommand(name.toLowerCase()) };
    }
    return { reply: errUnknownCommand(name.toLowerCase()) };
  }
  const argCount = args.length - 1;
  if (argCount < command.meta.min || (command.meta.max !== -1 && argCount > command.meta.max)) {
    const expectation = command.meta.max === -1
      ? `${command.meta.min} or more`
      : command.meta.min === command.meta.max
        ? command.meta.min
        : `${command.meta.min}..${command.meta.max}`;
    if (conn.multi !== null && !isTxnControl(name)) {
      conn.multi.aborted = `wrong number of arguments for '${name}'`;
      return { reply: errArity(name, expectation, argCount) };
    }
    return { reply: errArity(name, expectation, argCount) };
  }
  if (ctx.config.get('requirepass') !== '' && !conn.authed && name !== 'AUTH' && name !== 'QUIT' && name !== 'RESET') {
    return { reply: errCmd(name, 'authentication required (send AUTH first)') };
  }
  if (conn.subscriberMode && !isSubscriberAllowed(name)) {
    return {
      reply: errCmd(
        name,
        'command not allowed in subscriber mode (allowed: SUBSCRIBE, UNSUBSCRIBE, PSUBSCRIBE, PUNSUBSCRIBE, PING, QUIT, RESET)',
      ),
    };
  }
  if (conn.multi !== null && !isTxnControl(name)) {
    if (command.meta.blocking) {
      conn.multi.aborted = 'blocking commands are not allowed inside transactions';
      return { reply: errCmd(name, 'queued command failed: blocking commands are not allowed inside MULTI') };
    }
    conn.multi.queue.push(args);
    return { reply: simple('QUEUED') };
  }
  if (command.meta.write) {
    const limit = ctx.config.get('maxmemory');
    if (limit > 0 && !ctx.evictor.enforce()) {
      return { reply: errOom(name, limit) };
    }
    if (ctx.aof.degraded && ctx.txnMode === null) {
      return { reply: errSrv(`${name}: persistence is degraded; writes refused until REWRITEAOF succeeds`) };
    }
  }
  const outcome = command.handler(ctx, conn, args);
  if (outcome && outcome.renameRecord !== undefined) {
    expandRename(ctx, outcome);
  }
  return outcome;
}

function dispatchOnce(ctx, conn, args, options) {
  const startedAtNs = process.hrtime.bigint();
  let outcome;
  let handlerThrew = null;
  try {
    outcome = executeCommand(ctx, conn, args);
  } catch (err) {
    if (!err.reply) throw err;
    handlerThrew = err.reply;
    outcome = { reply: handlerThrew };
  } finally {
    const durationMicros = Math.round(Number(process.hrtime.bigint() - startedAtNs) / 1000);
    if (durationMicros >= ctx.config.get('slowlog-slower-than')) {
      ctx.slowlog.record(durationMicros, args, conn.addr ?? 'internal');
    }
  }

  ctx.stats.commandsProcessed += 1;
  ctx.opsWindow.tick();

  if (outcome.reply !== null && !conn.blocked) {
    conn.outbox.push(outcome.reply);
  }
  if (!options.tap) return outcome;

  if (outcome.mutations && outcome.mutations.length > 0) {
    emitMutations(ctx, outcome.mutations);
  }
  if (outcome.pushedKey) {
    wakeListWaiters(ctx, outcome.pushedKey.toString('latin1'));
  }
  if (ctx.monitors.size > 0 && !conn.monitoring) {
    streamMonitor(ctx, conn, args);
  }
  return outcome;
}

export function emitMutations(ctx, records) {
  if (!records || records.length === 0) return;
  for (const record of records) {
    if (record.length === 0) continue;
    notifyKeyEvent(ctx, record);
  }
  if (ctx.txnMode !== null) {
    for (const record of records) ctx.txnMode.records.push(record);
    return;
  }
  try {
    ctx.aof.appendBatch(records);
  } catch (err) {
    ctx.aof.degraded = true;
    ctx.log.error('append log write/fsync failed; persistence degraded', {
      error: err.message,
      policy: ctx.aof.fsyncPolicy,
    });
    throw err;
  }
}

function expandRename(ctx, outcome) {
  const [sourceBuf, targetBuf] = outcome.renameRecord;
  const target = targetBuf.toString('latin1');
  const entry = ctx.store.getEntry(target);
  if (entry !== null) {
    outcome.mutations = [
      ['DEL', sourceBuf],
      ['DEL', targetBuf],
      encodeEntryRecord(target, entry, ctx.store.nowMs()).map((part) => Buffer.from(part, 'latin1')),
    ];
    publishEvent(ctx, 'rename_from', sourceBuf, 'g');
    publishEvent(ctx, 'rename_to', targetBuf, 'g');
  } else {
    outcome.mutations = [['DEL', sourceBuf]];
  }
  void target;
}

const NOTIFICATION_TABLE = {
  SET: ['set', '$'],
  APPEND: ['append', '$'],
  INCR: ['incr', '$'],
  DECR: ['decr', '$'],
  INCRBY: ['incrby', '$'],
  DECRBY: ['decrby', '$'],
  SETRANGE: ['setrange', '$'],
  LPUSH: ['lpush', 'L'],
  RPUSH: ['rpush', 'L'],
  LPOP: ['lpop', 'L'],
  RPOP: ['rpop', 'L'],
  LSET: ['lset', 'L'],
  LTRIM: ['ltrim', 'L'],
  HSET: ['hset', 'H'],
  HDEL: ['hdel', 'H'],
  HINCRBY: ['hincrby', 'H'],
  SADD: ['sadd', 'S'],
  SREM: ['srem', 'S'],
  SINTERSTORE: ['sinterstore', 'S'],
  SUNIONSTORE: ['sunionstore', 'S'],
  SDIFFSTORE: ['sdiffstore', 'S'],
  ZADD: ['zadd', 'Z'],
  ZREM: ['zrem', 'Z'],
  ZINCRBY: ['zincrby', 'Z'],
  DEL: ['del', 'g'],
  EXPIRE: ['expire', 'g'],
  PEXPIRE: ['pexpire', 'g'],
  EXPIREAT: ['expireat', 'g'],
  PEXPIREAT: ['pexpireat', 'g'],
  PERSIST: ['persist', 'g'],
};

function notifyKeyEvent(ctx, record) {
  const verb = record[0].toString('latin1').toUpperCase();
  const entry = NOTIFICATION_TABLE[verb];
  if (entry === undefined) return;
  const [event, classChars] = entry;
  if (record.length < 2) {
    publishEvent(ctx, verb.toLowerCase(), null, classChars);
    return;
  }
  publishEvent(ctx, event, record[1], classChars);
}

function publishEvent(ctx, event, keyBuffer, classChars) {
  const flags = ctx.config.get('notify-keyspace-events').toUpperCase();
  if (flags === '') return;
  const hasGeneric = flags.includes('A') || flags.includes('G') || [...classChars].some((ch) => 'gLHSZn$'.includes(ch) && flags.includes(ch));
  if (!hasGeneric) return;
  if (flags.includes('K') || flags.includes('A')) {
    const keyText = keyBuffer === null ? '' : keyBuffer.toString('latin1');
    publishMessage(ctx, `__keyspace@0__:${keyText}`, Buffer.from(event, 'latin1'));
  }
  if (flags.includes('E') || flags.includes('A')) {
    if (keyBuffer !== null) publishMessage(ctx, `__keyevent@0__:${event}`, keyBuffer);
  }
}

function streamMonitor(ctx, conn, args) {
  const rendered = args.map((a) => escapeInline(a)).join(' ');
  const frame = Buffer.from(`${Date.now()} [${conn.addr}] ${rendered}\n`, 'latin1');
  for (const monitorConn of ctx.monitors) {
    monitorConn.outbox.push(frame);
    ctx.server.flushConn(monitorConn);
  }
}
