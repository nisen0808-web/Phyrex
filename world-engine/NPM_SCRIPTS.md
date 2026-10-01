# npm scripts 与验收入口

此表直接根据根目录和 world-engine/package.json 生成。仓库根目录执行；Windows 将 npm 写为 npm.cmd。所有入口使用 Node.js 20/22。

## 世界引擎入口

| npm script | 实际执行内容 |
|---|---|
| `npm --prefix world-engine run test` | `node tests/run-all.js` |
| `npm --prefix world-engine run stress` | `node tests/stability-1000-test.js` |
| `npm --prefix world-engine run demo` | `node demo/run-demo.js` |
| `npm --prefix world-engine run templates` | `node demo/template-demo.js` |
| `npm --prefix world-engine run play` | `node demo/play-demo.js` |
| `npm --prefix world-engine run shell` | `node demo/play-shell.js` |
| `npm --prefix world-engine run shell:sample` | `node demo/play-shell.js --script demo/sample-commands.txt` |
| `npm --prefix world-engine run snapshot` | `node demo/export-snapshot.js` |
| `npm --prefix world-engine run runtime` | `node demo/runtime-demo.js` |
| `npm --prefix world-engine run performance:report` | `node demo/performance-report-cli.js` |
| `npm --prefix world-engine run database:summary` | `node demo/database-summary-cli.js` |
| `npm --prefix world-engine run database:check` | `node demo/database-check-cli.js` |
| `npm --prefix world-engine run api` | `node demo/api-server.js` |
| `npm --prefix world-engine run api:live` | `node demo/api-server.js --auto-loop --interval 1000 --ticks-per-cycle 1 --autosave-every 25 --autosave-path output/live-world-save.json` |
| `npm --prefix world-engine run api:live:db` | `node demo/api-server.js --auto-loop --interval 1000 --ticks-per-cycle 1 --autosave-every 25 --autosave-mode database --db-provider jsonl --db-dir world-engine/data/db --db-name world-engine --resume-mode if-present` |
| `npm --prefix world-engine run viewer` | `node viewer/serve-viewer.js` |
| `npm --prefix world-engine run database:postgres` | `node demo/database-postgres-cli.js` |
| `npm --prefix world-engine run database:backup` | `node demo/database-backup-cli.js` |
| `npm --prefix world-engine run database:maintain` | `node demo/database-maintenance-cli.js` |
| `npm --prefix world-engine run account:admin` | `node demo/account-admin-cli.js` |
| `npm --prefix world-engine run test:engine:scale` | `node tests/integration/engine-scale.js` |
| `npm --prefix world-engine run engine:init` | `node demo/engine-init-cli.js` |
| `npm --prefix world-engine run engine:profile` | `node demo/engine-profile-cli.js` |
| `npm --prefix world-engine run test:postgres:quickstart` | `node tests/integration/postgres-engine-quickstart.js` |
| `npm --prefix world-engine run test:postgres:account-admin` | `node tests/integration/postgres-account-admin.js` |
| `npm --prefix world-engine run test:postgres:maintenance` | `node tests/integration/postgres-maintenance.js` |
| `npm --prefix world-engine run test:postgres:backup` | `node tests/integration/postgres-backup.js` |
| `npm --prefix world-engine run test:postgres` | `node tests/integration/postgres-store.js` |
| `npm --prefix world-engine run test:postgres:commands` | `node tests/integration/postgres-command-inbox.js` |
| `npm --prefix world-engine run runtime:postgres` | `node demo/durable-runtime-cli.js` |
| `npm --prefix world-engine run test:postgres:runtime` | `node tests/integration/postgres-durable-runtime.js` |
| `npm --prefix world-engine run test:postgres:runtime-commands` | `node tests/integration/postgres-runtime-commands.js` |
| `npm --prefix world-engine run api:postgres:commands` | `node demo/durable-command-api-server.js` |
| `npm --prefix world-engine run test:postgres:command-api` | `node tests/integration/postgres-command-api.js` |
| `npm --prefix world-engine run test:postgres:command-audit` | `node tests/integration/postgres-command-audit.js` |
| `npm --prefix world-engine run test:postgres:endurance` | `node tests/integration/postgres-engine-endurance.js` |
| `npm --prefix world-engine run test:postgres:command-audit-query` | `node tests/integration/postgres-command-audit-query.js` |

## 根目录兼容入口

| npm script | 实际执行内容 |
|---|---|
| `npm run test` | `node world-engine/tests/run-all.js` |
| `npm run stress` | `node world-engine/tests/stability-1000-test.js` |
| `npm run demo` | `node world-engine/demo/run-demo.js` |
| `npm run templates` | `node world-engine/demo/template-demo.js` |
| `npm run play` | `node world-engine/demo/play-demo.js` |
| `npm run shell` | `node world-engine/demo/play-shell.js` |
| `npm run shell:sample` | `node world-engine/demo/play-shell.js --script world-engine/demo/sample-commands.txt` |
| `npm run snapshot` | `node world-engine/demo/export-snapshot.js` |
| `npm run runtime` | `node world-engine/demo/runtime-demo.js` |
| `npm run api` | `node world-engine/demo/api-server.js` |
| `npm run api:live` | `node world-engine/demo/api-server.js --auto-loop --interval 1000 --ticks-per-cycle 1 --autosave-every 25 --autosave-path world-engine/output/live-world-save.json` |
| `npm run viewer` | `node world-engine/viewer/serve-viewer.js` |

## 本地与 CI

- engine:profile 在独立世界副本上测量真实耗时，输出新 JSON 报告；与 performance:report 的确定性负载估算口径不同。用法与边界见 RUNTIME_PERFORMANCE.md。

- 根目录与 world-engine 的 test 都通过 tests/run-all.js 自动发现全部 *-test.js；1000 tick stress 有独立必跑门禁，不隐藏进 discovery 分母。
- test:postgres 系列要求 WORLD_ENGINE_TEST_DATABASE_URL，数据库名以 _ci 或 _test 结尾，不可用即失败，禁止静默跳过。每个套件只清理自己创建的随机 schema。
- World Engine Tests：根目录与 world-engine 入口回归及 100 tick；World Engine CI：Node 20/22 discovery 和独立 1000 tick；World Engine PostgreSQL：真实 PostgreSQL 18 的存储、inbox、运行器、命令消费、认证 API、审计、审计查询、全库备份、维护、账户管理、CLI 快速启动。
- World Engine Endurance：Node 20/22 + PostgreSQL 18，1000 tick、100 个 checkpoint、4 个进程、回滚/丢确认和恢复续跑。
- World Engine Scale：Node 20/22 x 三个 seed/人口规模，完整状态恢复相等、有限数值、出生/死亡/代际、索引与容量。
- 所有日志管道使用 bash -e -o pipefail；新专项还必须匹配实际完成标记。不得只看 tee 的退出码或绿色图标。
- api、api:live、api:live:db 是旧同步/JSONL 兼容入口；生产持久命令语义用 api:postgres:commands + runtime:postgres。viewer、play、shell 为示例，不是本次引擎完成的验收替代物。
- PostgreSQL 的运行命令只读取 WORLD_ENGINE_DATABASE_URL / WORLD_ENGINE_DB_SCHEMA；连接 URL 不应放进 CLI 参数。备份和 secrets 目录已被 Git 忽略。
