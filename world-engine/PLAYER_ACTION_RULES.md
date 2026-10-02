# 玩家行动规则与成长结算

持久运行器版本为 **4**，命令 profile 为 `postgres-player-rules-v3`，行动规则版本为 **1**。公共玩家命令提交意图，收益、消耗、成长和伤害由引擎计算。输入与角色生命周期契约继续见 PLAYER_COMMAND_CONTRACT.md。本次不更改 Migration 1–4。

## 默认规则

| 行动 | 结果与消耗 |
|---|---|
| work | 默认获得 10 currency，消耗 6 体力；只能产出规则指定的资源 |
| gather | 默认采集最多 3 单位，消耗 4 体力；必须存在于当前地点库存，按实际库存扣减 |
| train | 默认获得 2 累计经验，消耗 8 体力；每累计 10 经验增长 1 power，默认 power 上限 1000 |
| rest | 最多恢复 12 生命与 20 体力，受角色最大值约束；结果报告实际恢复量 |
| damage | 默认伤害为 max(1, floor(power − defense))，消耗 8 体力；攻击力须大于 0，目标须同地存活 |
| move | 只能到相邻地点，消耗 2 体力 |
| transfer | 精确转移持有资源，消耗 1 体力；余额不足整体拒绝，不做部分转账 |
| interact | social 强度默认 3，消耗 2 体力 |

work/gather/train/damage/interact 可以声明小于等于规则上限的正 amount；这不降低体力消耗。train.amount 必须为整数。transfer.amount 上限为 1,000,000。0 数量拒绝，不能用 0 触发默认收益。priority、energyCost、rest.health/rest.energy 若显式传入，必须等于服务端规则；train.power 不接受玩家指定。规则参数本身经严格整数、字段与范围校验。

非致命攻击保留至少 1 生命；致命结果进入既有死亡、玩家继任和记忆处理。0 生命但尚未更新 status 的异常角色不能通过休息复活。训练直接改变累计经验和 power，不再制造 training 资源或为每次训练建立新目标。

## 行动预算与自主行为

每个角色同时只能有一个待执行的规则动作；同一 tick 至多成功结算一次。第二条待入队动作返回 `character_busy`，客户端应在后续 tick 用新命令 ID 提交下一次意图。不能用重试旧 ID 当作新行动。执行失败不消耗资源、体力或成功行动预算。

入队和执行时都检查当前角色、目标、地点、库存和体力；排队之后的世界变化可能使动作被拒绝。成功结果、角色状态和命令确认在同一个 checkpoint 提交，SQL 提交后才发布。提交确认丢失只重试冻结批次，不重新训练、采集或扣体力。

玩家拥有的角色仍参与世界自主目标规划，也使用同一规则与 tick 预算。有待执行玩家动作时不再追加自主动作；体力不足时可选择休息。健康且食物充足时允许其他目标参与选择，gain_power 转换为真实训练。已有 applied 回执不变，但之后 tick 的自主行为仍可能继续成长。NPC、受信任的本地构建 API 和被动世界系统保留原规则；行动预算不限制被动收入、生态变化或其他角色对它的作用。

## 配置、读取与恢复

世界配置为 `world.playerActionRules`，角色持久字段为 `playerActionState: {version, lastTick, experience}`。未配置的世界使用默认规则；服务端状态 API 返回规范化 `actionRules` 和当前角色的安全 `actionState`。字段不包含账户秘密或任意 meta。

新建世界时可提供不超过 16 KiB 的 UTF-8 JSON 配置文件，省略项使用默认值。例如文件内容 `{"workYield":7,"workEnergy":3,"experiencePerPower":8}`：

```sh
npm --prefix world-engine run engine:init -- --output output/bootstrap.json --world-id engine-world --player-rules player-rules.json
```

参数路径相对于 world-engine。无效规则不生成世界文件。配置与 simulation 参数一起进入 runtime config hash；已开始运行的世界不能随意改规则，修改后即使添加升级标志也返回 `WORLD_RUNTIME_CONFIG_MISMATCH`。本层未提供运行中规则迁移工具。

旧 runtime v1/v2/v3 世界先停止写入、完整备份，然后在原 simulation 配置下显式升级：

```sh
npm --prefix world-engine run runtime:postgres -- --world-id engine-world --batches 1 --upgrade-command-profile
npm run engine:serve -- --world-id engine-world
```

仅已知旧配置 hash 可以升级。首个成功 checkpoint 保存 v4 配置和 upgradedFrom；旧 pending 命令按新规则执行，曾经允许的零消耗或超额收益请求会被拒绝。旧 applied 回执不重放。升级标志不覆盖未知 hash、simulation 差异或 v4 规则冲突。升级后不要让旧运行器写入该世界。

## 验收与边界

三个新增 discovery 脚本覆盖规则权威性、同 tick 预算、库存守恒、体力、训练阈值、伤害、恢复、配置 hash 与 CLI。`npm --prefix world-engine run test:postgres:player-actions` 增加 10 组真实 PostgreSQL 场景：服务端收益、体力恢复、采集、转移、训练重启、战斗死亡、HTTP 规则读取、提交确认丢失、SQL 回滚和两个新进程的 v3 升级恢复。

SQL 专项必须使用独立 `_ci`/`_test` 数据库，缺失即失败。Node 20/22 各执行完整专项，保留 bash/pipefail 与实际完成标记；全回归分母为 121，最终通过证据以交付提交对应的 verification.json 和原始 CI 日志为准。

这是确定性的引擎规则与可配置数值基线；未包含技能树、职业数值平衡、装备系统或多角色组队战斗协议，也不把这些未实现内容列作已完成。
