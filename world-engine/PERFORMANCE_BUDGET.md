# Deterministic Load Sampling

本层为世界引擎增加系统级负载预算和采样能力。

## Design

该模块不使用真实时间 API。当前实现使用确定性负载估算，根据系统输出结构、数组规模、对象规模和调度状态估算每个系统的 load。

## Core modules

```text
world-engine/core/performance-budget-engine.js
world-engine/core/performance-runtime-engine.js
```

主要能力：

```text
analyzePerformanceBudget(world, simulationReport, scheduleReport, options)
estimateValueLoad(value)
getPerformanceBudgetSummary(world)
runDeterministicSimulationTickWithPerformance(world, options, kernel)
attachPerformanceBudgetToKernelReport(world, report, options)
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

## Runtime wrapper

`performance-runtime-engine.js` 提供 wrapper，不修改 deterministic runtime 主文件：

```text
runDeterministicSimulationTickWithPerformance
```

该 wrapper 会先运行原有 deterministic tick，然后根据 `report.kernel.order` 合成 schedule report，再调用 `analyzePerformanceBudget`，最后写入：

```text
report.kernel.performance
world.kernel.performance
```

这样可以先完成运行时报告接入，同时避免对主 runtime 文件做大面积修改。

## Tests

新增测试：

```text
performance-budget-test.js
performance-runtime-test.js
```

覆盖内容：

```text
1. value load estimator 能区分简单值、数组和对象。
2. analyzePerformanceBudget 能生成 world.kernel.performance 样本。
3. 预算过低时可以产生确定性超标记录。
4. getPerformanceBudgetSummary 能返回累计统计。
5. runtime wrapper 能把性能摘要写入 report.kernel.performance。
```
