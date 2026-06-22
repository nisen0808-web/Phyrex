# World Engine Quickstart

## 1. 拉取并测试

```bash
git clone https://github.com/nisen0808-web/Phyrex.git
cd Phyrex
npm test
```

当前默认测试共 32 个：

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
account-session-api-test.js
api-permission-test.js
api-admin-audit-test.js
client-web-test.js
browser-gameplay-test.js
browser-onboarding-test.js
browser-character-control-test.js
runtime-loop-test.js
browser-admin-console-test.js
browser-save-manager-test.js
world-template-test.js
stability-100-test.js
```

## 2. 启动本地网页版

```bash
npm run api
```

浏览器打开：

```text
http://127.0.0.1:8790/client
```

Windows 也可以直接双击仓库根目录：

```text
start-local-web.bat
```

网页版当前支持：

```text
一键创建账号、Session、玩家和角色
角色生命、精力、资源和装备状态
地图出口与移动按钮
探索地点
查看并接取地点委托
查看任务并领取奖励
查看背包、装备、卸下和使用物品
查看商店并购买、出售物品
安排离线 work / train / gather / rest
离线任务进度和取消
保存和读取世界
存档名称、备注、列表、读取确认和自动存档状态
自动刷新
WebSocket 实时事件
创建和切换多个受控角色
观察者模式
持续世界运行、暂停、停止和单步推进
GM / 运维状态、连接、审计和错误面板
```

## 3. 浏览器客户端核心 API

```text
GET  /players/:playerId/dashboard
POST /players/:playerId/actions
GET  /players/:playerId/inventory
GET  /players/:playerId/quests
GET  /players/:playerId/journal
GET  /players/:playerId/map
GET  /players/:playerId/shop
GET  /players/:playerId/board
GET  /players/:playerId/encounters
GET  /players/:playerId/offline
```

统一玩法动作：

```text
command
move
explore
accept_board_quest
claim_quest
claim_all_quests
equip_item
unequip_item
use_item
buy_item
sell_item
cancel_offline
start_adventure
create_character
switch_character
observer_mode
```

示例：

```bash
curl -X POST http://127.0.0.1:8790/players/api_player/actions \
  -H 'Content-Type: application/json' \
  -d '{"type":"explore"}'
```

```bash
curl -X POST http://127.0.0.1:8790/players/api_player/actions \
  -H 'Content-Type: application/json' \
  -d '{"type":"buy_item","shopId":"shop_qingyun_city_general","itemDefinitionId":"healing_pill","quantity":1}'
```

## 4. API Server

启动：

```bash
npm run api
```

服务端能力：

```text
HTTP API
SSE /stream
WebSocket /ws/ticks
Account / Session
Bearer token
Player binding
player / gm / admin 权限
GM 世界控制
持续世界运行控制
API audit
Admin status / runtime / loop / connections / audit / errors
```

主要端点：

```text
GET  /health
GET  /world
GET  /snapshot
GET  /stream
WS   /ws/ticks
POST /accounts
GET  /accounts/:accountId
POST /accounts/:accountId/players
POST /sessions
GET  /session
POST /sessions/revoke
GET  /players/:playerId
POST /commands
POST /offline
GET  /offline/:playerId
POST /tick
POST /runtime/run
POST /save
POST /load
GET  /saves
GET  /admin/status
GET  /admin/runtime
GET  /admin/loop
POST /admin/loop/start
POST /admin/loop/pause
POST /admin/loop/stop
POST /admin/loop/config
POST /admin/loop/step
GET  /admin/connections
GET  /admin/audit
GET  /admin/errors
```

完整接口说明见：

```text
world-engine/API.md
```

## 5. 世界运行与持久化

```bash
npm run runtime
```

当前服务层：

```text
persistence-engine.js        save / load / autosave / list saves
offline-command-engine.js    离线命令队列和长时间动作
runtime-engine.js            tick batch、自动存档和 runtime snapshot
runtime-loop-engine.js       定时持续运行、暂停、停止、单步和自动存档
api-server-engine.js         HTTP、SSE、WebSocket 和客户端托管
browser-client-engine.js     浏览器 dashboard 和统一玩法动作
```

## 6. 命令行试玩

```bash
npm run play
npm run shell
npm run shell:sample
```

Shell 支持中英文命令，包括：

```text
地图 / map
委托 / board
接取 / accept
探索 / explore
日志 / journal
背包 / inventory
商店 / shop
购买 / buy
装备 / equip
使用 / use
出售 / sell
卸下 / unequip
任务 / quests
领取 / claim
```

## 7. Snapshot 和 Viewer

```bash
npm run snapshot
npm run viewer
```

浏览器打开：

```text
http://127.0.0.1:8787/viewer/index.html
```

## 8. 1000 tick 压测

```bash
npm run stress
```

## 9. 当前关键上限

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
API audit log <= 1000
API errors <= 200
```

## 10. 常见命令

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
```
