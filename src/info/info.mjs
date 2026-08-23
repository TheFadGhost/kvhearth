const PAD_WIDTH = 24;
const NUMBER_WIDTH = 12;

function field(name) {
  return `${name}:`.padEnd(PAD_WIDTH, ' ');
}

function num(value) {
  return String(value).padStart(NUMBER_WIDTH, ' ');
}

function line(name, value) {
  return `${field(name)}${value}`;
}

function numericLine(name, value) {
  return `${field(name)}${num(value)}`;
}

export class InfoRenderer {
  constructor(ctx) {
    this.ctx = ctx;
  }

  render(section) {
    const wanted = section === 'default' ? ['server', 'clients', 'memory', 'stats', 'keyspace', 'persistence', 'eviction'] : [section];
    const parts = [];
    for (const name of wanted) {
      const body = this.renderSection(name);
      if (body === null) continue;
      if (parts.length > 0) parts.push('');
      parts.push(`# ${name.charAt(0).toUpperCase()}${name.slice(1)}`);
      parts.push(body);
    }
    return parts.join('\n') + '\n';
  }

  renderSection(name) {
    const ctx = this.ctx;
    switch (name) {
      case 'server':
        return [
          line('version', ctx.version),
          line('node', process.version),
          line('os', `${process.platform} ${process.arch}`),
          numericLine('process_id', process.pid),
          numericLine('uptime_seconds', Math.floor((Date.now() - ctx.startedAtMs) / 1000)),
          line('config_file', ctx.configFilePath ?? '-'),
        ].join('\n');
      case 'clients':
        return [
          numericLine('connected_clients', ctx.clients.size),
          numericLine('maxclients', ctx.config.get('maxclients')),
          numericLine('blocked_clients', ctx.blocking.waiterCount),
        ].join('\n');
      case 'memory': {
        const limit = ctx.config.get('maxmemory');
        const used = ctx.store.usedBytes;
        const stored = ctx.store.storedCount();
        return [
          numericLine('used_bytes_estimate', used),
          numericLine('maxmemory_bytes', limit),
          line('maxmemory_policy', ctx.config.get('maxmemory-policy')),
          numericLine('bytes_per_key_avg', stored > 0 ? Math.round(used / stored) : 0),
        ].join('\n');
      }
      case 'stats': {
        const hits = ctx.stats.keyspaceHits;
        const misses = ctx.stats.keyspaceMisses;
        const total = hits + misses;
        const rate = total === 0 ? 0.00 : (hits / total) * 100;
        return [
          numericLine('total_connections_received', ctx.stats.connectionsReceived),
          numericLine('total_commands_processed', ctx.stats.commandsProcessed),
          numericLine('instantaneous_ops_per_sec', ctx.opsWindow.perSecond()),
          numericLine('keyspace_hits', hits),
          numericLine('keyspace_misses', misses),
          numericLine('hit_rate_percent', rate.toFixed(2)),
          numericLine('expired_keys', ctx.store.stats.expired),
          numericLine('evicted_keys', ctx.store.stats.evicted),
          numericLine('rejected_connections', ctx.stats.rejectedConnections),
          numericLine('pubsub_messages_published', ctx.stats.pubsubPublished),
        ].join('\n');
      }
      case 'keyspace':
        return [
          numericLine('keys_logical', ctx.store.logicalCount()),
          numericLine('keys_stored', ctx.store.storedCount()),
          numericLine('keys_with_expiry', ctx.store.keysWithExpiry()),
        ].join('\n');
      case 'persistence':
        return [
          line('appendonly', ctx.config.get('appendonly') ? 'yes' : 'no'),
          line('append_fsync', ctx.aof.fsyncPolicy),
          numericLine('aof_bytes', ctx.aof.bytesOnDisk),
          line('aof_state', ctx.aof.degraded ? 'degraded' : 'ok'),
          numericLine('aof_rewrites_completed', ctx.stats.aofRewrites),
          numericLine('snapshot_keys_last_save', ctx.snapshotWriter.keysWritten),
          line('bgsave_in_progress', ctx.snapshotWriter.running ? 'yes' : 'no'),
          line('rewrite_in_progress', ctx.rewriter.running ? 'yes' : 'no'),
        ].join('\n');
      case 'eviction':
        return [
          numericLine('eviction_samples_last_run', ctx.evictor.lastRunSamples),
          numericLine('evictions_last_run', ctx.evictor.lastRunEvicted),
          numericLine('total_evicted', ctx.store.stats.evicted),
        ].join('\n');
      default:
        return null;
    }
  }
}
