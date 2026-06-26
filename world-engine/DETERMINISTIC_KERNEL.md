# Deterministic Simulation Kernel

开发主线已经重新收束到世界引擎本体。本内核为后续生态、经济、政治、文明和智能体系统提供可重复、可调试、可扩展的运行基础。

## 核心目标

```text
同一初始世界 + 同一输入 + 同一系统版本 = 同一世界状态
```

内核由以下模块组成：

```text
random-engine.js                         命名随机流和确定性兼容作用域
world-id-engine.js                       世界级单调 ID 序列
system-scheduler-engine.js               阶段、依赖、周期和失败策略
simulation-pipeline-engine.js            28 个独立模拟子系统
system-contract-engine.js                通用输入、输出与后置条件校验
simulation-system-contracts-engine.js    内置模拟系统 Contract 集合
state-integrity-engine.js                规范化序列化、SHA-256 和状态差异
replay-engine.js                         输入记录、重放和分歧定位
deterministic-simulation-engine.js       内核入口和管线兼容层
```

## 命名随机流

世界状态会保存：

```text
world.random.baseSeed
world.random.streams
world.random.draws
world.random.clock
```

每个系统使用独立流：

```js
const random = createRandomContext(world, 'economy.market');
const priceNoise = random.float('grain');
const selected = random.pick(candidates, 'seller');
```

一个系统新增随机调用，不会改变其他系统的随机序列。

兼容旧模块时可以使用：

```js
withDeterministicGlobals(world, 'legacy.population', () => {
  // 此同步作用域内的 Math.random() 和 Date.now() 可重复。
});
```

该兼容作用域只允许同步函数。新的引擎模块应优先显式使用 `context.random`。

## 世界级 ID

世界中的 Action、Event、Memory 和 Causality 记录使用世界级序列：

```text
action_<tick>_<sequence>
event_<tick>_<sequence>
memory_<tick>_<sequence>
cause_<tick>_<sequence>
```

序列保存在 `world.engineIds`，因此保存、读取和重放后不会重复。

## 系统调度器

系统定义示例：

```js
registerSystem(registry, {
  id: 'economy.market',
  phase: 'economy',
  after: ['economy.production'],
  everyTicks: 2,
  reads: ['economy.inventory'],
  writes: ['economy.markets'],
  run(context) {
    const noise = context.random.float('price');
    return updateMarkets(context.world, noise);
  },
});
```

调度器支持：

```text
自定义阶段
before / after 依赖
拓扑排序和循环依赖检测
同优先级按系统 ID 稳定排序
everyTicks / offsetTicks 周期
halt / continue 失败策略
整轮原子回滚
系统独立随机流
运行摘要和失败统计
未排序写冲突诊断
```

## 模块化模拟管线

默认确定性内核不再把完整模拟包装为单一 `world.simulation` 系统，而是运行 28 个独立系统。

默认阶段：

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

核心顺序：

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

优点：

```text
每个子系统拥有独立随机流
每个子系统拥有单独运行、跳过和失败统计
可按 auto* 选项关闭单个系统
模组可以注册 before / after 系统
依赖和读写范围可以检查
失败定位精确到具体子系统
```

默认入口：

```js
const kernel = createDeterministicSimulationKernel();
```

旧单体管线仍可用于兼容和对照：

```js
const legacyKernel = createDeterministicSimulationKernel({
  pipeline: 'legacy',
});
```

详细说明见：

```text
world-engine/SIMULATION_PIPELINE.md
```

## 系统 Contract

模块化管线默认启用严格 Contract：

```js
const kernel = createDeterministicSimulationKernel({
  contractPolicy: 'error',
});
```

支持三种策略：

```text
error   Contract 违规令系统失败
warn    记录违规并继续运行
off     跳过 Contract 校验
```

每个 Contract 可以定义：

```text
输入路径和 Schema
系统结果 Schema
执行后世界状态条件
自定义输入验证器
自定义输出验证器
```

内置 28 个模拟系统均有 Contract。验证结果会写入当前调度报告，累计统计保存在：

```text
world.kernel.contracts
```

统计包括：

```text
validations
violations
warnings
failures
inputFailures
outputFailures
postconditionFailures
每个系统的验证与违规信息
最近 100 次违规
```

模组系统可以直接声明：

```js
registerKernelSystem(kernel, {
  id: 'mod.climate.weather',
  phase: 'before',
  contract: {
    inputs: [
      { path: 'world.climate', schema: { type: 'object' } },
    ],
    output: {
      type: 'object',
      required: ['temperature'],
      properties: {
        temperature: { type: 'number' },
      },
    },
  },
  run(context) {
    return updateWeather(context.world, context.random);
  },
});
```

完整 Schema 子集、违规格式和覆盖率说明见：

```text
world-engine/SYSTEM_CONTRACTS.md
```

## 状态完整性

`state-integrity-engine.js` 会：

```text
递归排序对象键
稳定处理数组、Map、Set、Date、Buffer 和特殊数字
生成 SHA-256 状态摘要
比较两个状态并返回首批差异路径
按路径排除非核心字段
```

示例：

```js
const digest = hashWorldState(world);
const comparison = compareStates(leftWorld, rightWorld);
```

## 重放

```js
const tape = createReplayTape(world);

const report = runDeterministicSimulationTick(world, options, kernel);
recordReplayStep(tape, world, options, report);

const result = replayTape(tape, (replayWorld, input) => (
  runDeterministicSimulationTick(replayWorld, input, replayKernel)
));
```

每一步记录：

```text
输入
目标 tick
世界摘要
报告摘要
可选完整报告
```

摘要不一致时返回第一处分歧步骤。`verifyDeterministicExecution` 还可以从同一初始状态并行运行两份模拟，直接检查系统是否可重复。

Contract 验证统计只使用确定性世界状态和调度 tick，因此同样参与世界摘要和重放比较。

## 持久化

旧存档没有确定性字段时，读取会自动补充：

```text
world.random
world.engineIds
world.kernel
world.kernel.contracts
```

随机流位置、ID 序列、调度统计和 Contract 统计会随世界一起保存。

## 当前迁移状态

已经接入：

```text
世界创建与存档修复
Action / Event / Memory / Causality ID
人口出生、死亡和子代 ID
离线命令 ID
运行时世界推进
28 个模块化模拟系统
28 个内置系统输入、输出和后置条件 Contract
模块化与旧单体管线兼容切换
完整模拟重放验证
```

后续引擎批次将按顺序继续：

```text
1. 清除核心模块剩余的隐式 Math.random / Date.now
2. 输入事件日志与因果回放
3. 世界一致性约束和自动修复
4. 性能预算、系统级采样和长周期确定性压测
5. 自然、气候与生态系统
```
