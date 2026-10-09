# 已提交世界读取优化

角色状态、指令查询与权限检查此前每次都读取完整 checkpoint、校验摘要并恢复世界。试用备份 revision 142 的存档约 5.56 MB，而角色视图本身的计算仅约 0.2 ms。本层减少同一存档的重复传输与恢复，不改变模拟结果。

## 一致性与边界

PostgreSQL adapter 新增 `loadWorldView(worldId)`，只用于 HTTP 只读投影。每次调用都开启新的 repeatable-read 只读事务，读取当前 checkpoint 的标识；只有 world ID、sequence、revision、payload digest、SQL 行版本 `xmin` 和位置 `ctid` 全部一致时才复用已完整校验的数据。SQL 行即使在 revision/digest 未变的情况下被更新，也会重新读取并校验。首次读取及版本变化仍执行原有 checksum、schema、迁移和恢复检查。

每个 adapter 只保留一个冻结的世界快照，跨世界访问会替换它。数据库错误、世界缺失和关闭操作清空保留项；数据库不可用时绝不返回旧的成功响应。没有 TTL、会话凭证或已授权结果缓存。账号状态复制后再执行会话验证，避免会话过期和 lastSeenAt 修改共享世界。普通 `loadWorld` 继续返回可独立修改的世界，运行器保持原路径。

玩家状态的授权与投影来自同一份提交快照；指令写入、回执读取和审计查询仍使用原有 revision fence。读取与并发提交之间的快照语义保持不变。运行中的数据库恢复仍不受支持，须先停写并按恢复手册操作。

## 暂时不可用诊断

GM/Admin 的 `/admin/operations` 增加 `service.admission`：本进程因 503 拒绝提交的次数，以及最近一次的安全原因、是否已完成认证、heartbeatAgeMs、revision、tick。覆盖认证读取失败、运行器拒绝和实际入队失败三个阶段；认证前数据库失败不会被当作已认证用户。原因白名单区分数据库不可用、心跳过期、运行器故障和停止状态；不公开错误堆栈、连接串或令牌。401/403、健康探针不累计提交拒绝。服务恢复后保留最近拒绝，重启清零。

运行器拒绝接收提交时仍返回 503 `service_unavailable`，增加 `Retry-After: 1`。客户端应保留原 command ID，稍后查询或重试；这不是保证一秒后恢复，也不会自动执行一次新意图。原心跳门禁没有放宽。

## 验证与运行

本机隔离 PostgreSQL，同一 revision 142 备份、相同接口和返回结果，7 次读取：旧路径后 6 次中位数约 239.7 ms，优化路径后 6 次约 1.81 ms；首次优化读取约 282.9 ms，仍有校验与冻结成本。该数据是单机热读对照，不是 Render 延迟承诺，也不能据此认定历史 503 的根因已修复。

```sh
npm test
npm run test:postgres:read-view
npm run test:postgres:command-api
npm run engine:verify -- --suite postgres --report output/postgres-verification.json
```

真实 SQL 必须设置 `WORLD_ENGINE_TEST_DATABASE_URL`，库名以 `_test` 或 `_ci` 结尾；完整服务启停门禁在 Linux CI 上运行。新增 read-view 专项 8 组覆盖不可变视图、并发 HTTP、即时撤权、同版本 SQL 损坏、数据库失效、容量界限、过期与关闭。CI 保留 Node 20/22、完整回归、所有既有 SQL/耐久/规模门禁及 `bash -e -o pipefail`。普通 discovery 仍为 136 项；SQL 增为 17 专项共 153 组/Node 版本。最终是否通过以当前提交 CI 原始日志与线上报告为准。

无新依赖、SQL migration、运行版本或存档格式变更。仍为单写入器模式；免费平台的 CPU、休眠与网络波动不由这个缓存消除。
