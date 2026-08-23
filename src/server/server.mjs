import net from 'node:net';
import { RequestParser } from '../proto/parser.mjs';
import { errProto, errSrv } from './errors.mjs';
import { BlockingRegistry } from './blocking.mjs';
import { PersistenceError } from '../persist/aof.mjs';

export class OpsWindow {
  constructor() {
    this.buckets = new Array(10).fill(0);
    this.current = 0;
    setInterval(() => {
      this.current = (this.current + 1) % this.buckets.length;
      this.buckets[this.current] = 0;
    }, 1000).unref();
  }

  tick() {
    this.buckets[this.current] += 1;
  }

  perSecond() {
    return this.buckets.reduce((sum, n) => sum + n, 0);
  }
}

export class Server {
  constructor(ctx) {
    this.ctx = ctx;
    this.ctx.server = this;
    this.net = null;
    this.clients = new Map();
    this.execQueue = [];
    this.draining = false;
    this.nextConnectionId = 1;
    this.intervals = [];
    this.shuttingDown = false;
    this.stoppedPromise = null;
    this.touchedConns = new Set();
  }

  listen(bindAddress, port) {
    return new Promise((resolve, reject) => {
      this.net = net.createServer((socket) => this.onConnection(socket));
      this.net.on('error', reject);
      this.net.listen(port, bindAddress, () => {
        this.startTimers();
        resolve();
      });
    });
  }

  startTimers() {
    const ctx = this.ctx;
    this.intervals.push(setInterval(() => this.runExpirerCycle(), 100));
    this.intervals.push(setInterval(() => {
      if (ctx.aof.fsyncPolicy === 'everysec' && !ctx.aof.degraded) ctx.aof.flushPeriodic();
    }, 1000));
    const saveIntervalMs = ctx.config.get('save-interval') * 1000;
    if (saveIntervalMs > 0) {
      this.intervals.push(setInterval(() => {
        if (!ctx.snapshotWriter.running) ctx.snapshotWriter.start();
      }, saveIntervalMs));
    }
    this.intervals.push(setInterval(() => this.enforceIdleTimeout(), 1000));
    for (const timer of this.intervals) {
      if (typeof timer.unref === 'function') timer.unref();
    }
  }

  runExpirerCycle() {
    for (let round = 0; round < 4; round++) {
      const expired = this.ctx.store.activeExpireStep(20);
      if (expired / Math.max(20, 1) <= 0.25) break;
    }
  }

  enforceIdleTimeout() {
    const timeoutSeconds = this.ctx.config.get('timeout');
    if (timeoutSeconds <= 0) return;
    const deadline = Date.now() - timeoutSeconds * 1000;
    for (const conn of this.clients.values()) {
      if (conn.blocked !== null || conn.subscriberMode || conn.monitoring) continue;
      if (conn.lastActiveMs < deadline) {
        this.closeConnection(conn, 'idle timeout');
      }
    }
  }

  onConnection(socket) {
    const ctx = this.ctx;
    const maxclients = ctx.config.get('maxclients');
    if (this.shuttingDown) {
      socket.destroy();
      return;
    }
    if (this.clients.size >= maxclients) {
      ctx.stats.rejectedConnections += 1;
      socket.write(errSrv(`maxclients reached (limit ${maxclients})`));
      socket.end();
      return;
    }
    socket.setNoDelay(true);
    const conn = {
      id: this.nextConnectionId++,
      socket,
      addr: `${socket.remoteAddress ?? '?'}:${socket.remotePort ?? '?'}`,
      name: '',
      parser: new RequestParser({
        maxArgs: ctx.config.get('proto-max-args'),
        maxBulk: ctx.config.get('proto-max-bulk'),
        maxRequest: ctx.config.get('proto-max-request'),
      }),
      outbox: [],
      multi: null,
      watched: new Map(),
      subscriberMode: false,
      monitoring: false,
      blocked: null,
      heldRequests: [],
      authed: ctx.config.get('requirepass') === '',
      closeAfterReply: false,
      closing: false,
      connectedAtMs: Date.now(),
      lastActiveMs: Date.now(),
    };
    this.clients.set(conn.id, conn);
    ctx.clients = this.clients;
    ctx.stats.connectionsReceived += 1;
    ctx.log.debug('connection opened', { id: conn.id, address: conn.addr });

    socket.on('data', (chunk) => {
      conn.lastActiveMs = Date.now();
      const result = conn.parser.feed(chunk);
      if (result.fatal !== null) {
        conn.outbox.push(errProto(result.fatal.message));
        this.flushConn(conn);
        this.closeConnection(conn, 'protocol error');
        return;
      }
      for (const request of result.requests) {
        if (request === null) continue;
        this.enqueue(conn, request.args);
      }
      this.drain();
    });
    socket.on('error', (err) => {
      ctx.log.debug('connection socket error', { id: conn.id, error: err.code ?? String(err) });
    });
    socket.on('close', () => this.teardown(conn));
  }

