# World Engine Quickstart

## 1. 拉取并测试

```bash
git clone https://github.com/nisen0808-web/Phyrex.git
cd Phyrex
npm test
```

当前默认测试共 49 个：

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
browser-action-queue-test.js
browser-command-palette-test.js
world-template-api-test.js
browser-world-insights-test.js
browser-workspace-layout-test.js
password-credential-engine-test.js
session-token-hash-test.js
request-throttle-test.js
deterministic-random-engine-test.js
system-scheduler-engine-test.js
system-contract-engine-test.js
modular-simulation-pipeline-test.js
simulation-pipeline-contracts-test.js
source-purity-engine-test.js
natural-world-basic-test.js
natural-world-pipeline-test.js
replay-determinism-test.js
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
行动队列、重复执行、暂停和失败重试
命令面板、中英文搜索、收藏、最近记录和单键快捷操作
世界模板、重置前备份、循环安全和玩家重建
世界人口、排行榜、活动和运行诊断洞察
面板搜索、跳转、固定、折叠和紧凑工作区
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
世界模板列表和安全重置
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
GET  /admin/templates
POST /admin/templates/reset
GET  /admin/connections
GET  /admin/audit
GET  /admin/errors
```

完整接口说明见：

```text
world-engine/API.md
```

## 5. 确定性模拟内核

推荐的新引擎入口：

```js
const {
  createDeterministicSimulationKernel,
  initializeDeterministicSimulation,
  runDeterministicSimulationTicks,
} = require('./world-engine/core/deterministic-simulation-engine');

const kernel = createDeterministicSimulationKernel();
initializeDeterministicSimulation(world, options);
runDeterministicSimulationTicks(world, 10, options, kernel);
```

当前内核能力：

```text
命名随机流
世界级确定性 ID
28 个基础模拟子系统
natural.world 自然世界系统
人口、社会、经济、智能体、知识、文明和自然阶段
阶段和依赖调度
周期系统
原子失败回滚
系统写冲突诊断
系统输入、输出与后置条件 Contract 校验
源码确定性纯度审计
规范化状态哈希
确定性重放和分歧定位
旧存档自动补齐内核状态
旧单体管线兼容模式
```

详细说明：

```text
world-engine/DETERMINISTIC_KERNEL.md
world-engine/SIMULATION_PIPELINE.md
world-engine/SYSTEM_CONTRACTS.md
world-engine/DETERMINISTIC_PURITY.md
world-engine/NATURAL_WORLD.md
```

## 6. 世界运行与持久化

```bash
npm run runtime
```

当前服务层：

```text
random-engine.js             命名随机流和确定性兼容作用域
world-id-engine.js           世界级单调 ID 序列
system-scheduler-engine.js   系统阶段、依赖、周期与失败策略
system-contract-engine.js    输入、输出和执行后状态校验
source-purity-engine.js      源码随机数与系统时间审计
natural-world-engine.js      历法、季节、气候、天气、资源再生和灾害
natural-world-system-engine.js 默认确定性管线 natural.world 系统
simulation-pipeline-engine.js 28 个模块化模拟子系统
simulation-system-contracts-engine.js 内置模拟系统 Contract 集合
state-integrity-engine.js    规范序列化、SHA-256 与状态差异
replay-engine.js             记录、重放和确定性验证
deterministic-simulation-engine.js 模块化默认和旧单体兼容入口
persistence-engine.js        save / load / autosave / list saves
offline-command-engine.js    离线命令队列和确定性世界推进
runtime-engine.js            tick batch、自动存档和 runtime snapshot
runtime-loop-engine.js       定时持续运行、暂停、停止、单步和自动存档
api-server-engine.js         HTTP、SSE、WebSocket 和客户端托管
world-template-api-engine.js 世界模板权限、备份、重置和循环同步
browser-client-engine.js     浏览器 dashboard 和统一玩法动作
```

## 7. 命令行试玩

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

## 8. Snapshot 和 Viewer

```bash
npm run snapshot
npm run viewer
```

浏览器打开：

```text
http://127.0.0.1:8787/viewer/index.html
```

浏览器客户端中的“世界洞察”也直接使用 `/snapshot`，可查看人口分布、排行榜、最近活动和诊断，并可复制摘要或导出 JSON。

## 9. 1000 tick 压测

```bash
npm run stress
```

## 10. 当前关键上限

```text
world.memory <= 1000
simulation.reports <= 200
kernel.history <= 100
kernel.contracts.recentViolations <= 100
natural.weather.history <= 120
natural.disasters.history <= 100
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

## 11. 常见命令

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
