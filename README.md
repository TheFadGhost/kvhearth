# Kvhearth

An in-memory key-value database with durable persistence and a
hand-typable text protocol, for developers who want a readable, correct
data store they can study and extend.

**This is a learning-oriented implementation. It is not a production
database.** There is no replication, no clustering, no authentication
beyond a single static password, and no security hardening beyond binding
to localhost by default.

## Install

Requires Node.js 20 or newer. No dependencies:

```
git clone https://github.com/TheFadGhost/kvhearth.git
cd kvhearth
npm test          # optional: run the suite (197 tests)
node bin/kvhearth.mjs
```

The server starts on `127.0.0.1:7379` with the append log enabled and
fsynced every second.

## Quick start

Server:

```
node bin/kvhearth.mjs --port 7379 --dir ./data
```

Client CLI:

```
node bin/kvhearth-cli.mjs
kvhearth:127.0.0.1:7379> SET greeting "hello world"
OK
kvhearth:127.0.0.1:7379> GET greeting
hello world
kvhearth:127.0.0.1:7379> QUIT
```

One-shot mode:

```
node bin/kvhearth-cli.mjs --eval "RPUSH list1 a b c"
```

Shell completions for bash/zsh/fish live in `completions/`.

## The protocol over netcat

KTP v1 is designed to be typed by hand:

```
$ nc localhost 7379
PING
+PONG
SET greeting hello
+OK
GET greeting
$5
hello
EXPIRE greeting 60
:1
TTL greeting
:60
RPUSH nums 1 2 3
:3
LRANGE nums 0 -1
*3
$1
1
$1
2
$1
3
HSET h f v
:1
HGETALL h
*2
$1
f
$1
v
# comment lines produce no reply; blank lines neither
BADCMD x
-ERR unknown command 'badcmd'
GET
-ERR GET wrong number of arguments (expected 1, got 0)
LPUSH greeting oops
-WRONGTYPE LPUSH key 'greeting' holds string, expected list
QUIT
+OK
```

Replies come in exactly seven kinds: `+simple`, `-CODE message`,
`:integer`, `$len` + bytes bulk, `$-1` nil, `*n` array of replies, and
`*-1` nil array. Every frame ends with LF.

For binary values there is a typed request form — `%N` followed by N
length-prefixed arguments:

```
%3
3 SET
1 k
5 hello
```

Lengths are byte counts and are authoritative; payloads may contain any
bytes including newlines. The CLI always uses this form. Framing errors
produce one `-PROTO ...` reply then close the connection, so a malformed
request never mis-frames what follows.

Full specification: [DESIGN.md](DESIGN.md).

## Command reference

- Strings: GET SET APPEND STRLEN INCR DECR INCRBY DECRBY GETRANGE SETRANGE
  (SET options: EX s / PX ms / NX / XX / KEEPTTL)
- Lists: LPUSH RPUSH LPOP RPOP LLEN LRANGE LINDEX LSET LTRIM BLPOP BRPOP
- Hashes: HSET HGET HDEL HEXISTS HKEYS HVALS HGETALL HLEN HINCRBY
- Sets: SADD SREM SISMEMBER SMEMBERS SCARD SINTER SUNION SDIFF
  SINTERSTORE SUNIONSTORE SDIFFSTORE
- Sorted sets: ZADD ZSCORE ZINCRBY ZCARD ZCOUNT ZRANK ZREVRANK ZRANGE
  ZRANGEBYSCORE ZREVRANGEBYSCORE ZREM
- Keys: DEL EXISTS TYPE EXPIRE PEXPIRE EXPIREAT PEXPIREAT TTL PTTL
  PERSIST RENAME RENAMENX DBSIZE SCAN, MEMORY USAGE
- Transactions: MULTI EXEC DISCARD WATCH UNWATCH
- Pub/sub: SUBSCRIBE UNSUBSCRIBE PSUBSCRIBE PUNSUBSCRIBE PUBLISH,
  PUBSUB CHANNELS / NUMSUB / NUMPAT
- Server: PING ECHO AUTH RESET QUIT COMMANDS CONFIG GET / SET,
  CLIENT ID / GETNAME / SETNAME / LIST / KILL, INFO section,
  SAVE BGSAVE LASTSAVE REWRITEAOF SHUTDOWN SAVE|NOSAVE, MONITOR,
  SLOWLOG GET / LEN / RESET, FLUSHALL FLUSHDB, DEBUG SLEEP (gated),
  SELECT (refused: one keyspace by design)

Errors follow one shape: `CODE command argument-info: lowercase message`,
with codes PROTO ERR WRONGTYPE RANGE OOM SRV.

## Persistence model

Two files under `--dir` (default `./data`):

- **Append-only log (`kvhearth.aof`)** — the authoritative history of
  every mutating command, stored in plain typed form. Human-readable.
- **Snapshot (`kvhearth.snap`)** — a point-in-time image written by SAVE,
  chunked BGSAVE, or automatically at shutdown. Integrity-checked with a
  SHA-256 digest over the body; corrupt snapshots refuse to load.

