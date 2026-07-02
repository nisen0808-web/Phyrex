# Database Admin Endpoint

本层增加数据库运行状态查询入口。

## Endpoint

```text
GET /admin/database
```

该接口由 `world-template-api-engine.js` 拦截，并使用 `database-engine.js` 的 `getDatabaseStatus` 返回状态。

## Query parameters

```text
dbProvider=jsonl
dbDir=world-engine/data/db
dbName=world-engine
dbAutoCreate=true
```

也支持通用别名：

```text
provider
databaseDir
databaseName
autoCreate
```

## Example

```text
/admin/database?dbProvider=jsonl&dbDir=world-engine/data/db&dbName=world-engine
```

## Response

返回内容包括：

```text
database.version
database.provider
database.ready
database.directory
database.worldsFile
database.eventsFile
database.schemaFile
database.records
database.events
loop
```

`loop` 是当前 runtime loop summary，方便在一个接口里确认自动运行和自动保存状态。

## Test

新增：

```text
database-admin-status-test.js
```

覆盖：

```text
POST /save database mode
GET /admin/database
provider / records / events / name
api-server endpoint list contains GET /admin/database
```
