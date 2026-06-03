# World Engine Quickstart

这个文件只写最短路径，方便 clone 仓库后直接运行。

## 1. 拉取代码

```bash
git clone https://github.com/nisen0808-web/Phyrex.git
cd Phyrex
```

## 2. 运行完整快速测试

在仓库根目录运行：

```bash
npm test
```

这会执行：

```text
smoke-test.js
information-memory-test.js
identity-culture-test.js
religion-civilization-test.js
desire-opportunity-test.js
process-emergence-test.js
governance-conflict-test.js
technology-infrastructure-test.js
snapshot-test.js
viewer-test.js
stability-100-test.js
```

也可以进入 `world-engine` 目录运行：

```bash
cd world-engine
npm test
```

## 3. 运行 demo

在仓库根目录运行默认 100 tick demo：

```bash
npm run demo
```

也可以指定 tick 数，例如 300 tick：

```bash
node world-engine/demo/run-demo.js 300
```

在 `world-engine` 目录运行：

```bash
cd world-engine
npm run demo
```

或者：

```bash
node demo/run-demo.js 300
```

Demo 会创建一个小型修仙主题世界，包括：

```text
Qingyun City
Mist Forest
Black Iron Mine
Qingyun Sect
Black Iron Guild
Mist Forest Clan
36 个角色
组织关系
契约
城市
文明
科技
基础设施
治理
冲突
信息
记忆
过程
涌现事件
```

运行结束后会输出：

```text
World tick
Alive population
Cities
Organizations
Civilizations
Technologies unlocked
Infrastructure total / active
Governments total / unstable
Conflicts total / active
Processes total / active
World memory / 1000
Information items / 1000
Structured memories / 3000
Simulation reports / 200
Simulation counters
```

## 4. 导出前端可读快照 JSON

在仓库根目录运行：

```bash
npm run snapshot
```

默认输出：

```text
world-engine/output/demo-snapshot.json
```

也可以指定 tick 数：

```bash
node world-engine/demo/export-snapshot.js 300
```

也可以指定输出路径：

```bash
node world-engine/demo/export-snapshot.js 300 world-engine/output/demo-300.json
```

在 `world-engine` 目录运行：

```bash
cd world-engine
npm run snapshot
```

Snapshot 是给 UI / 前端读取的整理后数据，不需要前端直接读取完整 world state。

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

## 5. 浏览器查看世界快照

先生成 snapshot：

```bash
npm run snapshot
```

再启动本地 viewer：

```bash
npm run viewer
```

打开：

```text
http://localhost:8787/viewer/index.html
```

viewer 默认读取：

```text
world-engine/output/demo-snapshot.json
```

如果在 `world-engine` 目录内运行：

```bash
cd world-engine
npm run snapshot
npm run viewer
```

viewer 是零依赖静态页面，文件位于：

```text
world-engine/viewer/index.html
world-engine/viewer/app.js
world-engine/viewer/styles.css
world-engine/viewer/serve-viewer.js
```

## 6. 运行 1000 tick 手动压测

默认测试不跑 1000 tick，因为部分沙箱或 CI 环境可能超时。

需要长压测时，在仓库根目录运行：

```bash
npm run stress
```

或者：

```bash
node world-engine/tests/stability-1000-test.js
```

在 `world-engine` 目录运行：

```bash
npm run stress
```

## 7. 测试策略

```text
npm test
```

用于日常开发，覆盖功能测试和 100 tick 快速稳定性测试。

```text
npm run stress
```

用于手动长周期压测，覆盖 1000 tick 稳定性。

```text
npm run snapshot
```

用于生成前端可读取的 demo snapshot JSON。

```text
npm run viewer
```

用于本地浏览器查看 demo snapshot。

## 8. 当前关键上限

```text
world.memory <= 1000
simulation.reports <= 200
processes.byId <= 500
information.items <= 1000
memories.byId <= 3000
```

这些限制是为了避免世界长期运行后状态无限膨胀。

## 9. 常见命令

```bash
# 根目录
npm test
npm run demo
npm run snapshot
npm run viewer
npm run stress

# world-engine 目录
cd world-engine
npm test
npm run demo
npm run snapshot
npm run viewer
npm run stress

# 指定 demo tick
node world-engine/demo/run-demo.js 300
node world-engine/demo/run-demo.js 1000

# 指定 snapshot tick 和输出路径
node world-engine/demo/export-snapshot.js 300
node world-engine/demo/export-snapshot.js 300 world-engine/output/demo-300.json
```
