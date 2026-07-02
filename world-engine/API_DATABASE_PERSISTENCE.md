# API Database Persistence

本层为 API 保存、读取和列表操作增加可切换的持久化适配器。

## Core module

```text
core/api-database-persistence-engine.js
```

## Modes

支持两种模式：

```text
file
database
```

默认仍然是：

```text
file
```

这样不会破坏现有 `/save`、`/load`、`/saves` 的文件存档语义。

## API helpers

```text
saveWorldForApi(world, request, options)
loadWorldForApi(request, options)
listWorldSavesForApi(request, options)
getApiPersistenceStatus(request, options)
resolvePersistenceMode(request, options)
```

## Request fields

可以通过以下字段切换到数据库模式：

```text
persistence=database
mode=database
storage=database
useDatabase=true
database={...}
```

`db` 会被识别为 `database`。

## Database request example

```js
saveWorldForApi(world, {
  persistence: 'database',
  database: {
    provider: 'jsonl',
    directory: 'world-engine/data/db',
    name: 'world-engine',
  },
});
```

## File request example

```js
saveWorldForApi(world, {
  path: 'world-engine/output/api-world-save.json',
});
```

## Next step

当前 PR 增加的是 API 持久化适配层。下一步把 `api-server-engine.js` 中的 `/save`、`/load`、`/saves` 调用点替换成这些 helper。
