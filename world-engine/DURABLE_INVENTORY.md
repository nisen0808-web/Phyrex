# 持久物品、装备与商店

runtime **v5** / `postgres-inventory-v4` 补齐已有物品系统的持久命令。所有物品动作走现有认证、队列、执行时校验、动作预算及 checkpoint 同事务确认。Migration 1–4 原样保留。

## 命令与结果

继续使用 `POST /durable/worlds/:worldId/players/:playerId/commands`。示例请求：

```json
{"id":"purchase-1","type":"buy_item","payload":{"shopId":"shop_village_general","definitionId":"wooden_sword","quantity":1}}
```

| type | payload | 行为 |
|---|---|---|
| buy_item | shopId, definitionId, quantity（默认 1） | 当地商店扣库存、收款，角色得到物品 |
| sell_item | shopId, itemId, quantity（默认 1） | 当地商店实际付款并补回库存；余额不足拒绝 |
| equip_item | itemId | 装备到该物品定义的槽位，替换旧装备 |
| unequip_item | slot | weapon / armor / accessory / tool；空槽位拒绝 |
| use_item | itemId | 使用一个消耗品，结果给出实际恢复量 |
| give_item | itemId, targetId | 将完整物品实例/整叠数量赠送给同地存活角色 |

只能使用当前角色拥有的物品，owner 字段和 byOwner 索引同时核对；观察模式不能操作。装备中的物品必须先卸下才可出售、赠送或删除。客户端不能覆盖价格、属性、效果、槽位、所有者或成本。数量须为 1–100 的整数；非堆叠物品一次只能购买 1 件。出售不足数量整体拒绝，不隐式减少数量。

购买价来自商店库存。出售单价为 `max(1, floor(商店单价 / 2))`，新库存种类使用物品定义价作为基准。价格须为 1–1,000,000 的整数；货币变动守恒，商店余额不会凭空增加。交易不自动刷新库存或印钞；补货属于宿主世界的经济规则。

这些动作不额外扣体力，但与工作/训练/战斗共用一 tick 一次成功规则动作的预算。多个同角色请求排在一个批次里时，后续动作可能返回 character_busy；应在下一 tick 用新 ID 发送新的意图。重试旧命令 ID 只读取原结果。

## 装备与消费一致性

重复装备同一实例不重复加属性；替换时先撤销旧装备记录的加成，再加新装备。新装备保存 `equipmentApplied`，卸下按记录撤销，训练产生的永久成长保留。装备的 health/energy 加成映射到 maxHealth/maxEnergy，穿脱不能恢复当前生命或体力；卸下后当前值被上限约束。

装备只支持 power、defense、speed、intelligence、social、maxHealth、maxEnergy 及 health/energy 容量别名。消耗品只恢复 health/energy，按最大值截断；完全无效果返回 no_item_effect，不扣物品。死亡或零生命角色不能靠道具复活。装备账目与角色状态不一致时拒绝操作，保留原状态供宿主诊断，不凭空修正成长值。

历史存档中缺少 equipmentApplied 的已装备物品，第一次卸下按旧 stats 语义撤销一次。旧版本若已经发生重复叠加，无法从存档推断原始基础属性，升级不会猜测并回写；已知受影响存档需由宿主根据历史数据处理。

## 容量、安全视图与初始化

公共购买/赠送最多 128 个实例/角色；购买新实例时全世界最多 1000 个实例；现有堆叠数量最多 1,000,000；商店最多接收 64 种库存。受信任构建 API 可导入超过公共限额的历史数据，公共操作不会为了达到上限而删掉旧物品。

玩家 `state` 响应新增 inventory：当前角色物品、装备槽位和当前地点商店。读取不初始化商品、不创建商店、不改世界 revision。输出最多 128 件物品、8 个商店、每店 64 种库存，并包含实际 itemCount/shopCount/stockCount；旧导入内容超限时可识别截断。它不输出任意 meta、隐藏效果、其他角色背包或商店内部余额。

`engine:init` 可显式加载现有示例商品包：

```sh
npm --prefix world-engine run engine:init -- --output output/bootstrap.json --world-id engine-world --commerce starter
```

默认 `--commerce none` 保持主题无关的旧初始化语义。starter 在 village 建立示例商店；物品名称沿用旧演示，不是核心规则要求。宿主也可用 SDK 的 defineItem/createShop 配置自己的目录。商店只在构建时显式创建，读取状态不会生成新资产。

## 升级与验收

旧 runtime v1–v4 世界先停止旧写入器并完整备份，在原 simulation 与规则配置下显式运行一次 `--upgrade-command-profile`，再正常启服。已知旧 hash 才可升级；改动已有规则或未知 hash 依然拒绝。升级来源保存在 checkpoint，旧 applied 命令不重放。升级改变运行规则，不是 SQL migration。

新增三个物品回归与一个引擎交付契约回归；完整 discovery 为 125 项。真实 PostgreSQL `test:postgres:inventory` 含 12 组：HTTP 价格约束、装备重启、装备与成长、实际恢复量、商店预算、赠送归属、容量、安全读取、事务回滚、丢确认、最后一件库存竞争及两个新进程的 v4→v5 升级。Node 20/22 均执行；最终验收以对应交付代码的原始日志为准。
