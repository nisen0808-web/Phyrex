# GM / 运维控制台

浏览器客户端中的 GM / 运维控制台用于观察世界服务状态、连接数量、API 请求和最近错误。

## 启动

```bash
npm run api
```

打开：

```text
http://127.0.0.1:8790/client
```

控制台会随浏览器客户端自动加载。默认本地开发模式 `requireAuth=false` 可直接读取数据；开启鉴权后，需要使用带 `gm` 或 `admin` 角色的 Session。

## 聚合接口

```text
GET /admin/status
GET /admin/connections
GET /admin/audit?limit=200
GET /admin/errors?limit=50
```

控制台显示：

```text
世界 tick、玩家和账号数量
活动 Session 数量
持续运行状态
SSE 与 WebSocket 连接数
API 请求和错误计数
按 HTTP 方法、状态码和路径筛选审计记录
最近错误请求
原始运维快照
```

## 自动刷新

勾选“自动刷新”后，控制台会按所选间隔刷新；页面不可见时不会主动请求。刷新间隔和筛选条件会保存在浏览器 `localStorage` 中。

## 权限

开启：

```js
createWorldApiServer(world, { requireAuth: true })
```

权限规则：

```text
player 无权访问 /admin/*
gm/admin 可以读取运维数据
gm/admin 可以控制持续世界运行
```

普通玩家访问时，面板会显示权限提示，不会隐藏或吞掉 HTTP 错误。

## 审计字段

审计表展示：

```text
tick
method
path
statusCode
durationMs
accountId
playerId
error
```

服务端审计日志默认最多保留 1000 条记录，错误列表默认最多保留 200 条记录。

## 相关文件

```text
world-engine/client/admin-console.js
world-engine/client/admin-console.css
world-engine/tests/browser-admin-console-test.js
world-engine/tests/client-web-test.js
```
