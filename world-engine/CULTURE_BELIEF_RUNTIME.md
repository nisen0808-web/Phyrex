# Culture Belief Runtime Integration

本层把 culture-belief-flow 网络接入 deterministic runtime helper。

## Files

```text
core/culture-belief-flow-system-engine.js
core/culture-belief-flow-runtime-engine.js
tests/culture-belief-flow-runtime-test.js
```

## System

新增 modular pipeline system：

```text
knowledge.culture_belief_flow
```

默认 phase：

```text
knowledge
```

默认顺序：

```text
after knowledge.religion
before civilization.civilization
```

读写范围：

```text
reads: cultures, religions, entities, organizations, cities
writes: cultureBeliefFlow, cultures, religions, organizations
```

## Runtime helper

```text
createCultureBeliefFlowDeterministicKernel(options)
attachCultureBeliefFlowSystemToKernel(kernel, options)
runDeterministicSimulationTickWithCultureBeliefFlow(world, options, kernel)
```

该 helper 会先创建带 `knowledge.info_flow` 的 deterministic kernel，再注册 `knowledge.culture_belief_flow`。

## Report

运行后写入：

```text
report.cultureBeliefFlow
world.cultureBeliefFlow
```

并更新 counters：

```text
cultureBeliefFlowLinks
cultureBeliefTransfers
beliefCultureInfluences
beliefOrganizationLinks
```

## Options

默认启用：

```text
autoCultureBeliefFlow !== false
```

参数入口：

```text
cultureBeliefFlow: {
  maxLinksPerTick,
  traitTransferRatio,
  faithInfluenceRatio,
  organizationFaithThreshold,
  eventLimit
}
```

## Test

新增：

```text
culture-belief-flow-runtime-test.js
```

覆盖：

```text
kernel 注册 knowledge.info_flow
kernel 注册 knowledge.culture_belief_flow
schedule order 包含两个系统
report.cultureBeliefFlow 输出
城市文化被信仰影响
组织接入信仰网络
```
