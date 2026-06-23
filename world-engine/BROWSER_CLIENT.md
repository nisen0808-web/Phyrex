# Browser Client

启动：

```bash
npm run api
```

打开：

```text
http://127.0.0.1:8790/client
```

Windows 可以双击：

```text
start-local-web.bat
```

## 可玩功能

```text
一键创建本地账号、Session、玩家和角色
角色生命、精力、属性和资源
地图出口与移动
探索地点
接取地点委托
查看任务与领取奖励
背包装备、卸下、使用和出售
商店购买
离线任务与进度
行动队列、重复执行、暂停和失败重试
保存和读取世界
存档列表、名称、备注和读取确认
持续运行自动存档状态
自动刷新
WebSocket 实时事件
多角色创建与切换
观察者模式
持续世界运行控制
GM / 运维控制台
```

## Dashboard

```text
GET /players/:playerId/dashboard
```

一次返回：

```text
account
player
map
quests
inventory
shop
board
journal
encounters
offline
```

## 玩法动作

```text
POST /players/:playerId/actions
```

支持：

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
  -d '{"type":"move","locationId":"mist_forest"}'
```

```bash
curl -X POST http://127.0.0.1:8790/players/api_player/actions \
  -H 'Content-Type: application/json' \
  -d '{"type":"buy_item","shopId":"shop_qingyun_city_general","itemDefinitionId":"healing_pill","quantity":1}'
```

每次动作默认返回刷新后的 dashboard。

## 行动队列 / 回合计划器

浏览器可以把以下动作加入本地队列：

```text
work
train
gather
rest
explore
move
```

队列能力：

```text
按顺序串行执行
每项重复 1 到 99 次
预设工作、修炼、采集、休息和探索
步骤间隔 0 / 250 ms / 1 秒 / 3 秒
当前动作完成后暂停
选择出错即停或继续后续动作
失败项重试
上移、下移和移除
清除已完成或全部重来
localStorage 持久化
页面重载后将中断的 running 项恢复为 pending
```

队列调用现有 `POST /players/:playerId/actions`。`command` 和 `move` 仍沿用页面顶部“动作后推进”选项，因此不会引入独立的 tick 规则。

## 持续世界运行

浏览器中的“持续世界运行”面板使用：

```text
GET  /admin/loop
POST /admin/loop/start
POST /admin/loop/pause
POST /admin/loop/stop
POST /admin/loop/config
POST /admin/loop/step
```

可配置循环间隔、每轮 tick 数、自动存档间隔和存档路径。

## 本地存档管理

浏览器中的“本地存档管理”面板使用：

```text
POST /save
POST /load
GET  /saves?dir=<directory>
GET  /admin/loop
```

面板支持：

```text
保存路径和存档目录
显示名称和备注
生成带时间戳的新路径
存档元数据列表
文件大小、世界 ID、tick 和保存原因
读取前确认
选择已有存档作为快速保存路径
显示持续运行自动存档间隔、路径和最近状态
可选自动刷新
```

存档列表会返回 `metadata`、`label` 和 `reason`，旧存档没有元数据时仍可正常列出。

## GM / 运维控制台

浏览器会聚合：

```text
GET /admin/status
GET /admin/connections
GET /admin/audit?limit=200
GET /admin/errors?limit=50
```

面板提供：

```text
世界 tick、玩家、账号和 Session 指标
持续运行状态
SSE / WebSocket 连接数
API 请求与错误计数
按 HTTP 方法、状态码和路径筛选审计记录
最近错误列表
可选自动刷新
```

## 权限

开启 `requireAuth=true` 后：

```text
player 只能访问自己的 dashboard 和 actions
gm/admin 可以访问任意玩家
gm/admin 才能推进 tick、保存、列出存档和读档
gm/admin 才能控制持续世界运行
gm/admin 才能打开运维控制台数据
```
