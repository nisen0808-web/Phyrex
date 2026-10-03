# 引擎长期运行与恢复验收

本节点只处理世界引擎：人口演化、可选历史/终态保留、运行器重试，以及真实数据库中的长期演化和重启。没有新增玩家界面、生产部署或数据库 migration。

## 人口初始化

之前 `createEntity({ demographics: { age: 25 } })` 默认写入 `birthTick: 0`，人口系统首次计算年龄时会把创世 tick 的成年人重算为 0 岁。现在省略生日用 `null` 表示，首次人口初始化根据实际 `ticksPerYear` 和当前 tick 推导生日。显式 `birthTick: 0` 仍然是有效生日，优先于年龄；负生日支持创世时已经成年的角色。

新生儿使用实际出生 tick。生日确定后保存、恢复不会再次推导。缺失性别按已有确定性规则补齐。拒绝零/非有限人口年长及超出安全范围的推导生日。已保存的明确生日不重写；过去已经丢失的原始年龄无法凭空恢复。

## 可选历史保留

持续运行可在 simulation 的 `history` 中指定：

```js
history: { maxEventsPerEntity: 100, maxTimelineEvents: 500 }
```

两个上限均为 1 到 1,000,000 的整数，可单独使用。不指定时保持现有完整历史行为。每次历史摄取后先保留各人物最近的事件，再应用全局时间线容量；这里“最近”指插入顺序。人物经历、时间线、类型/地点/tick 索引同步重建，去重 ID 只保留滚动输入中仍存在的记忆。`world.history.retention.removedEvents` 记录累计移除量。

这会影响基于保留事件生成的人物叙事；它不是无损归档，也不限制人物总数、所有其他子系统或数据库 checkpoint 表。需要完整历史时保持关闭，或在启用前自行归档。运行期配置属于世界/运行器配置，不能为了通过测试临时放宽原有限制。

## 机会与冲突的终态容量

simulation 配置可显式启用：

```js
opportunity: { maxTerminalOpportunities: 40 },
conflict: { maxResolvedConflicts: 30 }
```

上限是 0 到 1,000,000 的整数；省略不清理，null、字符串、负数、非整数和非有限值直接拒绝。两个子系统在自身开始生成/推进前验证参数。零表示不保留可清理的终态记录，不取消活跃事件。每次对应子系统 tick 末尾执行；关闭该子系统时不会自动清理，也可调用 pruneOpportunities / pruneConflicts 显式执行。

机会的 claimed/expired/failed、冲突的 resolved 属于可清理终态。按结束时间从旧到新清理，同一时间按 ID 的固定字符顺序决胜；缺失结束时间回退到创建时间。机会和冲突索引同时重建并稳定排序。累计 created/claimed/resolved 等统计、随机流和 ID 高水位保持原值；保存恢复后不会回收已发出的 ID。

正在运行或停滞的过程通过 ownerType/ownerId、payload.opportunityId/conflictId 或 payload.key 引用的记录会受保护。活跃机会指向的冲突也受保护。已经领取的治理机会，在来源过程仍活跃或来源冲突尚未结束时继续保留，阻止同一治理奖励重复生成。政府环境类及未知治理 key 始终保留；过程/冲突结束后，其机会可以清理。这个契约依赖引擎生成 ID 不重复使用，不支持外部把已结束的来源强行复活或复用旧 ID。

保护引用优先于终态预算。`world.opportunities.retention` 和 `world.conflicts.retention`，以及对应 getStats 的 retention 字段，记录最近一次清理的 limit、累计 removed、retainedTerminal、protectedTerminal 和 overLimit。若受保护终态超过预算，overLimit 显式报告压力，不强行删掉依赖目标。它们是最近一次清理的观测值，不是持续实时统计。

这是可选、有损的终态历史保留，不是无损归档，也不是整个世界的硬内存上限。信息、记忆、已结束过程和历史报告中的旧 ID 作为历史出处保留；旧记录被清理后直接 getOpportunity/getConflict 返回 null。自定义扩展引用不在上述已识别路径中，需要扩展保护规则。活跃数量、人物总数、永久政府环境去重记录和数据库 checkpoint 表不由此预算限制。启用前需要保留的完整历史应由调用方存档。

