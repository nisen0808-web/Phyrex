# Engine Development Progress

本文件记录当前引擎优先阶段的完成度。浏览器客户端、账号和部署相关能力只作为参考客户端与运维外壳，不作为本阶段主线。

## 当前阶段：冲突治理过程联动层

| 引擎层 | 状态 | 说明 |
|---|---:|---|
| 世界状态与实体模型 | 75% | 已有结构一致性审计和修复，实体、地点、资源和引用更安全。 |
| Tick 与系统调度器 | 92% | 默认确定性内核已有 natural.world、ecology.world、world.consistency。 |
| 确定性随机数 | 80% | 已有命名随机流和兼容作用域；源码审计门禁已建立。 |
| 世界级确定性 ID | 92% | 城市、市场、产业、交易、目标、目标记忆、治理响应和治理过程 ID 已迁移到世界级确定性 ID。 |
| 模块化模拟管线 | 93% | 治理响应已经能进入 civilization.processes，并继续影响 civilization.conflict。 |
| 系统 Contract 校验 | 83% | civilization.governance、civilization.processes 和 civilization.conflict 均覆盖关键输出结构。 |
| 源码确定性纯度审计 | 35% | 已有扫描器、baseline、allowlist 和测试；下一步接入核心目录 baseline。 |
| 状态哈希与差异定位 | 82% | 一致性层可在重放前后修复结构性坏状态，减少无意义漂移。 |
| 重放与确定性验证 | 81% | 自然、生态、一致性、治理环境响应、治理过程执行和冲突治理联动进入确定性管线路径。 |
| 人口、家庭、遗产 | 68% | 人口生命周期已读取天气、灾害、资源、疾病、承载力和栖息地压力。 |
| 组织、契约、城市 | 73% | 城市系统已读取人口压力、资源短缺、自然灾害、生态承载力和维护缺口。 |
| 城市环境压力层 | 100% | 已完成压力计算、稳定度、风险、迁徙吸引力、维护缺口、状态变更、记忆和测试。 |
| 经济系统 | 68% | 经济系统已读取城市压力、自然灾害、生态压力、人口压力和地点资源。 |
| 经济环境联动层 | 100% | 已完成产业风险、生产倍率、价格压力、产业状态、市场供需冲击和测试。 |
| 智能体目标规划 | 72% | AI 目标层开始读取城市、经济、自然、生态、人口和资源压力。 |
| AI 环境目标层 | 100% | 已完成环境信号、避灾、迁徙、囤积、采集、找工作、支援城市目标和行动映射。 |
| 治理、过程、冲突 | 62% -> 68% | 冲突系统已读取 security_crackdown 和 mobilization 治理过程，影响相关冲突强度。 |
| 治理环境响应层 | 100% | 已完成救灾、公共工程、配给、治安维护、税率调整和组织动员。 |
| 治理过程执行层 | 100% | 已完成治理响应日志消费、governance_response 过程生成、持续效果、过程推进和确定性管线测试。 |
| 冲突治理过程联动层 | 0% -> 100% | 已完成治理过程对叛乱和组织冲突强度的联动、冲突记忆和统计接入。 |
| 信息、记忆、文化、宗教 | 55% | 已接入管线；仍需传播网络和文化变迁细化。 |
| 文明、科技、基础设施 | 50% | 已接入管线；仍需时代、扩散和依赖网络。 |
| 自然、气候、生态 | 55% | 自然世界和生态主模块已完成基础版，并能向人口、城市、经济、AI 目标、治理和冲突系统提供压力数据。 |
| 世界一致性检查与自动修复 | 100% | 已完成审计、修复计划、自动修复、报告记录、默认管线接入、Contract 和回归测试。 |
| 性能预算与采样 | 10% | 尚未形成系统级 profiling。 |

## 本批次新增

```text
Conflict governance process linkage
conflict-governance-process-engine.js
conflict-governance-process-test.js
CONFLICT_GOVERNANCE_PROCESS.md
processConflictTick.governanceProcessEffects
conflict.stats.governanceProcessEffects / governanceSuppressions / governanceMobilizations
security_crackdown -> suppress_revolt
mobilization -> mobilize_conflict
npm test 追加冲突治理过程回归测试
```

## 下一批建议

```text
1. 让 opportunity-engine 读取治理环境摘要和治理过程，生成公共救灾、工程、贸易和迁徙机会。
2. 增加贸易流系统，根据城市风险和价格差自动移动资源。
3. 让 organization-engine 根据治理过程吸纳灾民、志愿者、工人和治安力量。
4. 基于 source-purity-engine 扫描核心目录并生成首个 baseline。
5. 增加系统级性能预算与采样。
```
