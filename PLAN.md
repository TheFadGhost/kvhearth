# Kvhearth Plan

Feature decisions, each judged against three tests: does it serve the core
purpose (correct, durable, legible store); can it be finished to the project
quality bar; does it avoid becoming a second product.

## Accepted (first-class features)

- ACCEPT config file + CLI flags — makes committed behaviour (fsync policy,
  limits, cadence) reachable; small, testable surface.
- ACCEPT safe defaults — appendonly yes, fsync everysec, bind 127.0.0.1,
  maxclients cap: the correctness story made real with zero scope cost.
- ACCEPT errors naming command and offending argument — cheapest possible win
  for legibility; required by DESIGN error taxonomy.
- ACCEPT cursor-based SCAN — non-blocking replacement for KEYS; unit-testable.
- ACCEPT MONITOR stream — a tap on the dispatch loop; it is the study feature.
- ACCEPT keyspace notifications — rides existing pub/sub machinery; documented
  fire-and-forget.
- ACCEPT shutdown-with-save — completes the graceful-shutdown contract.
- ACCEPT log levels + text/json formats — needed to debug expiry, eviction,
  recovery; fields fixed once in DESIGN.
- ACCEPT docker-free single-command run — clone, `node bin/kvhearth.mjs`,
  poke with netcat. Single-executable packaging attempted opportunistically;
  the supported interface is the node entry points.
- ACCEPT shell completion (bash/zsh/fish, static files) — near-zero cost;
  improves the shipped CLI without touching the server.
- ACCEPT minimal AUTH (single configured password) — foot-stop against
  accidental LAN exposure; documented as not a security boundary.
- ACCEPT GETRANGE/SETRANGE, ZRANGEBYSCORE — finishing committed type scope,
  not new scope.
- ACCEPT key/TTL verb completeness (TYPE EXISTS RENAME DBSIZE PEXPIRE PTTL
  PERSIST EXPIREAT) — half-finished verb families invite ad hoc workarounds.
- ACCEPT CLIENT ID/LIST/KILL (small subset) — companion to connection limits.
- ACCEPT MEMORY USAGE key — makes eviction accounting observable; estimate
  documented as estimate.
- ACCEPT offline AOF check tool (`kvhearth --check-aof FILE`) — turns torn-tail
  recovery into something auditable without starting the server.

## Rejected (with reasons)

- REJECT replication — cannot be done correctly at this scope: consistency,
  failover and partial-reconnect each demand guarantees a learning codebase
  cannot honour; partial replication would be worse than none.
- REJECT clustering/sharding — second product; reshapes every structure and
  transaction semantic.
- REJECT query language — second product; the hand-typable protocol is the
  interface by design.
- REJECT secondary indexes — second product; undermines the per-op model.
- REJECT web admin console — second product; INFO + MONITOR + slowlog suffice.
- REJECT TLS — large audit surface disproportionate to a localhost learning
  tool; document fronting with an external terminator instead.
- REJECT multiple databases / SELECT — complexity tax on TTL sweeps, eviction,
  WATCH and compaction for near-zero study value.
- REJECT Lua/scripting — sandboxing, atomicity and AOF-determinism problems;
  a second runtime inside the first.
- REJECT persisted-file compression — destroys the human-readable append log,
  which is the point.
- REJECT UNLINK/async free — background freeing breaks the clean
  single-threaded execution story; DEL is correct at this scale.
- REJECT KEYS blocking pattern dump — SCAN exists; keeping both invites the
  production-blocking mistake this project warns against.

## Build order and release gates

1. v0.1.0 — protocol, dispatch skeleton, SET/GET/DEL/EXISTS/TYPE, AOF with
   fsync policies, recovery incl. torn tail, client basics. Gate: set/get over
   TCP survives kill -9 and restart.
2. v0.2.0 — full types (list hash set zset) + expiry engine (lazy + active).
3. v0.3.0 — MULTI/EXEC/WATCH CAS.
4. v0.4.0 — pub/sub, patterns, notifications, BLPOP/BRPOP.
5. v0.5.0 — persistence complete: snapshot, BGSAVE, REWRITEAOF compaction,
   crash-injection suite green.
6. v0.6.0 — eviction/memory accounting, INFO, slowlog, SCAN, MONITOR, CLIENT,
   config command, connection limits.
7. v0.7.0 — client CLI final (themes, escaping, completions), benchmark tool
   with published measured numbers.
8. v0.8.x..v1.0.0 — independent audits (design, code, durability/concurrency),
   AUDIT.md driven fixes, clean re-run, tag v1.0.0.
