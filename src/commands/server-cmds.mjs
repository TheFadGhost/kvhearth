import { simple, bulk, integer, array } from '../proto/serializer.mjs';
import { errCmd, ok, errSrv, errArity } from '../server/errors.mjs';
import { define, ReplySignal, bulkArray } from './util.mjs';
import { latin } from './strings.mjs';
import { writeSnapshotSync } from '../persist/snapshot.mjs';

export function registerServerCommands(add) {
  add(define('PING', { min: 0, max: 1 }, (ctx, conn, args) => {
    if (args.length === 2) return { reply: bulk(args[1]) };
    if (conn !== null && conn.subscriberMode) return { reply: array([simple('pong'), bulk('')]) };
    return { reply: simple('PONG') };
  }));

  add(define('ECHO', { min: 1, max: 1 }, (ctx, conn, args) => ({ reply: bulk(args[1]) })));

  add(define('SELECT', { min: 1, max: 1 }, () => ({
    reply: errCmd('SELECT', 'multiple databases are not supported in kvhearth'),
  })));

  add(define('AUTH', { min: 1, max: 2 }, (ctx, conn, args) => {
    const required = ctx.config.get('requirepass');
    if (required === '') {
      return { reply: errCmd('AUTH', 'no password is configured') };
    }
    const supplied = args.length >= 3 ? latin(args[2]) : latin(args[1]);
    if (supplied === required) {
      conn.authed = true;
      return { reply: ok() };
    }
    return { reply: errCmd('AUTH', 'invalid password') };
  }));

  add(define('RESET', { min: 0, max: 0 }, (ctx, conn) => {
    conn.multi = null;
    conn.watched.clear();
    const counts = ctx.pubsub.countsFor(conn.id);
    if (counts.channels.size > 0) ctx.pubsub.unsubscribe(conn.id);
    if (counts.patterns.size > 0) ctx.pubsub.punsubscribe(conn.id);
    conn.subscriberMode = false;
    if (ctx.monitors.has(conn)) {
      ctx.monitors.delete(conn);
      conn.monitoring = false;
    }
    conn.authed = ctx.config.get('requirepass') === '';
    return { reply: simple('RESET') };
  }));

  add(define('QUIT', { min: 0, max: 0 }, (ctx, conn) => {
    conn.closeAfterReply = true;
    return { reply: ok() };
  }));

  add(define('COMMANDS', { min: 0, max: 0 }, (ctx) => ({
    reply: bulkArray([...ctx.registry.keys()].sort().map((name) => Buffer.from(name, 'latin1'))),
  })));

  add(define('FLUSHALL', { min: 0, max: 1, write: true }, (ctx, conn, args) => {
    if (args.length === 2 && latin(args[1]).toUpperCase() !== 'ASYNC') {
      throw new ReplySignal(errCmd('FLUSHALL', `unsupported option '${latin(args[1])}'`));
    }
    ctx.store.flushAll();
    return { reply: ok(), mutations: [['FLUSHALL']] };
  }));

  add(define('FLUSHDB', { min: 0, max: 1, write: true }, (ctx, conn, args) => {
    if (args.length === 2 && latin(args[1]).toUpperCase() !== 'ASYNC') {
      throw new ReplySignal(errCmd('FLUSHDB', `unsupported option '${latin(args[1])}'`));
    }
    ctx.store.flushAll();
    return { reply: ok(), mutations: [['FLUSHALL']] };
  }));

  add(define('SAVE', { min: 0, max: 0 }, (ctx) => {
    try {
      writeSnapshotSync(ctx.store, ctx.snapPath, ctx.log);
      ctx.lastSaveAtMs = Date.now();
      return { reply: ok(), mutations: [] };
    } catch (err) {
      ctx.log.error('snapshot save failed', { error: err.code ?? String(err) });
      return { reply: errSrv(`SAVE failed (${err.code ?? err.message})`) };
    }
  }));

  add(define('BGSAVE', { min: 0, max: 0 }, (ctx) => {
    let outcome;
    try {
      outcome = ctx.snapshotWriter.start();
    } catch (err) {
      ctx.log.error('background snapshot failed to start', { error: err.message });
      return { reply: errSrv(`BGSAVE failed (${err.code ?? err.message})`) };
    }
    if (!outcome.ok && outcome.reason === 'busy') {
      return { reply: errCmd('BGSAVE', 'background save already in progress') };
    }
    return { reply: simple('Background saving started'), mutations: [] };
  }));

  add(define('LASTSAVE', { min: 0, max: 0 }, (ctx) => ({ reply: integer(Math.floor(ctx.lastSaveAtMs / 1000)) })));

  add(define('REWRITEAOF', { min: 0, max: 0 }, (ctx) => {
    if (ctx.aof.degraded) {
      const outcome = ctx.rewriter.start();
      if (outcome.ok) {
        ctx.aof.degraded = false;
        ctx.log.info('persistence recovered via aof rewrite');
        return { reply: simple('Rewrite of append only file started'), mutations: [] };
      }
      return { reply: errSrv('REWRITEAOF cannot run while persistence is degraded') };
    }
    const outcome = ctx.rewriter.start();
    if (!outcome.ok && outcome.reason === 'busy') {
      return { reply: errCmd('REWRITEAOF', 'rewrite already in progress') };
    }
    if (!outcome.ok) {
      return { reply: errSrv('REWRITEAOF requires an active append log (appendonly no)') };
    }
    return { reply: simple('Rewrite of append only file started'), mutations: [] };
  }));

  add(define('SHUTDOWN', { min: 0, max: 1 }, (ctx, conn, args) => {
    let mode = 'save';
    if (args.length === 2) {
      const flag = latin(args[1]).toUpperCase();
      if (flag === 'NOSAVE') mode = 'nosave';
      else if (flag === 'SAVE') mode = 'save';
      else throw new ReplySignal(errCmd('SHUTDOWN', `unsupported option '${latin(args[1])}'`));
    }
    setImmediate(() => ctx.server.shutdown({ save: mode === 'save' }));
    return { reply: null, mutations: [] };
  }));

  add(define('MONITOR', { min: 0, max: 0 }, (ctx, conn) => {
    ctx.monitors.add(conn);
    conn.monitoring = true;
    return { reply: ok() };
  }));

  add(define('DEBUG', { min: 1, max: -1 }, (ctx, conn, args) => {
    if (!ctx.config.get('enable-debug-commands')) {
      return { reply: errCmd('DEBUG', 'debug commands are disabled (enable-debug-commands no)') };
    }
    const sub = latin(args[1]).toUpperCase();
    if (sub === 'SLEEP' && args.length >= 3) {
      const seconds = Number(latin(args[2]));
      if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 5) {
        throw new ReplySignal(errCmd('DEBUG SLEEP', 'seconds must be between 0 and 5'));
      }
      blockForSeconds(seconds);
      return { reply: ok(), mutations: [] };
    }
    if (sub === 'JMAP') {
      return { reply: integer(0), mutations: [] };
    }
    return { reply: errCmd('DEBUG', `unsupported subcommand '${latin(args[1])}' (supported: SLEEP)` ) };
  }));

  add(define('CLIENT', { min: 1, max: -1 }, (ctx, conn, args) => clientCommand(ctx, conn, args)));

  add(define('SLOWLOG', { min: 1, max: -1 }, (ctx, conn, args) => slowlogCommand(ctx, args)));

  add(define('CONFIG', { min: 2, max: -1 }, (ctx, conn, args) => configCommand(ctx, args)));

  add(define('INFO', { min: 0, max: 1 }, (ctx, conn, args) => {
    const KNOWN_SECTIONS = ['server', 'clients', 'memory', 'stats', 'keyspace', 'persistence', 'eviction'];
    const section = args.length === 2 ? latin(args[1]).toLowerCase() : 'default';
    if (section !== 'default' && !KNOWN_SECTIONS.includes(section)) {
      throw new ReplySignal(errCmd('INFO', `unknown section '${latin(args[1])}'`));
    }
    return { reply: bulk(Buffer.from(ctx.infoRenderer.render(section), 'latin1')) };
  }));

  add(define('RESTORE', { min: 5, max: -1 }, (ctx, conn, args) => {
    void ctx;
    void conn;
    void args;
    return { reply: errCmd('RESTORE', 'reserved for internal use'), mutations: [] };
  }));
}

