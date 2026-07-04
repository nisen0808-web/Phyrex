# Viewer Database Report

新增数据库报告 viewer 页面。

## Page

```text
viewer/database-report.html
```

启动 viewer 后访问：

```text
http://localhost:8787/viewer/database-report.html
```

## Data source

默认读取：

```text
/admin/database/check?dbProvider=jsonl&dbDir=world-engine/data/db&dbName=world-engine
```

## Script

```text
viewer/database-report.js
```

## Sections

```text
Report Summary
Files
Warnings
Errors
Raw Report
```

## Coverage

```text
viewer-test.js
```

覆盖页面文件、脚本文件、关键 DOM、加载函数、渲染函数和 viewer server 启动提示。
