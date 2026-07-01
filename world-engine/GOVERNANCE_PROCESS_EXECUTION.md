# Governance Process Execution

治理过程执行层让治理响应从一次性状态修改，进一步变成可持续、多 tick、可追踪的世界过程。

上一层 `governance.environment` 已经能让政府、宗门、帮派和组织根据城市风险、经济压力、灾害、资源短缺和产业停摆触发集体响应。本层把这些响应接入 `process-engine`，让救灾、公共工程、配给、治安维护、税率调整和动员在后续 tick 中持续推进。

## 世界链路

```text
natural.world
-> ecology.world
-> population.environment
-> city.pressure
-> economy.environment
-> AI environment goals
-> governance.environment
-> governance process execution
```

治理响应写入：

```text
world.governance.responseLog
```

过程系统读取这些响应，并生成：

```text
world.processes.byId[*].type = governance_response
```

## 输入

```text
world.governance.responseLog
world.governance.governments
world.organizations.byId
world.cities.byId
world.locations[*].resources
world.economy.markets.global
```

## 新增过程类型

```text
governance_response
```

每个治理响应过程会保留：

```text
payload.responseType
payload.governmentId
payload.organizationId
payload.cityIds
payload.locationIds
payload.severity
payload.responseCount
payload.durationTicks
payload.ticksAdvanced
payload.effectsApplied
```

## 支持的响应过程

### disaster_relief

救灾过程会持续向受影响地点补充食物和水，并逐步提高政府服务能力、合法性，降低骚乱。

### public_works

公共工程过程会逐步提高城市基础设施和稳定度，并缓慢降低维护缺口。

### rationing

配给过程会持续降低食物市场的即时需求，并在地点元数据中记录配给状态。

### security_crackdown

治安维护过程会逐步提高城市 security 和政府 enforcement，降低 unrest，同时轻微损耗 legitimacy。

### tax_adjustment

税率调整过程会在税收调整之后逐步影响合法性和社会不满。

### mobilization

动员过程会提高组织 cohesion、政府 enforcement 和城市 security。

## 确定性

新治理过程由治理响应 ID 和世界级确定性 ID 共同驱动：

```text
nextWorldId(world, 'process', 'process.governance_response')
```

已经消费过的治理响应会记录到：

```text
world.processes.consumedGovernanceResponseIds
```

因此同一个响应不会重复创建过程，确定性回放时也能保持稳定。

## 测试

新增测试：

```text
governance-process-execution-test.js
```

测试覆盖：

```text
1. governance response log 被 process-engine 消费。
2. 治理响应生成 governance_response 过程。
3. 救灾、公共工程、治安维护能在 tick 中持续产生效果。
4. 治理过程会随 tick 推进并最终 resolved。
5. 确定性 modular pipeline 中 civilization.processes 可以处理治理响应，且 Contract 零违规。
```

## 当前限制

本层只负责把治理响应转成多 tick 过程，并提供基础持续效果。后续还需要让 conflict-engine 读取 `security_crackdown` 和 `mobilization` 过程，让 opportunity-engine 读取救灾和公共工程过程，生成更多公共任务和组织协作。
