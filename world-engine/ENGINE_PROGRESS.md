# Engine Development Progress

当前主线为 MUD 世界模拟、确定性和持久化可靠性。不新增 UI 或生产部署功能。

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

PR #66 已合并，提交 482079ef。验收 head 7be27ad 的完整回归 88/88，真实
PostgreSQL 18 存储 14/14、命令 inbox 8/8、durable runtime 11/11、runtime-command
7/7 均在 Node 20/22 通过，100/1000 tick 通过。运行器已按 FIFO 在隔离候选世界消费
pending commands；读取或提交的短暂数据库故障均有界重试，不重复执行命令。

## 当前开发层

认证后的异步 PostgreSQL command API：POST 只向 durable inbox 入队，GET 只读取
pending/applied 状态。HTTP handler 不调用 `executePlayerCommand`，不会直接修改世界内存。
世界状态仍只由 durable runtime 在事务确认后发布。

每次 POST/GET 都从最新 PostgreSQL checkpoint 验证 Bearer session。普通账号只能访问
`account.playerIds` 中的玩家，GM/Admin 沿用现有 privileged player 权限。POST 还要求目标
player 在最新 checkpoint 中真实存在。

授权决定绑定世界 revision。`enqueueCommand` 在 PostgreSQL transaction 中对 world row
使用 `FOR SHARE`，确认授权时看到的 revision 仍是当前 revision；并发 checkpoint 会与该锁
协调。revision 已变化时 HTTP adapter 重新加载最新 world/session/ownership 再决定，避免
“撤权已提交但旧授权请求仍入队”。GET command 也带授权 revision 做一致性检查。

响应不暴露 command input digest、原始 input、SQL 错误文本或连接配置；默认不开 CORS，
使用 no-store/nosniff/no-referrer 安全头。命令 body 默认上限 64 KiB，服务默认绑定
127.0.0.1:8791，数据库 URL/TLS 仍只走已有 WORLD_ENGINE_* 环境配置。

受控测试覆盖 401/403、GM、幂等冲突、pending/applied polling、body limit 和授权撤销竞态。
真实 PostgreSQL 18 测试覆盖 HTTP enqueue -> runtime consume -> GET applied，全程确认 HTTP
不会在 runtime checkpoint 前修改世界；还覆盖 direct revision fence 和真实撤权竞态。
当前等待最终远端 Node 20/22、完整回归、1000 tick 和 PostgreSQL 五层专项验收。

| 能力 | 当前实现与边界 |
|---|---|
| 世界模拟、ID 与源码审计 | #61 已验收；更深自然、代际、文明科技演化仍待深化。 |
| JSONL | 同步接口与重启恢复继续兼容，仍是单写原型。 |
| PostgreSQL 存储 | #63 已验收真实驱动、迁移、原子存档、冲突、幂等与校验。 |
| PostgreSQL 世界运行器 | #64 已验收提交后发布、失败重试、持续运行、停机与真实 SQL 重启续跑。 |
| PostgreSQL 命令 inbox | #65 已验收 Migration 2、持久命令入队、查询和 checkpoint 同事务确认。 |
| Runtime 命令消费 | #66 已验收 FIFO 隔离执行、事务确认、retry reuse 与 read-backoff。 |
| Durable command HTTP API | 本层已实现认证入队与结果轮询、revision-fenced authorization；等待远端验收。 |
| 旧同步 HTTP 玩家操作 | 保持兼容，尚未重定向到 durable API；不会在本层静默改变语义。 |
| 生产运行 | 未配置生产数据库，未验收网关限流、备份恢复、保留策略、领导者租约与部署。 |

下一节点在本层验收后优先做 command API 的请求限流/审计与生产边界，再决定是否逐步把旧
`POST /players/:playerId/actions` 迁移为 durable enqueue。迁移必须保持兼容或明确版本化，
不会直接替换现有同步语义。

不使用没有统一验收分母的百分比。实现与边界见 POSTGRES_COMMAND_API.md、
POSTGRES_COMMAND_INBOX.md、POSTGRES_DATABASE.md 和 POSTGRES_DURABLE_RUNTIME.md。
