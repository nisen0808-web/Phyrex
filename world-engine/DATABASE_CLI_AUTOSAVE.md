# Database Autosave CLI

本层为 API server 启动脚本增加数据库自动保存参数。

## Script

```text
world-engine/demo/api-server.js
```

## New options

```text
--autosave-mode <file|database>
--db-provider <provider>
--db-dir <dir>
--db-name <name>
--db-auto-create <bool>
```

## File autosave

默认仍然是文件模式：

```bash
node world-engine/demo/api-server.js \
  --auto-loop \
  --autosave-every 25 \
  --autosave-path world-engine/output/live-world-save.json
```

## Database autosave

数据库自动保存示例：

```bash
node world-engine/demo/api-server.js \
  --auto-loop \
  --autosave-every 25 \
  --autosave-mode database \
  --db-provider jsonl \
  --db-dir world-engine/data/db \
  --db-name world-engine
```

## Environment variables

也可以通过环境变量配置：

```text
WORLD_ENGINE_AUTOSAVE_MODE=database
WORLD_ENGINE_DB_PROVIDER=jsonl
WORLD_ENGINE_DB_DIR=world-engine/data/db
WORLD_ENGINE_DB_NAME=world-engine
WORLD_ENGINE_DB_AUTO_CREATE=true
```

## Exports

`api-server.js` 现在导出：

```text
buildRuntimeLoopOptions(args, context)
buildDatabaseOptions(args)
```

便于测试和后续运维脚本复用。

## Test

新增：

```text
database-cli-autosave-test.js
```

覆盖：

```text
parseArgs database autosave flags
buildDatabaseOptions
buildRuntimeLoopOptions database mode
buildRuntimeLoopOptions file mode compatibility
endpoint list contains GET /admin/database
```
