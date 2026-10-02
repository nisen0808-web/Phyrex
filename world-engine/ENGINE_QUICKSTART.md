# 世界引擎 v1 启动与恢复

当前运行器使用 v3 玩家命令规则。已有 v1/v2 世界需要停止旧写入器并显式升级，步骤与命令字段见 [PLAYER_COMMAND_CONTRACT.md](PLAYER_COMMAND_CONTRACT.md)。
需要 Node.js 20 或 22、npm、PostgreSQL 18。命令从仓库根目录执行。Windows 使用 `npm.cmd`；macOS/Linux 可以直接使用 `npm`。`npm --prefix world-engine run ...` 启动的脚本工作目录是 `world-engine/`，因此脚本参数 `output/...` 指向 `world-engine/output/...`。

## 准备数据库

已有 PostgreSQL 时，设置 `WORLD_ENGINE_DATABASE_URL` 和专用 schema 即可。远程连接默认必须验证 TLS 证书，不能为了连接成功关闭校验。本地可选 Docker Compose：

```powershell
npm.cmd ci --prefix world-engine --ignore-scripts
New-Item -ItemType Directory -Force world-engine/output, world-engine/secrets, world-engine/backups | Out-Null

# 仅首次初始化数据库时生成，后续使用原凭据。不要打印或提交这个变量。
$env:WORLD_ENGINE_POSTGRES_PASSWORD = node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))"
docker compose -f world-engine/compose.engine.yml up -d --wait
$env:WORLD_ENGINE_DATABASE_URL = "postgresql://engine:$($env:WORLD_ENGINE_POSTGRES_PASSWORD)@127.0.0.1:55432/engine"
$env:WORLD_ENGINE_DB_SCHEMA = "world_engine"
npm.cmd --prefix world-engine run database:postgres -- migrate
```

