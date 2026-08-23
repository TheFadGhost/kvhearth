import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Clock } from '../src/util/clock.mjs';
import { Logger } from '../src/log/logger.mjs';
import {
  Config,
  resolveConfig,
  loadConfigFile,
  ConfigError,
  CONFIG_KEYS,
} from '../src/config/config.mjs';
import { Store } from '../src/store/store.mjs';
import { AppendLog, NullAppendLog } from '../src/persist/aof.mjs';
import { SnapshotWriter } from '../src/persist/snapshot-writer.mjs';
import { cleanStaleTemporaries, recover } from '../src/persist/recovery.mjs';
import { applyRestore } from '../src/persist/restore.mjs';
import { AofRewriter } from '../src/persist/rewrite.mjs';
import { Evictor } from '../src/memory/eviction.mjs';
import { PubSubHub } from '../src/pubsub/pubsub.mjs';
import { globMatch } from '../src/util/glob.mjs';
import { BlockingRegistry } from '../src/server/blocking.mjs';
import { OpsWindow, Server } from '../src/server/server.mjs';
import { installDispatcher } from '../src/server/dispatch.mjs';
import { buildRegistry } from '../src/commands/registry.mjs';
import { InfoRenderer } from '../src/info/info.mjs';
import { SlowLog } from '../src/server/slowlog.mjs';

const VERSION = '0.1.0';
const HELP = `kvhearth ${VERSION}
usage: node bin/kvhearth.mjs [options]

server options:
  --config FILE            read configuration from FILE
  --bind ADDRESS           bind address (default 127.0.0.1)
  --port N                 listen port (default 7379)
  --dir PATH               data directory (default ./data)
  --appendonly yes|no      enable the append-only log (default yes)
  --append-fsync POLICY    always | everysec | never (default everysec)
  --save-interval SECONDS  periodic snapshot; 0 disables (default 0)
  --maxmemory BYTES        memory limit; 0 disables (default 0)
  --maxmemory-policy P     noeviction | allkeys-lru (default noeviction)
  --maxclients N           connection limit (default 1024)
  --timeout SECONDS        idle connection timeout; 0 never (default 0)
  --requirepass PASSWORD   require AUTH with this password
  --log-level LEVEL        debug|info|warn|error (default info)
  --log-format FORMAT      text|json (default text)
  --enable-debug-commands  allow DEBUG subcommands (default off)

tools:
  --check-config           validate configuration and exit
  --check-aof FILE         scan an append log and report integrity
  --version                print version
  --help                   this text

all configuration keys are also accepted as --<key> VALUE flags:
${CONFIG_KEYS.map((k) => `  ${k}`).join('\n')}`;

const BOOLEAN_FLAGS = new Set(['appendonly', 'save-on-shutdown', 'enable-debug-commands']);

function parseArgv(argv) {
  const flags = {};
  const special = [];
  for (let i = 0; i < argv.length; i++) {
    let token = argv[i];
    if (token.startsWith('--')) token = token.slice(2);
    else if (token.startsWith('-') && token.length === 2) token = token.slice(1);
    else throw new ConfigError(`unexpected argument '${argv[i]}'`);
    if (token === 'help' || token === 'version' || token === 'check-config') {
      special.push(token);
      continue;
    }
    if (token === 'check-aof') {
      if (i + 1 >= argv.length) throw new ConfigError('--check-aof requires a file path');
      special.push(`check-aof:${argv[++i]}`);
      continue;
    }
    if (BOOLEAN_FLAGS.has(token) && (i + 1 >= argv.length || argv[i + 1].startsWith('-'))) {
      flags[token] = 'yes';
      continue;
    }
    if (i + 1 >= argv.length) throw new ConfigError(`flag '--${token}' requires a value`);
    flags[token] = argv[++i];
  }
  return { flags, special };
}

