# PostgreSQL 历史保留与维护

Migration 4 只追加结构，Migration 1–3 的 SQL 和 checksum 不变。运行 `npm --prefix world-engine run database:postgres -- migrate` 后才能使用此版本的存储、备份和审计适配器。升级前用旧版本引擎备份；旧版本备份必须先恢复到相同 migration 版本，再执行升级。

默认不自动清理。以下命令通过 `WORLD_ENGINE_DATABASE_URL` 和 `WORLD_ENGINE_DB_SCHEMA` 选择数据库，数据库账户必须有维护权限。备份路径不能已经存在，父目录必须存在。

```sh
# 只预览：保留最新 20 个完整存档
npm --prefix world-engine run database:maintain -- checkpoints --world-id WORLD --keep 20

# 先完整备份，再压缩最多 100 个旧存档；填写刚核对的当前 revision
npm --prefix world-engine run database:maintain -- checkpoints --world-id WORLD --keep 20 --limit 100 --expected-revision 123 --apply --backup ./backups/before-compaction.ndjson

# 只预览：sequence 小于 10000 的前 100 条审计
npm --prefix world-engine run database:maintain -- audit --before-sequence 10000 --limit 100

# 先完整备份，再归档本次备份确实包含的最多 100 条审计
npm --prefix world-engine run database:maintain -- audit --before-sequence 10000 --limit 100 --apply --backup ./backups/before-audit-retirement.ndjson
```

存档压缩保留原始 request ID、request hash、payload checksum、revision、sequence、metadata 以及外键目标，仅移除旧 envelope。最新存档永远保留；每个被压缩的 envelope 都先校验。世界行锁和 expectedRevision 防止与写入者冲突，失败会回滚整个批次。压缩不推进世界 revision。重复提交完全相同的历史保存请求返回原来的成功凭据，不发布旧状态、不再执行命令；修改后的同 ID 请求仍报幂等冲突。读取已压缩的历史 revision 返回 `WORLD_DB_CHECKPOINT_ARCHIVED`，需要恢复清理前的备份才能读取其世界内容。

审计归档将明细变为永久小型 receipt：request ID、sequence、允许字段的摘要及原始创建时间。它不保留 token、正文或连接信息。归档后管理员查询只返回仍保留的明细；旧明细在清理前备份里。append 和归档共享按 request ID 的事务锁，旧请求重试返回 `idempotent: true, retained: false`，不会重新插入明细。不同字段重用同一 request ID 仍失败。

审计归档按备份中的精确行及其摘要逐条核验，不能按 sequence 范围直接 DELETE。sequence 先分配后提交：较小 sequence 的事务可能在备份快照开始后才提交，范围删除会误删未备份内容。并发重复归档允许已归档行缺失，但发现行内容改变会回滚整个批次。

这些是容量管理工具，不代表数据库总容量有固定上限。checkpoint receipts、command inbox、world events 和 audit receipts 仍保留以维护幂等、命令结果和引用关系；world metadata 也由调用者控制大小。完整备份文件会持续占用磁盘，需要按恢复需求转存和保管。PostgreSQL 更新/删除后的磁盘回收依赖正常 VACUUM 运维，文件大小不保证立即缩小。直接存储 API `compactCheckpoints` / `retireAuditRecords` 是可信维护层，调用者需先建立备份；面向操作员的 CLI 强制先完成备份。

真实 PostgreSQL 验收：`WORLD_ENGINE_TEST_DATABASE_URL` 指向 `_ci` 或 `_test` 结尾的隔离测试数据库，再执行 `npm --prefix world-engine run test:postgres:maintenance`。覆盖备份、批次上限、版本冲突、损坏回滚、晚提交审计、并发幂等及归档后恢复。CI 使用 `bash -e -o pipefail` 和明确的 8/8 完成标记，数据库不可用时禁止静默跳过。
