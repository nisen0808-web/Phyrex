# Trade Flow System

贸易流系统让经济层根据地点资源、城市压力和市场压力，在每个经济 tick 中自动移动资源。

## Pipeline

```text
city.pressure
-> economy.environment
-> trade flow system
-> market price update
```

贸易流发生在 `processEconomyTick` 内部，位置在居民消费之后、市场价格更新之前。

## Inputs

```text
world.locations[*].resources
world.cities.byId
world.cities.indexes.byLocation
world.cities.pressure.bySettlement
world.population.environment
world.natural.disasters.active
world.economy.markets.global
```

## Outputs

贸易流摘要写入：

```text
world.economy.tradeFlows
```

长期日志写入：

```text
world.economy.tradeFlowLog
```

交易流水写入：

```text
world.economy.transactions[*].type = trade_flow
```

经济统计新增：

```text
world.economy.stats.tradeFlowCount
world.economy.stats.tradeFlowVolume
```

## Supported resources

```text
food
water
wood
stone
metal
fuel
luxury
```

## Route selection

系统会为每种资源寻找：

```text
source location: surplus above local reserve
target location: deficit based on local need and city pressure
```

城市压力和灾害风险会降低路线容量，市场价格压力会提高流动优先级和流动规模。

## Determinism

贸易流 ID 使用世界级确定性 ID：

```text
nextWorldId(world, 'trade_flow', 'economy.trade_flow.<resource>')
```

候选生成阶段只做规划，不修改资源。资源只会在 `applyTradeFlow` 中正式移动。

## Tests

新增测试：

```text
trade-flow-system-test.js
```

覆盖内容：

```text
1. 直接调用 processTradeFlows，可以把食物从富余地点移动到短缺地点。
2. processEconomyTick 会自动执行贸易流并写入交易流水。
3. deterministic modular pipeline 中 autoEconomy 可以运行贸易流，且 Contract 零违规。
```
