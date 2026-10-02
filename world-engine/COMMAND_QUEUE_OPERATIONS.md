# 命令队列容量与重连查询

持久命令队列现在同时约束每个世界和每个玩家的 pending 数量。默认每世界 10,000 条、每玩家 1,000 条；applied 记录不占用这些名额，仍保留原有幂等结果。

## 配置与提交

| 设置 | 默认值 | 合法范围 |
|---|---:|---:|
| `WORLD_ENGINE_COMMAND_QUEUE_MAX_PENDING` | 10000 | 1–100000 的整数 |
| `WORLD_ENGINE_COMMAND_QUEUE_MAX_PLAYER_PENDING` | 1000 | 1–100000 的整数 |

也可在 PostgreSQL store 的数据库选项中传 `maxPendingCommands`、`maxPendingPerPlayer`。与连接配置一致，显式选项优先于环境变量；不提供关闭保护的无限值。玩家实际可用容量同时受世界容量约束。

同一世界的所有入队进程应使用一致配置，并在升级时停止旧版入队进程。本限制由新版引擎事务执行，不是数据库触发器；旧二进制或直接 SQL 写入不会自动获得这层保护。容量配置不写入模拟世界、不影响随机数或运行器配置 hash。

入队事务首先锁定世界行并检查 revision，然后查找相同命令 ID；相同玩家和输入返回旧记录，改内容返回冲突。只有新命令才检查容量并插入，世界锁使不同数据库连接的检查和插入串行化。运行器提交世界与 applied 结果使用相同世界锁，因此名额只在确认事务提交后释放。容量失败不创建命令，也不分配新 sequence。计数使用已有 pending 索引，只扫描最多配置上限条记录，不读取 applied 的输入和结果。

HTTP 满队列返回 `429`，错误码分别为 `command_queue_full` 或 `player_queue_full`，附 `Retry-After: 1`。这是最短重试建议，不承诺一秒后一定有空位。来源/账户请求限流仍独立执行；相同命令重复请求也要经过认证和请求限流。统一服务的运行器故障停收规则仍生效，满队列本身不关闭健康 readiness，消费端需要继续工作以释放容量。

降低配置不会删除、取消或修改原有 pending。新命令等待积压低于相应上限后才恢复接受；相同 ID 的幂等请求仍能返回原记录。备份恢复保存既有命令，不使用入队接口重新创建，所以完整历史和恢复语义不变。

## 玩家找回命令记录

```text
GET /durable/worlds/:worldId/players/:playerId/commands?limit=50&beforeSequence=123&status=pending
Authorization: Bearer <token>
```

已绑定玩家的账户及 GM/Admin 可访问。`limit` 默认 50、最大 100；`beforeSequence` 是大于零的安全整数；`status` 可省略或为 pending/applied。未知、重复或无效参数返回 400；不能从 query 覆盖 world/player 或请求任意字段。

响应包含 worldId、playerId、用于授权的 revision、倒序 records 和 nextBeforeSequence。每条记录只包含 id/worldId/playerId/sequence/status/submittedAt/appliedAt。列表 SQL 也只读取这些列，不先拉取完整 JSON 再丢弃。需要单条命令结果时，使用既有 `GET /durable/worlds/:worldId/commands/:commandId`。

下一页传上页的 nextBeforeSequence；后续新插入的命令不会挤进更旧的页。满页返回游标，末页恰好等于 limit 时可能再请求一次空页。分页是实时查询，状态会由 pending 变为 applied；特别是使用 status 过滤时，它不是跨多次请求冻结的快照。每页的授权和 SQL 查询通过 revision fence 与 repeatable-read snapshot 配对；遇到权限版本变化，重新授权而不是返回旧权限的数据。

## 管理员积压诊断

```text
GET /durable/worlds/:worldId/admin/queue
Authorization: Bearer <GM-or-Admin-token>
```

不接受查询参数。返回 worldId、revision、pending、pendingIsLowerBound、oldestPendingSequence、worldCapacityAvailable 和当前进程配置的 limits。没有命令输入、结果、连接串或账户会话。

扫描最多世界容量加一条。若旧数据或降低配置导致超限，`pendingIsLowerBound: true` 表示 pending 是下界，例如上限 2 时显示 3，含义是“至少 3 条”；不为了显示精确计数无界扫描旧积压。worldCapacityAvailable 只描述世界名额，不代表特定玩家也有空位或运行器健康。

两个新读取接口共享既有账户 read limiter，查询都会记录持久审计，route 分别为 history、queue。审计筛选支持这两个名字；独立审计事务故障不改写已经完成的命令结果。

## 验证与兼容

使用 Migration 2 已有的 pending 和 player sequence 索引；Migration 1–4 的内容与 checksum 均未修改。本地自动发现测试覆盖配置边界、固定投影、查询校验、共享读限流、429、审计和授权重试。

`npm --prefix world-engine run test:postgres:command-queue` 在隔离 `_test`/`_ci` PostgreSQL 库运行 10 组专项，包含跨连接并发、满容量幂等、世界隔离、回滚不释放名额、分页插入竞争、权限撤销、降低容量和新运行器进程恢复；在 Node 20/22 的现有 PostgreSQL CI 必跑，缺数据库直接失败。旧 store/inbox/runtime/API/备份/服务测试保持不变，不减少千轮和规模门禁。
