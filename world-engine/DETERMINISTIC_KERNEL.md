# Deterministic Simulation Kernel

这一批把开发主线重新收束到世界引擎本体，建立后续生态、经济、政治和智能体系统共同依赖的确定性内核。

## 核心目标

```text
同一初始世界 + 同一输入 + 同一系统版本 = 同一世界状态
```

内核由以下模块组成：

```text
random-engine.js                    命名随机流和确定性兼容作用域
world-id-engine.js                  世界级单调 ID 序列
system-scheduler-engine.js          阶段、依赖、周期和失败策略
state-integrity-engine.js           规范化序列化、SHA-256 和状态差异
replay-engine.js                    输入记录、重放和分歧定位
deterministic-simulation-engine.js  现有完整模拟系统的确定性适配层
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
  phase: 'post',
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

默认确定性适配器把现有完整模拟作为 `world.simulation` 系统运行，并允许扩展系统加入 before 和 after 阶段。后续会逐步把各子系统拆成独立注册项。

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

## 持久化

旧存档没有确定性字段时，读取会自动补充：

```text
world.random
world.engineIds
world.kernel
```

随机流位置、ID 序列和调度统计会随世界一起保存。

## 当前迁移状态

已经接入：

```text
世界创建与存档修复
Action / Event / Memory / Causality ID
人口出生、死亡和子代 ID
离线命令 ID
运行时世界推进
完整模拟确定性适配器
```

后续引擎批次将按顺序继续：

```text
1. 将现有模拟子系统拆成独立调度项
2. 清除核心模块剩余的隐式 Math.random / Date.now
3. 输入事件日志与因果回放
4. 世界一致性约束和自动修复
5. 性能预算、系统级采样和长周期确定性压测
```
