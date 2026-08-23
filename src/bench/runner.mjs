import { performance } from 'node:perf_hooks'
import { randomBytes } from 'node:crypto'

const CONNECT_TIMEOUT_MS = 5000
const KEY_PREFIX = 'bench:key:'

export async function loadClientClass() {
  const mod = await import('../client/lib.mjs')
  if (typeof mod.KvhearthClient !== 'function') {
    throw new Error('src/client/lib.mjs does not export KvhearthClient')
  }
  return mod.KvhearthClient
}

export function percentile(sortedSamples, p) {
  if (!Array.isArray(sortedSamples) || sortedSamples.length === 0) {
    throw new Error('percentile requires a non-empty sorted sample array')
  }
  if (!Number.isFinite(p) || p < 0 || p > 100) {
    throw new Error('percentile requires p in [0, 100]')
  }
  const n = sortedSamples.length
  let rank = Math.ceil((p / 100) * n)
  if (rank < 1) rank = 1
  if (rank > n) rank = n
  return sortedSamples[rank - 1]
}

function mulberry32(seed) {
  let a = seed >>> 0
  return function next() {
    a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function parseMix(mix) {
  const match = /^(\d+):(\d+)$/.exec(String(mix))
  if (!match) throw new Error("mix must be SET:GET shares like '1:1'")
  const setShare = Number(match[1])
  const getShare = Number(match[2])
  if (setShare < 1 || getShare < 1) throw new Error('mix shares must both be >= 1')
  return { setShare, getShare }
}

function numberOption(value, name, minimum, fallback) {
  if (value === undefined) return fallback
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n < minimum) {
    throw new Error(name + ' must be a number >= ' + minimum)
  }
  return n
}

async function probeServer(ClientClass, { host, port }) {
  try {
    const client = new ClientClass({ host, port })
    await client.connect()
    const persistenceReply = await client.cmd(['INFO', 'persistence'])
    const serverReply = await client.cmd(['INFO', 'server'])
    const persistenceText = persistenceReply.data ? persistenceReply.data.toString('latin1') : ''
    const serverText = serverReply.data ? serverReply.data.toString('latin1') : ''
    await client.end()
    return {
      appendFsync: matchInfoField(persistenceText, 'append_fsync') ?? 'unknown',
      version: matchInfoField(serverText, 'version') ?? 'unknown',
    }
  } catch {
    return { appendFsync: 'unknown', version: 'unknown' }
  }
}

function matchInfoField(text, field) {
  const line = text.split('\n').find((candidate) => candidate.startsWith(field + ':'))
  if (line === undefined) return null
  return line.slice(field.length + 1).trim()
}

function intOption(value, name, minimum, maximum, fallback) {
  const n = numberOption(value, name, minimum, fallback)
  if (!Number.isInteger(n) || n > maximum) {
    throw new Error(name + ' must be an integer in [' + minimum + ', ' + maximum + ']')
  }
  return n
}

export async function runBenchmark(options = {}) {
  const o = options === null ? {} : options
  const host = o.host === undefined ? '127.0.0.1' : String(o.host)
  const port = intOption(o.port, 'port', 1, 65535, 7379)
  const clients = intOption(o.clients, 'clients', 1, 4096, 50)
  const pipeline = intOption(o.pipeline, 'pipeline', 1, 4096, 1)
  const seconds = numberOption(o.seconds, 'seconds', 0, 10)
  const warmup = numberOption(o.warmup, 'warmup', 0, 2)
  if (seconds <= 0) throw new Error('seconds must be > 0')
  const { setShare, getShare } = parseMix(o.mix === undefined ? '1:1' : o.mix)
  const keys = intOption(o.keys, 'keys', 1, 2147483647, 100000)
  const valueSize = intOption(o.valueSize, 'valueSize', 1, 67108863, 64)
  const seed = o.seed === undefined
    ? randomBytes(4).readUInt32BE(0)
    : numberOption(o.seed, 'seed', 0, 0) >>> 0
  const ClientClass = o.clientClass === undefined ? await loadClientClass() : o.clientClass

  const startedAtISO = new Date().toISOString()
  const serverMeta = await probeServer(ClientClass, { host, port })
  const mixTotal = setShare + getShare
  const stats = { totalOps: 0, opsFailed: 0, samples: [] }

  const liveRecord = {
    results(count, failedCount, elapsedMs) {
      stats.totalOps += count
      stats.opsFailed += failedCount
      for (let i = 0; i < count; i++) stats.samples.push(elapsedMs)
    },
    failure(count, elapsedMs) {
      stats.totalOps += count
      stats.opsFailed += count
      for (let i = 0; i < count; i++) stats.samples.push(elapsedMs)
    },
  }
  const noopRecord = { results() {}, failure() {} }

  function makeWorker(index) {
    const rng = mulberry32((seed ^ Math.imul(index + 1, 0x9E3779B9)) >>> 0)
    let client = null
    const connect = () => {
      const c = new ClientClass({ host, port, connectTimeoutMs: CONNECT_TIMEOUT_MS })
      return c.connect().then(() => c)
    }
    const destroyQuietly = () => {
      try {
        client.destroy()
      } catch {}
    }
    const nextBatch = () => {
      const batch = []
      for (let i = 0; i < pipeline; i++) {
        const roll = Math.floor(rng() * mixTotal)
        const key = KEY_PREFIX + Math.floor(rng() * keys)
        if (roll < setShare) {
          batch.push(['SET', key, randomBytes(valueSize)])
        } else {
          batch.push(['GET', key])
        }
      }
      return batch
    }
    return {
      async open() {
        client = await connect()
      },
      async phase(deadlineMs, record) {
        while (performance.now() < deadlineMs) {
          const batch = nextBatch()
          const startedAt = performance.now()
          let replies = null
          let socketFailed = false
          try {
            replies = batch.length === 1
              ? [await client.cmd(batch[0])]
              : await client.pipeline(batch)
          } catch {
            socketFailed = true
          }
          const elapsedMs = performance.now() - startedAt
          if (socketFailed) {
            record.failure(batch.length, elapsedMs)
            destroyQuietly()
            try {
              client = await connect()
            } catch {
              return false
            }
            continue
          }
          let failedCount = 0
          for (const reply of replies) {
            if (reply !== null && reply !== undefined && reply.kind === 'error') failedCount++
          }
          record.results(batch.length, failedCount, elapsedMs)
        }
        return true
      },
      closeGracefully() {
        try {
          client.end()
        } catch {}
      },
      kill() {
        destroyQuietly()
      },
    }
  }

  const workers = []
  for (let i = 0; i < clients; i++) workers.push(makeWorker(i))
  try {
    await Promise.all(workers.map(w => w.open()))
  } catch (err) {
    for (const w of workers) w.kill()
    throw new Error('could not connect to ' + host + ':' + port + ': ' + (err && err.message))
  }
  try {
    if (warmup > 0) {
      const warmupDeadline = performance.now() + warmup * 1000
      await Promise.all(workers.map(w => w.phase(warmupDeadline, noopRecord)))
    }
    const windowStart = performance.now()
    const windowDeadline = windowStart + seconds * 1000
    await Promise.all(workers.map(w => w.phase(windowDeadline, liveRecord)))
    const durationSecondsActual = (performance.now() - windowStart) / 1000
    stats.samples.sort((a, b) => a - b)
    const latencyMs = {
      p50: percentile(stats.samples, 50),
      p90: percentile(stats.samples, 90),
      p99: percentile(stats.samples, 99),
      p999: percentile(stats.samples, 99.9),
      max: stats.samples.length > 0 ? stats.samples[stats.samples.length - 1] : 0,
    }
    return {
      startedAtISO,
      params: {
        host,
        port,
        clients,
        pipeline,
        seconds,
        warmup,
        mix: setShare + ':' + getShare,
        keys,
        valueSize,
        nodeVersion: process.version,
        platform: process.platform,
        serverAppendFsync: serverMeta.appendFsync,
        serverVersion: serverMeta.version,
      },
      durationSecondsActual,
      totalOps: stats.totalOps,
      opsFailed: stats.opsFailed,
      opsPerSecond: stats.totalOps / durationSecondsActual,
      latencyMs,
    }
  } finally {
    for (const w of workers) w.closeGracefully()
  }
}
