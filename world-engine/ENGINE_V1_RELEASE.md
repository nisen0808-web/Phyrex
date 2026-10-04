# 单写世界引擎 v1 交付范围与统一验收

软件包版本 **1.0.1**（private，未发布 npm），持久运行器版本 **5**，SQL Migration **1–4**。这三个版本标识用途不同。v1 已通过 PR #73 合并至 main（c20f856）；本次审查修复、规模基线变化和兼容性见 [1.0.1 发布说明](RELEASE_1_0_1.md)，隔离测试和上线准备见 [运行手册](ISOLATED_VALIDATION_RUNBOOK.md)。本次修订的最终提交与合并状态随交付证据记录。

## 完成边界

v1 提供可独立演化、可持久运行、可接入玩家意图、可备份恢复的单写世界引擎。下表每一项都有实现和可执行验收；完整交付要求普通回归、真实数据库、耐久及六组规模作业全部通过。本文是范围清单，不能替代对应提交的日志与 verification.json。

| 能力 | 实现入口 / 验收 |
|---|---|
| 确定性世界、随机流、ID、调度与系统契约 | deterministic-simulation、system-scheduler、system-contract；源码纯度、恢复、100/1000 tick |
| 人口、出生死亡、家族与遗产 | population、family、legacy；人口/继承回归与多代际规模测试 |
| 组织、身份、契约、治理与冲突 | organization、identity、contract、governance、process；组织/治理/过程回归 |
| 经济、城市、贸易、自然与生态 | economy、city、trade-flow、natural-world、ecology；守恒、压力联动与长期演化 |
| 信息、记忆、文化、宗教和文明 | information、memory、info-flow、culture、religion、civilization；传播/文明回归 |
| 历史、叙事与小说蓝图 | history、narrative-score、novel；从历史生成内容，不反向伪造世界事件 |
| 玩家控制、归属、死亡继任与行动成长 | player-command-contract、player-action-rules；角色与真实 SQL 领域专项 |
| 物品、装备、消费、交易与状态读取 | inventory-operations；装备/守恒/容量回归和 12 组真实 SQL 专项 |
| 持久服务、认证、命令、限流与审计 | engine:serve、durable runtime/API、account admin；事务、撤权、队列、HTTP、Worker 故障专项 |
| 历史保留、备份、恢复与离线交付 | maintenance、backup、retention；全 schema 原子恢复、幂等 receipts、Git bundle 与文件哈希 |

这些基础引擎均已存在，README 原“后续路线”的信息、记忆、身份、文化、宗教、贸易和文明不能再误列为从零待开发。主题设定、完整职业技能树、组队玩法、游戏平衡和图形界面属于上层产品；本引擎不以这些内容作为世界运行的前提。

## 本地编程入口

从仓库根目录使用 `require('./world-engine')`。构建 API 供受信任的宿主代码使用；玩家输入使用 submitPlayerIntent，自动启用公共命令契约。持久服务接收 HTTP 命令，不能把本地内存结果当作 SQL 已提交结果。

```js
const engine = require('./world-engine');
const world = engine.createSampleWorld({ population: 2, commerce: 'starter' });
engine.createPlayerCharacter(world, 'observer', { locationId: 'village' });
const { command } = engine.submitPlayerIntent(world, 'observer', {
  id: 'purchase-1', type: 'buy_item',
  payload: { shopId: 'shop_village_general', definitionId: 'wooden_sword' },
});
engine.advanceDeterministicBatch(world, 1);
const result = engine.getPlayerCommandResult(world, 'observer', command.id);
```

按 command ID 重新读取结果，不能持有旧对象引用假定它随规范化后的世界自动变化。返回结果为副本，旧命令日志仍受已有保留预算限制；跨重启的长期回执应从 PostgreSQL inbox 查询。SDK 同时导出 createWorld/registerLocation/registerEntity/connectLocations、角色构建、规则配置、物品/商店定义、持久 store/runtime/API 与安全状态投影；完整协议见源码 index.js。底层模块保留，不把所有内部接口承诺为稳定公共接口。

## 统一验收入口

```sh
npm ci --prefix world-engine --ignore-scripts
npm --prefix world-engine run engine:verify -- --suite regression
npm --prefix world-engine run engine:verify -- --suite all --list
# Linux + Node 20 或 22；预先设置独立的 WORLD_ENGINE_TEST_DATABASE_URL
npm --prefix world-engine run engine:verify -- --suite all --report output/verification-new.json
```

suite 支持 regression、postgres、endurance、scale、stress、all；默认只跑普通回归。all 按顺序执行 22 个门禁，包括全部 16 个 SQL 专项。首次失败立即停止，退出码非零；即使子进程退出 0，也必须找到实际完成输出，不接受打印出的命令文本冒充完成。报告只能写入新文件，不覆盖旧验收。SQL 缺失/非隔离数据库名直接失败，不跳过。完整服务信号测试需 Linux，Windows 可运行普通回归与其他单项入口。

仓库的五个 CI workflow 继续保留：root/nested、Node 20/22、PostgreSQL 18、1000 tick 耐久、三种人口规模 x 两种 Node。统一入口不替代或减少这些既有门禁。日志管道继续使用 bash/pipefail；历史假绿记录见 CI_VALIDATION_STATUS.md。

## 操作约束

一个世界只运行一个写入器，冲突由 revision fence 拒绝；通过最新已提交状态授权。重试不重放，SQL 确认后发布。默认 checkpoint 上限 32 MiB，历史保留不等于无限活跃人口，数据库 receipts/inbox/events 总量仍需运维管理。HTTP audit 为独立事务，正常停机等待审计，突然断电仍有丢失窗口。

生产托管、多实例领导者选举、分布式网关限流、账户注册与密码找回属于部署/产品层。测试容器通过不表示已部署生产。运行、升级和恢复见 ENGINE_QUICKSTART.md、DURABLE_INVENTORY.md 与 MIGRATION_HANDOFF.md（交付包）。
