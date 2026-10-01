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

PR #67 已合并，提交 4d6174e3。验收 head 8685bc7 的完整回归 90/90，真实
PostgreSQL 18 存储 14/14、命令 inbox 8/8、durable runtime 11/11、runtime-command
7/7、authenticated command API 9/9 均在 Node 20/22 通过，100/1000 tick 通过。
HTTP POST 已是 durable enqueue，GET 为 pending/applied 查询；session/player 授权使用
最新 checkpoint，并通过 world revision fence 防止并发撤权后的 stale enqueue。

## 当前开发层

Durable command API 请求限流：任何数据库读取前先按实际 socket remote address 执行
source rate limit，默认不信任 `X-Forwarded-For` 等代理头。认证成功后再按 world + account
分别限制 POST command submission 和 GET status polling，多个 session token 不能绕过账号限额。

默认窗口为 60 秒：source 240 次、account POST 60 次、account GET 240 次。跟踪表显式
限制为 5000 source keys 和 10000 account keys，过期窗口会清理，超限返回 429 与
`Retry-After`。这是单进程保护层；多实例或互联网入口仍需要可信网关做分布式限流。

限流参数通过 `WORLD_ENGINE_COMMAND_API_*` 环境变量配置；数据库 URL/TLS/密码策略没有
变化，仍只使用已有数据库环境配置，不增加 credential CLI flags。

新增 `request-rate-limit-engine.js`，并增加纯 limiter 与 HTTP 限流回归，覆盖固定窗口、
window reset、bounded key tracking、account submit limit、source limit、Retry-After，以及
伪造 X-Forwarded-For 不能替代真实 socket 地址。

| 能力 | 当前实现与边界 |
|---|---|
| 世界模拟、ID 与源码审计 | #61 已验收；更深自然、代际、文明科技演化仍待深化。 |
| JSONL | 同步接口与重启恢复继续兼容，仍是单写原型。 |
| PostgreSQL 存储 | #63 已验收真实驱动、迁移、原子存档、冲突、幂等与校验。 |
| PostgreSQL 世界运行器 | #64 已验收提交后发布、失败重试、持续运行、停机与真实 SQL 重启续跑。 |
| PostgreSQL 命令 inbox | #65 已验收 Migration 2、持久命令入队、查询和 checkpoint 同事务确认。 |
| Runtime 命令消费 | #66 已验收 FIFO 隔离执行、事务确认、retry reuse 与 read-backoff。 |
| Durable command HTTP API | #67 已验收认证入队/结果轮询、revision-fenced authorization 与真实 SQL E2E。 |
| Command API process limiter | #68 已验收有界 source/account 限流。 |
| Durable command API audit | #70 已验收 Migration 3、安全字段审计与写入失败隔离。 |
| 旧同步 HTTP 玩家操作 | 保持兼容，尚未重定向到 durable API；不会静默改变语义。 |
| 生产运行 | 未配置生产数据库，未验收网关分布式限流、完整数据库备份恢复、领导者租约与部署。 |

PR #70 合并提交为 `40ea6898ecb007ad21cba6e1baa5c1d20a865faf`，主线回归 93/93。
审计查询节点在独立 PR #71 中已实现并完成验收，截至本分支建立时尚未合并。

## 当前引擎本体节点：长期运行与恢复

`feature/engine-reliability-gates` 直接基于 #70 主线开发，不依赖 #71，也不扩展 UI。
修复初始成年人年龄被清零的问题，增加显式可选的历史容量策略，统一队列读取与提交失败的
重试间隔。新增独立的 Node 20/22 + PostgreSQL 18 endurance workflow：1000 tick、
100 个事务 checkpoint、4 个真实进程、SQL 回滚/丢确认故障注入和新 schema 恢复续跑。
这段描述分支实现；最终通过情况以对应 head 的实际日志为准。
完整契约与尚未完成的引擎边界见 `ENGINE_RELIABILITY_GATES.md`。

后续补齐机会和冲突的可选终态容量：稳定清理旧记录、保护活跃引用和治理奖励去重，
超出预算时报告受保护数量及压力。三个 seed 的 80 tick 回归对照持续行为和保存恢复；
真实 SQL 长期门禁启用该策略并断言实际发生清理。默认完整历史行为继续保留。

不使用没有统一验收分母的百分比。实现与边界见 POSTGRES_COMMAND_API.md、
POSTGRES_COMMAND_INBOX.md、POSTGRES_DATABASE.md 和 POSTGRES_DURABLE_RUNTIME.md。