async function main() {
  const rawArgs = process.argv.slice(2);
  let parsed;
  try {
    parsed = parseArgv(rawArgs);
  } catch (err) {
    fail(err.message, 2);
    return;
  }
  const { flags, special } = parsed;
  if (special.includes('version')) {
    process.stdout.write(`kvhearth ${VERSION}\n`);
    return;
  }
  if (special.includes('help')) {
    process.stdout.write(HELP + '\n');
    return;
  }
  if (special.length > 0 && special[0].startsWith('check-aof:')) {
    checkAof(special[0].slice('check-aof:'.length));
    return;
  }

  let configFilePath = null;
  let fileText = null;
  if (flags.config !== undefined) {
    configFilePath = path.resolve(flags.config);
    try {
      fileText = loadConfigFile(configFilePath);
    } catch (err) {
      fail(err.message, 2);
      return;
    }
    delete flags.config;
  }

  let resolved;
  try {
    resolved = resolveConfig({ fileText, flags });
  } catch (err) {
    fail(err.message, 2);
    return;
  }
  const config = new Config(resolved);

  const logger = new Logger({
    level: config.get('log-level'),
    format: config.get('log-format'),
  });

  if (special.includes('check-config')) {
    for (const key of CONFIG_KEYS) {
      process.stdout.write(`${key}: ${String(config.get(key))} (from ${config.sourceOf(key)})\n`);
    }
    return;
  }

  const dir = path.resolve(config.get('dir'));
  fs.mkdirSync(dir, { recursive: true });

  const clock = new Clock();
  const store = new Store(clock);
  store.onExpire = (key) => logger.debug('key expired', { key: key.replace(/[^\x20-\x7e]/g, '?') });

  const snapPath = path.join(dir, config.get('snap-file'));
  const aofPath = path.join(dir, config.get('aof-file'));
  const aof = config.get('appendonly')
    ? new AppendLog({ filePath: aofPath, fsyncPolicy: config.get('append-fsync'), log: logger })
    : new NullAppendLog();

  const ctx = {
    version: VERSION,
    configFilePath,
    config,
    log: logger,
    clock,
    store,
    aof,
    snapPath,
    glob: globMatch,
    monitors: new Set(),
    slowlog: new SlowLog(config.get('slowlog-max-len')),
    pubsub: new PubSubHub(),
    blocking: new BlockingRegistry(),
    evictor: new Evictor(store, config),
    stats: {
      connectionsReceived: 0,
      commandsProcessed: 0,
      rejectedConnections: 0,
      keyspaceHits: 0,
      keyspaceMisses: 0,
      pubsubPublished: 0,
      aofRewrites: 0,
    },
    opsWindow: new OpsWindow(),
    txnMode: null,
    startedAtMs: Date.now(),
    lastSaveAtMs: 0,
  };

  buildRegistry(ctx);
  installDispatcher(ctx);
  ctx.expandOutcomeRecords = (outcome) => {
    if (outcome.restoreRecord !== undefined) {
      const targetKey = outcome.restoreRecord[0].toString('latin1');
      const entry = store.getEntry(targetKey);
      outcome.mutations = entry !== null
        ? [encodeEntryRecord(targetKey, entry, store.nowMs()).map((part) => Buffer.from(part, 'latin1'))]
        : [['DEL', outcome.restoreRecord[0]]];
    }
  };
  ctx.infoRenderer = new InfoRenderer(ctx);
  ctx.snapshotWriter = new SnapshotWriter({ store, log: logger, snapPath });
  ctx.rewriter = new AofRewriter({ store, aof, log: logger, aofPath });

  const server = new Server(ctx);
  server.shutdownPromise = new Promise((resolveShutdown) => {
    server.resolveShutdown = resolveShutdown;
  });
  server.shutdown = wrapShutdown(server);
  ctx.server = server;

  store.onEvict = (key) => {
    if (store.internalMode || ctx.txnMode !== null) return;
    try {
      ctx.emitMutations([['DEL', Buffer.from(key, 'latin1')]]);
    } catch (err) {
      logger.error('failed to journal eviction', { key: key.replace(/[^\x20-\x7e]/g, '?'), error: err.message });
    }
  };

  ctx.applyRuntimeConfig = (key, value) => {
    const probeConfig = new Config(resolveConfig({ flags: { [key]: value } }));
    switch (key) {
      case 'maxmemory':
        config.values.maxmemory = probeConfig.get('maxmemory');
        break;
      case 'maxmemory-policy':
        config.values['maxmemory-policy'] = probeConfig.get('maxmemory-policy');
        break;
      case 'slowlog-slower-than':
        config.values['slowlog-slower-than'] = probeConfig.get('slowlog-slower-than');
        break;
      case 'slowlog-max-len':
        config.values['slowlog-max-len'] = probeConfig.get('slowlog-max-len');
        ctx.slowlog.maxLen = probeConfig.get('slowlog-max-len');
        break;
      case 'requirepass':
        config.values.requirepass = probeConfig.get('requirepass');
        break;
      case 'notify-keyspace-events':
        config.values['notify-keyspace-events'] = probeConfig.get('notify-keyspace-events');
        break;
      case 'timeout':
        config.values.timeout = probeConfig.get('timeout');
        break;
      default:
        throw new Error(`'${key}' is not settable at runtime`);
    }
  };

  cleanStaleTemporaries({ aof: aofPath, snap: snapPath }, logger);
  if (aof instanceof AppendLog) aof.open();

  store.internalMode = true;
  const recovery = recover({
    store,
    aofPath,
    snapPath,
    applyCommand: (args) => {
      const verb = args[0].toString('latin1').toUpperCase();
      if (verb === 'RESTORE') {
        applyRestore(store, args);
        return;
      }
      const pseudoConn = recoveryPseudoConn();
      ctx.dispatchCore(pseudoConn, args);
      pseudoConn.outbox.length = 0;
      if (store.usedBytes > 64 * 1024 * 1024 * 1024) {
        logger.warn('recovery memory guard tripped');
      }
    },
    log: logger,
  });
  store.internalMode = false;
  ctx.stats.keyspaceHits = store.stats.hits;
  ctx.stats.keyspaceMisses = store.stats.misses;

  logger.info('recovery complete', {
    snapshot_keys: recovery.snapshotKeys,
    aof_commands: recovery.aofCommands,
    truncated_tail_bytes: recovery.truncatedTailBytes,
  });

  const bind = config.get('bind');
  const port = config.get('port');
  try {
    await server.listen(bind, port);
  } catch (err) {
    fail(`cannot bind ${bind}:${port} (${err.code ?? err.message})`, 10);
    return;
  }
  logger.info('listening', { address: `${bind}:${port}`, version: VERSION, append_fsync: aof.fsyncPolicy });

  const requestShutdown = () => {
    server.shutdown({ save: config.get('save-on-shutdown') }).then(() => {
      process.exit(0);
    });
  };
  process.on('SIGINT', requestShutdown);
  process.on('SIGTERM', requestShutdown);
  process.on('SIGBREAK', requestShutdown);

  setInterval(() => {
    ctx.stats.keyspaceHits = store.stats.hits;
    ctx.stats.keyspaceMisses = store.stats.misses;
  }, 1000).unref();
}

