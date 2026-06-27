# World Consistency and Repair Engine

`world-consistency-engine.js` 是世界状态一致性检查与自动修复层。目标是在每个 tick 结束前发现坏状态，尽量自动修复，并把结果写入世界状态，避免长期运行后状态逐渐腐坏。

## 当前能力

```text
实体位置检查
实体状态补齐
实体数值字段修正
地点 ID 检查
地点资源非负检查
地点邻接关系检查
人口索引重建
自然天气和灾害引用检查
自然历史长度限制
生态栖息地引用检查
生态种群数值检查
生态 byLocation 索引重建
世界记忆长度限制
模拟报告长度限制
内核历史长度限制
Contract 最近违规长度限制
```

## 默认管线接入

默认确定性内核会注册：

```text
world.consistency
```

该系统运行在 `finalize` 阶段，优先级为 `100`，并且在 `finalize.report` 之前运行。

读取：

```text
*
```

写入：

```text
consistency
entities
locations
population
natural
ecology
memory
simulation
kernel
```

## 执行模式

默认会执行修复：

```js
runDeterministicSimulationTick(world, {
  simulation: {
    consistency: { repair: true },
  },
});
```

可只审计不修复：

```js
runDeterministicSimulationTick(world, {
  simulation: {
    consistency: { repair: false },
  },
});
```

可完全关闭默认系统：

```js
const kernel = createDeterministicSimulationKernel({
  includeConsistencyWorld: false,
});
```

可跳过执行但保留系统注册：

```js
runDeterministicSimulationTick(world, {
  simulation: {
    autoConsistency: false,
  },
});
```

## 输出状态

每次执行会写入：

```text
world.consistency.lastReport
world.consistency.reports
world.consistency.stats
```

报告包含：

```text
ok
issueCount
repairableCount
repairedCount
issues
repairs
dryRun
```

## 设计边界

该层只修复结构性坏状态，例如引用缺失、索引过期、负资源、过长历史。复杂玩法含义仍应由对应系统处理，例如死亡原因、经济价格、家族继承和战争结果。
