# Viewer Database Summary Card

本层把数据库摘要接入 World Engine Viewer 页面。

## Files

```text
viewer/index.html
viewer/database-summary.js
tests/viewer-test.js
```

## UI

新增两个卡片：

```text
Database Summary
Database Health
```

默认读取：

```text
/admin/database/summary?dbProvider=jsonl&dbDir=world-engine/data/db&dbName=world-engine
```

## Rendered fields

Database Summary 显示：

```text
provider
ready
records
events
worlds shown
latest world
latest tick
recent worlds
```

Database Health 显示：

```text
ok
ready
supported
has records
has events
latest world
latest tick
recent event types
warnings
```

## Notes

`database-summary.js` 是独立脚本，不改动主 `app.js` 的 snapshot 渲染逻辑。这样可以把数据库 UI 作为单独模块维护。

## Test

`viewer-test.js` 覆盖：

```text
database-url
databaseSummary
databaseHealth
database-summary.js
loadDatabaseSummary
renderDatabaseSummary
renderDatabaseHealth
```
