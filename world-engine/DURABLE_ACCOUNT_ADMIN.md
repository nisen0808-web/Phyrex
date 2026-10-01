# 持久账户与会话管理

`account:admin` 是拥有数据库写权限的操作员工具，不是公网注册或玩家权限接口。连接由 `WORLD_ENGINE_DATABASE_URL` / `WORLD_ENGINE_DB_SCHEMA` 环境变量提供。写操作必须提供 world、account、唯一 request ID 和当前 expectedRevision。

管理前暂停并关闭该世界的运行器，核对数据库 revision，操作完成后重新加载并启动运行器。管理操作不推进 tick，会保存一个新 revision。未停止的旧运行器会因 revision fence 拒绝继续写入；不会覆盖管理结果。运行器的配置摘要 metadata 会保留。冲突后应重新读取并检查意图，再使用新 request ID 和新 revision；工具不会自动把旧权限操作应用到新世界。

```sh
# 查看世界版本：database status / export 或账户 inspect 的 revision
npm --prefix world-engine run database:postgres -- status

# 示例假设世界 revision 为 1；每次成功管理写入后加 1
npm --prefix world-engine run account:admin -- account.create --world-id WORLD --account-id operator --roles admin --request-id create-operator --expected-revision 1

# 创建一个尚未绑定的随机凭据文件；目录必须存在，拒绝覆盖现有文件
npm --prefix world-engine run account:admin -- token.create --output ./secrets/operator.token

# 发行会话。文件内容只在进程内读取，不放在命令行、输出或审计中
npm --prefix world-engine run account:admin -- session.issue --world-id WORLD --account-id operator --token-file ./secrets/operator.token --ttl-ticks 10000 --max-sessions 20 --request-id issue-operator --expected-revision 2

npm --prefix world-engine run account:admin -- inspect --world-id WORLD --account-id operator
npm --prefix world-engine run account:admin -- account.roles --world-id WORLD --account-id operator --roles player --request-id remove-admin --expected-revision 3
npm --prefix world-engine run account:admin -- session.revoke-all --world-id WORLD --account-id operator --request-id revoke-all --expected-revision 4
```

`session.issue` 也可读取 `WORLD_ENGINE_SESSION_TOKEN`，但不能同时指定 token 文件。凭据需要 32–512 个 ASCII 字母、数字、下划线或连字符；推荐使用内置的 48 字节随机生成器。token 文件创建时请求权限 0600，Windows 下还需使用现有安全目录 ACL。输出仅包含文件路径或 session ID，不打印凭据内容。生成文件本身不会修改账户；只有发行 checkpoint 提交成功后凭据才生效。重复发行使用相同 request ID、原始 expectedRevision 和同一 token 文件，可查询原提交结果。

支持操作：

| 操作 | 特有参数 | 行为 |
|---|---|---|
| `account.create` | `--name`、`--roles player,gm,admin` | 创建账户，禁止覆盖已有账户 |
| `account.roles` | `--roles` | 替换角色，下一次 durable HTTP 请求读取已提交权限 |
| `account.status` | `--status active/suspended/closed` | 停用时同时撤销活跃会话；重新启用不会恢复旧会话 |
| `player.link` | `--player-id` | 绑定已有玩家，同时移除旧账户权限和反向索引 |
| `player.unlink` | `--player-id` | 解除属于该账户的玩家绑定 |
| `session.issue` | `--token-file`、`--ttl-ticks`、`--max-sessions` | 发行新会话，超限撤销最旧活跃会话；同 tick 内按发行顺序处理 |
| `session.revoke` | `--session-id` | 只撤销指定账户的该会话 |
| `session.revoke-all` | 无 | 撤销该账户全部活跃会话 |
| `inspect` | 只需 world/account | 只读查看；没有 token/hash/prefix |

TTL 使用世界 tick，不是墙上时间；暂停世界时 TTL 不推进。旧会话记录仍在世界中，以拒绝重用已撤销凭据。账户维护是世界规模相关数据，不能借历史裁剪清除撤权凭据。它不提供密码注册、找回密码、公开 token 发行或多因素认证。

操作采用克隆状态、提交后确认，SQL 短暂故障最多重试三次，重试复用完全相同的候选状态和随机 session ID。历史请求凭据保存安全结果和操作摘要（token 先 hash 后参与摘要），相同请求只返回原结果，不重新执行。并发相同发行请求收敛到赢家的 session ID；不同内容重用 request ID 报冲突。存档压缩保留管理凭据，备份恢复后仍然可以确认历史结果，不会恢复旧权限。事件 `account.administration` 只记录操作名称、账户/会话/玩家 ID、状态及角色。

验收：本地 `npm test` 自动发现 `durable-account-admin-test.js`；真实隔离 PostgreSQL 使用 `npm --prefix world-engine run test:postgres:account-admin`，覆盖实际 HTTP 撤权、换绑、SQL 丢确认、并发发行、运行器版本冲突、失败回滚及归档后完整恢复。所有 CI 保留 `bash -e -o pipefail`。
