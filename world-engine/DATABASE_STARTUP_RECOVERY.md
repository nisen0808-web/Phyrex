# Database Startup Recovery

本层补齐数据库存档到 API 启动的恢复链路。恢复在监听端口、启动自动循环之前完成，不修改存档文件，不补跑 seed ticks，不在失败时偷偷创建新世界。

## 启动方式

在 world-engine 目录执行：

```bash
npm run api:live:db
```

该脚本新增 `--resume-mode if-present`：空库允许首次创建演示世界；只有一个已存世界时恢复其最新写入记录；多个世界时拒绝猜测，必须指定 world ID。

指定已有世界并要求成功恢复：

```bash
npm run api:live:db -- --resume-mode required --resume-world checkpoint
```

直接从仓库根目录运行，明确使用同一个数据目录：

```bash
node world-engine/demo/api-server.js --auto-loop --autosave-every 25 --autosave-mode database --db-provider jsonl --db-dir world-engine/data/db --db-name world-engine --resume-mode required --resume-world checkpoint
```

`checkpoint` 是示例 ID，需要替换成实际存档的 world ID。路径仍按当前工作目录解析；不要把仓库根目录命令与 world-engine 目录命令的相对路径混用。跨目录启动宜传入绝对 `--db-dir`。本批次不移动既有数据库目录。

## 模式

| 模式 | 空库 | 一个世界 | 多个世界 |
|---|---|---|---|
| off | 使用原有演示世界初始化 | 不读取数据库 | 不读取数据库 |
| if-present | 允许首次初始化 | 恢复最新写入记录 | 需要 --resume-world |
| required | 拒绝启动 | 恢复最新写入记录 | 需要 --resume-world |

`--resume-world` 单独使用时默认采用 required。显式指定不存在的 world ID，即使使用 if-present 也会失败。off 与 --resume-world 冲突会报配置错误。

普通 `npm run api` 和 `api:live` 的恢复默认仍为 off，保留原有行为。只有数据库 live 脚本默认启用 if-present。恢复与自动保存是独立设置；需要继续写回数据库时必须使用 database autosave。

环境变量（直接启动命令且未指定对应 CLI 参数时生效）：

```text
WORLD_ENGINE_DB_RESUME_MODE=required
WORLD_ENGINE_DB_RESUME_WORLD=checkpoint
WORLD_ENGINE_DB_PROVIDER=jsonl
WORLD_ENGINE_DB_DIR=/absolute/path/to/database
WORLD_ENGINE_DB_NAME=world-engine
WORLD_ENGINE_AUTOSAVE_MODE=database
```

CLI 参数优先于环境变量。不要将空字符串作为显式恢复模式或 world ID。

## 记录选择与校验

“最新”按追加 sequence 判断，不能按 tick 最大值判断。世界回滚后，新存档可能比旧存档 tick 更小。同 tick 多次保存也选择 sequence 最大的记录。

世界记录读取会校验 JSON、记录类型、非空 ID、安全整数 sequence/tick/schemaVersion、递增 sequence、记录 ID 唯一性，以及 record/envelope/world 的 ID 和 tick 一致性。entities 和 locations 必须为对象。此校验是存档结构门禁，不替代每个模拟系统的完整 Contract。

恢复只读取一次 worlds 文件，在该读结果中完成选择，再复制并调用既有 schema 迁移及状态修复函数。未知未来 schema 拒绝恢复，不自动退回旧记录。非法 JSON、截断行、错误记录类型、重复或倒退 sequence 等均使启动失败，保留原文件供排查。

JSONL 错误包含真实物理行号（空行也计入行号），不回显原始 JSON 内容。只读的 `database:check` 仍可用于调查坏文件；本层不提供破坏性清理或自动截断。

## 核心入口

```text
prepareDatabaseStartup(options, env)
normalizeDatabaseStartupMode(value)
readWorldSaveRecords(file)
restoreWorldSaveRecord(record, config)
validateWorldSaveRecord(record)
createApiServerFromArgs(args, env)
```

启动输出增加 `startup` 摘要：mode、status、provider、worldId、tick、sequence。摘要不写入模拟 world，不包含连接密码或完整世界数据。

## 验证范围

`tests/database-startup-recovery-test.js` 已接入 `npm test`，包含 10 组场景：

- 空库、关闭模式及未实现 provider。
- 单世界、多世界、显式 world ID 选择。
- 回滚后低 tick 存档、同 tick 最新记录。
- 随机流与世界级确定性 ID 续接。
- 损坏尾行、真实行号和原文件字节不变。
- 非法记录及 envelope/world 不一致。
- sequence 重复、sequence 缺口及未来 schema。
- CLI/环境变量优先级、缺参和拼写错误。
- required 失败时进程非零退出，未开始监听。
- 真实 API 子进程从 tick 17 恢复，经 HTTP 推进和自动保存到 tick 18，退出后启动另一进程恢复 tick 18。

## 尚未完成的生产能力

当前仍是单写入进程的同步 JSONL 原型。SQLite/PostgreSQL 仅有配置占位，没有 SQL 驱动、事务、迁移表、索引或已部署数据库实例。现有追加写也不保证断电后的事务原子性；缺少跨进程锁、校验和、压缩归档和完整灾备演练。文件会整体读取，持续运行后的文件体积和恢复内存开销仍需治理。不要将页面、CLI 和基础读写完成度等同于生产数据库完成度。
