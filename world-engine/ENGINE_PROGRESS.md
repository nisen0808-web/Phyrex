# Engine Development Progress

当前主线为 MUD 世界模拟、确定性和持久化可靠性。不新增 UI 或生产部署功能。

## 已验收主线

PR #61 已合并，提交 5e84da7d。验收 head b6b4137 的 Node 20/22、根目录与引擎目录回归为 83/83，100 tick 与独立 1000 tick 通过。此前 CI 假绿证据保留在 CI_VALIDATION_STATUS.md；工作流使用显式 bash/pipefail，不放宽断言。

PR #63 已合并，提交 373f8bab。验收 head 4bf429e 的完整回归 84/84，真实 PostgreSQL 18 专项在 Node 20/22 各 14/14，100/1000 tick 通过。

PR #64 已合并，提交 15908081。验收 head e0a25b1 的完整回归 86/86，真实 PostgreSQL 18 存储专项各 14/14，持久化世界运行器专项各 11/11，100/1000 tick 通过。运行器只在 SQL 确认后发布世界；重试不重复模拟或消耗随机流。

PR #65 已合并，提交 56f28c3b。验收 head f25f5d2 的完整回归 87/87，真实 PostgreSQL 18 存储 14/14、命令 inbox 8/8、durable runtime 11/11 均在 Node 20/22 通过，100/1000 tick 通过。Migration 2、幂等命令入队与 checkpoint 同事务确认已验收。

PR #66 已合并，提交 482079ef。验收 head 7be27ad 的完整回归 88/88，真实 PostgreSQL 18 存储 14/14、命令 inbox 8/8、durable runtime 11/11、runtime-command 7/7 均在 Node 20/22 通过，100/1000 tick 通过。运行器已按 FIFO 在隔离候选世界消费 pending commands；读取或提交的短暂数据库故障均有界重试，不重复执行命令。

PR #67 已合并，提交 4d6174e3。验收 head 8685bc7 的完整回归 90/90，真实 PostgreSQL 18 存储 14/14、命令 inbox 8/8、durable runtime 11/11、runtime-command 7/7、authenticated command API 9/9 均在 Node 20/22 通过，100/1000 tick 通过。HTTP POST 已是 durable enqueue，GET 为 pending/applied 查询；session/player 授权使用最新 checkpoint，并通过 world revision fence 防止并发撤权后的 stale enqueue。

PR #68 已合并，提交 9d8fec31。验收 head ef01dba 的完整回归 92/92，root/nested 各 92/92，100/1000 tick 通过；PostgreSQL 18 存储 14/14、命令 inbox 8/8、durable runtime 11/11、runtime-command 7/7、authenticated command API 9/9 均在 Node 20/22 通过。Command API 已有有界 source/account process limiter；真实时间只由 platform/HTTP 入口注入，未放宽 deterministic hardening。

## 当前开发层

Durable command API operational audit：正式 Migration 3 增加 append-only `command_api_audit`。审计只记录 world、认证 account、可选 player/command、route、method、status code、outcome 和数据库时间，不保存 Bearer token、session hash、raw command body、input digest、数据库 URL、SQL error、user-agent 或源 IP。

成功 POST 的 command row 与 audit row 在同一个 PostgreSQL 事务里提交；audit insert 失败会回滚 command ingress。GET 在命令数据返回客户端前先写 audit；audit 写失败则请求失败，不返回未审计的数据。

认证成功后形成的业务 4xx（例如 player/command forbidden、missing、command ID conflict 和最终 revision conflict）会记录 durable audit。401、429、5xx、pre-auth JSON/path/content-type 错误不额外写数据库，避免匿名流量和限流流量形成写放大。

Store 新增 `appendCommandApiAudit`、`listCommandApiAudits` 和 `summary().commandApiAudits`。Audit 查询必须指定 worldId，limit 最大 1000，可按 account/player/command/route/status/sequence 过滤；本层不新增公网 audit endpoint。

新增普通回归覆盖 audit codec、安全字段、成功/失败审计策略和 fail-closed GET；真实 PostgreSQL 18 专项覆盖 Migration 3、POST 原子回滚、GET 审计失败、运行器应用后的审计、匿名/429 不写入和有界过滤。当前等待最终远端 Node 20/22 与完整回归验收。

| 能力 | 当前实现与边界 |
|---|---|
| 世界模拟、ID 与源码审计 | #61 已验收；更深自然、代际、文明科技演化仍待深化。 |
| JSONL | 同步接口与重启恢复继续兼容，仍是单写原型。 |
| PostgreSQL 存储 | #63 已验收真实驱动、迁移、原子存档、冲突、幂等与校验。 |
| PostgreSQL 世界运行器 | #64 已验收提交后发布、失败重试、持续运行、停机与真实 SQL 重启续跑。 |
| PostgreSQL 命令 inbox | #65 已验收 Migration 2、持久命令入队、查询和 checkpoint 同事务确认。 |
| Runtime 命令消费 | #66 已验收 FIFO 隔离执行、事务确认、retry reuse 与 read-backoff。 |
| Durable command HTTP API | #67 已验收认证入队/结果轮询、revision-fenced authorization 与真实 SQL E2E。 |
| Command API process limiter | #68 已验收有界 source/account 限流、Retry-After、socket-only source identity 与时间边界。 |
| Durable operational audit | 本层实现 Migration 3、POST 原子审计、GET response-before-audit gate 和有界读取；等待最终 SQL 验收。 |
| 旧同步 HTTP 玩家操作 | 保持兼容，尚未重定向到 durable API；不会静默改变语义。 |
| 生产运行 | 未配置生产数据库，未验收分布式网关限流、audit retention/export、备份恢复、领导者租约与部署。 |

下一节点在本层验收后优先做多实例 single-writer/leader lease，避免多个 runtime 实例依赖 revision conflict 作为常态协调；之后再做 audit retention/partitioning 或旧同步 action route 的版本化迁移。

不使用没有统一验收分母的百分比。实现与边界见 POSTGRES_COMMAND_API_AUDIT.md、POSTGRES_COMMAND_API.md、POSTGRES_COMMAND_INBOX.md、POSTGRES_DATABASE.md 和 POSTGRES_DURABLE_RUNTIME.md。
