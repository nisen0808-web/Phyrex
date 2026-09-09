# Engine Development Progress

当前主线为 MUD 世界模拟、确定性和持久化可靠性。不新增 UI、登录或部署功能。

## 已验收主线

PR #61 已合并，提交 5e84da7d。验收 head b6b4137 的 Node 20/22、根目录与
引擎目录回归为 83/83，100 tick 与独立 1000 tick 通过。此前 CI 假绿证据保留在
CI_VALIDATION_STATUS.md；工作流使用显式 bash/pipefail，不放宽断言。

PR #63 已合并，提交 373f8bab。验收 head 4bf429e 的完整回归 84/84，真实
PostgreSQL 18 专项在 Node 20/22 各 14/14，100/1000 tick 通过。实际日志已核对。

PR #64 已合并，提交 15908081。验收 head e0a25b1 的完整回归 86/86，真实
PostgreSQL 18 存储专项在 Node 20/22 各 14/14，持久化世界运行器专项各 11/11，
100/1000 tick 通过。运行器只在 SQL 确认后发布世界；重试不重复模拟或消耗随机流。

## 当前开发层

PostgreSQL 外部命令 inbox：外部请求先作为不可变命令记录入库，由数据库序号提供
稳定 FIFO 顺序。相同 worldId + commandId + playerId + input 的重复提交幂等；同一
commandId 改写输入会被拒绝。

命令执行结果通过 `saveWorld(..., { commandResults })` 和世界快照、世界 revision、
latest pointer 与 checkpoint events 在同一个 PostgreSQL 事务里确认。结果绑定命令
sequence、commandId、playerId 和 input digest；旧命令、伪造 digest 或被其他运行器
提前消费的命令会让整个 checkpoint 回滚。

本层新增正式 Migration 2，不修改已发布 Migration 1。真实 PostgreSQL 18 专项覆盖
幂等入队、FIFO 查询、结果轮询、原子确认、丢失确认后的 save 幂等、伪造 receipt
回滚、SQL trigger 故障回滚、双消费者竞争和 backlog 边界。当前以 PR 最终远端日志
为验收来源，本地/契约测试不会冒充 SQL 证据。

| 能力 | 当前实现与边界 |
|---|---|
| 世界模拟、ID 与源码审计 | #61 修复和完整回归已验收；更深自然、代际、文明科技演化仍待深化。 |
| JSONL | 同步接口与重启恢复继续兼容，仍是单写原型。 |
| PostgreSQL 存储 | #63 真实驱动、迁移、原子存档、并发冲突、幂等与校验已验收。 |
| PostgreSQL 世界运行器 | #64 已验收提交后发布、失败重试、持续运行、停机与真实 SQL 重启续跑。 |
| PostgreSQL 命令 inbox | 本层实现 Migration 2、持久命令入队、查询和与 checkpoint 同事务确认；等待最终远端验收。 |
| 现有 HTTP 与玩家操作 | 尚未切换；下一层把 HTTP 变成命令提交/结果查询适配器，不直接修改 live world。 |
| 生产运行 | 未配置生产数据库，未验收备份恢复、保留策略、主从复制、领导者租约与部署。 |

下一节点是让 durable runtime 在每个新 batch 前读取 pending commands，调用现有
`executePlayerCommand` 在隔离候选世界执行，并把 commandResults 和 checkpoint 一起
提交。之后再接异步 HTTP 提交/轮询接口。

不使用没有统一验收分母的百分比。实现与边界见 POSTGRES_COMMAND_INBOX.md、
POSTGRES_DATABASE.md 和 POSTGRES_DURABLE_RUNTIME.md。