  enqueue(conn, args) {
    if (conn.blocked !== null) {
      conn.heldRequests.push(args);
      return;
    }
    this.execQueue.push({ conn, args });
  }

  drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.execQueue.length > 0) {
        const item = this.execQueue.shift();
        const { conn, args } = item;
        if (conn.closing || !this.clients.has(conn.id)) continue;
        try {
          this.ctx.dispatch(conn, args);
        } catch (err) {
          if (err instanceof PersistenceError) {
            conn.outbox.push(errSrv('persistence failure acknowledged; write NOT durable'));
          } else {
            this.ctx.log.error('command execution failed unexpectedly', {
              command: args[0]?.toString('latin1'),
              error: err.stack ?? String(err),
            });
            conn.outbox.push(errSrv('internal error executing command'));
          }
        }
        this.touchedConns.add(conn);
      }
    } finally {
      this.draining = false;
    }
    for (const conn of this.touchedConns) this.flushConn(conn);
    this.touchedConns.clear();
  }

  flushConn(conn) {
    if (conn.outbox.length === 0) return;
    if (conn.closing || conn.socket.destroyed) {
      conn.outbox.length = 0;
      return;
    }
    const payload = Buffer.concat(conn.outbox);
    conn.outbox.length = 0;
    try {
      conn.socket.write(payload);
    } catch {
      this.closeConnection(conn, 'write failed');
      return;
    }
    if (conn.closeAfterReply) {
      conn.closing = true;
      conn.socket.end();
    }
  }

  resumeConnection(conn) {
    const held = conn.heldRequests;
    conn.heldRequests = [];
    for (const args of held) this.enqueue(conn, args);
  }

  closeConnection(conn, reason) {
    this.ctx.log.debug('closing connection', { id: conn.id, reason });
    conn.closing = true;
    conn.socket.end();
  }

  teardown(conn) {
    if (!this.clients.has(conn.id)) return;
    this.clients.delete(conn.id);
    this.ctx.blocking.dropConnection(conn.id);
    this.ctx.monitors.delete(conn);
    this.ctx.pubsub.drop(conn.id);
    this.ctx.log.debug('connection closed', { id: conn.id, address: conn.addr });
  }

  shutdown({ save }) {
    if (this.shuttingDown) return this.shutdownPromise;
    this.shuttingDown = true;
    const ctx = this.ctx;
    this.ctx.log.info('shutdown initiated', { save: save ? 'yes' : 'no' });

    for (const timer of this.intervals) clearInterval(timer);

    for (const conn of this.clients.values()) {
      this.flushConn(conn);
    }

    if (this.net !== null) {
      try {
        this.net.close();
      } catch {}
    }

    if (save && ctx.config.get('save-on-shutdown')) {
      try {
        ctx.snapshotWriter.writeSyncNow();
        ctx.log.info('snapshot saved during shutdown');
      } catch (err) {
        ctx.log.warn('shutdown snapshot failed', { error: err.message });
      }
    }

    try {
      if (ctx.aof.active) ctx.aof.close();
    } catch (err) {
      ctx.log.error('failed to close append log cleanly', { error: err.message });
    }

    for (const conn of this.clients.values()) {
      conn.socket.destroy();
      this.teardown(conn);
    }

    ctx.log.info('shutdown complete');
    return this.shutdownPromise;
  }
}
