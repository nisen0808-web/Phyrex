# Database Summary API

本层把数据库 viewer summary 接入 API。

## Endpoint

```text
GET /admin/database/summary
```

## Query parameters

数据库配置：

```text
dbProvider=jsonl
dbDir=world-engine/data/db
dbName=world-engine
```

摘要限制：

```text
worldLimit=20
eventLimit=20
limit=20
order=desc
worldId=<world id>
type=<event type>
```

## Example

```text
/admin/database/summary?dbProvider=jsonl&dbDir=world-engine/data/db&dbName=world-engine
```

## Response

返回 `buildDatabaseViewerSummary` 的结果：

```text
version
generatedAt
status
totals
latestWorld
worlds
events
health
```

## Coverage

`database-admin-status-test.js` 已覆盖：

```text
GET /admin/database
GET /admin/database/summary
endpoint list registration
```
