import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { runBenchmark, percentile } from '../src/bench/runner.mjs'

const LF = Buffer.from('\n', 'ascii')

function readLine(buf, offset) {
  const idx = buf.indexOf(0x0A, offset)
  if (idx === -1) return null
  return { line: buf.subarray(offset, idx), next: idx + 1 }
}

function badFrame(offset) {
  return { argv: null, offset }
}

function parseRequest(buf, offset) {
  if (offset >= buf.length) return null
  if (buf[offset] === 0x25) {
    const head = readLine(buf, offset)
    if (head === null) return null
    const count = Number.parseInt(head.line.subarray(1).toString('ascii'), 10)
    if (!Number.isInteger(count) || count < 1 || count > 1024) return badFrame(head.next)
    let pos = head.next
    const parts = []
    for (let i = 0; i < count; i++) {
      let sp = -1
      const limit = Math.min(buf.length, pos + 24)
      for (let j = pos; j < limit; j++) {
        if (buf[j] === 0x20) {
          sp = j
          break
        }
        if (buf[j] === 0x0A) break
      }
      if (sp === -1) return badFrame(pos)
      const len = Number.parseInt(buf.subarray(pos, sp).toString('ascii'), 10)
      if (!Number.isInteger(len) || len < 0) return badFrame(sp + 1)
      const dataStart = sp + 1
      if (buf.length < dataStart + len + 1) return null
      if (buf[dataStart + len] !== 0x0A) return badFrame(dataStart + len)
      parts.push(Buffer.from(buf.subarray(dataStart, dataStart + len)))
      pos = dataStart + len + 1
    }
    return { argv: parts, offset: pos }
  }
  const head = readLine(buf, offset)
  if (head === null) return null
  const text = head.line.toString('latin1').replace(/\r$/, '')
  if (text.length === 0 || text.startsWith('#')) return { argv: [], offset: head.next }
  const tokens = text.split(/\s+/).filter(t => t.length > 0)
  return { argv: tokens.map(t => Buffer.from(t, 'latin1')), offset: head.next }
}

function renderReply(argv) {
  const cmd = argv[0].toString('ascii').toUpperCase()
  if (cmd === 'SET') return '+OK\n'
  if (cmd === 'GET') return '$1\nx\n'
  if (cmd === 'PING') return '+PONG\n'
  return '-ERR unknown command\n'
}

class fallbackMockClient {
  constructor(opts = {}) {
    this.host = opts.host === undefined ? '127.0.0.1' : opts.host
    this.port = opts.port
    this.connectTimeoutMs = opts.connectTimeoutMs === undefined ? 5000 : opts.connectTimeoutMs
    this.socket = null
    this.buffer = Buffer.alloc(0)
    this.waiters = []
  }
  connect() {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: this.host, port: this.port })
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new Error('fallbackMockClient connect timeout'))
      }, this.connectTimeoutMs)
      socket.once('connect', () => {
        clearTimeout(timer)
        this.socket = socket
        resolve()
      })
      socket.on('data', chunk => this.consume(chunk))
      socket.once('error', err => {
        clearTimeout(timer)
        if (this.socket === null) reject(err)
        else this.breakWaiters()
        socket.destroy()
      })
      socket.on('close', () => this.breakWaiters())
    })
  }
  consume(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    for (;;) {
      const parsed = parseReply(this.buffer, 0)
      if (parsed === null) break
      this.buffer = this.buffer.subarray(parsed.offset)
      const waiter = this.waiters.shift()
      if (waiter !== undefined) waiter.resolve(parsed.reply)
    }
  }
  breakWaiters() {
    const waiters = this.waiters
    this.waiters = []
    for (const waiter of waiters) waiter.reject(new Error('connection closed before reply'))
  }
  send(argv) {
    const parts = [Buffer.from('%' + argv.length + '\n', 'ascii')]
    for (const arg of argv) {
      const bytes = Buffer.isBuffer(arg) ? arg : Buffer.from(String(arg), 'utf8')
      parts.push(Buffer.from(bytes.length + ' ', 'ascii'))
      parts.push(bytes)
      parts.push(LF)
    }
    this.socket.write(Buffer.concat(parts))
  }
  nextReply() {
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }))
  }
  async cmd(argv) {
    this.send(argv)
    return await this.nextReply()
  }
  async pipeline(commands) {
    const promises = []
    for (let i = 0; i < commands.length; i++) promises.push(this.nextReply())
    for (const argv of commands) this.send(argv)
    return await Promise.all(promises)
  }
  end() {
    if (this.socket !== null) this.socket.end()
  }
  destroy() {
    if (this.socket !== null) {
      this.socket.destroy()
      this.socket = null
    }
  }
}

