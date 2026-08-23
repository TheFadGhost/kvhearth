# Kvhearth Design

Version: 1.0 (this document is the contract; implementations conform to it)

## Point of view

Kvhearth is deliberately boring. A database is infrastructure you meet at 3am,
so everything about it — the wire protocol, the replies, the errors, the logs,
the stats — should be predictable enough to operate from memory and legible
enough to debug through a raw socket. Human interfaces come first: the
protocol can be typed by hand over netcat, errors say which command and which
argument was wrong, numbers in stats line up in columns, and severity in logs
is carried by a word as well as a colour. There is no theme gallery, no
marketing register, no magic. Where a guarantee exists it is stated exactly;
where it does not, that is stated too.

## 1. Wire protocol — Kvhearth Text Protocol (KTP) v1

### 1.1 Framing and encoding

- Transport: TCP. Default port 7379.
- Every frame (request line, argument record, reply) terminates with `\n` (LF, 0x0A).
- Input accepts `\n` or `\r\n` line endings; replies always emit bare `\n`.
- Bytes are binary; only protocol keywords are interpreted. Values and keys
  are arbitrary byte strings unless stated otherwise.
- Size limits (enforced BEFORE allocation):
  - `proto-max-args`    max arguments per request        default 1024
  - `proto-max-bulk`    max bytes per single argument    default 64 MiB
  - `proto-max-request` max bytes buffered per request   default 128 MiB
- Any framing violation produces one `-PROTO ...` reply and then the server
  closes the connection (the stream can no longer be framed reliably). This
  guarantees a malformed request never mis-frames a subsequent one.

### 1.2 Requests

Two forms. Either may be used at any time on any connection.

Inline form — one line, whitespace-split:

```
SET greeting "hello world"
```

- Tokens are separated by one or more spaces or tabs.
- A token may be wrapped in double quotes to contain spaces; inside quotes
  the escapes `\\ \" \n \r \t \0 \xHH` are recognised. An unterminated quote
  is a framing violation.
- Inline form carries arbitrary bytes only via escapes; use the typed form
  for raw binary.
- Empty lines are ignored (no reply). Lines starting with `#` are comments
  and ignored (no reply) — this lets humans annotate netcat sessions.

Typed form — length-prefixed, fully binary-safe:

```
%3
3 SET
1 k
5 hello
```

- First line: `%N` where N is the argument count, `1 <= N <= proto-max-args`.
- Then N records. Each record is: decimal byte-length, one space, exactly
  length raw bytes, then `\n`. The raw bytes may contain anything, including
  `\n` and `\0`; the length is authoritative.
- If EOF or a non-matching byte follows the declared length, that is a
  framing violation (reply `-PROTO`, close).

### 1.3 Replies

Every reply ends with `\n`. Exactly seven kinds:

| Kind          | Shape                | Example                |
|---------------|----------------------|------------------------|
| Simple string | `+<text>`            | `+OK`                  |
| Error         | `-<CODE> <message>`  | `-ERR GET wrong number of arguments (expected 1, got 0)` |
| Integer       | `:<int64 decimal>`   | `:42`                  |
| Bulk string   | `$<len>\n<bytes>\n`  | `$5\nhello\n`          |
| Nil bulk      | `$-1`                |                        |
| Array         | `*<n>` + n replies   | `*2\n$1\na\n$1\nb\n`   |
| Nil array     | `*-1`                |                        |

