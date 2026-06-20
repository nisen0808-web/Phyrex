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
保存和读取世界
自动刷新
WebSocket 实时事件
```

## Dashboard

```text
GET /players/:playerId/dashboard
```

一次返回：

```text
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

## 权限

开启 `requireAuth=true` 后：

```text
player 只能访问自己的 dashboard 和 actions
gm/admin 可以访问任意玩家
gm/admin 才能推进 tick、保存和读档
```
