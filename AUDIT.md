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
live fuzzer zero findings.

## Round 2

Two verification auditors re-tested every Round 1 fix against the real
binaries and swept for regressions.

Design verdicts: 7 of 8 FIXED; A3 (nested empty array rendering) still
broken, fixed in Round 2. New: NEW-1 negative slowlog-slower-than
accepted (fixed), NEW-2 seconds-typed config rejected unit suffixes
(fixed).

Code verdicts: 12 of 13 FIXED; B8 half-broken via a missing errArity
import (fixed). Two new HIGH findings, both release blockers:

- N1 — snapshot + full-log replay double-applied delta commands
  (INCR x3 then SAVE then restart yielded 6). Resolution: the startup
  matrix was redesigned. The append log alone is authoritative; snapshots
  are operator-managed backups loaded only when no log content exists.
  DESIGN §4.1/§4.2 and README updated to state this. Regression test
  added (delta commands apply exactly once across save and restart).
- N2 — MULTI+STORE commands threw on a missing import inside EXEC,
  mutating memory with nothing journaled. Fixed (import restored,
  double-expansion branch removed); the per-element catch now bounds any
  future throw to an error element.

Also fixed in Round 2 follow-up: BGSAVE failures named instead of SRV
internal, SET deadline computed once for store and journal.

Regression gate after Round 2 fixes: 198/198 suite green; crash harness
12 rounds fsync=always acked=32412 verified=32412 OK.

## Outcome status

Round 3 re-audit verdict: **CLEAN** — zero blocking findings. One LOW
doc-wording nit (§4.2 'whenever one exists' -> 'whenever it has content')
fixed in the same commit as this entry. v1.0.0 tagged after this verdict
with the full regression gate green: 198/198 suite, crash harness OK,
live fuzzer zero findings.