### 1.4 Worked session (hand-typed)

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
# a comment line produces no reply; blank lines neither
%4
4 HSET
1 h
1 f
1 v
:1
```

### 1.5 Error taxonomy

Three classes, distinguishable by the leading CODE token. Codes are a fixed
set: `PROTO`, `ERR`, `WRONGTYPE`, `RANGE`, `OOM`, `SRV`.

- Protocol error — `PROTO`. Framing only. One reply, then disconnect.
- Command error — produced while executing a well-framed command:
  - `ERR`       misuse: wrong arity, unknown command, bad value, overflow.
  - `WRONGTYPE` key holds a different type; names the key, actual, expected.
  - `RANGE`     index/count/offset out of admissible range.
  - `OOM`       mutation refused by maxmemory policy.
- Server error — `SRV`: the server failed (disk, fsync, limits), not the client.

Message shape rule: every command-level error begins with the CODE, then the
command name, then a single space and a lowercase human message; when an
argument is at fault the message names it (position or option letter). The
shape is identical for every command; no command invents its own layout.

Examples:
```
-ERR SET wrong number of arguments (expected 2..5, got 1)
-WRONGTYPE LPUSH key 'greeting' holds string, expected list
-RANGE LRANGE start: must be an integer
-OOM SET: maxmemory limit reached (268435456 bytes)
-SRV REWRITEAOF: fsync failed
```

### 1.6 Command conventions

- Verb-first, uppercase canonical spelling; input matching is ASCII
  case-insensitive.
- Positional arguments first, in fixed documented order. Options are uppercase
  flags placed after positionals, each consuming exactly one following value
  when it takes one; option order among themselves is free.
- Mutating commands are acknowledged only after their effect is durable
  according to the active append-log fsync policy (§4.3).
- `RESTORE` is reserved for persistence; clients receive
  `-ERR RESTORE reserved for internal use`.

## 2. Data model and semantics

Types: `string`, `list`, `hash`, `set`, `zset`. A key holds exactly one type;
operating on it with another type's commands is `WRONGTYPE` and never mutates.

- string: bytes. INCR/DECR family operates on signed 64-bit integers stored
  as decimal text; overflow or non-integer value is `ERR` naming key and
  argument.
- list: ordered byte strings; push/pop both ends; indices int64,
  negative-from-end; out-of-range reads clamp, out-of-range LSET is `RANGE`.
- hash: field -> value, both byte strings.
- set: unique members; insertion order is the stable enumeration order;
  algebra across two or more keys.
- zset: member -> IEEE-754 double score; ordering score ascending, ties by
  unsigned byte order of member. Scores accept `-inf`, `+inf`; range bounds
  accept `(x` exclusive syntax.
- All counts, indices, lengths parse within ±2^53; beyond that is `RANGE`.

### 2.1 Locked semantic decisions

These were fixed during implementation and are binding:

- `LPUSH k a b c` leaves the list as `[c b a]` (elements pushed head-first,
  in argument order); the append log stores the original command, so replay
  reproduces the identical order.
- `LPOP`/`RPOP k count`: a negative `count` pops from the opposite end and
  returns elements in pop order.
- `ZADD ... CH` returns the number of members changed (added plus updated);
  without `CH` it returns only the number added. Append-log records for
  ZADD are stored as plain upserts so replays are idempotent regardless of
  the flags used originally.
- `ZRANGEBYSCORE`/`ZREVRANGEBYSCORE` on a missing key return an empty array
  (same as `ZRANGE`), not a nil array.
- `PUBLISH` returns the number of distinct connections that received at
  least one delivery. A `pmessage` frame is `[pmessage, pattern, channel,
  payload]`; `message` is `[message, channel, payload]`.
- Tab characters inside bulk values render literally in the CLI; other
  control bytes switch the value to its escaped representation.

### 2.2 Expiry

- Millisecond resolution internally. Commands: `EXPIRE key seconds`,
  `PEXPIRE key ms`, `EXPIREAT`, `PEXPIREAT`, `TTL`, `PTTL`, `PERSIST`,
  `SET ... EX s|PX ms`, `SET ... KEEPTTL`.
- Guarantee: an expired key is never observable — reads check the deadline
  first (lazy expiry), so visibility ends exactly at the deadline. Reclamation
  additionally runs an active expirer sampling 20 keys per 100ms cycle with
  escalating rounds while more than 25% of samples prove expired. Reclamation
  timing is probabilistic; visibility timing is exact.

## 3. Concurrency model

Single-threaded command execution: connections do async IO; complete requests
are queued and executed strictly one at a time. Chosen because MULTI/EXEC
atomicity, blocking ops, eviction and per-key versions become trivially
correct; clarity of correctness outranks parallelism for a study-grade store.
Sharded locking rejected: buys throughput this project does not need at the
cost of exactly the subtle bugs the project exists to avoid. Parsing,
buffering, socket writes and fsync scheduling overlap execution; only command
execution is serial. Consequences stated plainly: long-running commands block
everyone (`DEBUG SLEEP` capped at 5s, disabled unless enabled); throughput
scales with pipelining rather than CPU count.

## 4. Persistence

Files live under `dir` (default `./data`).

### 4.1 Append-only log (authoritative)

`kvhearth.aof`, header line `KVHEARTH-AOF 1`, body: mutating commands in
typed form, in execution order, plus `RESTORE` records produced by
compaction. Recovery replays through the ordinary parser.

Startup matrix:
- AOF present: replay it, regardless of any snapshot. The log alone is
  authoritative; this is what makes delta commands (INCR, RPUSH, APPEND,
  LPOP and friends) safe across restarts.
- Snapshot only (log absent or empty): load it. Snapshots are
  operator-managed backups, not restart accelerators - pairing the two
  safely would require log truncation epochs, which this codebase
  deliberately avoids.
- Neither present: empty start.

### 4.2 Snapshot

`kvhearth.snap`, header `KVHEARTH-SNAP 1`, body: one `RESTORE` per key in
typed form, footer `#END sha256=<hex> keys=<n>`, digest computed over all
bytes between header end and footer start. Corrupt digest -> refuse to load
(fail closed, exit code 12). Written by `SAVE` (synchronous), `BGSAVE`
(chunked, non-blocking), and automatically at shutdown unless
`save-on-shutdown no`. A snapshot is a backup: recovery prefers the
append log whenever one exists (§4.1).

`RESTORE key type ttl_abs_epoch_ms encoded` with type one of
`string list hash set zset`; `encoded` is a nested typed-form payload holding
the value parts (elements; field/value pairs; members; member/score
alternates). Expiry stored as absolute epoch ms (-1 = none) to avoid drift.

### 4.3 Durability guarantees, stated honestly

`append-fsync` selects when the OS is asked to flush:

| policy   | process crash              | OS crash / power loss       |
|----------|----------------------------|-----------------------------|
| always   | no acknowledged write lost | none lost, modulo the disk's volatile cache |
| everysec | no acknowledged write lost | up to ~1 second may be lost |
| never    | no acknowledged write lost | unbounded recent tail may be lost |

Process crashes lose nothing under any policy: acknowledgement happens after
the bytes reach the OS page cache. Only `always` says anything about power
loss, and even then it trusts the drive. Write or fsync failure is never
ignored: the affected connection receives `-SRV ...`, ERROR is logged, and
the server marks persistence degraded (no further acknowledged writes until
operator intervention) rather than continuing silently.

### 4.4 Compaction (log rewrite)

`REWRITEAOF` builds `kvhearth.aof.rewrite` containing one `RESTORE` per live
key. Chunked serialisation from the main loop (512 keys per tick) so reads
never block; concurrent mutations accumulate in an in-memory diff buffer;
completion appends the buffer, fsyncs, closes the live descriptor, renames
atomically over the log, reopens. Writes pause only for the swap
(sub-millisecond) and are never lost: if the diff exceeds 32 MiB the rewrite
aborts cleanly (temp deleted, appends continue to the original log) and
retries later. Crash mid-rewrite leaves the original intact; stale
`.rewrite` temporaries are removed at startup. Equivalence contract: the
rewritten log replays to logical state identical to the original's, verified
by state hashing in tests.

### 4.5 Torn tails and foreign files

- Truncated final entry: detected by the incremental parser at EOF,
  discarded, logged with dropped byte count; startup proceeds.
- Zero-length or missing-header log: treated as empty history, logged.
- Major version mismatch in either file: refuse to start (exit 11), message
  names file and version found.

## 5. Transactions and optimistic concurrency

- `MULTI` opens a queue; queued commands answer `+QUEUED`. Queue-time failure
  (unknown command, arity) marks the transaction aborted; `EXEC` replies
  `-ERR EXEC aborted (queued error: ...)`.
- `EXEC` runs the queue atomically; the whole block is appended to the log
  before the reply. Runtime errors appear as error elements inside the array
  and do not undo prior elements (atomic visibility and durability; not
  transactional rollback — documented).
- `WATCH key...` (max 128) registers interest in key versions. Any confirmed
  mutation — including expiry-driven removal — bumps the version and dirties
  watches. `EXEC` with a dirty watch returns `*-1` and discards the queue.
  `UNWATCH`, `DISCARD`, `RESET`, disconnect clean up.
- `BLPOP`/`BRPOP` park the connection FIFO per key, wake on push from any
  client or on timeout (seconds, fractional, 0 = forever): `*2` key+value or
  `*-1`. Expired-away keys do not wake waiters early.

## 6. Pub/sub and notifications

- `SUBSCRIBE`/`UNSUBSCRIBE`, `PSUBSCRIBE`/`PUNSUBSCRIBE`,
  `PUBLISH channel message` -> receiver count. Fire-and-forget, no
  persistence, no replay. Subscriber connections accept only subscription
  commands, `PING`, `QUIT`, `RESET`.
- Confirmations are `*3` arrays (`subscribe`, channel, count).
- Patterns: `*`, `?`, `[...]`, `\` escape; fnmatch semantics shared with SCAN.
- Keyspace notifications off by default (`notify-keyspace-events ""`):
  classes `g` generic, `n` string, `L` list, `H` hash, `S` set, `Z` zset;
  `K` -> `__keyspace@0__:<key>`, `E` -> `__keyevent@0__:<event>`, `A` = all.

## 7. Memory and eviction

- Accounting is an explicit documented estimate: per-entry overhead + key + 
  value bytes recursively. `maxmemory 0` disables enforcement.
- Policies: `noeviction` (default; `-OOM` on refused writes) and
  `allkeys-lru` - approximate LRU, sample 16 random entries, evict least
  recently touched, repeat until under limit or nothing evictable.
  Evictions are journaled as `DEL` records so replay stays consistent.
  Approximation stated; reads always succeed regardless of policy.
  Overshoot window: a single write larger than the remaining headroom is
  admitted before the limit trips (enforcement runs before the mutation,
  which cannot know the value size in advance); the next mutation is
  refused. This bounds overshoot at one entry.

## 8. Server operations

- `maxclients` 1024; overflow gets `-SRV maxclients reached (limit N)` then
  close. Idle `timeout` seconds (0 = never).
- Slow log: ring of `slowlog-max-len` (128), threshold
  `slowlog-slower-than` microseconds (10000); fields timestamp, duration,
  client, truncated argv. `SLOWLOG GET [n] | LEN | RESET`.
- `MONITOR`: `<unix_ms> [<addr>] "CMD" "arg"...` per executed command,
  args escaped per §1.2 escapes; MONITOR itself excluded.
- `SCAN cursor [MATCH p] [COUNT n] [TYPE t]`: resumable non-blocking pages;
  static keyspace traverses fully; churn may miss/repeat (stated).
- Graceful shutdown (SIGINT/SIGTERM, `SHUTDOWN [SAVE|NOSAVE]`): stop
  accepting, flush+fsync log, optional snapshot, exit 0. Force-kill skips all
  of it; torn-tail rules cover recovery.

## 9. Client CLI

`kvhearth-cli [--host H] [--port N] [--theme dark|light|plain] [--no-color]`
plus one-shot `--eval "..."`. The CLI always sends typed-form requests.

Rendering rules (fixed):
- simple -> text itself; integer -> `(integer) N`; nil bulk -> `(nil)`;
- bulk printable-without-control-chars UTF-8 -> raw; otherwise C-style
  escaped quoted form (`\n \t \xHH`); terminal corruption prevented by
  construction;
- array -> numbered lines `1)` recursively; nil array -> `(nil array)`;
  empty array -> `(empty array)`;
- error -> `(error) CODE message`.

Colour: exactly three themes — dark, light, plain. Tokens ok/error/warn/
dim/number/prompt; severity always carried by words and symbols too
(deuteranopia-safe); colour only on TTY; `NO_COLOR` env or `--no-color`
force plain. No theme gallery beyond these three. Static shell completions
under `completions/` for bash/zsh/fish.

## 10. Logging and stats

Log formats (fields fixed once):
- text: `2026-08-22T18:03:04.123Z INF listening address=127.0.0.1:7379`
  levels DBG INF WRN ERR; lower_snake field keys.
- json: `{"ts":"...","level":"info","msg":"listening","address":"..."}`,
  same vocabulary.

INFO layout: `# Section` headers; `name:` padded left to column 30; numeric
values right-aligned fixed 12-column tabular zone, no separators (no jitter);
sections Server, Clients, Memory, Stats, Keyspace, Persistence, Eviction;
derived hit rate beside hits/misses; nothing important buried in prose.

