# Engine Regression Hardening

PR #61 / Issue #62. Engine-only repair; no UI or deployment expansion.

## Correctness repairs

- World IDs retain their public prefix/tick/sequence format, but counters now
  serialize a prefix-wide high-water mark. Independent namespace counters can
  no longer emit the same ID. Unmigrated saves reserve the maximum old counter;
  invalid counters/ticks and safe-integer overflow fail rather than emitting an
  invalid ID. Existing IDs are not rewritten.
- Ecology initializes missing fields in unversioned partial saves without
  accepting explicit future versions. Suitability uses the species' diet and
  habitat affinity rather than imposing identical food/water dependence on all
  species. Zero-population records have a consistent index representation.
- City maintenance requires both funding and service capacity, discounted by
  disruption. Missing maintenance contributes to risk; explicit zero-valued
  city attributes survive initialization.
- Natural regeneration leaves corrupt resource values for the auditable repair
  stage. Consistency repairs nonfinite values to zero, does not apply repairs to
  already removed population records, and counts detected (not just remaining)
  issues. Population index rebuilding matches its audit's demographic scope.
- Process limits apply at insertion, including creation by later conflict and
  emergence stages. Cleanup rebuilds indexes and respects explicit zero caps.
  Registration bookkeeping does not create extra life-arc processes.
- Mobilization targets external collective conflicts, not domestic revolt.
  Organization recruitment allocates its shared budget across linked processes
  in rounds instead of exhausting it on the first process.
- Scheduler initialization preserves performance-only legacy state and still
  rejects explicit unsupported versions.

## Determinism boundary

Simulation record IDs use `nextWorldId`. Information, opportunities, battles and
religion propagation use named world-owned random streams. Schema event/action
builders require IDs; world-aware callers allocate them. Template creation time
is derived from the deterministic world clock.

Operational timestamps for HTTP/authentication, persistence and loop scheduling
are isolated in `platform/runtime-clock.js`. This adapter is not a replacement
RNG: simulation systems may not call its wall-clock functions. A regression test
restricts wall-clock use to the eight transport/persistence/runtime modules.
The template builder only uses its pure explicit-timestamp formatter.

The core purity baseline remains empty. No new allowlist findings, ignored core
files or suppression directives were added.

## Test coverage

`tests/run-all.js` discovers every `*-test.js` except the independently mandatory
1000-tick stress test. Both root and world-engine `npm test` use this runner.
A failure in one test does not prevent executing later regressions.

`engine-regression-hardening-test.js` adds eight groups covering ID namespaces,
legacy/resume/overflow, partial-state version guards, finite repairs and indexes,
resource-corruption visibility, late process creation/caps, zero city values,
direct deterministic execution, and the operational clock boundary.

Local Node 22.16.0: 83 regression scripts passed. Remote Node 20/22 and the latest
head's 1000-tick stress logs remain required before merge. CI icons alone are not
acceptance evidence; see `CI_VALIDATION_STATUS.md` for the historical incident.
