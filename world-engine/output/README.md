# Generated World Snapshots

这个目录用于存放 demo 或工具脚本生成的世界快照 JSON。

默认生成命令：

```bash
npm run snapshot
```

默认输出：

```text
world-engine/output/demo-snapshot.json
```

指定 tick 数：

```bash
node world-engine/demo/export-snapshot.js 300
```

指定输出路径：

```bash
node world-engine/demo/export-snapshot.js 300 world-engine/output/demo-300.json
```

快照由 `core/snapshot-engine.js` 生成，面向 UI / 前端读取。

主要字段：

```text
world
counters
population
cities
organizations
civilizations
technology
infrastructure
governance
conflicts
processes
emergence
information
memories
narrative
limits
recentReports
```

这些字段已经经过整理，不需要前端直接读取完整 world state。
