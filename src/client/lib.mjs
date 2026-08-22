import { EventEmitter } from 'node:events'
import net from 'node:net'

const LF = 0x0a
const CR = 0x0d
const MAX_LINE_BYTES = 64 * 1024 * 1024
const MAX_ARRAY_DEPTH = 65536

export function encodeRequest(args) {
  if (!Array.isArray(args)) {
    throw new TypeError('command arguments must be an array')
  }
  if (args.length < 1) {
    throw new TypeError('command requires at least one argument')
  }
  const buffers = args.map((arg) => {
    if (typeof arg === 'string') return Buffer.from(arg, 'utf8')
    if (Buffer.isBuffer(arg)) return arg
    throw new TypeError('command arguments must be strings or Buffers')
  })
  const parts = [Buffer.from('%' + buffers.length + '\n')]
  for (const bytes of buffers) {
    parts.push(Buffer.from(bytes.length.toString(10) + ' '))
    parts.push(bytes)
    parts.push(Buffer.from('\n'))
  }
  return Buffer.concat(parts)
}

class ReplyParser {
  constructor(onReply, onViolation) {
    this.onReply = onReply
    this.onViolation = onViolation
    this.buf = null
    this.pos = 0
    this.state = 'line'
    this.bulkRemaining = 0
    this.bulkParts = []
    this.stack = []
  }

  reset() {
    this.buf = null
    this.pos = 0
    this.state = 'line'
    this.bulkRemaining = 0
    this.bulkParts = []
    this.stack = []
  }

  feed(chunk) {
    if (this.buf === null || this.pos >= this.buf.length) {
      this.buf = chunk
      this.pos = 0
    } else {
      this.buf = Buffer.concat([this.buf.subarray(this.pos), chunk])
      this.pos = 0
    }
    try {
      this.run()
    } catch (err) {
      this.reset()
      this.onViolation(err)
    }
  }

  run() {
    const buf = this.buf
    for (;;) {
      if (this.state === 'line') {
        const nl = buf.indexOf(LF, this.pos)
        if (nl === -1) {
          if (buf.length - this.pos > MAX_LINE_BYTES) {
            throw new Error('kvhearth: reply line exceeds maximum length')
          }
          return
        }
        let end = nl
        if (end > this.pos && buf[end - 1] === CR) end -= 1
        const line = buf.subarray(this.pos, end)
        this.pos = nl + 1
        this.handleLine(line)
      } else if (this.state === 'bulk-payload') {
        const avail = buf.length - this.pos
        if (avail < 1) return
        const take = Math.min(avail, this.bulkRemaining)
        if (take > 0) {
          this.bulkParts.push(buf.subarray(this.pos, this.pos + take))
          this.pos += take
          this.bulkRemaining -= take
        }
        if (this.bulkRemaining > 0) return
        this.state = 'bulk-end'
      } else {
        if (buf.length - this.pos < 1) return
        const byte = buf[this.pos]
        if (byte === CR) {
          this.pos += 1
          continue
        }
        if (byte !== LF) {
          throw new Error('kvhearth: bulk payload not terminated by LF')
        }
        this.pos += 1
        const data = Buffer.concat(this.bulkParts)
        this.bulkParts = []
        this.state = 'line'
        this.deliver({ kind: 'bulk', data })
      }
    }
  }

  handleLine(line) {
    if (line.length === 0) {
      throw new Error('kvhearth: empty reply line')
    }
    const marker = line[0]
    if (marker === 0x2b) {
      this.deliver({ kind: 'simple', text: line.toString('utf8', 1) })
      return
    }
    if (marker === 0x2d) {
      const raw = line.toString('utf8', 1)
      const space = raw.indexOf(' ')
      if (space === -1) {
        this.deliver({ kind: 'error', code: raw, text: '' })
      } else {
        this.deliver({
          kind: 'error',
          code: raw.slice(0, space),
          text: raw.slice(space + 1),
        })
      }
      return
    }
    if (marker === 0x3a) {
      const text = line.toString('ascii', 1)
      if (!/^-?[0-9]+$/.test(text)) {
        throw new Error('kvhearth: malformed integer reply')
      }
      this.deliver({ kind: 'integer', n: Number(text) })
      return
    }
    if (marker === 0x24) {
      const len = parseLength(line)
      if (len === -1) {
        this.deliver({ kind: 'nil-bulk' })
        return
      }
      if (len < -1) {
        throw new Error('kvhearth: malformed bulk length')
      }
      this.state = 'bulk-payload'
      this.bulkRemaining = len
      this.bulkParts = []
      return
    }
    if (marker === 0x2a) {
      const count = parseLength(line)
      if (count === -1) {
        this.deliver({ kind: 'nil-array' })
        return
      }
      if (count < -1) {
        throw new Error('kvhearth: malformed array length')
      }
      if (count === 0) {
        this.deliver({ kind: 'array', items: [] })
        return
      }
      if (this.stack.length >= MAX_ARRAY_DEPTH) {
        throw new Error('kvhearth: array nesting too deep')
      }
      this.stack.push({ remaining: count, items: [] })
      return
    }
    throw new Error('kvhearth: unknown reply type byte 0x' + marker.toString(16))
  }

