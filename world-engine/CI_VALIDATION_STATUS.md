# CI Validation Status

## Scope and source of truth

This record accompanies PR #61 (database startup recovery and save validation). The PR is a draft and must not be merged until the actual full regression and stress suites pass. GitHub's earlier green workflow icons were not sufficient evidence of passing tests.

The implementation and workflow revision tested below is `bbee9ca752856b884b327d84614e88575e801668`. Subsequent documentation changes do not change the code tested in these runs. The latest-head workflow must still be checked before any future merge.

## Verified execution results

| Check | Actual result | Evidence |
|---|---|---|
| Database startup recovery, Node 20 | Passed all 10 scenario groups | Job 102604111537, Run database recovery regression step |
| Database startup recovery, Node 22 | Passed all 10 scenario groups | Job 102604111534, Run database recovery regression step |
| Full Node 20 suite | Failed | Job 102604111537, Run complete test suite step |
| Full Node 22 suite | Failed | Job 102604111534, Run complete test suite step |
| Root npm test | Failed | Job 102604110398 |
| World-engine npm test | Failed | Job 102604110398 |
| Direct 100 tick stability test | Passed | Job 102604110398, Direct fast stability test step |
| 1000 tick stress | Failed: process count should be capped at 500 | Job 102604111270, stability-1000-test.js:83 |

Current workflow evidence:

- World Engine CI: https://github.com/nisen0808-web/Phyrex/actions/runs/34392526145
- World Engine Tests: https://github.com/nisen0808-web/Phyrex/actions/runs/34392526026

## Why earlier workflows appeared green

Both workflows ran tests through pipelines such as `npm test 2>&1 | tee ...`. Their unspecified Linux shell used `bash -e` without `pipefail`, so a successful tee process could hide npm's nonzero exit code.

The Node 20 and Node 22 jobs also ran only root `npm test`, which invoked the 57-file run-all.js suite. Additional test files chained in world-engine/package.json were not covered by those jobs. In the separate World Engine Tests workflow, the extended package test command still stopped at the first failing run-all.js because its steps were connected by &&.

This branch now sets `defaults.run.shell: bash` in both workflows, uses the world-engine package test command for the Node 20/22 complete suites, and runs the new recovery regression independently. With the corrected shell, logs show `bash --noprofile --norc -e -o pipefail`, and failed tests now correctly produce failed jobs. No failing assertions were removed, skipped, or changed into allowed failures.

Reference for shell behavior:
https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idstepsshell

## Historical regression evidence

The earlier PR #60 Node 22 job 85163447491, in workflow run 28718305165, already logged `57 tests: 52 passed, 5 failed` while the workflow reported success. The initial PR #61 Node 22 job 102601757669 showed the same five failures before this branch corrected the workflow shell. This establishes that those five regressions predate the startup-recovery implementation.

Historical workflow:
https://github.com/nisen0808-web/Phyrex/actions/runs/28718305165

| Regression | Observed failure | Next investigation |
|---|---|---|
| governance-environment-response-test.js:47 | Six responses have only one unique response ID | Response IDs use the same prefix with per-type counter namespaces; verify and fix allocation/collision handling without weakening uniqueness checks. |
| ecology-engine-test.js:30 | Desert/forest dragon suitability comparison fails | Inspect species suitability, biome resolution, and fixture resource assumptions. |
| city-environment-pressure-test.js:34 | Expected maintenance gap, actual gap is 0 | Trace local resources, maintenance demand, and zero/default handling. |
| world-consistency-engine-test.js:36 | Expected repaired index ['human'], actual undefined | Trace index reconstruction and canonical entity/species references. |
| world-consistency-pipeline-test.js:21 | ecology.world rejects ecology version undefined | Inspect partial-state compatibility and repair ordering before system execution. |

A further 1000 tick stress blocker was confirmed after enabling pipefail: process count exceeds the expected cap of 500. Its historical occurrence has not been checked against old stress logs. Do not label it as newly introduced or historically proven solely from the current failure. The failure needs investigation in process creation, lifecycle cleanup, and configured caps.

## Recovery work that is verified

The independent recovery suite executes real operations, not just source-string checks. It includes malformed records, physical JSONL line numbers, sequence ordering, rollback saves, multiple-world selection, required/off/if-present modes, schema rejection, unchanged source bytes, random-stream and deterministic-ID continuation, CLI failure before listening, and a real two-process restart test.

The restart test restores tick 17, advances through HTTP to tick 18 with database autosave, terminates the first API process, then starts a second process and verifies that it restores tick 18 and sequence 2 without applying seed ticks again.

## Remaining acceptance work

Fix the five base regressions and the 1000 tick process-cap failure, then execute the full extended package chain and inspect the latest-head logs. Passing the focused recovery suite is not a substitute for passing the full engine.

JSONL persistence remains a synchronous, single-writer prototype. SQLite/PostgreSQL drivers, SQL migrations, transactions, concurrent writer protection, durability checksums, bounded storage growth, and production backup/restore acceptance have not been implemented or verified in this PR.

## Follow-up repair (local verification; remote gate still pending)

The five historical base regressions and the process-cap defect have now been
reproduced and repaired locally. The newly unblocked extended suite exposed
additional governance-process, mobilization-scope, recruitment-budget,
partial-scheduler-state, and purity-baseline failures; these were also repaired.

The unified discovery runner executes 83 regression scripts, all passing on
local Node 22.16.0. The empty core purity baseline is retained, with no added
suppression directives or ignored core modules. An eight-group hardening test
covers the changed invariants. See ENGINE_HARDENING.md.

This section supersedes the earlier "remaining acceptance work" implementation
status, not the historical log evidence. Remote latest-head Node 20/22, the full
World Engine Tests workflow and 1000-tick stress must still pass before merging.
