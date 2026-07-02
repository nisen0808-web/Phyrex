# Database Configuration

本层为 world-engine 增加数据库配置和本地数据库适配器。

## 当前默认方案

当前默认 provider 是：

```text
jsonl
```

也就是零依赖本地 JSONL 数据库。这样不会引入 native npm 依赖，也不会破坏当前 CI 和 Windows 本地开发。

后续可以继续增加：

```text
sqlite
postgres
```

当前这两个 provider 已保留配置入口，但还没有外部驱动适配器。

## Environment variables

```text
WORLD_ENGINE_DB_PROVIDER=jsonl
WORLD_ENGINE_DB_DIR=world-engine/data/db
WORLD_ENGINE_DB_NAME=world-engine
WORLD_ENGINE_DB_AUTO_CREATE=true
WORLD_ENGINE_DATABASE_URL=
DATABASE_URL=
```

## Files

默认会生成：

```text
world-engine/data/db/world-engine-worlds.jsonl
world-engine/data/db/world-engine-events.jsonl
world-engine/data/db/world-engine-schema.json
```

`worlds.jsonl` 存世界存档 envelope。

`events.jsonl` 存数据库事件。

`schema.json` 记录当前 JSONL record 结构。

## Core modules

```text
core/database-config-engine.js
core/database-engine.js
```

## API

```text
loadDatabaseConfig(input, env)
getDatabaseConfigSummary(config)
createDatabaseStore(options)
saveWorldToDatabase(world, options)
loadWorldFromDatabase(worldId, options)
listDatabaseWorlds(options)
appendDatabaseEvent(input, options)
getDatabaseStatus(options)
```

## Example

```js
const { createDatabaseStore } = require('./core/database-engine');

const db = createDatabaseStore({
  provider: 'jsonl',
  directory: 'world-engine/data/db',
  name: 'world-engine',
});

db.saveWorld(world, { reason: 'manual_save' });
const loaded = db.loadWorld('world');
const worlds = db.listWorlds();
```

## Notes

本层不替换现有 JSON save/load 文件，只是新增数据库式持久化入口。现有 `saveWorld`、`loadWorld`、`autosaveWorld` 仍然可用。

当前目标是先完成可配置持久化底座，下一步再把 API server 的 `/save`、`/load`、runtime loop autosave 接入数据库 store。
