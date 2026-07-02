# API Database Routes

本层把 API server 的保存、读取和列表路由接入 API persistence adapter。

## Entry point

当前 `demo/api-server.js` 使用：

```text
world-template-api-engine.js
```

所以本层在 template API wrapper 中拦截以下路由：

```text
GET  /saves
POST /save
POST /load
```

其余 API 继续交给 base API server。

## Default mode

默认仍然是文件模式：

```text
file
```

所以原来的 JSON save/load 行为仍然保留。

## Database mode

通过 body 或 query 参数启用：

```text
persistence=database
mode=database
storage=database
useDatabase=true
```

`db` 也会被识别为 `database`。

## POST /save database example

```json
{
  "persistence": "database",
  "database": {
    "provider": "jsonl",
    "directory": "world-engine/data/db",
    "name": "world-engine"
  }
}
```

## POST /load database example

```json
{
  "persistence": "database",
  "worldId": "world",
  "database": {
    "provider": "jsonl",
    "directory": "world-engine/data/db",
    "name": "world-engine"
  }
}
```

## GET /saves database example

```text
/saves?persistence=database&dbProvider=jsonl&dbDir=world-engine/data/db&dbName=world-engine
```

## Test

新增：

```text
api-database-routes-test.js
```

覆盖：

```text
POST /save in database mode
GET /saves in database mode
POST /load in database mode
POST /save in default file mode
GET /saves in default file mode
```
