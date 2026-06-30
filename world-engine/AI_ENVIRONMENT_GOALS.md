# AI Environment Goals

AI 环境目标层让 NPC 读取自然、生态、人口、城市和经济压力，并主动生成避灾、迁徙、囤积、找工作、采集和支援城市目标。

## 输入来源

```text
natural.weather.byLocation
natural.disasters.active
ecology.habitats.byLocation
ecology.populations.byKey
population.environment
cities.pressure
cities.byId
economy.environment
economy.industries
locations.resources
entities.goals
```

## 环境信号

每个 NPC 会在 desire profile 中写入：

```text
profile.environment
```

字段包括：

```text
locationId
cityId
cityRisk
economyRisk
pricePressure
populationRisk
disasterRisk
resourceRisk
migrationAppeal
localIndustryStalled
safeLocationId
totalRisk
```

## 新增目标类型

```text
seek_shelter        避灾，移动到更安全地点
migrate             迁徙，离开高风险城市
stockpile_resource  囤积资源，例如食物
gather_resources    采集资源
find_work           找工作，缓解经济压力
support_city        支援城市，降低城市风险\```

## 行动映射

```text
seek_shelter  -> move
migrate       -> move
stockpile     -> gather
find_work     -> work
support_city  -> work
gather        -> gather
```

## 触发条件

```text
城市风险高          -> seek_shelter / migrate / support_city
灾害风险高          -> seek_shelter
食物和水短缺        -> stockpile_resource / gather_resources
经济风险高          -> find_work
价格压力高          -> stockpile_resource
本地产业停摆        -> find_work
安全地点存在        -> migrate / seek_shelter
```

## 确定性修复

本层同时将目标 ID 和目标记忆 ID 迁移到世界级确定性 ID，避免 `Date.now` 和 `Math.random` 造成重放漂移。

## 后续方向

```text
1. 让 opportunity-engine 读取同一套环境信号，生成公共机会
2. 让治理系统响应大规模避灾和迁徙
3. 让贸易系统响应囤积和价格套利
4. 让组织系统吸纳失业者和灾民
5. 增加多步路径迁徙和安全路线选择
```