数据库只绑定本机 55432 端口。Compose 的持久卷挂载 `/var/lib/postgresql`，符合 PostgreSQL 18 官方镜像的版本化数据目录；参考 [官方镜像说明](https://hub.docker.com/_/postgres)。此 Compose 是本地开发配置，数据库用户具备管理权限。数据库初始化后，修改环境变量不会自动更改已有数据库密码；请保管原凭据。普通 `docker compose ... down` 保留数据卷，不要用删除卷的选项作为日常停机方式。

## 建立世界与账户

以下流程假设是空 schema。已有世界请直接恢复，不能重新导入覆盖。

```powershell
npm.cmd --prefix world-engine run engine:init -- --output output/bootstrap.json --world-id engine-world --seed my-first-world --population 12
npm.cmd --prefix world-engine run database:postgres -- import --input output/bootstrap.json --request-id bootstrap --expected-revision 0

# 初始世界 revision 为 1，依次进行三次管理写入
npm.cmd --prefix world-engine run account:admin -- account.create --world-id engine-world --account-id operator --roles admin --request-id create-operator --expected-revision 1
npm.cmd --prefix world-engine run account:admin -- player.link --world-id engine-world --account-id operator --player-id observer --request-id link-observer --expected-revision 2
npm.cmd --prefix world-engine run account:admin -- token.create --output secrets/operator.token
npm.cmd --prefix world-engine run account:admin -- session.issue --world-id engine-world --account-id operator --token-file secrets/operator.token --request-id issue-operator --expected-revision 3
npm.cmd --prefix world-engine run account:admin -- inspect --world-id engine-world --account-id operator
```

示例世界包含四个相连地点、创始人口、组织、观察者玩家和长期容量配置。没有内嵌账户或通用密码。默认一年 720 tick；长测中的加速参数不用于这里。

首次启动前先跑有限批次，查看提交结果：

```powershell
npm.cmd --prefix world-engine run runtime:postgres -- --world-id engine-world --batches 2 --ticks-per-batch 5 --interval 10
```

只有数据库成功提交后才报告 `committed`。每个世界保持一个写入运行器；另一个写入者会被 revision fence 拒绝。

## 持续运行与命令 API

在一个已设置数据库 URL/schema 的终端运行统一服务：

```powershell
# HTTP 与演化 Worker 在同一进程内隔离运行，Ctrl+C 安全关机
npm.cmd run engine:serve -- --world-id engine-world --host 127.0.0.1 --port 8791 --interval 1000
```

另一个终端检查可用性：

```powershell
Invoke-RestMethod -Uri http://127.0.0.1:8791/health/live
Invoke-RestMethod -Uri http://127.0.0.1:8791/health/ready
```

运行器阻塞、心跳过期或数据库不可用时 readiness 返回 503，暂停接受新命令。完整状态读取、安全关机和恢复规则见 [引擎服务说明](ENGINE_SERVICE.md)。旧 `runtime:postgres --continuous` 与 `api:postgres:commands` 两进程方式仍可用；同一世界不要同时启动多个写入器。

用另一个终端发送一个带固定命令 ID 的操作：

```powershell
$engineToken = (Get-Content -LiteralPath world-engine/secrets/operator.token -Raw).Trim()
$engineHeaders = @{ Authorization = "Bearer $engineToken" }
$engineBody = @{ id = "first-wait"; type = "wait"; ticks = 1 } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8791/durable/worlds/engine-world/players/observer/commands -Headers $engineHeaders -ContentType application/json -Body $engineBody
Invoke-RestMethod -Uri http://127.0.0.1:8791/durable/worlds/engine-world/commands/first-wait -Headers $engineHeaders
Invoke-RestMethod -Uri 'http://127.0.0.1:8791/durable/worlds/engine-world/admin/audit?limit=20' -Headers $engineHeaders
Invoke-RestMethod -Uri http://127.0.0.1:8791/durable/worlds/engine-world/players/observer/state -Headers $engineHeaders
Invoke-RestMethod -Uri http://127.0.0.1:8791/durable/worlds/engine-world/admin/summary -Headers $engineHeaders
Invoke-RestMethod -Uri 'http://127.0.0.1:8791/durable/worlds/engine-world/players/observer/commands?limit=20' -Headers $engineHeaders
Invoke-RestMethod -Uri http://127.0.0.1:8791/durable/worlds/engine-world/admin/queue -Headers $engineHeaders
```

提交先返回 pending，运行器提交后轮询返回 applied；同一 ID 同一内容重试不会重放，改变内容会冲突。普通 player 只操作已绑定玩家，GM/Admin 可以查询审计。限流按本进程来源/账户执行；部署多 API 实例时需外部统一限流。HTTP 审计异步写入，失败独立计数；正常停机等待已经响应的请求完成审计写入。它不是与命令提交同事务的强制审计账本。

如需修改角色、停用账户或撤销 token，先停止该世界写入运行器，使用 inspect 读取最新 revision，再按 [账户管理说明](DURABLE_ACCOUNT_ADMIN.md) 操作，随后重新启动。API 每次请求从已提交状态授权。

## 备份、恢复与维护

```powershell
npm.cmd --prefix world-engine run database:backup -- export backups/engine-full.ndjson
npm.cmd --prefix world-engine run database:backup -- verify backups/engine-full.ndjson
```

这是同一个 schema 下全部世界、历史存档、命令、事件、审计和序列高水位的一致性快照；不包含数据库角色和其他 schema。文件会包含业务状态及 token hash，需要保管。已有文件绝不覆盖。恢复目标必须是空的专用 schema，且 migration 版本与备份完全一致：

```powershell
# 先停止旧的世界运行器/API，再切换所有终端到恢复后的 schema
$env:WORLD_ENGINE_DB_SCHEMA = "world_engine_restore"
npm.cmd --prefix world-engine run database:postgres -- migrate
npm.cmd --prefix world-engine run database:backup -- restore backups/engine-full.ndjson
npm.cmd --prefix world-engine run runtime:postgres -- --world-id engine-world --batches 1
```

恢复不会覆盖非空库；坏文件或 SQL 错误会回滚整次导入。最新世界、幂等结果与待消费命令一起恢复。更多约束见 [完整备份](POSTGRES_BACKUP.md)。旧版本备份使用同版本引擎先恢复，再升级；不能直接把 Migration 3 备份导入已迁移到 4 的目标。

历史压缩先预览，确认当前 revision 后再指定新备份文件执行。详见 [数据库维护](POSTGRES_MAINTENANCE.md) 与 [运行态容量](OPERATIONAL_RETENTION.md)。v1 默认 checkpoint 上限 32 MiB，活跃世界规模超出范围会明确报错；不承诺无限人口或无限历史。

## 运行验收

```powershell
npm.cmd test
npm.cmd --prefix world-engine test
npm.cmd --prefix world-engine run stress
npm.cmd --prefix world-engine run test:engine:scale -- small
npm.cmd --prefix world-engine run test:engine:scale -- medium
npm.cmd --prefix world-engine run test:engine:scale -- large
```

真实 SQL 测试必须另外提供 `WORLD_ENGINE_TEST_DATABASE_URL`，数据库名以 `_test` 或 `_ci` 结尾。不要指向开发业务库；测试只创建和删除自己的随机 schema，但需要显式隔离。完整 scripts 清单见 [NPM_SCRIPTS.md](NPM_SCRIPTS.md)。SQL 快速启动门禁 `test:postgres:quickstart` 会以新进程执行本说明中的初始化、迁移、导入、账户、运行器、备份、恢复命令，再检查 HTTP 命令和恢复后的继续运行。

CI 的成功必须包括实际完成标记。历史上 `npm test | tee ...` 未开启 pipefail，曾出现 57 个测试中 5 个失败但 job 仍绿色；#61 修复。所有新门禁保留 bash 的 `-e -o pipefail` 和结果断言，不能把输出管道成功当成引擎测试成功。