  deliver(reply) {
    let frame = this.stack[this.stack.length - 1]
    if (frame === undefined) {
      this.onReply(reply)
      return
    }
    frame.items.push(reply)
    frame.remaining -= 1
    while (frame.remaining === 0) {
      this.stack.pop()
      const array = { kind: 'array', items: frame.items }
      frame = this.stack[this.stack.length - 1]
      if (frame === undefined) {
        this.onReply(array)
        return
      }
      frame.items.push(array)
      frame.remaining -= 1
    }
  }
}

function parseLength(line) {
  const text = line.toString('ascii', 1)
  if (!/^-?[0-9]+$/.test(text)) {
    throw new Error('kvhearth: malformed length prefix')
  }
  return Number(text)
}

export class KvhearthClient extends EventEmitter {
  constructor(options = {}) {
    super()
    this.host = options.host !== undefined ? options.host : '127.0.0.1'
    this.port = options.port !== undefined ? options.port : 7379
    this.connectTimeoutMs =
      options.connectTimeoutMs !== undefined ? options.connectTimeoutMs : 5000
    this.parser = new ReplyParser(
      (reply) => this.dispatchReply(reply),
      (err) => this.onProtocolError(err),
    )
    this.socket = null
    this.connected = false
    this.pending = []
    this.bufferedPushes = []
    this.connectPromise = null
    this.endPromise = null
  }

  connect() {
    if (this.connected && this.socket !== null) return Promise.resolve(this)
    if (this.connectPromise !== null) return this.connectPromise
    this.parser.reset()
    this.bufferedPushes = []
    this.connectPromise = new Promise((resolve, reject) => {
      const socket = net.connect({ host: this.host, port: this.port })
      this.socket = socket
      let settled = false
      const settle = (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (err) {
          socket.removeAllListeners()
          socket.destroy()
          this.socket = null
          this.connectPromise = null
          reject(err)
          return
        }
        this.connected = true
        this.connectPromise = null
        resolve(this)
      }
      const timer = setTimeout(() => {
        settle(
          new Error(
            'kvhearth: connect timed out after ' +
              this.connectTimeoutMs +
              'ms to ' +
              this.host +
              ':' +
              this.port,
          ),
        )
      }, this.connectTimeoutMs)
      socket.once('connect', () => settle(null))
      socket.on('error', (err) => {
        if (!settled) {
          settle(err)
          return
        }
        this.emit('error', err)
      })
      socket.on('data', (chunk) => this.parser.feed(chunk))
      socket.on('close', () => this.onSocketClose())
    })
    return this.connectPromise
  }

  cmd(args) {
    try {
      const encoded = encodeRequest(args)
      this.assertConnected()
      return new Promise((resolve, reject) => {
        this.pending.push({ resolve, reject })
        this.socket.write(encoded)
      })
    } catch (err) {
      return Promise.reject(err)
    }
  }

  pipeline(cmds) {
    try {
      if (!Array.isArray(cmds)) {
        throw new TypeError('pipeline expects an array of commands')
      }
      const encoded = cmds.map((args) => encodeRequest(args))
      this.assertConnected()
      const promises = encoded.map(
        () =>
          new Promise((resolve, reject) => {
            this.pending.push({ resolve, reject })
          }),
      )
      this.socket.write(Buffer.concat(encoded))
      return Promise.all(promises)
    } catch (err) {
      return Promise.reject(err)
    }
  }

  end() {
    if (this.socket === null) return Promise.resolve()
    if (this.endPromise !== null) return this.endPromise
    this.endPromise = new Promise((resolve) => {
      const socket = this.socket
      socket.once('close', () => resolve())
      if (!socket.writableEnded) socket.end()
    })
    return this.endPromise
  }

  destroy() {
    this.failPending(new Error('kvhearth: connection destroyed'))
    this.bufferedPushes = []
    this.connected = false
    if (this.socket !== null) this.socket.destroy()
  }

  assertConnected() {
    if (this.socket === null || !this.connected) {
      throw new Error('kvhearth: client is not connected')
    }
  }

  dispatchReply(reply) {
    if (this.pending.length > 0) {
      const waiter = this.pending.shift()
      waiter.resolve(reply)
      if (this.pending.length === 0 && this.bufferedPushes.length > 0) {
        const flush = this.bufferedPushes
        this.bufferedPushes = []
        for (const push of flush) this.emit('push', push)
      }
      return
    }
    this.emit('push', reply)
  }

  onProtocolError(err) {
    this.failPending(err)
    this.bufferedPushes = []
    this.emit('error', err)
    if (this.socket !== null) this.socket.destroy()
  }

  onSocketClose() {
    this.connected = false
    this.socket = null
    this.endPromise = null
    this.connectPromise = null
    this.failPending(new Error('kvhearth: connection closed before reply'))
    this.emit('close')
  }

  failPending(err) {
    const waiting = this.pending
    this.pending = []
    for (const waiter of waiting) waiter.reject(err)
  }
}