回归覆盖：默认无改动、非法配置无子系统副作用、零预算、引用解除、超额压力、JSONB 对象顺序变化、重复清理、保存恢复、治理去重及来源 ID 不复用。另以三个 seed 各运行 80 tick，对照不开启清理的世界，验证持续行为和随机状态一致，并比较中途恢复后的完整状态。真实 SQL 长期门禁启用 40/30 预算，要求实际发生机会和冲突清理。

## 队列读取重试

`runtime.summary().nextDelayMs` 同时反映队列读取失败和 checkpoint 提交失败的有界指数退避。内置定时循环及 CLI 都使用同一值，成功提交后恢复正常间隔。达到重试上限仍停止，重试不重新执行已有候选世界。

## JSONB 索引一致性

新增真实 SQL 门禁在 500 tick 抓到人口索引检查的排序误判：原实现直接比较对象 JSON 字符串，JSONB 重排键后会把正确索引判为过期。现在按成员关系比较，不依赖对象键或成员数组顺序，也不修改被检查的世界；重复、缺失、额外成员和非数组桶仍会报错。生态成员索引沿用同一严格检查。

## 独立 PostgreSQL endurance gate

世界规范化现在保留原有有限 JSON 捕获，再直接排序捕获的对象树，省去第二份整世界 JSON 字符串和再次解析；数组顺序保持不变。等价回归对照旧实现，覆盖完整世界、别名引用、缺省值、特殊键、数值键、非有限数据和循环引用。该优化不改变数据库格式、摘要算法或规范化后的状态。

```sh
npm ci --prefix world-engine --ignore-scripts
npm test
npm --prefix world-engine run stress
# 必须显式提供独立的 *_ci 或 *_test 数据库；缺失环境变量直接失败。
npm --prefix world-engine run test:postgres:endurance
```

`WORLD_ENGINE_TEST_DATABASE_URL` 通过环境变量提供，不写入命令行。测试只创建并删除自身随机命名的 schema。

新增 GitHub Actions `World Engine Endurance`，在 Node 20/22 + PostgreSQL 18 上分别执行。每个子进程最多 10 分钟，整个 job 最多 25 分钟。初版 5 分钟子进程等待在后半段触发超时，因此调整等待预算；1000 tick、100 个 checkpoint、世界容量和所有正确性断言保持不变。此门禁验证功能恢复，不将超时预算当作吞吐承诺。

1. 四个真实子进程各执行 250 tick，每 10 tick 原子保存，共 1000 tick / 100 个 checkpoint。
2. 四轮 FIFO 命令、重复提交、有效命令和确定性拒绝；重启后不重复消费。
3. SQL trigger 注入事务回滚，以及已提交后丢失确认，两者均重试同一候选世界。
4. 每 250 tick 与无数据库、无重启、无重试的参考演化比较完整世界摘要，涵盖随机流、ID 和子系统状态。
5. 一致性、出生/死亡/后代、历史和既有过程容量等断言。
6. 把最终 checkpoint 和 runtime metadata 恢复到新 schema，继续 10 tick 后再次比较完整状态，并拒绝变更运行器配置。

测试配置明确使用 4 个初始人物、2 个地点和较快的年长，保留默认自然、生态、信息/文化管线。小说和叙事生成关闭，分别由既有专项覆盖。此 gate 验证长序列一致性和真实 SQL 恢复，不代表大规模负载、无限期内存稳定或完整数据库备份。checkpoint 恢复不包含外部 pending inbox 和 audit 表。

独立工作流保留显式 `bash` 的 `-e -o pipefail`，输出经 `tee` 留存并检查真实完成标记；不能以 CI 图标代替日志核验。原有全量回归、100/1000 tick 和所有 PostgreSQL 专项仍保留。

## 引擎完成边界

本文记录 #72 的可靠性节点，本节点本身不代表整个引擎完成。后续整合分支 #73 已补充其他运行态历史保留、Migration 4 的存档/审计维护、持久账户与会话控制、完整数据库备份恢复，以及多 seed 生命周期与容量门禁。最终完成状态以 ENGINE_COMPLETION.md 为准。分布式领导者、高可用和生产部署属于独立运行架构；玩家界面不属于引擎范围。