function wrapShutdown(server) {
  const original = Object.getPrototypeOf(server).shutdown;
  return function patched(options) {
    const result = original.call(this, options);
    if (this.resolveShutdown && !this._shutdownResolved) {
      this._shutdownResolved = true;
      queueMicrotask(() => this.resolveShutdown());
    }
    return result;
  };
}

let recoveryConn = null;
function recoveryPseudoConn() {
  if (recoveryConn === null) {
    recoveryConn = {
      id: -1,
      addr: 'recovery',
      name: '',
      outbox: [],
      multi: null,
      watched: new Map(),
      subscriberMode: false,
      monitoring: false,
      blocked: null,
      authed: true,
      closeAfterReply: false,
      closing: false,
    };
  }
  return recoveryConn;
}

function checkAof(filePath) {
  const report = { header: null, commands: 0, bytes: 0, truncatedTailBytes: 0, status: 'ok' };
  let raw;
  try {
    raw = fs.readFileSync(filePath);
  } catch (err) {
    process.stderr.write(`check-aof: cannot read '${filePath}': ${err.code ?? err.message}\n`);
    process.exit(2);
  }
  import('../src/proto/parser.mjs').then(async ({ RequestParser }) => {
    const newlineAt = raw.indexOf(0x0a);
    if (newlineAt === -1) {
      process.stdout.write(`file: ${filePath}\nheader: missing\nstatus: unreadable\n`);
      process.exit(11);
    }
    report.header = raw.toString('latin1', 0, newlineAt).trim();
    const parser = new RequestParser();
    const CHUNK = 1 << 16;
    let consumed = newlineAt + 1;
    while (consumed < raw.length) {
      const end = Math.min(consumed + CHUNK, raw.length);
      const { requests, fatal } = parser.feed(raw.subarray(consumed, end));
      consumed = end;
      if (fatal !== null) {
        report.status = `corrupt mid-file: ${fatal.message}`;
        break;
      }
      report.commands += requests.filter((r) => r !== null).length;
    }
    report.truncatedTailBytes = parser.buffer.length - parser.offset;
    report.bytes = raw.length;
    process.stdout.write(
      [
        `file: ${filePath}`,
        `header: ${report.header}`,
        `total_bytes: ${report.bytes}`,
        `commands: ${report.commands}`,
        `truncated_tail_bytes: ${report.truncatedTailBytes}`,
        `status: ${report.status}`,
        '',
      ].join('\n'),
    );
    process.exit(report.status === 'ok' ? 0 : 11);
  });
}

function fail(message, code) {
  process.stderr.write(`kvhearth: error: ${message}\n`);
  process.exit(code);
}

main().catch((err) => {
  process.stderr.write(`kvhearth: fatal: ${err.stack ?? err.message}\n`);
  process.exit(Number.isInteger(err.exitCode) ? err.exitCode : 1);
});
