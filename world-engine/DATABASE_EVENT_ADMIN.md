# Database Event Admin

本层增加数据库事件查看入口。

## Engine helpers

```text
appendDatabaseEvent(input, options)
listDatabaseEvents(options)
```

`listDatabaseEvents` 支持：

```text
database
worldId
type
limit
order
```

## Endpoint

```text
GET /admin/database/events
```

## Query parameters

数据库配置：

```text
dbProvider=jsonl
dbDir=world-engine/data/db
dbName=world-engine
```

事件过滤：

```text
worldId=<world id>
type=<event type>
limit=100
order=desc
```

## Example

```text
/admin/database/events?dbProvider=jsonl&dbDir=world-engine/data/db&dbName=world-engine&limit=20
```

过滤某一类事件：

```text
/admin/database/events?dbProvider=jsonl&dbDir=world-engine/data/db&dbName=world-engine&type=runtime.loop
```

## Response

返回：

```text
database
events
```

`events` 每条包括：

```text
id
sequence
worldId
tick
type
payload
createdAt
```

## Test

新增：

```text
database-event-admin-test.js
```

覆盖：

```text
appendDatabaseEvent
listDatabaseEvents latest order
listDatabaseEvents by type
GET /admin/database/events
api-server endpoint list contains GET /admin/database/events
```

## Notes

本批次只做事件查看。事件清理入口后续单独做，避免和查询功能混在一个 PR 中。
