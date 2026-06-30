# Engine Development Progress

本文件记录当前引擎优先阶段的完成度。浏览器客户端、账号和部署相关能力只作为参考客户端与运维外壳，不作为本阶段主线。

## 当前阶段：经济环境联动层

| 引擎层 | 状态 | 说明 |
|---|---:|---|
| 世界状态与实体模型 | 75% | 已有结构一致性审计和修复，实体、地点、资源和引用更安全。 |
| Tick 与系统调度器 | 92% | 默认确定性内核已有 natural.world、ecology.world、world.consistency。 |
| 确定性随机数 | 80% | 已有命名随机流和兼容作用域；源码审计门禁已建立。 |
| 世界级确定性 ID | 89% | 城市、市场、产业和交易 ID 已迁移到世界级确定性 ID。 |
| 模块化模拟管线 | 92% | 28 个内置模拟系统已拆分，默认额外接入 natural.world、ecology.world、world.consistency。 |
| 系统 Contract 校验 | 82% | world.consistency 已纳入 Contract 覆盖。 |
| 源码确定性纯度审计 | 35% | 已有扫描器、baseline、allowlist 和测试；下一步接入核心目录 baseline。 |
| 状态哈希与差异定位 | 82% | 一致性层可在重放前后修复结构性坏状态，减少无意义漂移。 |
| 重放与确定性验证 | 78% | 自然、生态和一致性系统均加入重放路径。 |
| 人口、家庭、遗产 | 68% | 人口生命周期已读取天气、灾害、资源、疾病、承载力和栖息地压力。 |
| 组织、契约、城市 | 72% | 城市系统已读取人口压力、资源短缺、自然灾害、生态承载力和维护缺口。 |
| 城市环境压力层 | 100% | 已完成压力计算、稳定度、风险、迁徙吸引力、维护缺口、状态变更、记忆和测试。 |
| 经济系统 | 40% -> 68% | 经济系统开始读取城市压力、自然灾害、生态压力、人口压力和地点资源。 |
| 经济环境联动层 | 0% -> 100% | 已完成产业风险、生产倍率、价格压力、产业状态、市场供需冲击和测试。 |
| 智能体目标规划 | 45% | 已有欲望、机会、行动规划；下一步读取经济风险、migrationAppeal 和 city.status。 |
| 信息、记忆、文化、宗教 | 55% | 已接入管线；仍需传播网络和文化变迁细化。 |
| 文明、科技、基础设施 | 50% | 已接入管线；仍需时代、扩散和依赖网络。 |
| 治理、过程、冲突 | 45% | 已接入管线；仍需外交、战争、法律系统。 |
| 自然、气候、生态 | 55% | 自然世界和生态主模块已完成基础版，并能向人口、城市和经济系统提供压力数据。 |
| 世界一致性检查与自动修复 | 100% | 已完成审计、修复计划、自动修复、报告记录、默认管线接入、Contract 和回归测试。 |
| 性能预算与采样 | 10% | 尚未形成系统级 profiling。 |

## 本批次新增

```text
economy environment linkage
economy-environment-linkage-test.js
ECONOMY_ENVIRONMENT_LINKAGE.md
world.economy.environment 摘要
industry.environment / riskScore / productionMultiplier / pricePressure
industry status: active / constrained / declining / stalled
market environmentalDemand / environmentalSupplyShock
```

## 下一批建议

```text
1. 让 AI 目标系统读取经济风险、migrationAppeal 和 city.status，触发迁徙、避灾、求助和囤积
2. 让治理系统读取 city.status 和 pricePressure，触发税收、救灾、戒严和公共工程
3. 增加贸易流系统，根据城市风险和价格差自动移动资源
4. 基于 source-purity-engine 扫描核心目录并生成首个 baseline
5. 增加系统级性能预算与采样
```
