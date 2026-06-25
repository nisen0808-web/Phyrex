# Modular Simulation Pipeline

`simulation-pipeline-engine.js` 将原先单体 `runSimulationTick` 拆成可独立调度、统计、跳过和扩展的系统管线。

## 默认阶段

```text
before
population
social
economy
agency
advance
knowledge
civilization
finalize
after
```

`before` 和 `after` 留给模组、规则集和测试扩展；中间阶段由引擎内置系统使用。

## 内置系统

```text
population.lifecycle
population.families
population.legacy
social.contracts
social.organizations
economy.production
economy.cities
agency.identity
agency.desire
agency.opportunity
agency.planning
world.advance
knowledge.information
knowledge.memory
knowledge.culture
knowledge.religion
civilization.civilization
civilization.technology
civilization.infrastructure
civilization.governance
civilization.processes
civilization.emergence
civilization.conflict
civilization.players
finalize.history
finalize.narrative
finalize.novel
finalize.report
```

## 使用方式

默认确定性内核使用模块化管线：

```js
const {
  createDeterministicSimulationKernel,
  initializeDeterministicSimulation,
  runDeterministicSimulationTick,
} = require('./core/deterministic-simulation-engine');

const kernel = createDeterministicSimulationKernel();
initializeDeterministicSimulation(world, options);
const report = runDeterministicSimulationTick(world, {
  simulation: options,
}, kernel);
```

旧单体管线仍可用于兼容和结果对照：

```js
const legacyKernel = createDeterministicSimulationKernel({
  pipeline: 'legacy',
});
```

## 扩展系统

```js
const { registerKernelSystem } = require('./core/deterministic-simulation-engine');

registerKernelSystem(kernel, {
  id: 'mod.weather.prepare',
  phase: 'before',
  reads: ['calendar', 'climate'],
  writes: ['weather'],
  run(context) {
    const rain = context.random.chance(0.2, 'rain');
    context.world.weather = { rain, tick: context.targetTick };
    return context.world.weather;
  },
});
```

系统上下文提供：

```text
world
system
report
shared
tick
targetTick
random
nextId
hash
```

每个系统使用独立随机流 `system:<systemId>`。因此某个子系统新增随机调用，不会移动其他子系统的随机序列。

## 动态开关

现有 `DEFAULT_SIMULATION_OPTIONS` 中的 `auto*` 开关直接控制系统是否执行。例如：

```js
runDeterministicSimulationTick(world, {
  simulation: {
    autoPopulation: false,
    autoEconomy: true,
    autoNarrative: false,
  },
}, kernel);
```

被关闭的系统会记录为 `skipped`，并保留在调度报告和系统统计中。

## 周期系统

叙事与小说系统继续遵循：

```text
narrativeEveryTicks
novelEveryTicks
```

调度判断使用目标 tick，因此报告周期与世界推进后的 tick 一致。

## 报告与统计

每次运行都会生成：

```text
完整 simulation report
compact simulation report
系统执行顺序
completed / skipped / failed 数量
每个系统的运行、跳过和失败次数
每个系统结果摘要
最终世界 SHA-256 digest
```

`finalize.report` 负责：

```text
修剪 world.memory
增加 simulation.counters.ticks
更新 simulation.lastTickReport
维护最多 200 条 simulation.reports
```

## 兼容性

```text
runSimulationTick              保留原单体实现
pipeline: legacy               通过确定性调度器包装单体实现
pipeline: modular              新默认，28 个独立系统
```

这允许旧存档、旧测试和已有调用方逐步迁移，而无需一次性删除原实现。

## 后续引擎工作

```text
1. 将核心系统中的隐式 Math.random / Date.now 改为显式 context.random
2. 为系统输入和输出增加 schema / contract 校验
3. 引入世界一致性约束与自动修复系统
4. 增加系统级性能预算和采样
5. 将外部玩家输入纳入事件日志与因果回放
```