function clientCommand(ctx, conn, args) {
  const sub = latin(args[1]).toUpperCase();
  if (sub === 'ID') return { reply: integer(conn.id) };
  if (sub === 'GETNAME') {
    return { reply: conn.name === '' ? bulk(null) : bulk(Buffer.from(conn.name, 'latin1')) };
  }
  if (sub === 'SETNAME') {
    if (args.length < 3) throw new ReplySignal(errCmd('CLIENT SETNAME', 'a name is required'));
    conn.name = latin(args[2]);
    return { reply: ok() };
  }
  if (sub === 'LIST') {
    const lines = [];
    for (const target of ctx.clients.values()) {
      lines.push(
        `id=${target.id} addr=${target.addr} name=${target.name || '-'} age=${Math.floor((Date.now() - target.connectedAtMs) / 1000)} idle=${Math.floor((Date.now() - target.lastActiveMs) / 1000)} mode=${target.subscriberMode ? 'subscriber' : 'normal'}`,
      );
    }
    return { reply: bulk(Buffer.from(lines.join('\n') + (lines.length > 0 ? '\n' : ''), 'latin1')) };
  }
  if (sub === 'KILL') {
    if (args.length >= 3 && latin(args[2]).toUpperCase() === 'ID') {
      if (args.length < 4) throw new ReplySignal(errArity('CLIENT KILL', 'ID and a client id', args.length - 2));
      const targetId = Number(latin(args[3]));
      for (const target of ctx.clients.values()) {
        if (target.id === targetId) {
          ctx.server.closeConnection(target, 'client kill');
          return { reply: ok() };
        }
      }
      throw new ReplySignal(errCmd('CLIENT KILL', `no such client id ${targetId}`));
    }
    throw new ReplySignal(errCmd('CLIENT', `unsupported subcommand form '${args.slice(2).map(latin).join(' ')}'`));
  }
  throw new ReplySignal(errCmd('CLIENT', `unsupported subcommand '${latin(args[1])}'`));
}

