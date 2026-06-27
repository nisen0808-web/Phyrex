# City Environment Pressure

城市环境压力层让城市系统读取自然世界、生态系统和人口环境摘要，将外部压力转化为城市稳定度、风险、维护缺口和迁徙吸引力。

## 输入来源

```text
population.environment.byLocation
natural.weather.byLocation
natural.disasters.active
ecology.habitats.byLocation
ecology.populations.byKey
locations.resources
cities.byId
organizations.byId
economy.industries
```

## 压力维度

```text
resourcePressure        食物和水资源短缺
populationPressure      人口环境风险
灾害风险                天气和活跃灾害
生态压力                栖息地适宜度、承载力、疾病和生态健康
infrastructurePressure  基础设施不足
securityPressure        治安不足
maintenance.gap         城市维护缺口
```

## 输出字段

每个 settlement 会写入：

```text
settlement.pressure
settlement.risk
settlement.stability
settlement.migrationAppeal
settlement.maintenance
settlement.status
```

城市总摘要写入：

```text
world.cities.pressure
```

摘要包含：

```text
tick
settlements
highRisk
averageRisk
averageStability
averageMigrationAppeal
bySettlement
```

## 城市状态

```text
active      稳定
strained    承压
declining   衰退
failing     失败边缘
```

## 对城市的影响

高风险和维护缺口会降低基础设施、财富和治安；低风险且维护充足时会缓慢提升基础设施。状态变化会写入城市记忆，方便后续叙事、历史和 AI 系统读取。

## 后续方向

```text
1. 经济系统读取 city.pressure 调整生产、价格和贸易
2. AI 目标系统读取 migrationAppeal，触发迁徙、避灾、求助和囤积
3. 治理系统读取 city.status，触发税收、救灾、戒严和公共工程
4. 基础设施系统读取 maintenance.gap，形成长期维修和崩坏链路
```
