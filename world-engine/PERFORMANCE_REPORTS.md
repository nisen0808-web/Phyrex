# Performance Trend Reports

本层把 `world.kernel.performance.samples` 转成可读的趋势报告和压力场景报告。

## Core module

```text
world-engine/core/performance-report-engine.js
```

主要能力：

```text
createPerformanceTrendReport(world, options)
createPerformancePressureScenarioReport(world, scenarios, options)
createPerformanceOperationsReport(world, scenarios, options)
aggregateTopSystems(samples, limit)
```

## Trend report

趋势报告会读取最近 N 个样本，并输出：

```text
sampleCount
averageTotalLoad
maxTotalLoad
averageMaxSystemLoad
maxSystemLoad
warningCount
violationCount
trend.direction
topSystems
```

`trend.direction` 支持：

```text
rising
falling
stable
```

## Pressure scenario report

压力场景报告会把多个样本或放大后的样本整理成场景列表，并输出：

```text
scenarioCount
highestRisk
summary.averageRiskScore
summary.violationScenarios
summary.warningScenarios
summary.maxTotalLoad
```

每个场景包含：

```text
name
totalLoad
maxSystemLoad
warnings
violations
riskScore
topSystems
```

## Operations report

`createPerformanceOperationsReport` 会组合 trend 和 pressure，并生成建议：

```text
trend
pressure
recommendations
```

## Test

新增测试：

```text
performance-report-test.js
```

该测试通过 `package.json` 接入 `npm test`。
