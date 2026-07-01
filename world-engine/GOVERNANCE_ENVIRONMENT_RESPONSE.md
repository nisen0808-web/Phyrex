# Governance Environment Response

治理环境响应层把世界压力从 NPC 个体反应推进到组织和政权的集体反应。这个层不做 UI、不做客户端、不做登录部署，只负责让 `civilization.governance` 在每个 tick 读取环境状态，并把治理响应写回世界状态。

## 位置

治理环境响应复用现有的 `governance-engine.js` 和默认管线中的 `civilization.governance` 系统。

当前世界链路变成：

```text
natural.world
-> ecology.world
-> population.environment
-> city.pressure
-> economy.environment
-> AI environment goals
-> governance.environment
```

自然、生态、人口、城市和经济的压力先被前置系统计算出来。治理系统随后读取这些压力，决定政府、宗门、帮派或组织控制的城市是否需要救灾、限粮、公共工程、治安压制、税率调整或动员。

## 输入

治理系统会读取以下世界状态：

```text
world.cities.pressure
world.cities.byId[*].status
world.cities.byId[*].maintenance
world.economy.environment
world.economy.industries
world.population.environment
world.natural.weather.byLocation
world.natural.disasters.active
world.locations[*].resources
world.organizations.byId
world.entities
```

每个政府会根据自己控制的城市、城市位置、组织所在地和辖区人口，生成一份 `government.environment`。

## 环境信号

单个政府的环境信号包括：

```text
cityRisk
securityRisk
migrationPressure
maintenanceGap
populationRisk
economyRisk
pricePressure
weatherRisk
disasterRisk
resourcePressure
foodCoverage
waterCoverage
industrialRisk
stalledIndustries
constrainedIndustries
failingCities
activeDisasters
totalRisk
recommendedResponses
```

世界级治理摘要会写入：

```text
world.governance.environment
```

摘要包括政府数量、高风险政府数量、平均风险、平均城市风险、平均经济风险、平均价格压力、活跃灾害数量、停摆产业数量、迁徙压力、响应数量和按响应类型统计的数据。

## 治理响应类型

### disaster_relief

救灾响应。用于活跃灾害、严重天气风险或城市灾害风险过高的情况。会消耗国库，向辖区地点补充食物和水，提高服务能力和合法性，并压低骚乱。

### rationing

粮食和基础物资调拨。用于食物或水资源覆盖率不足、城市资源压力过高的情况。会降低市场的即时食物需求，并在地点上写入配给状态。

### public_works

公共工程。用于城市风险过高、维护缺口过大、城市进入 declining 或 failing 状态的情况。会消耗国库，提高城市基础设施和稳定度，并提升治理服务能力。

### security_crackdown

治安维护和压制。用于城市治安过低、辖区不稳定、骚乱过高的情况。会提高 lawLevel 和 military，降低 openness，提高 enforcement 和城市 security，但会损耗一部分 legitimacy。

### tax_adjustment

税率调整。用于价格压力、经济压力、社会压力或财政压力明显的情况。高社会压力时优先降低税率，财政压力高且社会压力不高时才提高税率。

### mobilization

组织动员。用于产业停摆、工业风险高、系统性风险高的情况。会消耗国库，提高 military、enforcement、组织 cohesion 和城市 security。

## 确定性和可审计

治理响应 ID 使用世界级确定性 ID：

```text
nextWorldId(world, 'gov_response', 'governance.response.<type>')
```

响应会写入：

```text
government.responses
world.governance.responseLog
government.memory
world.information
```

因此每次治理响应都能回放、审计，并追踪当时的风险输入。

## Contract

`civilization.governance` 的系统 Contract 已扩展，输出必须包含：

```text
created
updated
unrest
taxCollected
environment
responses
```

这样默认确定性管线会验证治理环境摘要和治理响应是否被稳定产出。

## 测试

新增测试：

```text
governance-environment-response-test.js
```

测试覆盖两部分：

```text
1. 直接调用 processGovernanceTick，确认高风险城市会触发治理响应。
2. 通过 deterministic modular pipeline 跑 civilization.governance，确认 Contract 零违规，治理环境摘要和响应写入世界状态。
```