function parseReply(buf, offset) {
  if (offset >= buf.length) return null
  const marker = String.fromCharCode(buf[offset])
  const line = readLine(buf, offset)
  switch (marker) {
    case '+':
      if (line === null) return null
      return { reply: { kind: 'simple', text: line.line.subarray(1).toString('utf8') }, offset: line.next }
    case '-':
      if (line === null) return null
      {
        const text = line.line.subarray(1).toString('utf8')
        const sp = text.indexOf(' ')
        return {
          reply: {
            kind: 'error',
            code: sp === -1 ? text : text.slice(0, sp),
            message: sp === -1 ? '' : text.slice(sp + 1),
          },
          offset: line.next,
        }
      }
    case ':':
      if (line === null) return null
      return {
        reply: { kind: 'integer', n: Number.parseInt(line.line.subarray(1).toString('ascii'), 10) },
        offset: line.next,
      }
    case '$':
      if (line === null) return null
      {
        const len = Number.parseInt(line.line.subarray(1).toString('ascii'), 10)
        if (len === -1) return { reply: { kind: 'nil-bulk' }, offset: line.next }
        if (!Number.isInteger(len) || len < 0) {
          return { reply: { kind: 'error', code: 'PROTO', message: 'bad bulk length' }, offset: line.next }
        }
        if (buf.length < line.next + len + 1) return null
        return {
          reply: { kind: 'bulk', data: Buffer.from(buf.subarray(line.next, line.next + len)) },
          offset: line.next + len + 1,
        }
      }
    case '*':
      if (line === null) return null
      {
        const count = Number.parseInt(line.line.subarray(1).toString('ascii'), 10)
        if (count === -1) return { reply: { kind: 'nil-array' }, offset: line.next }
        let pos = line.next
        const items = []
        for (let i = 0; i < count; i++) {
          const child = parseReply(buf, pos)
          if (child === null) return null
          items.push(child.reply)
          pos = child.offset
        }
        return { reply: { kind: 'array', items }, offset: pos }
      }
    default:
      return { reply: { kind: 'error', code: 'PROTO', message: 'unknown reply marker' }, offset: offset + 1 }
  }
}

test('percentile uses nearest-rank on sorted samples', () => {
  assert.equal(percentile([1, 2, 3, 4], 50), 2)
  assert.equal(percentile([10, 20, 30], 100), 30)
  assert.equal(percentile([10, 20, 30], 0), 10)
  assert.equal(percentile([5], 99.9), 5)
  assert.equal(percentile([4, 1, 3, 2, 5].sort((a, b) => a - b), 90), 5)
})

test('runBenchmark against mock server produces sane report', async () => {
  const sockets = new Set()
  const server = net.createServer(sock => {
    sockets.add(sock)
    let buf = Buffer.alloc(0)
    sock.on('data', chunk => {
      buf = Buffer.concat([buf, chunk])
      for (;;) {
        const req = parseRequest(buf, 0)
        if (req === null) break
        buf = buf.subarray(req.offset)
        if (req.argv === null) {
          sock.write('-PROTO framing violation\n')
          sock.destroy()
          return
        }
        if (req.argv.length === 0) continue
        sock.write(renderReply(req.argv))
      }
    })
    const drop = () => sockets.delete(sock)
    sock.on('close', drop)
    sock.on('error', () => {})
  })

  const port = await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })

  let clientClass
  try {
    const mod = await import('../src/client/lib.mjs')
    clientClass = mod.KvhearthClient
  } catch {
    clientClass = fallbackMockClient
  }

  try {
    const report = await runBenchmark({
      host: '127.0.0.1',
      port,
      clients: 2,
      pipeline: 2,
      seconds: 1,
      warmup: 0,
      mix: '1:1',
      keys: 100,
      valueSize: 16,
      clientClass,
    })
    assert.ok(report.totalOps > 0)
    assert.equal(report.opsFailed, 0)
    assert.ok(report.opsPerSecond > 0)
    assert.ok(report.durationSecondsActual >= 0.9)
    const l = report.latencyMs
    for (const field of ['p50', 'p90', 'p99', 'p999', 'max']) {
      assert.equal(typeof l[field], 'number')
      assert.ok(Number.isFinite(l[field]))
    }
    assert.ok(l.p50 <= l.p90)
    assert.ok(l.p90 <= l.p99)
    assert.ok(l.p99 <= l.p999)
    assert.ok(l.p999 <= l.max)
    assert.ok(!Number.isNaN(Date.parse(report.startedAtISO)))
    assert.equal(report.params.host, '127.0.0.1')
    assert.equal(report.params.port, port)
    assert.equal(report.params.clients, 2)
    assert.equal(report.params.pipeline, 2)
    assert.equal(report.params.mix, '1:1')
    assert.equal(report.params.keys, 100)
    assert.equal(report.params.valueSize, 16)
    assert.equal(report.params.nodeVersion, process.version)
    assert.equal(report.params.platform, process.platform)
    assert.ok(typeof report.params.nodeVersion === 'string' && report.params.nodeVersion.length > 0)
    assert.ok(typeof report.params.platform === 'string' && report.params.platform.length > 0)
  } finally {
    for (const sock of sockets) sock.destroy()
    await new Promise(resolve => server.close(() => resolve()))
  }
})