Startup: snapshot (if any) loads first, then the entire append log
replays over it. Every logged record assigns absolute state, so replay is
idempotent. A truncated final entry (crash mid-write) is detected and
discarded; a corrupt record mid-file refuses startup rather than loading
partial history. `node bin/kvhearth.mjs --check-aof FILE` reports on a
log without starting anything.

### Durability guarantees, per fsync policy

Acknowledged means: the client received the reply after the command was
written to the append log under the active policy.

| `--append-fsync` | Process crash (kill -9) | OS crash / power loss |
|---|---|---|
| `always` | no acknowledged write lost | no acknowledged write lost, modulo your disk's volatile write cache |
| `everysec` (default) | no acknowledged write lost | up to about one second of acknowledged writes may be lost |
| `never` | no acknowledged write lost | an unbounded recent tail may be lost |

Process crashes lose nothing under every policy because replies are sent
only after bytes reach the OS page cache. Only `always` claims power-loss
durability, and even then it trusts the drive. An fsync or write error is
never ignored: the connection gets `-SRV`, the fact is logged at ERROR,
and the server refuses further acknowledged writes until REWRITEAOF
succeeds.

REWRITEAOF compacts the log to one RESTORE record per live key while the
server keeps serving reads and writes; concurrent writes are captured in
a diff and included, so the rewritten log replays to identical state
(tested via state hashing).

## Concurrency model

Single-threaded command execution. Connections parse and buffer on async
IO; complete requests execute strictly one at a time. This makes
MULTI/EXEC atomicity, WATCH versioning, blocking operations and eviction
trivially correct. Throughput scales with pipelining rather than CPU
count — that trade was chosen deliberately in favor of auditability.

## Configuration

A config file (`--config FILE`) contains `key value` lines. Any key can
also be passed as `--key VALUE`. Units are explicit: sizes accept b/kb/mb/gb,
durations us/ms/s/m/h. Unknown keys abort startup (typo safety).
`--check-config` prints the resolved values and where each came from.

| key | default | meaning |
|---|---|---|
| bind / port | 127.0.0.1 / 7379 | listen address |
| dir | ./data | persistence directory |
| appendonly | yes | enable the append log |
| append-fsync | everysec | always / everysec / never |
| save-on-shutdown | yes | write snapshot on graceful exit |
| save-interval | 0 s | periodic background snapshot (0 = off) |
| maxmemory | 0 | byte limit; 0 disables enforcement |
| maxmemory-policy | noeviction | noeviction / allkeys-lru (approximate, sample-based) |
| maxclients | 1024 | connection cap; surplus get SRV + close |
| timeout | 0 s | idle connection timeout (0 = never) |
| requirepass | empty | require AUTH before commands |
| proto-max-args / -bulk / -request | 1024 / 64mb / 128mb | protocol limits, enforced before allocation |
| slowlog-slower-than | 10000 us | threshold for the slow log |
| slowlog-max-len | 128 | ring size |
| log-level / log-format | info / text | debug..error; text or json |
| theme | dark | CLI colour theme (dark/light/plain) |
| notify-keyspace-events | empty | K/E + classes g n L H S Z, A=all |

## Benchmarks

Measured with `bin/kvhearth-bench.mjs` on this repository's reference
machine: Intel Core i7-14700KF (20C/28T), 32 GB RAM, Windows 11,
Node.js v24.14.1, loopback TCP, SET:GET 1:1 mix, 64-byte random values.
Latency is client-side request-to-reply, reported as percentiles.

| scenario | throughput | p50 | p99 | p999 |
|---|---|---|---|---|
| everysec, 8 clients, pipeline 1, 50k keys | 55,037 ops/s | 0.134 ms | 0.309 ms | 0.756 ms |
| everysec, 1 client, pipeline 1 | 15,559 ops/s | 0.050 ms | 0.140 ms | 0.225 ms |
| always, 8 clients, pipeline 1, 50k keys | 4,958 ops/s | 1.528 ms | 3.745 ms | 5.204 ms |
| everysec, 50 clients, pipeline 16 | 219,731 ops/s | 3.487 ms | 6.209 ms | 8.279 ms |

The gap between everysec and always is the price of power-loss
durability, measured rather than claimed. Reproduce:

```
node bin/kvhearth.mjs --append-fsync everysec &
node bin/kvhearth-bench.mjs --clients 8 --pipeline 1 --seconds 10 --warmup 2 --keys 50000
```

## Architecture note

One process, one event loop. `src/proto` holds the request parser and
reply serializer, written from DESIGN.md by independent implementers so
the spec had to stand on its own. `src/store` is the five-type keyspace
with lazy expiry, per-entry versions (which WATCH consumes) and explicit
memory estimates. `src/persist` owns the append log, snapshots,
compaction and recovery. `src/server` wires connections to a strictly
ordered execution queue; blocking operations park outside it and are
woken by the mutations they wait for. Commands live in `src/commands`,
one family per file, each returning its reply plus the exact mutation
records destined for the append log.

## License

MIT — see [LICENSE](LICENSE).
