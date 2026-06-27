# Population Environment Pressure

人口生命周期现在会读取自然世界和生态系统，把天气、灾害、资源、疾病、承载力和栖息地压力转化为出生率和死亡率修正。

## 输入来源

```text
natural.weather.byLocation
natural.disasters.active
ecology.habitats.byLocation
ecology.populations.byKey
locations.resources
entities
species
population
```

## 压力维度

```text
weatherRisk        天气风险，例如热浪、寒潮、风暴、干旱
disasterRisk       活跃灾害风险
resourceRisk       食物和水资源短缺风险
diseaseRisk        生态系统疾病负载
overcrowdingRisk   种群超过承载力的压力
habitatRisk        当前地点对物种的栖息地不适宜程度
ecologyHealth      生态种群健康度
```

## 对人口系统的影响

```text
mortalityMultiplier  放大自然死亡率
mortalityBonus       额外死亡率加成
birthMultiplier      折减或放大出生尝试概率
```

死亡率仍保留原有年龄逻辑：儿童、老人、超过预期寿命和超过自然最大年龄都会影响死亡率。环境压力会在年龄逻辑之后叠加。

出生率仍保留原有年龄、性别、物种兼容和关系亲和度逻辑。环境压力会在出生尝试前折减出生概率。

## 输出摘要

每次 `processPopulationTick` 会返回并写入：

```text
world.population.environment
```

摘要字段：

```text
tick
entities
highRisk
averageRisk
averageMortalityMultiplier
averageBirthMultiplier
byLocation
```

## 后续方向

```text
1. 让城市系统读取 population.environment 的高风险地点
2. 让经济系统读取人口压力导致的劳动力变化
3. 让 AI 目标系统读取环境压力，触发迁徙、避灾和求助行为
4. 让疾病系统从生态种群扩展到具体角色感染状态
```
