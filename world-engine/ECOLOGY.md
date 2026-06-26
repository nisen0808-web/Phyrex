# Ecology Engine

`ecology-engine.js` 是自然世界之上的生态系统主模块，用于把气候、天气、资源和灾害转化为栖息地、种群、承载力、食物链、迁移和疾病压力。

## 当前能力

```text
地点栖息地评估
物种适宜度
种群初始化
承载力计算
种群增长和衰退
捕食关系和食物链交互
疾病风险和爆发
迁移压力
邻接地点迁移
生态摘要
```

## 默认物种生态画像

```text
human
spirit_beast
dragon
deer
rabbit
wolf
```

每个物种画像包括生态位、营养级、基础种群、基础承载力、增长率、资源需求、偏好栖息地、猎物、天敌和疾病敏感度。

## 确定性管线接入

默认确定性内核会注册：

```text
ecology.world
```

该系统运行在 `before` 阶段，优先级为 `90`，默认排在 `natural.world` 后面，早于人口、经济、智能体和文明系统。

读取：

```text
locations
entities
species
natural
ecology
```

写入：

```text
ecology
memory
```

输出报告：

```text
habitats
seeded
populations
foodWeb
disease
migration
```

可通过内核选项关闭：

```js
const kernel = createDeterministicSimulationKernel({
  includeEcologyWorld: false,
});
```

可通过模拟选项跳过执行：

```js
runDeterministicSimulationTick(world, {
  simulation: {
    autoEcology: false,
  },
}, kernel);
```

## 与自然世界的关系

`ecology.world` 会读取 `natural.world` 生成的气候、天气、灾害和地点资源。若自然世界被关闭，生态系统仍会用地点名称、资源和默认平原环境生成保守估计。

## 下一步

```text
1. 人口系统读取生态疾病、资源压力和承载力
2. 城市系统读取生态承载力和灾害压力
3. 经济系统读取生态资源再生和食物链损耗
4. 增加疾病传播网络和跨地点传播
5. 增加长期生态演替和物种灭绝事件
```
