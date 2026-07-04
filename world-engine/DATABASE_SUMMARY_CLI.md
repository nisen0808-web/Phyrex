# Database Summary CLI

数据库摘要导出命令。

## Command

```bash
npm run database:summary
```

或直接运行：

```bash
node demo/database-summary-cli.js
```

## Defaults

读取目录：

```text
world-engine/data/db
```

数据库名称：

```text
world-engine
```

输出文件：

```text
world-engine/output/database-summary.json
```

## Options

```text
--db-provider jsonl
--db-dir world-engine/data/db
--db-name world-engine
--output world-engine/output/database-summary.json
--world-limit 20
--event-limit 20
--order desc
--world-id <world id>
--type <event type>
--quiet
```

## Output fields

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

## Coverage

`database-cli-autosave-test.js` 覆盖参数解析和 database options 构建。
