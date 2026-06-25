# System Contracts

系统 Contract 为模块化模拟管线提供运行前、结果和运行后的可执行约束。它用于在错误扩散到后续 Tick 之前，定位具体系统、阶段和字段。

## Contract 阶段

```text
before  系统运行前检查世界状态和上下文
result  检查系统返回值
later   不支持
post    不支持
after   系统运行后检查世界不变量
```

实际支持的阶段为：

```text
before
result
after
```

## 定义示例

```js
registerSystem(registry, {
  id: 'economy.market',
  phase: 'economy',
  contracts: {
    before: [
      {
        id: 'market.inventory',
        target: 'world',
        path: 'economy.inventory',
        type: 'object',
      },
    ],
    result: [
      {
        id: 'market.transactions',
        target: 'result',
        path: 'transactions',
        type: 'array',
      },
    ],
    after: [
      context => (
        context.world.economy.balance >= 0
          ? true
          : 'economy balance must remain non-negative'
      ),
    ],
  },
  run(context) {
    return processMarket(context.world);
  },
});
```

## 支持的目标

```text
world
result
context
shared
report
system
```

路径使用点号或数组下标：

```text
economy.markets.global
actions.pending[0].type
```

## 内置字段约束

```text
required / allowUndefined
nullable
type
enum
min / max
integer / finite
minLength / maxLength
minItems / maxItems
predicate / validate
severity
message / code
metadata
```

支持的类型包括：

```text
undefined
null
boolean
string
number
integer
object
array
function
date
map
set
buffer
```

## 自定义验证器返回值

验证器必须同步执行，可返回：

```text
true / undefined / null       通过
false                         失败
string                        失败原因
{ ok, code, message, ... }    结构化结果
array                         多个结果
```

返回 Promise 会生成 `contract_async_validator_forbidden`。

## 执行策略

```text
error  默认；error 级问题会使当前系统失败
warn   记录 violation，但继续运行
 off   不执行 Contract
```

配置：

```js
const kernel = createDeterministicSimulationKernel({
  contractPolicy: 'error',
  contractMaxIssues: 50,
  contractIncludeValues: false,
});
```

每次运行也可以覆盖：

```js
runDeterministicSimulationTick(world, {
  scheduler: {
    contractPolicy: 'warn',
  },
}, kernel);
```

## 模拟管线 Contract

默认模块化内核会为 28 个模拟系统安装 Contract，包括：

```text
世界 ID、Tick、实体和地点根状态
simulationFrame 上下文
每个系统返回值的 object / array 类型
人口出生和死亡列表
欲望目标和机会列表
知识传播和记忆列表
文明、科技、基础设施和冲突结果列表
world.advance 的目标 Tick 不变量
finalize.report 的完成状态和报告 Tick 不变量
```

目前共安装：

```text
28 个受约束系统
214 条 Contract
140 条 before
71 条 result
3 条 after
```

## 运行报告

完整调度报告新增：

```text
schedule.contracts.systems
schedule.contracts.checks
schedule.contracts.warnings
schedule.contracts.violations
schedule.contracts.failures
```

每个执行系统包含：

```text
entry.contracts.status
entry.contracts.checks
entry.contracts.stages.before
entry.contracts.stages.result
entry.contracts.stages.after
```

世界状态保存累计统计：

```text
world.kernel.contracts
```

可通过：

```js
getSystemContractSummary(world)
```

读取每个系统的检查次数、警告、违反、失败和最近问题。

## 错误结构

严格模式下，Contract 失败首先产生：

```text
SystemContractError
code = system_contract_failed
systemId
stage
contractId
contractReport
```

随后由调度器包装为：

```text
code = system_schedule_failed
systemId
cause = SystemContractError
report
```

因此可以精确定位失败系统和字段，而不必从最终世界状态反推原因。

## 后续工作

```text
1. 为更多系统增加领域级数值范围和引用完整性 Contract
2. 引入 Contract 版本迁移与 Ruleset 覆盖
3. 将 Contract 失败接入世界一致性修复器
4. 增加系统性能预算 Contract
5. 把外部输入事件纳入同一验证框架
```
