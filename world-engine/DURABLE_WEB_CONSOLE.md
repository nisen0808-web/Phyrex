# 持久世界网页控制台

启动 `npm run engine:serve -- --world-id engine-world` 后，在浏览器打开 `http://127.0.0.1:8791/`。Render 部署直接打开服务的 HTTPS 根地址。同一个进程提供静态页面和 durable API，不需要另建前端服务或配置 CORS。

填写已有世界 ID、玩家 ID 和访问令牌；默认填写的 `phyrex-trial / trial-player` 只适用于试运行世界，其他世界须改成自己的 ID。账户和角色仍按 ENGINE_QUICKSTART.md 与 DURABLE_ACCOUNT_ADMIN.md 在受信任环境中建立。公开页面没有注册、提权、手动推进世界、存档覆盖或文件读取接口。

## 已实现

- 登录后先显示入门引导：工作一次 → 查看真实结算 → 购买可负担且有库存的装备 → 装备并查看变化。没有可行动角色、体力不足、没有装备在售时给出相应下一步；引导不会自动提交行动。
- 行动卡展示当前世界规则中的收益和消耗；常见物品使用中文名称与公开属性说明。自定义物品名称保留。装备的 health/energy 加成明确表示上限增加，不承诺直接恢复生命或体力。
- 提交后引导停留在等待结果状态，已知未结算行动完成前禁用新行动；刷新只查询原指令，不新建指令。结果显示实际收益与常见拒绝原因，无需阅读原始 JSON。引导进度仅在当前连接内记录，重新进入仍可再次体验。
- 世界步数、存档版本、原始回执和管理员工具折叠展示；常见问题说明等待、重新登录、角色自主变化和页面功能边界。

- 查看已提交的 tick/revision、当前角色、生命/体力/成长、资源、地点、物品和当地商店。
- 提交等待、工作、休息、训练、购买一件、出售一件、装备/卸下、使用消耗品；收益与价格全部由引擎决定。
- 最新/更早指令分页、单条回执、手动更新结果。`pending/applied` 是入库状态，`accepted/completed/rejected` 是领域结果；页面分别显示，202 不表示执行成功。
- GM/Admin 查询世界概况、队列积压和审计；按状态码、路由、玩家筛选并用 sequence 游标向前分页。普通玩家仍由服务端返回 403。
- 页面不轮询、不发保活请求；不会阻止免费实例休眠。等待结算后点击更新回执。免费实例休眠期间世界不会持续推进。

## 凭据与重试边界

令牌只存在页面内存中，不进 URL、localStorage、sessionStorage、日志或交接截图。退出、刷新、页面离开或 401 均清除内存凭据，重新进入须重新填写。对本地 HTTP 只使用回环地址；公网使用 HTTPS。

每次新行动先生成随机编号，将 `{id,type,payload}` 保存到该标签页的 sessionStorage，再发送请求。**只有未确认指令保存在浏览器中，不包含令牌。** 储存按世界和玩家隔离，存储不可用时禁止发送。断线、超时、429、503 等未确认结果保留原请求，下一次点击“按原编号重试”使用完全相同的内容；收到匹配的服务端回执后才清除。刷新再连接也会恢复待确认编号。关闭标签页或清理浏览器数据会丢失此恢复信息，执行情况需查服务器指令历史；不要凭猜测再次购买。

退出会中断请求并隔离旧响应，但不能撤回已入队的命令。没有自动新编号重试，也没有将提交失败误当作“从未执行”。若罕见编号冲突长期无法确认，保留编号，由管理员核查回执后处理；页面不提供强行清空待确认请求的按钮。

静态文件只有五个精确允许路径：`/`、`/console/style.css`、`/console/app.mjs`、`/console/session.mjs`、`/console/guide.mjs`。不把请求路径拼成文件路径，不暴露旧演示文件、账户秘密、包文件或磁盘目录。页面使用 CSP（无内联脚本、无第三方源）、禁止被框架嵌入、no-store、nosniff、no-referrer。所有世界文本用 textContent 渲染。静态请求经过来源限流，但与健康探针一样不写 SQL 业务审计。

脚本加载失败时，连接按钮保持禁用；令牌输入框没有原生表单字段名，登录表单明确使用 POST，CSP `form-action 'none'` 禁止所有原生表单导航。即使 JavaScript 未安装事件监听器，也不会把令牌回退到 URL 查询参数。

`engine:serve` 默认开启控制台；直接构建 durable API 默认关闭，需明确 `webConsole: true`；嵌入式宿主可用 `createEngineService({ ..., api: { webConsole: false } })` 关闭。没有更改 SQL Migration 1–4、runtime v5、revision fence、提交后发布或冻结批次重试规则。

## 验证

```sh
npm test
node world-engine/tests/durable-console-test.js
node world-engine/tests/durable-console-session-test.js
node world-engine/tests/durable-console-guide-test.js
node world-engine/tests/helpers/console-fixture.js
# 可选：在内存中接受首条 POST 后丢弃 HTTP 响应，验证浏览器恢复
node world-engine/tests/helpers/console-fixture.js --lose-first-response
```

最后两个命令输出随机回环地址；世界 `console-test`，玩家 `one`，测试令牌 `console-player-fixture` 或 `console-admin-fixture`。这是无数据库的隔离内存样例，只供本机验收；不是部署命令。按 Ctrl+C 结束。

三个控制台回归脚本覆盖静态文件隔离、CSP/限流、玩家越权、购买/回执/重复提交、分页、提交确认丢失、刷新恢复、旧会话响应隔离、401、429、超时、存储故障、并发提交、新手下一步决策及商品属性脱敏。完整 discovery 为 129 项。真实 PostgreSQL 原有专项仍在 Node 20/22 CI 运行，必须核对日志完成标记和实际分母，保留 bash/pipefail，不能用静态网页或仅健康 200 代替功能验收。

## 当前边界

当前界面只操作已有角色，不提供自助账户、角色创建/切换、地图移动、赠送、战斗、世界规则编辑或运行中账户管理。相应已存在的底层 API 能力不等于网页已接入。管理界面只读。背包最多展示 128 个实例、8 个商店、每店 64 种商品，并显示实际总数；超限导入内容不会被页面删除。真实游戏内容、职业数值和平衡不在本控制台交付范围内。