function slowlogCommand(ctx, args) {
  const sub = latin(args[1]).toUpperCase();
  if (sub === 'GET') {
    const requestedCount = args.length > 2 ? Number(latin(args[2])) : undefined;
    const entries = ctx.slowlog.get(requestedCount);
    const frames = entries.map((entry) => array([
      integer(entry.seq),
      integer(entry.timestampSeconds),
      integer(entry.durationMicros),
      array(entry.argv.map((arg) => bulk(arg))),
      bulk(Buffer.from(entry.address, 'latin1')),
    ]));
    return { reply: array(frames) };
  }
  if (sub === 'LEN') return { reply: integer(ctx.slowlog.len()) };
  if (sub === 'RESET') {
    ctx.slowlog.reset();
    return { reply: simple('OK') };
  }
  throw new ReplySignal(errCmd('SLOWLOG', `unsupported subcommand '${latin(args[1])}'`));
}

const CONFIG_MUTABLE = new Set([
  'maxmemory',
  'maxmemory-policy',
  'slowlog-slower-than',
  'slowlog-max-len',
  'requirepass',
  'notify-keyspace-events',
  'timeout',
]);

const CONFIG_READONLY = new Set([
  'bind', 'port', 'dir', 'appendonly', 'append-fsync', 'save-on-shutdown', 'save-interval',
  'maxclients', 'proto-max-args', 'proto-max-bulk', 'proto-max-request',
  'log-level', 'log-format', 'theme', 'enable-debug-commands', 'aof-file', 'snap-file',
]);

function configCommand(ctx, args) {
  const sub = latin(args[1]).toUpperCase();
  if (sub === 'GET') {
    if (args.length < 3) throw new ReplySignal(errCmd('CONFIG GET', 'a parameter pattern is required'));
    const pattern = latin(args[2]);
    const names = [...CONFIG_MUTABLE, ...CONFIG_READONLY].filter((name) => ctx.glob(pattern.toLowerCase(), name)).sort();
    const flat = [];
    for (const name of names) flat.push(bulk(Buffer.from(name, 'latin1')), bulk(Buffer.from(renderConfigValue(ctx, name), 'latin1')));
    return { reply: array(flat) };
  }
  if (sub === 'SET') {
    if (args.length !== 4) throw new ReplySignal(errCmd('CONFIG SET', 'expected exactly one parameter and one value'));
    const name = latin(args[2]).toLowerCase();
    const value = latin(args[3]);
    if (!CONFIG_MUTABLE.has(name)) {
      throw new ReplySignal(errCmd('CONFIG SET', `parameter '${name}' is not settable at runtime${CONFIG_READONLY.has(name) ? ' (read-only)' : ''}`));
    }
    try {
      ctx.applyRuntimeConfig(name, value);
    } catch (err) {
      throw new ReplySignal(errCmd('CONFIG SET', `${name}: ${err.message}`));
    }
    return { reply: ok() };
  }
  if (sub === 'REWRITE') {
    return { reply: errCmd('CONFIG REWRITE', 'not supported; edit the config file directly') };
  }
  throw new ReplySignal(errCmd('CONFIG', `unsupported subcommand '${latin(args[1])}'`));
}

function renderConfigValue(ctx, name) {
  const value = ctx.config.get(name);
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  return String(value);
}

function blockForSeconds(seconds) {
  const deadline = process.hrtime.bigint() + BigInt(Math.round(seconds * 1e9));
  while (process.hrtime.bigint() < deadline) {
    for (let i = 0; i < 20000; i++) {
      if ((i & 1023) === 0 && process.hrtime.bigint() >= deadline) break;
    }
  }
}
