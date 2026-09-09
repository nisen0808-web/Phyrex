# Engine Development Progress

当前主线为 MUD 世界模拟、确定性和持久化可靠性。不新增 UI、登录或部署功能。

## 已验收主线

PR #61 已合并，提交 5e84da7d。验收 head b6b4137 的 Node 20/22、根目录与
引擎目录回归为 83/83，100 tick 与独立 1000 tick 通过。此前 CI 假绿证据保留在
CI_VALIDATION_STATUS.md；工作流使用显式 bash/pipefail，不放宽断言。

PR #63 已合并，提交 373f8bab。验收 head 4bf429e 的完整回归 84/84，真实
PostgreSQL 18 专项在 Node 20/22 各 14/14，100/1000 tick 通过。

PR #64 已合并，提交 15908081。验收 head e0a25b1 的完整回归 86/86，真实
PostgreSQL 18 存储专项各 14/14，持久化世界运行器专项各 11/11，100/1000 tick
通过。运行器只在 SQL 确认后发布世界；重试不重复模拟或消耗随机流。

PR #65 已合并，提交 56f28c3b。验收 head f25f5d2 的完整回归 87/87，真实
PostgreSQL 18 存储 14/14、命令 inbox 8/8、durable runtime 11/11 均在 Node 20/22
通过，100/1000 tick 通过。Migration 2、幂等命令入队与 checkpoint 同事务确认已验收。

## 当前开发层

Durable runtime 现在在创建新 batch 时读取最多 100 条 pending commands，按数据库
sequence FIFO 顺序调用现有 `executePlayerCommand`，再推进确定性模拟。命令执行发生
在隔离候选世界中，SQL checkpoint 未确认前不会发布给读取者。

命令结果与世界 checkpoint、revision、latest pointer 和事件一起提交。运行器重试时
保留同一候选世界、commandResults、requestId 与 expectedRevision，不重新读取 inbox、
不重新执行命令，也不会重复消耗随机数或 ID。确定性拒绝（例如 missing_player）会作为
终态结果提交，避免坏命令永久堵塞队列。

运行器配置 fingerprint 升级为 version 2，包含固定 command profile；允许 #64 写入的
精确 version-1 fingerprint 单向升级一次，其他 simulation 配置变化继续拒绝。命令每批
固定上限 100，不开放为启动参数，避免历史存档升级时产生未记录的确定性差异。

新增受控存储契约覆盖命令执行顺序、拒绝结果、重试不重放、late-arrival 延后、legacy
fingerprint 升级、模拟失败不确认和 batch 上限。真实 PostgreSQL 18 专项覆盖实际命令
消费、lost acknowledgement、SQL trigger rollback、双运行器竞争、late-arrival 和重启
后不重复执行。当前等待最终远端 Node 20/22 和完整回归验收。

| 能力 | 当前实现与边界 |
|---|---|
| 世界模拟、ID 与源码审计 | #61 已验收；更深自然、代际、文明科技演化仍待深化。 |
| JSONL | 同步接口与重启恢复继续兼容，仍是单写原型。 |
| PostgreSQL 存储 | #63 已验收真实驱动、迁移、原子存档、冲突、幂等与校验。 |
| PostgreSQL 世界运行器 | #64 已验收提交后发布、失败重试、持续运行、停机与真实 SQL 重启续跑。 |
| PostgreSQL 命令 inbox | #65 已验收 Migration 2、持久命令入队、查询和 checkpoint 同事务确认。 |
| Runtime 命令消费 | 本层已实现隔离执行、固定 FIFO batch、事务确认与 retry reuse；等待最终 SQL 验收。 |
| 现有 HTTP 与玩家操作 | 尚未切换；下一层把 HTTP 变成命令提交/结果查询适配器，不直接修改 live world。 |
| 生产运行 | 未配置生产数据库，未验收备份恢复、保留策略、主从复制、领导者租约与部署。 |

下一节点是异步 HTTP command adapter：POST 只做 durable enqueue，GET 查询 pending/applied
结果；权限层必须绑定 session/account 到允许的 playerId，不能信任任意 caller playerId。

不使用没有统一验收分母的百分比。实现与边界见 POSTGRES_COMMAND_INBOX.md、
POSTGRES_DATABASE.md 和 POSTGRES_DURABLE_RUNTIME.md。
