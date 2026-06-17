# World Engine API

启动本地网页版：

```bash
npm run api
```

然后打开：

```text
http://127.0.0.1:8790/client
```

Windows 可以直接双击仓库根目录的：

```text
start-local-web.bat
```

指定端口：

```bash
node world-engine/demo/api-server.js --host 127.0.0.1 --port 8790
```

核心接口：

```text
GET  /client
GET  /client/app.js
GET  /client/style.css
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
GET  /players/:playerId/inventory
GET  /players/:playerId/quests
GET  /players/:playerId/journal
GET  /players/:playerId/map
GET  /players/:playerId/shop
GET  /players/:playerId/board
GET  /players/:playerId/encounters
GET  /players/:playerId/offline
POST /players
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
GET  /admin/connections
GET  /admin/audit
GET  /admin/errors
```

## 本地网页版能力

`/client` 是纯 HTML/CSS/JS，不依赖 React，不需要安装前端依赖。

当前支持：

```text
创建账号
创建 Session
创建玩家和角色
查看世界状态
查看角色状态卡
查看地图 / 当前地点
查看任务
查看背包 / 装备
查看商店
查看日志时间线
提交 work / train / gather / rest / move 命令
安排离线 work / train / gather / rest
推进 tick
查看离线任务
连接 WebSocket /ws/ticks
查看原始 API 响应
```

## 玩家详情接口

这些接口是给浏览器客户端使用的轻量查询接口。

```bash
curl http://127.0.0.1:8790/players/api_player/inventory
curl http://127.0.0.1:8790/players/api_player/quests
curl http://127.0.0.1:8790/players/api_player/journal?limit=20
curl http://127.0.0.1:8790/players/api_player/map
curl http://127.0.0.1:8790/players/api_player/shop
curl http://127.0.0.1:8790/players/api_player/board
curl http://127.0.0.1:8790/players/api_player/encounters
curl http://127.0.0.1:8790/players/api_player/offline
```

开启 `requireAuth=true` 后，这些接口同样会检查玩家归属。普通 player 只能查看自己的 `playerId`，GM/admin 可以查看任意玩家。

## 事件流

`GET /stream` 是 Server-Sent Events，用于简单浏览器订阅。

`WS /ws/ticks` 是 WebSocket tick stream，用于 PC、手机端、桌面端持续接收世界事件。

当前广播事件：

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
account.created
account.player.created
session.created
```

## 账号与 Session

创建账号：

```bash
curl -X POST http://127.0.0.1:8790/accounts \
  -H 'Content-Type: application/json' \
  -d '{"id":"api_account","name":"API Account","roles":["player"]}'
```

创建 GM 账号：

```bash
curl -X POST http://127.0.0.1:8790/accounts \
  -H 'Content-Type: application/json' \
  -d '{"id":"gm_account","name":"GM Account","roles":["gm"]}'
```

创建 session：

```bash
curl -X POST http://127.0.0.1:8790/sessions \
  -H 'Content-Type: application/json' \
  -d '{"accountId":"api_account","options":{"sessionTtlTicks":1000}}'
```

验证 session：

```bash
curl http://127.0.0.1:8790/session \
  -H 'Authorization: Bearer <TOKEN>'
```

撤销 session：

```bash
curl -X POST http://127.0.0.1:8790/sessions/revoke \
  -H 'Content-Type: application/json' \
  -d '{"token":"<TOKEN>","reason":"manual"}'
```

在账号下创建玩家和角色：

```bash
curl -X POST http://127.0.0.1:8790/accounts/api_account/players \
  -H 'Authorization: Bearer <TOKEN>' \
  -H 'Content-Type: application/json' \
  -d '{"player":{"id":"api_player","name":"API Player"},"character":{"id":"api_hero","name":"API Hero","species":"human","locationId":"qingyun_city","resources":{"currency":100,"food":10}}}'
```

查看账号：

```bash
curl http://127.0.0.1:8790/accounts/api_account \
  -H 'Authorization: Bearer <TOKEN>'
```

## 权限模式

默认 `requireAuth=false`，方便本地开发和测试。

正式客户端可以用：

```js
createWorldApiServer(world, { requireAuth: true })
```

开启后：

```text
player 只能访问和操作自己绑定的 playerId
gm/admin 可以访问任意 player
gm/admin 才能 tick / runtime/run / save / load / saves
gm/admin 才能访问 /admin/*
```

## 管理接口

管理接口需要 GM/admin：

```bash
curl http://127.0.0.1:8790/admin/status \
  -H 'Authorization: Bearer <GM_TOKEN>'
```

```bash
curl http://127.0.0.1:8790/admin/audit?limit=100 \
  -H 'Authorization: Bearer <GM_TOKEN>'
```

```bash
curl http://127.0.0.1:8790/admin/errors?limit=50 \
  -H 'Authorization: Bearer <GM_TOKEN>'
```

```bash
curl http://127.0.0.1:8790/admin/connections \
  -H 'Authorization: Bearer <GM_TOKEN>'
```

## 玩家与世界命令

提交命令示例：

```bash
curl -X POST http://127.0.0.1:8790/commands \
  -H 'Content-Type: application/json' \
  -d '{"playerId":"api_player","command":{"type":"work","resource":"currency","amount":10}}'
```

安排离线命令示例：

```bash
curl -X POST http://127.0.0.1:8790/offline \
  -H 'Content-Type: application/json' \
  -d '{"playerId":"api_player","command":{"type":"train","amount":1,"durationTicks":2,"runsEveryTicks":1,"repeat":2}}'
```

推进世界：

```bash
curl -X POST http://127.0.0.1:8790/tick \
  -H 'Content-Type: application/json' \
  -d '{"ticks":3}'
```

保存世界：

```bash
curl -X POST http://127.0.0.1:8790/save \
  -H 'Content-Type: application/json' \
  -d '{"filePath":"world-engine/output/api-world-save.json","options":{"createBackup":false}}'
```

读档恢复：

```bash
curl -X POST http://127.0.0.1:8790/load \
  -H 'Content-Type: application/json' \
  -d '{"filePath":"world-engine/output/api-world-save.json"}'
```