## 11. Benchmark methodology

Closed-loop, fixed window: warmup (2s default) excluded; measured window
(10s default); C connections (50), pipeline depth (1); configurable mix
(default SET:GET 1:1), keyspace 100000 keys, 64-byte random values. Latency =
client-side request-write to complete-reply. Report ops/sec and p50/p90/p99/
p999/max; averages never headline. Published numbers always state hardware,
workload mix, value size, concurrency, pipeline depth, duration; the tool
that measured them ships here.

## 12. Testing bar

Parser fuzzing (malformed, truncated, oversized, split-across-packets incl.
byte-by-byte delivery): no crash, no hang, no mis-framing. Full semantic
coverage per command incl. wrong-type, empty collections, negative counts,
expiry mid-operation. Injected-clock expiry incl. expiry between WATCH and
EXEC. Transaction atomicity and CAS invalidation under concurrency.
Crash-injection killing the server at randomised points during write storms,
asserting every acknowledged write survives under `always`. Recovery from
truncated tail, empty log, prior-version files. Compaction equivalence by
state hash incl. concurrent writes. Concurrent interleavings vs sequential
reference model plus linearizability-style check on register/CAS. Eviction
at limit. Blocking-op timeouts. Pub/sub no cross-talk. Tests are never
deleted, weakened or skipped to reach green.
