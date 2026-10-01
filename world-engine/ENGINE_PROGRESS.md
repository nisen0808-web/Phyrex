# Engine Development Progress

最新性能层基于 441d2d0，增加局部索引去重、稳定的前 K 条传播连接选择和普通 JSON 状态复制快路径；完整回归分母为 110。完整 tick 同机中位数从 5.96 秒降至 5.15 秒，结果摘要相同。实现、单项测量与限制见 KNOWLEDGE_SCALE_PERFORMANCE.md；最终 CI 证据按本层提交保存，下面保留历史基线。

当前整合分支完成单写 PostgreSQL 世界引擎 v1 的功能验收，详见 ENGINE_COMPLETION.md、ENGINE_ACCEPTANCE.md 和 ENGINE_QUICKSTART.md。功能提交 e99cb1c 的本地/CI 回归 106/106、真实 SQL、耐久和六组生命周期长测全部通过。main 仍为 #70，后续代码在 #73；下文保留各历史阶段，不将开放 PR 写成已合并。

## 已验收主线

后续性能层增加真实耗时剖析、记忆保留的等价快路径、逐阶段关系汇总和 hash 配置复用。本地回归为 108/108；128 人物固定场景三次同机对照约 3.03 倍速度，世界摘要不变。详情与测量边界见 RUNTIME_PERFORMANCE.md；最终 CI 证据按交付提交保存，以下 106/106 等历史基线不代表新版本分母。

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

PR #68 已合并，提交 9d8fec31。最终 head ef01dba 的 Node 20/22 与 root/nested
回归 92/92，既有五个真实 SQL 专项及 100/1000 tick 均通过。

PR #70 已合并，提交 40ea6898。最终 head 13328d3 的完整回归 93/93；真实
PostgreSQL 18 的 store 14/14、inbox 8/8、runtime 11/11、runtime-command 7/7、
command API 9/9、audit 4/4 在 Node 20/22 均通过。Migration 3 增加独立持久
请求审计；不记录 token、raw input、digest 或连接信息。审计失败不改变命令结果。

## 已验收限流层

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

## 当前开发层：GM/Admin 审计查询

`feature/durable-command-audit-query` 增加
`GET /durable/worlds/:worldId/admin/audit`：GM/Admin 权限、world revision fence、
同一 repeatable-read snapshot 中的版本检查与审计读取、共享账号 read limiter、
严格白名单过滤和有界倒序 `beforeSequence` 分页。响应只包含安全字段，查询自身
在响应之后才记录。审计 append 故障只独立计数，不再被 HTTP 错误处理误记为 500。

本层不更改已发布 Migration 1–3。新增 11 组受控 HTTP 回归和 10 组真实 SQL
专项，完整 discovery 分母从 93 增为 94。SQL workflow 在 Node 20/22、
PostgreSQL 18 上增加独立成功标记，保留所有既有门禁及 bash/pipefail。
实现细节与分页的实时读取边界见 POSTGRES_COMMAND_AUDIT_QUERY.md。
此段描述分支实现；最终 head 的远端验收记录见对应 PR，不能据此推断已经合并。

| 能力 | 当前实现与边界 |
|---|---|
| 世界演化、ID 与源码审计 | #61 的基线已验收；#73 增加出生/死亡、最多第 7 代与多 seed 恢复验证。系统规则可继续扩展，测试不承诺文明永续或任意数值平衡。 |
| JSONL | 同步接口与重启恢复继续兼容，仍是单写原型。 |
| PostgreSQL 存储 | #63 已验收真实驱动、迁移、原子存档、冲突、幂等与校验。 |
| PostgreSQL 世界运行器 | #64 已验收提交后发布、失败重试、持续运行、停机与真实 SQL 重启续跑。 |
| PostgreSQL 命令 inbox | #65 已验收 Migration 2、持久命令入队、查询和 checkpoint 同事务确认。 |
| Runtime 命令消费 | #66 已验收 FIFO 隔离执行、事务确认、retry reuse 与 read-backoff。 |
| Durable command HTTP API | #67 已验收认证入队/结果轮询、revision-fenced authorization 与真实 SQL E2E。 |
| Command API process limiter | #68 已验收有界 source/account 限流。 |
| Durable command API audit | #70 已验收 Migration 3、安全字段审计与写入失败隔离。 |
| Privileged audit query | #71 的 GM/Admin 查询、revision fence、过滤与倒序游标已整合到当前完成分支。 |
| 旧同步 HTTP 玩家操作 | 保持兼容，尚未重定向到 durable API；不会静默改变语义。 |
| 完整备份和历史维护 | 完成分支已实现并验证全 schema 备份/原子恢复、Migration 4、旧 checkpoint 压缩和审计归档；详见 POSTGRES_BACKUP.md、POSTGRES_MAINTENANCE.md。 |
| 持久账户管理 | 完成分支已实现并验证账户/角色/状态/玩家绑定/会话发行撤销、版本冲突、幂等及恢复；详见 DURABLE_ACCOUNT_ADMIN.md。 |
| 生产部署边界 | 未配置生产数据库或公网部署，外部网关分布式限流、领导者租约与高可用属于独立运维服务。 |

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
