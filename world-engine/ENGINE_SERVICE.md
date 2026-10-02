# 单写引擎服务

当前运行器使用 v3 玩家命令规则。已有 v1/v2 世界需要停止旧写入器并显式升级，步骤与命令字段见 [PLAYER_COMMAND_CONTRACT.md](PLAYER_COMMAND_CONTRACT.md)。
完成数据库初始化和账户配置后，从仓库根目录启动：

```sh
npm ci --prefix world-engine --ignore-scripts
npm run engine:serve -- --world-id engine-world --host 127.0.0.1 --port 8791
```

也可使用 `npm --prefix world-engine run engine:serve -- ...`。Windows 使用 `npm.cmd`。连接和 TLS 继续使用 `WORLD_ENGINE_DATABASE_URL`、`WORLD_ENGINE_DB_SCHEMA` 及现有数据库配置；不在参数或日志中输出 URL、token。默认监听本机，端口 `0` 可由系统分配，启动输出包含实际监听地址。世界必须预先存在且迁移版本正确；服务不会偷偷初始化或覆盖数据。完整建立流程见 [ENGINE_QUICKSTART.md](ENGINE_QUICKSTART.md)。

## 进程与一致性

一个 Node 进程内，HTTP 主线程接受和读取命令；独立 Worker 线程独占演化运行器、世界副本与写入连接池。演化计算不会占用 HTTP 事件循环，状态读取仍需从 PostgreSQL 解码已提交的 checkpoint，大世界读取不是零成本操作。默认每批 1 tick、批次间隔 1000 ms，不重叠执行；实际频率还取决于计算和提交耗时。

先验证数据库及目标世界，再绑定端口，最后启动 Worker。因此端口冲突不会启动第二个世界写入器。每个世界仍然只运行一个服务/运行器；本服务没有新增分布式选主。其他进程修改世界会触发原有 revision fence；不能把两个 `engine:serve` 实例当成高可用集群。

命令响应的 `pending` 只表示收件箱已持久化。`applied` 与世界 checkpoint 原子提交后才能读取；运行器重试同一个候选状态，不重新模拟。读取接口的授权和数据来自同一个已提交 checkpoint，返回 `revision` 和 `tick`；它是该版本的观察结果，不保证传输结束时世界还停留在该版本。

## HTTP 接口

业务接口都使用 `Authorization: Bearer <token>`，沿用来源/账户限流、无隐式 CORS、`Cache-Control: no-store`、`X-Request-Id` 和安全错误码。统一服务仅允许指定的 `worldId`。

| 方法与路径（前缀 `/durable/worlds/:worldId`） | 权限与结果 |
|---|---|
| `POST /players/:playerId/commands` | 已绑定玩家或 GM/Admin；命令 ID 幂等；运行器不健康时拒绝新提交，返回 503 |
| `GET /players/:playerId/commands` | 已绑定玩家或 GM/Admin；固定字段的命令记录分页，最大 100 条 |
| `GET /admin/queue` | GM/Admin；有界积压诊断、容量和最早 pending sequence |
| `GET /commands/:commandId` | 命令所属玩家账户或 GM/Admin；读取 pending/applied 和结果 |
| `GET /players/:playerId/state` | 已绑定玩家或 GM/Admin；玩家基本字段、当前受控角色的固定数值字段、当前地点 ID/名称 |
| `GET /admin/summary` | GM/Admin；tick/revision，实体总数、存活实体数、地点、组织、玩家数量 |
| `GET /admin/audit` | GM/Admin；白名单过滤、最多 1000 条、sequence 游标；route 过滤支持 `state`、`summary`、`history`、`queue` |

`state`、`summary` 不接受查询参数，不返回任意 meta、账户/会话、token hash、私有记忆、其他角色清单或完整世界存档。角色视图数值字段固定为 health/maxHealth/energy/maxEnergy/power/defense/speed/intelligence/social，以及 currency/food；没有角色时 character 为 null。这是最小观察接口，不是完整游戏客户端的地图、背包和叙事页面。新增业务路由沿用独立审计事务，失败不改变已完成命令；不需要改变 Migration 1–4。

| 健康接口 | 行为 |
|---|---|
| `GET /health/live` | 无需 token；HTTP 进程可响应则 200，不代表写入可用 |
| `GET /health/ready` | 无需 token；运行器健康且 PostgreSQL 能读取目标世界头信息才返回 200，否则 503 |

健康接口只返回 `{ok,status}`，不泄露世界名称、数据库地址、异常详情或运行配置。它们消耗来源限流额度，不写持久审计，避免探针让审计表持续膨胀。并发数据库探针合并，完成后不缓存成功结果。

Worker 每 250 ms 报告一次安全状态；默认 30 秒没有新状态、重试中、阻塞或退出都会关闭 readiness 和新命令入口。演化线程执行极重的批次时也无法发送心跳，因此超过阈值会保守停收；`--heartbeat-timeout` 可按已测批次耗时调整。故障发现有心跳传播窗口，窗口内已接受的命令保持持久 pending，由恢复后的运行器消费；停收不是跨进程即时开关。已提交状态和结果在数据库可用时仍可读取。

## 停机与故障恢复

Ctrl+C / SIGTERM 先停止 HTTP 接收，等待已接受请求和审计，再要求 Worker 等待当前批次、确认待提交结果并关闭连接。HTTP 在默认 5 秒后断开仍未完成的客户端连接，避免半截上传永远阻止停机。统一 CLI 总关机期限默认 30 秒；超过期限强制退出并报告 `WORLD_SERVICE_SHUTDOWN_TIMEOUT`，退出码为 1。Worker 崩溃、未确认 checkpoint 或关机超时不能报告成功。

成功关机不承诺清空整个收件箱。未消费命令仍在数据库中，重启同一世界即可继续；已有 applied 命令保持原结果。异常退出或超时后，先读取最新 checkpoint 和命令状态再恢复，不依赖进程最后打印的 tick 推测是否提交。

账户或世界管理操作应先正常停止写入器，再按最新 revision 修改，之后重启。意外管理写入导致 revision 冲突时，服务停收并保留已提交数据；修复后重新启动，不能自动覆盖外部更改。

可调参数：`--ticks-per-batch`、`--interval`、`--retry-delay`、`--max-attempts`、`--startup-timeout`、`--shutdown-timeout`、`--heartbeat-timeout`，单位为 tick 或毫秒，见 `--help`。HTTP 限流继续使用 `WORLD_ENGINE_COMMAND_API_*`。旧 `runtime:postgres` 与 `api:postgres:commands` 两进程入口继续可用，但不要与统一服务对同一世界同时运行写入器。

## 验收

自动 discovery 包含状态权限/脱敏/读限流、上传中断、故障停收、端口冲突清理、真实 Worker 隔离/心跳/超时/崩溃测试。`test:postgres:service` 在 Node 20/22 + PostgreSQL 18 的 Linux CI 必跑，以真实子进程验证启动、命令提交、SQL 状态读取、SIGTERM、重启幂等、数据库故障、revision 冲突、审计过滤和日志脱敏。Windows 没有等价的 POSIX SIGTERM，专项会明确报错而不假装跳过成功；本地通用回归照常运行。CI 保留原有全部门禁、pipefail 与实际完成标记。

命令队列容量、重连分页和积压诊断的完整契约见 [COMMAND_QUEUE_OPERATIONS.md](COMMAND_QUEUE_OPERATIONS.md)。满队列返回 429，不影响健康运行器继续消费；它与故障停收的 503 是不同情况。
