# System Contracts and Determinism Audit

本批次为模块化模拟管线增加两个内核能力：

```text
系统输入 / 输出 / 后置状态 Contract
隐式 Math.random / Date.now 使用审计
```

## System Contract

每个调度系统可以声明：

```js
registerSystem(registry, {
  id: 'economy.market',
  phase: 'economy',
  contract: {
    input: {
      paths: [
        { path: 'world.economy', schema: 'object' },
        { path: 'world.tick', schema: 'integer' },
      ],
    },
    output: {
      type: 'object',
      required: ['updated'],
      properties: {
        updated: { type: 'array', items: 'string' },
      },
    },
    post: {
      paths: [
        { path: 'world.economy.markets', schema: 'object' },
      ],
    },
  },
  run(context) {
    return updateMarkets(context.world);
  },
});
```

Contract 阶段：

```text
input   系统执行前，验证上下文和世界路径
output  系统执行后，验证返回值
post    系统执行后，验证世界状态和自定义不变量
```

## Contract 策略

```text
strict  任意违反都会使系统失败，默认值
warn    记录违反但允许系统完成
off     完全关闭验证
```

调用示例：

```js
runSystemSchedule(world, registry, {
  contractPolicy: 'strict',
});
```

系统可覆盖全局策略：

```js
{
  id: 'experimental.system',
  contractPolicy: 'warn',
}
```

## Schema DSL

支持类型：

```text
any
null
boolean
number
integer
string
array
object
function
undefined
```

对象约束：

```text
required
properties
additionalProperties
optional
nullable
enum
const
predicate
```

字符串和数值约束：

```text
min / max
minLength / maxLength
pattern
```

数组约束：

```text
items
minItems
maxItems
```

数组形式的 Schema 表示 `oneOf`。

辅助函数：

```js
const {
  objectSchema,
  arraySchema,
  validateSchema,
} = require('./core/system-contract-engine');
```

## 内置模拟 Contract

`simulation-contract-catalog-engine.js` 为模块化管线的 28 个系统全部声明 Contract。

Contract 会验证：

```text
simulationFrame 是否存在
world.tick 是否有效
关键返回数组和对象是否存在
治理税收是否为 number
最终报告是否包含 tickBefore / tickAfter
系统结束后 world.tick 和 simulation report 是否仍有效
```

默认确定性内核会自动应用目录：

```js
const kernel = createDeterministicSimulationKernel();
```

需要暂时禁用时：

```js
const kernel = createDeterministicSimulationKernel({
  contracts: false,
});
```

## Contract 报告

单次调度报告增加：

```text
contractViolations
systems[].contract.policy
systems[].contract.status
systems[].contract.violations
systems[].contract.stages
```

长期调度摘要增加：

```text
kernel.contractViolations
kernel.systems.<id>.contractViolations
kernel.systems.<id>.lastContractStatus
```

Contract 失败会生成：

```text
name: SystemContractError
code: system_contract_violation
systemId
stage
violations
```

## 确定性来源审计

调度器仍为旧模块提供确定性兼容作用域，但现在会区分：

```text
显式 context.random 调用
隐式 Math.random 调用
显式 context.random.now 调用
隐式 Date.now 调用
```

每个系统记录：

```text
implicitRandomCalls
implicitClockCalls
totalRandomDraws
totalClockReads
explicitRandomDraws
explicitClockReads
warnings
```

## 确定性策略

```text
compat  保持确定性替换，不产生告警
audit   保持确定性替换，并记录隐式调用，默认值
strict  Math.random 或 Date.now 一经调用立即使系统失败
```

示例：

```js
runSystemSchedule(world, registry, {
  determinismPolicy: 'strict',
});
```

系统也可以覆盖策略：

```js
{
  id: 'new.explicit.system',
  determinismPolicy: 'strict',
  run(context) {
    return {
      random: context.random.float('value'),
      now: context.random.now('timestamp'),
    };
  },
}
```

严格模式错误：

```text
name: ImplicitDeterminismError
code: implicit_determinism_source
source: Math.random | Date.now
```

## 迁移方式

对审计中出现告警的系统，依次替换：

```js
Math.random()
```

为：

```js
context.random.float('purpose')
context.random.int(min, max, 'purpose')
context.random.chance(probability, 'purpose')
context.random.pick(values, 'purpose')
```

并将：

```js
Date.now()
```

替换为：

```js
context.random.now('purpose')
```

完成迁移后，把该系统的 `determinismPolicy` 改为 `strict`，防止以后重新引入隐式来源。

## 当前结果

```text
28 / 28 模块化模拟系统拥有 Contract
默认 Contract 策略为 strict
默认确定性策略为 audit
旧系统仍可运行，但隐式来源会被量化
新系统可以直接启用 strict 确定性模式
```

下一阶段会根据审计统计逐个清除核心系统中的隐式随机源，并引入外部输入事件日志和因果回放。
