# Database Live API Script

本层增加一条数据库自动保存版 API live 启动命令。

## Script

```bash
npm run api:live:db
```

实际执行：

```bash
node demo/api-server.js \
  --auto-loop \
  --interval 1000 \
  --ticks-per-cycle 1 \
  --autosave-every 25 \
  --autosave-mode database \
  --db-provider jsonl \
  --db-dir world-engine/data/db \
  --db-name world-engine
```

## Difference from api:live

`api:live` 使用文件自动保存：

```text
output/live-world-save.json
```

`api:live:db` 使用 JSONL 数据库自动保存：

```text
world-engine/data/db/world-engine-worlds.jsonl
world-engine/data/db/world-engine-events.jsonl
world-engine/data/db/world-engine-schema.json
```

## Status endpoint

启动后可以检查：

```text
GET /admin/database?dbProvider=jsonl&dbDir=world-engine/data/db&dbName=world-engine
```

## Test

新增：

```text
database-live-script-test.js
```

覆盖：

```text
api:live:db exists
uses --auto-loop
uses --autosave-mode database
uses jsonl provider
uses world-engine/data/db
uses world-engine db name
uses autosave every 25 ticks
```
