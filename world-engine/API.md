# World Engine API

启动服务：

```bash
npm run api
```

指定端口：

```bash
node world-engine/demo/api-server.js --host 127.0.0.1 --port 8790
```

核心接口：

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
  -H 'Content-Type: application/json' \
  -d '{"player":{"id":"api_player","name":"API Player"},"character":{"id":"api_hero","name":"API Hero","species":"human","locationId":"qingyun_city","resources":{"currency":100,"food":10}}}'
```

查看账号：

```bash
curl http://127.0.0.1:8790/accounts/api_account
```

## 玩家与世界命令

创建玩家示例：

```bash
curl -X POST http://127.0.0.1:8790/players \
  -H 'Content-Type: application/json' \
  -d '{"player":{"id":"api_player","name":"API Player"},"character":{"id":"api_hero","name":"API Hero","species":"human","locationId":"qingyun_city","resources":{"currency":100,"food":10}}}'
```

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
