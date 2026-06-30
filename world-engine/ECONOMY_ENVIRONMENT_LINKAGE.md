# Economy Environment Linkage

经济环境联动层让经济系统读取城市压力、自然灾害、生态压力、人口环境和地点资源，把外部世界压力转化为产业生产效率、产业状态、市场价格压力和全局经济风险。

## 输入来源

```text
cities.pressure
cities.byId
population.environment
natural.weather.byLocation
natural.disasters.active
ecology.habitats.byLocation
ecology.populations.byKey
locations.resources
economy.industries
economy.markets
```

## 产业压力维度

```text
cityPressure       城市风险和稳定度带来的经营压力
disasterRisk       天气和活跃灾害风险
ecologyRisk        栖息地、承载力、疾病和生态健康风险
populationRisk     人口环境压力
resourceRisk       地点资源覆盖不足
riskScore          产业综合风险
productionMultiplier 生产效率修正
pricePressure      价格压力
```

## 产业状态

```text
active       正常运行
constrained  承压运行
declining    衰退运行
stalled      停摆
```

## 输出字段

每个产业会写入：

```text
industry.environment
industry.status
industry.efficiency
industry.cost
```

全局经济会写入：

```text
world.economy.environment
```

摘要包含：

```text
tick
industries
highRisk
stalled
averageRisk
averageProductionMultiplier
averagePricePressure
byIndustry
```

## 市场价格联动

经济环境会增加市场资源的：

```text
environmentalDemand
environmentalSupplyShock
```

价格更新时会把这些压力并入供需比，影响食品、木材、金属、燃料、奢侈品、知识和服务价格。

## 确定性修复

本层将 `market`、`industry` 和 `transaction` ID 从随机字符串迁移到世界级确定性 ID，避免重放时 ID 漂移。

## 后续方向

```text
1. 让贸易系统根据城市风险和价格差自动移动资源
2. 让 AI 目标系统读取经济风险，触发囤积、换工作、迁徙和套利
3. 让治理系统读取价格压力，触发救灾、税收、补贴和征用
4. 让基础设施系统读取产业停摆，形成维修和供应链中断
```
