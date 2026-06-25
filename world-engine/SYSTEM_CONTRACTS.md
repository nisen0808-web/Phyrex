# System Contracts

`system-contract-engine.js` 为确定性调度系统提供输入、输出和执行后状态校验。

## 目标

```text
系统在读取世界前确认输入状态满足约定
系统返回后确认结果结构满足约定
系统写入后确认关键后置条件成立
Contract 失败能够精确定位到系统、阶段和字段路径
验证统计随世界状态保存并参与确定性重放
```

## 默认策略

模块化确定性内核默认使用：

```text
contractPolicy: error
```

支持：

```text
error   发现违规立即令当前系统失败，并按调度器失败策略处理
warn    记录违规但继续运行
of      关闭 Contract 校验
```

正确的关闭值为：

```text
off
```

示例：

```js
const kernel = createDeterministicSimulationKernel({
  contractPolicy: 'warn',
});
```

单次运行也可以覆盖：

```js
runDeterministicSimulationTick(world, {
  scheduler: {
    contractPolicy: 'off',
  },
}, kernel);
```

## Contract 定义

```js
const contract = createSystemContract({
  description: 'Example economy system contract',
  inputs: [
    {
      path: 'world.tick',
      schema: { type: 'integer', minimum: 0 },
    },
    {
      path: 'world.economy.markets',
      optional: true,
      schema: { type: 'object' },
    },
  ],
  output: {
    type: 'object',
    required: ['updated'],
    properties: {
      updated: {
        type: 'array',
        items: { type: 'string', minLength: 1 },
      },
    },
  },
  postconditions: [
    {
      path: 'world.economy',
      schema: { type: 'object' },
    },
  ],
});
```

路径根对象包括：

```text
world
shared
options
system
report
tick
targetTick
result
```

数组索引支持两种写法：

```text
world.entities.0.id
world.entities[0].id
```

## Schema 子集

支持的类型：

```text
any
null
array
object
integer
number
string
boolean
```

支持的约束：

```text
nullable
anyOf
const
enum
minimum
maximum
minLength
maxLength
pattern
minItems
maxItems
items
required
properties
additionalProperties
validate
```

自定义字段验证器：

```js
{
  type: 'number',
  validate(value) {
    return value % 2 === 0 || 'Value must be even';
  },
}
```

自定义输入或输出验证器：

```js
createSystemContract({
  validateInput(root, metadata) {
    if (root.world.tick !== metadata.context.tick) {
      return {
        path: 'world.tick',
        code: 'tick_mismatch',
        message: 'World tick must match scheduler tick',
      };
    }
    return true;
  },
  validateOutput(result) {
    return result.ok === true || 'System result must be successful';
  },
});
```

验证器可以返回：

```text
true / undefined / null     通过
false                       通用失败
string                      以字符串作为错误信息
violation object            单个详细违规
violation object[]          多个详细违规
```

## 注册自定义系统

```js
registerKernelSystem(kernel, {
  id: 'mod.climate.weather',
  phase: 'before',
  reads: ['climate'],
  writes: ['weather'],
  contract: {
    inputs: [
      { path: 'world.climate', schema: { type: 'object' } },
    ],
    output: {
      type: 'object',
      required: ['temperature', 'precipitation'],
      properties: {
        temperature: { type: 'number' },
        precipitation: { type: 'number', minimum: 0 },
      },
    },
  },
  run(context) {
    return updateWeather(context.world, context.random);
  },
});
```

## 内置覆盖

模块化管线的 28 个系统均已挂接 Contract：

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

`world.advance` 还会检查：

```text
world.tick === targetTick
```

`finalize.report` 还会检查：

```text
simulationFrame.finalized === true
world.simulation.lastTickReport 已写入
```

## 运行报告

每个已执行系统的调度条目会增加：

```js
entry.contract = {
  version: 1,
  policy: 'error',
  input: {
    status: 'valid',
    violations: [],
  },
  output: {
    status: 'valid',
    violations: [],
  },
  postconditions: {
    status: 'valid',
    violations: [],
  },
};
```

违规结构：

```js
{
  stage: 'output',
  path: '$result.updated',
  code: 'type_mismatch',
  message: '$result.updated must be array, received string',
  expected: 'array',
  actual: 'string',
}
```

## 世界状态统计

状态保存在：

```text
world.kernel.contracts
```

包括：

```text
validations
violations
warnings
failures
inputFailures
outputFailures
postconditionFailures
systems
lastViolation
recentViolations
```

读取摘要：

```js
const summary = getSystemContractSummary(world);
```

确定性内核摘要还提供：

```text
contracts
contractCoverage
```

## Contract 覆盖率

```js
const coverage = analyzeContractCoverage(kernel.registry);
```

返回：

```text
systems
contracted
uncontracted
coverage
contractedIds
uncontractedIds
```

内置模块化系统目标覆盖率为：

```text
28 / 28 = 100%
```

模组新增系统后，可以通过覆盖率摘要发现尚未声明 Contract 的系统。

## 确定性

Contract 校验不得读取真实时间、外部网络或进程级随机数。所有验证统计只使用：

```text
系统 ID
调度 tick
确定性系统结果
确定性世界状态
```

因此 Contract 状态会稳定参与世界哈希和重放比较。
