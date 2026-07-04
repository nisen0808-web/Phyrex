# Database Viewer Summary

本层为数据库管理 viewer 增加摘要数据整理模块。

## Core module

```text
core/database-viewer-summary-engine.js
```

## API

```text
buildDatabaseViewerSummary(options)
summarizeDatabaseHealth(status, worlds, events)
summarizeRecentEventTypes(events)
```

## Summary fields

`buildDatabaseViewerSummary` 返回：

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

## Health fields

```text
ok
ready
supported
hasRecords
hasEvents
latestTick
latestWorldId
recentEventTypes
warnings
```

## Usage

```js
const { buildDatabaseViewerSummary } = require('./core/database-viewer-summary-engine');

const summary = buildDatabaseViewerSummary({
  database: {
    provider: 'jsonl',
    directory: 'world-engine/data/db',
    name: 'world-engine',
  },
  worldLimit: 20,
  eventLimit: 20,
});
```

## Purpose

这个模块不直接修改前端页面。它先把数据库状态、最近世界存档、最近事件和健康信息整理成稳定对象，后续可以直接接到 viewer 页面或 API 输出。

## Test

当前通过 `viewer-test.js` 覆盖模块存在性和事件类型聚合函数行为。

另外保留了独立的：

```text
database-viewer-summary-test.js
```

用于后续扩展完整数据库摘要测试。
