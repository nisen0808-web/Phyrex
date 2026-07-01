# Performance Trend Reports

本层把 `world.kernel.performance.samples` 转成可读的趋势报告和压力场景报告。

## Core modules

```text
world-engine/core/performance-report-engine.js
world-engine/core/performance-markdown-engine.js
```

主要能力：

```text
createPerformanceTrendReport(world, options)
createPerformancePressureScenarioReport(world, scenarios, options)
createPerformanceOperationsReport(world, scenarios, options)
aggregateTopSystems(samples, limit)
formatPerformanceReportMarkdown(report, options)
```

## CLI

性能报告可以通过命令导出 JSON：

```text
npm run performance:report -- output/runtime-world-save.json output/performance-report.json --mode operations
```

也可以导出 Markdown：

```text
npm run performance:report -- output/runtime-world-save.json output/performance-report.md --mode operations --format markdown
```

也可以直接运行：

```text
node demo/performance-report-cli.js <input-save> <output-file> --mode operations --format markdown
```

支持参数：

```text
--input <file>
--output <file>
--mode operations | trend | pressure
--format json | markdown
--window <number>
--top <number>
--multipliers 1,1.5,2
--quiet
```

CLI 默认读取：

```text
output/runtime-world-save.json
```

CLI 默认输出：

```text
output/performance-report.json
output/performance-report.md
```

当输出路径是 `.md` 或 `.markdown` 时，即使没有传入 `--format markdown`，CLI 也会自动使用 Markdown 格式。

## Markdown output

Markdown 输出包含：

```text
Trend
Top Systems
Pressure Scenarios
Recommendations
```

该格式更适合复制到开发记录、运营报告或 GitHub issue。

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

## Tests

新增测试：

```text
performance-report-test.js
performance-report-cli-test.js
```

这些测试通过 `package.json` 接入 `npm test`，覆盖 JSON 和 Markdown 两种 CLI 输出。
