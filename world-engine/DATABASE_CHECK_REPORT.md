# Database Check Report

本层增加数据库只读检查报告。

## Core module

```text
core/database-check-report-engine.js
```

## CLI

```bash
npm run database:check
```

等价于：

```bash
node demo/database-check-cli.js
```

默认输出：

```text
world-engine/output/database-check.json
```

## Report fields

```text
version
config
supported
ok
counts
files
warnings
errors
```

## File checks

当前覆盖：

```text
worlds JSONL
events JSONL
schema JSON
```

JSONL 文件会统计：

```text
exists
bytes
lines
records
recordTypes
firstSequence
lastSequence
minTick
maxTick
parseErrors
```

## Options

```text
--db-provider jsonl
--db-dir world-engine/data/db
--db-name world-engine
--output world-engine/output/database-check.json
--quiet
```

## Coverage

```text
database-config-test.js
  buildDatabaseCheckReport
  inspectJsonLineFile
  summarizeDatabaseCheckReport

database-cli-autosave-test.js
  database-check-cli argument parsing
  database-check-cli database options
```
