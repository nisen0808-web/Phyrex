# World Engine Quickstart

这个文件只写最短路径，方便 clone 仓库后直接运行。

## 1. 拉取代码

```bash
git clone https://github.com/nisen0808-web/Phyrex.git
cd Phyrex
```

## 2. 运行完整快速测试

```bash
npm test
```

默认测试包括：

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
journal-encounter-board-test.js
item-inventory-shop-test.js
persistence-offline-runtime-test.js
stability-100-test.js
```

## 3. 运行世界 demo

```bash
npm run demo
```

指定 tick 数：

```bash
node world-engine/demo/run-demo.js 300
```

## 4. 运行固定试玩 demo

```bash
npm run play
```

## 5. 运行交互式 Shell

```bash
npm run shell
```

英文命令：

```text
help
status
world
tutorial
quests
map
board
accept <boardItemId>
explore
journal
inventory
shop
buy <shopId> <itemDefinitionId> [quantity]
equip <itemId|itemDefinitionId>
use <itemId|itemDefinitionId>
sell <itemId|itemDefinitionId> [quantity]
unequip <slot|itemId|itemDefinitionId>
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

中文命令：

```text
帮助
状态
世界
教程
任务
地图
委托
接取 <boardItemId>
探索
日志
背包
商店
购买 <shopId> <itemDefinitionId> [quantity]
装备 <itemId|itemDefinitionId>
使用 <itemId|itemDefinitionId>
出售 <itemId|itemDefinitionId> [quantity]
卸下 <slot|itemId|itemDefinitionId>
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

脚本化试玩：

```bash
npm run shell:sample
```

## 6. 内容层能力

当前可玩内容层包括：

```text
quest-engine.js              任务、目标、奖励、领取
tutorial-engine.js           新手任务链和下一步提示
turn-report-engine.js        每次 wait 后生成回合报告
map-engine.js                当前地点、出口、资源、附近实体、组织、城市
shell-alias-engine.js        英文/中文命令别名
player-journal-engine.js     玩家日志 / 个人史
encounter-engine.js          探索遭遇 / 地点事件
quest-board-engine.js        地点委托板 / 接取委托
item-engine.js               物品定义 / 物品实例
inventory-engine.js          背包 / 装备 / 使用物品
shop-engine.js               地点商店 / 购买 / 出售
```

## 7. 世界服务引擎能力

当前服务层包括：

```text
persistence-engine.js        save / load / autosave / list saves
offline-command-engine.js    离线命令队列 / 长时间动作 / 定时执行
runtime-engine.js            世界运行器 / tick batch / 自动存档 / runtime snapshot
```

运行 runtime demo：

```bash
npm run runtime
```

或在 `world-engine` 目录：

```bash
cd world-engine
npm run runtime
```

runtime demo 会执行：

```text
创建世界
创建玩家
安排离线 work / train
运行 runtime tick
自动存档
生成 runtime snapshot
读档恢复
查询离线命令状态
列出存档文件
```

## 8. 地图、探索、委托、背包闭环

典型玩法：

```text
地图
商店
购买 shop_qingyun_city_general wooden_sword 1
购买 shop_qingyun_city_general healing_pill 2
背包
装备 wooden_sword
使用 healing_pill
委托
接取 board_mist_forest_gather_wood
探索
日志
采集 wood 5
等待 1
任务
领取
报告
```

## 9. Query Engine 常用查询

```js
queryWorld(world, { type: 'map', playerId: 'player_id' })
queryWorld(world, { type: 'map', locationId: 'mist_forest' })
queryWorld(world, { type: 'quests', playerId: 'player_id' })
queryWorld(world, { type: 'tutorial', playerId: 'player_id' })
queryWorld(world, { type: 'journal', playerId: 'player_id' })
queryWorld(world, { type: 'encounters', playerId: 'player_id' })
queryWorld(world, { type: 'board', playerId: 'player_id' })
queryWorld(world, { type: 'inventory', playerId: 'player_id' })
queryWorld(world, { type: 'shop', playerId: 'player_id' })
queryWorld(world, { type: 'offline', playerId: 'player_id' })
```

## 10. 导出前端可读快照 JSON

```bash
npm run snapshot
```

Snapshot 主要字段：

```text
world
counters
population
players
commands
offlineCommands
quests
tutorials
journals
encounters
questBoards
items
shops
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

## 11. 浏览器查看世界快照

```bash
npm run snapshot
npm run viewer
```

打开：

```text
http://localhost:8787/viewer/index.html
```

Viewer 会显示：

```text
players
commands
tutorials
quests
journals
encounters
questBoards
items
shops
cities
organizations
civilizations
systems
limits
recentReports
raw snapshot
```

## 12. 运行 1000 tick 手动压测

```bash
npm run stress
```

## 13. 当前关键上限

```text
world.memory <= 1000
simulation.reports <= 200
processes.byId <= 500
information.items <= 1000
memories.byId <= 3000
commands.byId <= 500
quests.byId <= 500
offlineCommands <= 500 snapshot limit
journals <= 300 per player
encounters <= 300 per player
questBoards <= 500 snapshot limit
itemInstances <= 1000
shops <= 500 snapshot limit
```

## 14. 常见命令

```bash
npm test
npm run demo
npm run play
npm run shell
npm run shell:sample
npm run snapshot
npm run runtime
npm run viewer
npm run stress

cd world-engine
npm test
npm run demo
npm run play
npm run shell
npm run shell:sample
npm run snapshot
npm run runtime
npm run viewer
npm run stress
```
