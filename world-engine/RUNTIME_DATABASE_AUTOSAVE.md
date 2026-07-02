# Runtime Database Autosave

本层为 runtime loop autosave 增加数据库模式。

## Core modules

```text
core/runtime-autosave-engine.js
core/runtime-loop-engine.js
```

## Modes

当前支持：

```text
file
database
```

默认仍然是：

```text
file
```

所以原有 `autosavePath` 文件保存逻辑保持兼容。

## Runtime loop options

文件模式：

```js
createRuntimeLoop(world, {
  autosaveEveryTicks: 25,
  autosaveMode: 'file',
  autosavePath: 'world-engine/output/live-world-save.json',
});
```

数据库模式：

```js
createRuntimeLoop(world, {
  autosaveEveryTicks: 25,
  autosaveMode: 'database',
  autosaveDatabase: {
    provider: 'jsonl',
    directory: 'world-engine/data/db',
    name: 'world-engine',
  },
});
```

## Direct autosave helper

```text
runRuntimeAutosave(world, options)
resolveRuntimeAutosaveMode(options)
summarizeRuntimeAutosave(save)
```

## Runtime summary

`getRuntimeLoopSummary(loop)` 现在包含：

```text
autosaveMode
autosaveDatabase
lastAutosave
```

## Test

新增：

```text
runtime-database-autosave-test.js
```

覆盖：

```text
runRuntimeAutosave database mode
runtime loop file autosave compatibility
runtime loop database autosave
summary exposes autosaveMode and lastAutosave
```
