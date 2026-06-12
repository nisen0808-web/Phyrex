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
player-command-test.js
shell-engine-test.js
shell-script-test.js
quest-tutorial-report-test.js
map-alias-test.js
query-content-test.js
stability-100-test.js
```

也可以进入 `world-engine` 目录运行：

```bash
cd world-engine
npm test
```

## 3. 运行世界 demo

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

## 4. 运行最小可玩 demo

在仓库根目录运行：

```bash
npm run play
```

在 `world-engine` 目录运行：

```bash
cd world-engine
npm run play
```

`play-demo.js` 会执行一条固定试玩链路：

```text
创建玩家账号
创建玩家角色
查看玩家状态
inspect 当前地点
work 赚钱
move 到 Mist Forest
gather 木材
join Qingyun Sect
train 修炼
查看排行榜
查看命令历史
查看世界概览
```

这条链路验证：

```text
Player
→ Character
→ Command
→ Action / Goal / Organization
→ Tick
→ Result
→ Query
```

核心文件：

```text
world-engine/core/player-engine.js
world-engine/core/command-engine.js
world-engine/core/query-engine.js
world-engine/demo/play-demo.js
world-engine/tests/player-command-test.js
```

## 5. 运行交互式 Shell

在仓库根目录运行：

```bash
npm run shell
```

在 `world-engine` 目录运行：

```bash
cd world-engine
npm run shell
```

进入 shell 后可以输入英文命令：

```text
help
status
world
tutorial
quests
map
inspect location
move mist_forest
work currency 20
wait 1
report 1
gather wood 5
train 3
join "Qingyun Sect"
leaderboard overall
commands
claim
snapshot
quit
```

也支持中文别名：

```text
帮助
状态
世界
教程
任务
地图
查看 地点
前往 mist_forest
工作 currency 20
等待 1
报告 1
采集 wood 5
修炼 3
加入 "Qingyun Sect"
排行 overall
命令
领取
快照
退出
```

也可以运行脚本化命令：

```bash
npm run shell:sample
```

或手动指定脚本：

```bash
node world-engine/demo/play-shell.js --script world-engine/demo/sample-commands.txt
```

Shell 相关文件：

```text
world-engine/core/shell-engine.js
world-engine/core/shell-alias-engine.js
world-engine/core/map-engine.js
world-engine/demo/play-shell.js
world-engine/demo/sample-commands.txt
world-engine/tests/shell-engine-test.js
world-engine/tests/shell-script-test.js
world-engine/tests/map-alias-test.js
```

## 6. 任务 / 教程 / 回合报告

内容层已经有三条基础能力：

```text
quest-engine.js        任务、目标、奖励、领取
tutorial-engine.js     新手任务链和下一步提示
turn-report-engine.js  每次 wait 后生成回合报告
```

Shell 中对应命令：

```text
tutorial / 教程
quests / 任务
claim / 领取
report / 报告
```

`wait` 命令会自动推进世界，并返回本回合摘要。

## 7. 地图 / 地点查询

地图能力由：

```text
world-engine/core/map-engine.js
```

提供。

Shell 中使用：

```text
map
map mist_forest
地图
地图 mist_forest
```

返回：

```text
当前地点
资源
出口 / 邻接地点
城市
组织
附近实体
```

Query Engine 也支持：

```js
queryWorld(world, { type: 'map', playerId: 'player_id' })
queryWorld(world, { type: 'map', locationId: 'mist_forest' })
queryWorld(world, { type: 'quests', playerId: 'player_id' })
queryWorld(world, { type: 'tutorial', playerId: 'player_id' })
```

## 8. 导出前端可读快照 JSON

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
players
commands
quests
tutorials
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

## 9. 浏览器查看世界快照

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

## 10. 运行 1000 tick 手动压测

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

## 11. 测试策略

```text
npm test
```

用于日常开发，覆盖功能测试和 100 tick 快速稳定性测试。

```text
npm run play
```

用于验证固定的最小可玩链路。

```text
npm run shell
```

用于人工交互式试玩。

```text
npm run shell:sample
```

用于脚本化 shell 测试。

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

## 12. 当前关键上限

```text
world.memory <= 1000
simulation.reports <= 200
processes.byId <= 500
information.items <= 1000
memories.byId <= 3000
commands.byId <= 500
quests.byId <= 500
```

这些限制是为了避免世界长期运行后状态无限膨胀。

## 13. 常见命令

```bash
# 根目录
npm test
npm run demo
npm run play
npm run shell
npm run shell:sample
npm run snapshot
npm run viewer
npm run stress

# world-engine 目录
cd world-engine
npm test
npm run demo
npm run play
npm run shell
npm run shell:sample
npm run snapshot
npm run viewer
npm run stress

# 指定 demo tick
node world-engine/demo/run-demo.js 300
node world-engine/demo/run-demo.js 1000

# 指定 snapshot tick 和输出路径
node world-engine/demo/export-snapshot.js 300
node world-engine/demo/export-snapshot.js 300 world-engine/output/demo-300.json

# 指定 shell 脚本
node world-engine/demo/play-shell.js --script world-engine/demo/sample-commands.txt
```
