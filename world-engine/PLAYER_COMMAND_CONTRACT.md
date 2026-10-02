# 玩家命令、角色生命周期与执行结果

持久运行器版本为 3，命令规则标识 `postgres-player-contract-v2`。本层补齐入库之后的领域边界：HTTP 202 表示命令已入队；语义校验在执行时针对当前世界进行，失败仍在同一 checkpoint 中确认，不能让一条坏命令反复堵住后面的命令。

## 输入与容量

数值必须是有限 JSON number，不接受字符串、布尔、数组或 null 的隐式转换。0 保留其含义，不再被默认值替代。禁止原型字典键，检查目标的实体类型、归属、存活与地点。未知命令、无效字段及参数返回稳定 reason，不把异常消息当成玩家结果。实现缺陷或数据库错误继续使候选批次回滚，不能伪装成已成功提交的玩家拒绝。

持久玩家命令使用按类型的 payload 白名单。常见上限如下；这是 v2 规则的一部分，修改需升级规则版本，而非在运行中随意改配置。

| 参数 | 范围 |
|---|---|
| wait.ticks | 整数 1–1000；表示等待意图，不单独快进世界 |
| priority | 0–100 |
| gather/work/train/interact/damage.amount | 0–100 |
| transfer.amount | 0–1,000,000，实际转移不超过持有量 |
| energyCost、rest.health、rest.energy | 0–100 |
| power、目标 amount/power | 0–1,000,000 |
| 每玩家累计角色 | 100，死亡角色仍占历史名额 |
| 每角色活跃目标、待执行动作 | 各 100；NPC 逻辑仍受既有世界容量策略约束 |

数值上限是输入与容量约束，不代表战斗、职业收益和文明存续已完成游戏平衡。资源名称保持主题独立，允许安全的扩展资源键。受信任的本地世界构建 API 可配置角色属性；持久 HTTP 玩家命令不能传入这些内部属性。旧演示 API 仍是本地开发工具，不能作为公网账户入口。

## 角色与行动

`create_character` 仅允许 name、species、locationId、sex、active；ID、stats、resources、traits、demographics、meta 由引擎构建，不接受玩家覆盖。创建前检查 ID、地点、种族和属性；失败不能留下半个角色、改写别人或改变归属。角色 roster、反向索引和实体 owner 必须一致。已有归属不能被另一个玩家的 bind/switch 夺取。

观察模式只能观察、创建和切换角色等控制操作，不能操纵旧 activeEntity。创建非激活角色保留当前观察模式和主角色；死亡后只在真正属于自己的存活角色中选择继任者。全部角色死亡只记录一次状态变化，恢复后不会每 tick 重复写死亡记忆。

移动、采集、工作、休息、交互、转移、伤害与训练动作附带引擎分配的命令关联。动作执行后更新命令为 completed 或 rejected，并记录执行 tick 与结果。移动目标不是邻居、目标提前离开、目标/执行者死亡都能成为明确失败结果。交互、转移与伤害在公共规则下要求同地，并在执行时再次检查。加入组织只允许 member/student，重复加入返回现有成员身份，不重复制造契约。

accepted 是队列接收计数，completed/rejected 包含稍后结算，所以不能把三者相加当成 submitted。命令回执仍区分数据库 pending/applied 与领域 accepted/completed/rejected。

## 提交、恢复和升级

默认内建玩家动作一 tick 完成，运行器在演化后捕获执行结果，再和世界、inbox 确认一同原子提交。失败提交和确认丢失继续使用冻结的候选批次重试，不重放动作、不重复消耗随机流。自定义 advance 若不处理动作，回执可能仍为 accepted；历史 SQL 回执保持提交时结果，不会被后续任意写回。已被世界命令日志占用的命令 ID 返回 command_id_collision；遗留危险键名返回 invalid_identifier，均不会覆盖旧命令或阻塞整个队列。

旧版本 1/2 的 runtime config hash 默认返回 `WORLD_RUNTIME_COMMAND_PROFILE_UPGRADE_REQUIRED`。升级前停止旧写入器并做备份，在原 simulation 配置下执行一次：

```sh
npm --prefix world-engine run runtime:postgres -- --world-id engine-world --batches 1 --upgrade-command-profile
npm run engine:serve -- --world-id engine-world
```

也可在 engine:serve 添加同名标志，让首批提交升级。升级前的 pending 命令按新规则校验，原有 applied 回执不重放。首批 checkpoint 记录新 configHash、commandProfile 与 upgradedFrom，后续运行保留来源。未知 hash 或不同 simulation 配置依然拒绝，标志不能绕过配置冲突。已升级的世界不能交给旧运行器写入。没有 runtime 元数据的新世界直接采用 v3。

Migration 1–4 原样保留；这次升级的是存档中的运行规则，不新增数据库表。

## 验证入口

```sh
npm test
npm --prefix world-engine run test:postgres:player-contract
```

新增三个本地回归脚本，覆盖畸形输入、无部分修改、角色归属/死亡继任、执行时检查、恢复一致和动作结算。真实 PostgreSQL 专项包含 10 组：HTTP 坏命令后的继续运行、安全回执/审计、危险键名、角色创建/归属、观察模式、目标先移动、提交确认丢失、SQL 回滚及两个新进程恢复、明确规则升级、活跃目标上限。SQL 测试缺少数据库时失败，不静默跳过；Node 20/22 CI 均保留 pipefail 和实际完成输出门禁。当前交付是否通过，以对应代码提交的日志和 verification.json 为准。
