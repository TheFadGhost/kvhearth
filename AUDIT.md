# Kvhearth Audit Log

Independent audits performed before v1.0.0 by sub-agents that did not
write the code under review. Findings are fixed in order of severity;
the regression gate (full suite, crash harness, live fuzzer) re-runs
after every batch. This file records the audit round and its outcome.

## Round 1

Auditor A (design surfaces): 9 findings (2 HIGH, 4 MED, 3 LOW).
Auditor B (code paths): 19 findings (5 HIGH, 8 MED, 6 LOW).

### HIGH

| # | Area | Finding | Status |
|---|---|---|---|
| A1 | protocol | `%0` empty typed request reaches dispatcher and crashes it instead of `-PROTO` + close | FIXED |
| A2 | docs | DESIGN worked session uses `%2` for HSET with field+value (needs `%4`); §1.5 shape prose disagrees with its own examples | FIXED |
| B1 | persistence | snapshots/AOF replayed through a limited parser: >1024-arg records or >64MiB values brick restarts (exit 12) | FIXED |
| B2 | persistence | relative TTLs logged raw (`EXPIRE k s`, `SET .. EX`), so expired keys resurrect after restart | FIXED |
| B3 | lists | `LPOP/RPOP k count` drops `count` from the AOF record; replay diverges | FIXED |
| B4 | zsets | inf + -inf produces NaN score; NaN reaches snapshots and makes the server unbootable | FIXED |
| B5 | server | unguarded periodic-save interval can kill the process (EACCES/EISDIR at tmp open) | FIXED |

### MEDIUM

| # | Area | Finding | Status |
|---|---|---|---|
| A3 | cli | nested empty array renders `(unknown reply kind 'array')` | FIXED |
| A4 | info | five stat names overflow column 24; rows jitter (37–39 chars vs uniform) | FIXED |
| A5 | config | `slowlog-slower-than` unit conversion ×1000 wrong; fractional `us` values abort startup | FIXED |
| A6 | config | server rejects `theme plain` while README documents it | FIXED |
| B6 | persistence | SINTERSTORE/SUNIONSTORE/SDIFFSTORE logged as raw multi-key verbs; rewrite diff drops source-side effects | FIXED |
| B7 | txns | internal throw mid-EXEC leaves memory mutated with nothing appended | FIXED |
| B8 | errors | missing option operands yield `-SRV internal error` instead of named errors (ZRANGEBYSCORE LIMIT, CLIENT KILL ID) | FIXED |
| B9 | protocol | `%0` accepted by parser (duplicate of A1, parser side) | FIXED |
| B10 | blocking | huge BLPOP timeouts clamp to 1ms via setTimeout and fire immediately | FIXED |
| B11 | durability | success reply queued before append; fsync failure produced contradictory double replies | FIXED |
| B12 | eviction | evictions not journaled; evicted keys resurrect after restart | FIXED |
| B13 | recovery | replay buffers every reply until boot ends (memory proportional to log size) | FIXED |

### LOW

| # | Area | Finding | Status |
|---|---|---|---|
| A7 | server | unknown INFO section returns near-empty bulk instead of an error | FIXED |
| A8 | cli | CLI accepts unknown --theme values silently | FIXED |
| A9 | memory | first oversized write may overshoot maxmemory before OOM trips | DOCUMENTED (single-entry overshoot window stated in DESIGN §7) |
| B14 | dead code | no-op try/catch in recovery, dead imports, unreachable err.reply branches, unused rewrite-overflow status | FIXED |
| B15 | duplication | pending-byte estimation and formatScore implemented twice | FIXED |
| B16 | errors | SCAN cursor misuse replies ERR not RANGE; BGSAVE failures unnamed | FIXED |
| B17 | strings | SET EX validates magnitude before ×1000 (precision loss past 2^53 µs) | FIXED |
| B18 | config | theme enum lacked plain (same as A6) | FIXED |
| B19 | lifecycle | maxclients reject never destroys socket; shutdown does not cancel background writers; rewrite finish-failure could leave closed fd; boot reads AOF twice | FIXED |

## Outcome

Round 1 fixes landed in commits following this file's introduction.
Regression gate after fixes: full suite green, crash harness green,
live fuzzer zero findings. Re-audit scheduled as Round 2; v1.0.0 is
tagged only after a clean re-audit.
