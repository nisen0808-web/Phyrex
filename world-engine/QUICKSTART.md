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
api-server-test.js
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
api-server-engine.js         HTTP API / 客户端接入 / tick event stream
```

运行 runtime demo：

```bash
npm run runtime
```

## 8. API Server

启动 API 服务：

```bash
npm run api
```

指定端口：

```bash
node world-engine/demo/api-server.js --host 127.0.0.1 --port 8790
```

核心端点：

```text
GET  /health
GET  /world
GET  /snapshot
GET  /stream
GET  /players/:playerId
POST /players
POST /commands
POST /offline
GET  /offline/:playerId
POST /tick
POST /runtime/run
POST /save
POST /load
GET  /saves
```

创建玩家：

```bash
curl -X POST http://127.0.0.1:8790/players \
  -H 'Content-Type: application/json' \
  -d '{"player":{"id":"api_player","name":"API Player"},"character":{"id":"api_hero","name":"API Hero","species":"human","locationId":"qingyun_city","resources":{"currency":100,"food":10}}}'
```

提交命令：

```bash
curl -X POST http://127.0.0.1:8790/commands \
  -H 'Content-Type: application/json' \
  -d '{"playerId":"api_player","command":{"type":"work","resource":"currency","amount":10}}'
```

安排离线命令：

```bash
curl -X POST http://127.0.0.1:8790/offline \
  -H 'Content-Type: application/json' \
  -d '{"playerId":"api_player","command":{"type":"train","amount":1,"durationTicks":2,"runsEveryTicks":1,"repeat":2}}'
```

推进 tick：

```bash
curl -X POST http://127.0.0.1:8790/tick \
  -H 'Content-Type: application/json' \
  -d '{"ticks":3}'
```

Tick stream 使用 Server-Sent Events：

```bash
curl http://127.0.0.1:8790/stream
```

后续客户端可以用这个流订阅：

```text
hello
ping
tick
runtime
save
load
command
offline.queued
player.created
```

## 9. 地图、探索、委托、背包闭环

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

## 10. Query Engine 常用查询

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

## 11. 导出前端可读快照 JSON

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

## 12. 浏览器查看世界快照

```bash
npm run snapshot
npm run viewer
```

打开：

```text
http://localhost:8787/viewer/index.html
```

## 13. 运行 1000 tick 手动压测

```bash
npm run stress
```

## 14. 当前关键上限

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

## 15. 常见命令

```bash
npm test
npm run demo
npm run play
npm run shell
npm run shell:sample
npm run snapshot
npm run runtime
npm run api
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
npm run api
npm run viewer
npm run stress
```
