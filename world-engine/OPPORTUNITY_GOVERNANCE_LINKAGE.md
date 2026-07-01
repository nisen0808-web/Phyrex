# Opportunity Governance Linkage

本层让 `opportunity-engine` 读取治理环境摘要、治理过程和冲突状态，并生成可以被 NPC 发现和认领的公共机会。

## Pipeline

```text
governance.environment
-> governance process execution
-> conflict governance process linkage
-> opportunity governance linkage
```

## Inputs

```text
world.governance.environment
world.governance.governments
world.processes.byId[*].type = governance_response
world.conflicts.byId
world.cities.byId
world.economy.markets.global
```

## Generated opportunities

### Governance environment

高治理风险会生成：

```text
public relief
relief supply route
migration support
```

这些机会来自 `world.governance.environment.byGovernment`，用于把高风险政府、资源压力、价格压力和迁徙压力转成 NPC 可参与的公共任务。

### Governance processes

活跃治理过程会生成：

```text
relief work
public works contract
ration logistics
stabilization channel
```

这些机会来自 `world.processes.byId` 中的 `governance_response` 过程。

### Conflict linkage

相关冲突会生成：

```text
conflict mediation
```

这些机会来自高强度冲突，或者已被治理过程标记过的冲突。

## Deduplication

每个治理机会都会写入：

```text
payload.governanceOpportunityKey
```

只要同 key 的机会仍处于 `active` 或 `claimed` 状态，就不会重复生成。

## Stats

`getOpportunityStats(world)` 新增：

```text
governanceGenerated
```

## Test

新增测试：

```text
opportunity-governance-linkage-test.js
```

覆盖内容：

```text
1. 高治理风险可以生成公共救助、补给、迁徙和协作机会。
2. 活跃治理过程可以生成过程相关机会。
3. 相关冲突可以生成调停类机会。
4. 同一个 governanceOpportunityKey 不会重复生成 active 或 claimed 机会。
5. deterministic modular pipeline 中 agency.opportunity 可以生成治理机会，且 Contract 零违规。
```
