import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { KvhearthClient } from '../src/client/lib.mjs'

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function startServer(onConnection) {
  const sockets = []
  const server = net.createServer((sock) => {
    sock.setNoDelay(true)
    sockets.push(sock)
    onConnection(sock)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const stop = () =>
    new Promise((resolve) => {
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections()
      }
      for (const sock of sockets) sock.destroy()
      server.close(() => resolve())
    })
  return { port: server.address().port, stop }
}

async function withClient(port, fn) {
  const client = new KvhearthClient({ port })
  try {
    await client.connect()
    return await fn(client)
  } finally {
    client.destroy()
  }
}

function onceEvent(emitter, event) {
  return new Promise((resolve) => emitter.once(event, resolve))
}

async function waitForPush(client) {
  const result = await Promise.race([
    onceEvent(client, 'push').then((reply) => ({ ok: true, reply })),
    sleep(3000).then(() => ({ ok: false })),
  ])
  assert.ok(result.ok, 'timed out waiting for push event')
  return result.reply
}

function bigSequence() {
  return [
    {
      cmd: ['PING'],
      wire: '+PONG\n',
      want: { kind: 'simple', text: 'PONG' },
    },
    {
      cmd: ['BOGUS'],
      wire: '-ERR BOGUS unknown command\n',
      want: { kind: 'error', code: 'ERR', text: 'BOGUS unknown command' },
    },
    {
      cmd: ['INCR', 'c'],
      wire: ':42\n',
      want: { kind: 'integer', n: 42 },
    },
    {
      cmd: ['GET', 'k'],
      wire: '$5\nhello\n',
      want: { kind: 'bulk', data: Buffer.from('hello') },
    },
    {
      cmd: ['GET', 'gone'],
      wire: '$-1\n',
      want: { kind: 'nil-bulk' },
    },
    {
      cmd: ['LRANGE', 'l', '0', '-1'],
      wire: '*2\n$1\na\n$1\nb\n',
      want: {
        kind: 'array',
        items: [
          { kind: 'bulk', data: Buffer.from('a') },
          { kind: 'bulk', data: Buffer.from('b') },
        ],
      },
    },
    {
      cmd: ['SMEMBERS', 's'],
      wire: '*0\n',
      want: { kind: 'array', items: [] },
    },
    {
      cmd: ['EXEC'],
      wire: '*-1\n',
      want: { kind: 'nil-array' },
    },
    {
      cmd: ['LPUSH', 'k', 'x'],
      wire: '-WRONGTYPE LPUSH key \'k\' holds string, expected list\n',
      want: {
        kind: 'error',
        code: 'WRONGTYPE',
        text: 'LPUSH key \'k\' holds string, expected list',
      },
    },
    {
      cmd: ['HGETALL', 'h'],
      wire: '*3\n*2\n$1\na\n:7\n$-1\n*-1\n',
      want: {
        kind: 'array',
        items: [
          {
            kind: 'array',
            items: [
              { kind: 'bulk', data: Buffer.from('a') },
              { kind: 'integer', n: 7 },
            ],
          },
          { kind: 'nil-bulk' },
          { kind: 'nil-array' },
        ],
      },
    },
  ]
}

test('scripted sequence parses every reply kind exactly', { timeout: 15000 }, async () => {
  const seq = bigSequence()
  const srv = await startServer((sock) => {
    sock.on('data', () => {})
    sock.write(seq.map((step) => step.wire).join(''))
  })
  try {
    await withClient(srv.port, async (client) => {
      const promises = seq.map((step) => client.cmd(step.cmd))
      const replies = await Promise.all(promises)
      replies.forEach((reply, i) => {
        assert.deepStrictEqual(reply, seq[i].want)
      })
    })
  } finally {
    await srv.stop()
  }
})

test('parses replies delivered one byte at a time', { timeout: 30000 }, async () => {
  const seq = bigSequence()
  let idx = 0
  const srv = await startServer((sock) => {
    sock.on('data', () => {
      if (idx >= seq.length) return
      const blob = Buffer.from(seq[idx].wire)
      idx += 1
      let i = 0
      const timer = setInterval(() => {
        if (sock.destroyed || i >= blob.length) {
          clearInterval(timer)
          return
        }
        sock.write(blob.subarray(i, i + 1))
        i += 1
      }, 3)
    })
  })
  try {
    await withClient(srv.port, async (client) => {
      for (const step of seq) {
        const reply = await client.cmd(step.cmd)
        assert.deepStrictEqual(reply, step.want)
      }
    })
  } finally {
    await srv.stop()
  }
})

test('coalesced multi-reply chunk maps pipeline results in order', { timeout: 15000 }, async () => {
  const all = bigSequence()
  const seq = [all[2], all[0], all[4], all[1], all[7], all[5]]
  const batch = Buffer.concat(seq.map((step) => Buffer.from(step.wire)))
  let sawRequest = false
  const srv = await startServer((sock) => {
    sock.on('data', (chunk) => {
      if (!sawRequest) {
        sawRequest = true
        assert.ok(chunk.length > 0)
        sock.write(batch)
      }
    })
  })
  try {
    await withClient(srv.port, async (client) => {
      const replies = await client.pipeline(seq.map((step) => step.cmd))
      assert.equal(replies.length, seq.length)
      replies.forEach((reply, i) => {
        assert.deepStrictEqual(reply, seq[i].want)
      })
    })
    assert.ok(sawRequest)
  } finally {
    await srv.stop()
  }
})

test('requests are encoded in typed form, binary-safe', { timeout: 15000 }, async () => {
  const args = ['SET', 'a\nb', Buffer.from([0x00, 0xff])]
  const expected = Buffer.concat([
    Buffer.from([0x25, 0x33, 0x0a]),
    Buffer.from([0x33, 0x20, 0x53, 0x45, 0x54, 0x0a]),
    Buffer.from([0x33, 0x20, 0x61, 0x0a, 0x62, 0x0a]),
    Buffer.from([0x32, 0x20, 0x00, 0xff, 0x0a]),
  ])
  let acc = Buffer.alloc(0)
  let mismatch = null
  const srv = await startServer((sock) => {
    sock.on('data', (chunk) => {
      acc = Buffer.concat([acc, chunk])
      if (mismatch === null && !acc.subarray(0, Math.min(expected.length, acc.length)).equals(expected.subarray(0, Math.min(expected.length, acc.length)))) {
        mismatch = new Error('request prefix diverges from typed-form encoding')
      }
      if (mismatch === null && acc.length >= expected.length) sock.write('+OK\n')
    })
  })
  try {
    await withClient(srv.port, async (client) => {
      const reply = await client.cmd(args)
      assert.deepStrictEqual(reply, { kind: 'simple', text: 'OK' })
      for (let i = 0; i < 200 && acc.length < expected.length; i += 1) {
        await sleep(10)
      }
    })
    assert.equal(mismatch, null)
    assert.ok(
      acc.equals(expected),
      'received request bytes must equal independent typed-form encoding',
    )
  } finally {
    await srv.stop()
  }
})

const PUSH_FRAME = '*3\n$9\nsubscribe\n$4\nchat\n:1\n'
const PUSH_REPLY = {
  kind: 'array',
  items: [
    { kind: 'bulk', data: Buffer.from('subscribe') },
    { kind: 'bulk', data: Buffer.from('chat') },
    { kind: 'integer', n: 1 },
  ],
}

test('unsolicited push fires while idle, then cmd round-trips', { timeout: 15000 }, async () => {
  const srv = await startServer((sock) => {
    sock.write(PUSH_FRAME)
    sock.on('data', () => sock.write('+PONG\n'))
  })
  try {
    const client = new KvhearthClient({ port: srv.port })
    try {
      const pushPromise = waitForPush(client)
      await client.connect()
      const push = await pushPromise
      assert.deepStrictEqual(push, PUSH_REPLY)
      const pong = await client.cmd(['PING'])
      assert.deepStrictEqual(pong, { kind: 'simple', text: 'PONG' })
    } finally {
      client.destroy()
    }
  } finally {
    await srv.stop()
  }
})

test('push trailing replies in one chunk emits only after outstanding reaches zero', { timeout: 15000 }, async () => {
  const batch = '+OK\n:5\n' + PUSH_FRAME
  let sent = false
  const srv = await startServer((sock) => {
    sock.on('data', () => {
      if (!sent) {
        sent = true
        sock.write(batch)
      }
    })
  })
  try {
    await withClient(srv.port, async (client) => {
      let pushCount = 0
      let pendingAtPush = -1
      client.on('push', () => {
        pushCount += 1
        pendingAtPush = client.pending.length
      })
      const replies = await client.pipeline([['A'], ['B']])
      assert.deepStrictEqual(replies[0], { kind: 'simple', text: 'OK' })
      assert.deepStrictEqual(replies[1], { kind: 'integer', n: 5 })
      assert.equal(pushCount, 1)
      assert.equal(pendingAtPush, 0)
      assert.equal(client.bufferedPushes.length, 0)
    })
  } finally {
    await srv.stop()
  }
})

test('connect rejects when the port is closed', { timeout: 15000 }, async () => {
  const probe = net.createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise((resolve) => probe.close(resolve))
  const client = new KvhearthClient({ port, connectTimeoutMs: 2000 })
  try {
    await assert.rejects(client.connect(), (err) => err instanceof Error)
    await assert.rejects(client.cmd(['PING']), /not connected/)
  } finally {
    client.destroy()
  }
})

test('connect timeout bounds an unresponsive host', { timeout: 15000 }, async () => {
  const client = new KvhearthClient({
    host: '192.0.2.123',
    port: 81,
    connectTimeoutMs: 150,
  })
  const started = Date.now()
  try {
    await assert.rejects(client.connect(), (err) => err instanceof Error)
    assert.ok(Date.now() - started < 5000, 'rejection must be bounded by connectTimeoutMs')
  } finally {
    client.destroy()
  }
})

test('end resolves cleanly and later commands reject', { timeout: 15000 }, async () => {
  const srv = await startServer((sock) => {
    sock.on('data', () => sock.write('+PONG\n'))
  })
  try {
    const client = new KvhearthClient({ port: srv.port })
    await client.connect()
    const pong = await client.cmd(['PING'])
    assert.deepStrictEqual(pong, { kind: 'simple', text: 'PONG' })
    await client.end()
    await assert.rejects(client.cmd(['PING']), /not connected/)
    client.destroy()
  } finally {
    await srv.stop()
  }
})

test('framing violation emits error, rejects pending, destroys connection', { timeout: 15000 }, async () => {
  let sent = false
  const srv = await startServer((sock) => {
    sock.on('data', () => {
      if (!sent) {
        sent = true
        sock.write('@junk line\n')
      }
    })
  })
  try {
    const client = new KvhearthClient({ port: srv.port })
    try {
      await client.connect()
      const errPromise = onceEvent(client, 'error')
      const closePromise = onceEvent(client, 'close')
      const replyPromise = client.cmd(['PING'])
      const err = await errPromise
      assert.ok(err instanceof Error)
      assert.match(err.message, /unknown reply type/i)
      await assert.rejects(replyPromise, (reason) => reason === err)
      await closePromise
      await assert.rejects(client.cmd(['PING']), /not connected/)
    } finally {
      client.destroy()
    }
  } finally {
    await srv.stop()
  }
})
