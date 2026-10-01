# PostgreSQL 引擎全库备份恢复

`database:backup` 导出专用引擎 schema 中所有世界、所有 checkpoint、世界事件、pending/applied command inbox、command API audit 和身份序列高水位。它不是单世界 JSON 导出，不包含集群角色、数据库权限、其他 schema 或外部扩展。目标引擎 migration 版本必须与备份一致。

```sh
# 通过 WORLD_ENGINE_DATABASE_URL / WORLD_ENGINE_DB_SCHEMA 配置连接。
npm --prefix world-engine run database:backup -- export output/world-engine.ndjson
npm --prefix world-engine run database:backup -- verify output/world-engine.ndjson
# 将环境变量切换到新的专用 schema，先迁移，再恢复。
npm --prefix world-engine run database:postgres -- migrate
npm --prefix world-engine run database:backup -- restore output/world-engine.ndjson
```

导出采用 PostgreSQL REPEATABLE READ 只读事务和游标，逐条写出 checkpoint，避免把全部数据库加载到内存。序列不是 MVCC 数据；导出结束时记录高水位，允许保留并发/失败事务产生的间隙，恢复后不能重用已分配位置。SQL 机制见 [事务隔离](https://www.postgresql.org/docs/18/transaction-iso.html) 和 [ALTER SEQUENCE](https://www.postgresql.org/docs/18/sql-altersequence.html)。

文件格式为 UTF-8 NDJSON，包含固定版本头、白名单表/列数据、序列状态和 SHA-256 尾记录。导出先写同目录临时文件并 fsync，完成后通过不覆盖目标的原子链接发布。目录需预先存在；已有文件不覆盖。备份中含私有世界数据、账户凭据哈希和命令输入，须限制文件目录访问；校验和用于发现损坏，不是加密或来源签名。文件权限在支持的平台设置为 0600，Windows 使用目录 ACL。

恢复前验证文件，再在一个 SQL 事务中重新校验并导入。目标表必须为空；锁定目标表后检查，防止并发写入破坏恢复。固定表名和列名、参数化值、checkpoint 摘要与 command input 摘要、外键和唯一约束共同验证内容。损坏、截断、尾随数据、未知列或 SQL 失败均回滚。序列使用事务性 ALTER RESTART，避免非事务 setval 导致失败后序列被改写。

默认每行最多 64 MiB；库 API 可显式配置 maxLineBytes，最大 1 GiB。导出、恢复受数据库语句超时及存储 IO 能力约束；长期导出会保持 MVCC snapshot，生产大库应在合适窗口操作。无需 pg_dump 外部二进制或额外 npm 依赖。

验证门禁包含多世界、完整行值与时间精度、并发导出隔离、命令幂等、sequence gaps、session 哈希、pending 消费、恢复续跑、非空目标拒绝、损坏回滚和 SQL 故障后重试。具体通过状态以当前提交 CI 日志为准。
