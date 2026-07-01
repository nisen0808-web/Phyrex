# Deterministic Load Sampling

本层为世界引擎增加系统级负载预算和采样能力。

## Design

该模块不使用真实时间 API。当前实现使用确定性负载估算，根据系统输出结构、数组规模、对象规模和调度状态估算每个系统的 load。

## Core module

```text
world-engine/core/performance-budget-engine.js
```

主要能力：

```text
analyzePerformanceBudget(world, simulationReport, scheduleReport, options)
estimateValueLoad(value)
getPerformanceBudgetSummary(world)
```

## State

采样结果写入：

```text
world.kernel.performance
```

结构包括：

```text
samples
last
stats.samples
stats.warnings
stats.violations
stats.maxTotalLoad
```

## Budget model

系统会为每个 scheduler system 生成 sample：

```text
systemId
phase
status
load
budget
section
```

总负载超过 `maxTotalLoad` 时记录总负载超标。单系统负载超过对应系统预算时记录系统负载超标。

## Current integration

当前 PR 先交付独立模块和测试。运行时主文件接入后续用单独小 PR 完成。

## Test

新增测试：

```text
performance-budget-test.js
```

覆盖内容：

```text
1. value load estimator 能区分简单值、数组和对象。
2. analyzePerformanceBudget 能生成 world.kernel.performance 样本。
3. 预算过低时可以产生确定性超标记录。
4. getPerformanceBudgetSummary 能返回累计统计。
```
