# Natural World Engine

`natural-world-engine.js` 是自然世界主模块，负责给世界模拟提供历法、季节、气候、天气、资源再生和灾害压力。

## 当前能力

```text
世界历法
年、月、日、小时、季节
地点生物群系
温度、湿度、降水、肥沃度、干旱度
天气生成
地点资源容量
资源再生
天气对资源恢复的影响
灾害生成
灾害持续时间
灾害对资源的损耗
自然世界摘要
```

## 默认天气类型

```text
clear
cloudy
rain
storm
snow
drought
heatwave
cold_snap
```

## 默认灾害类型

```text
flood
wildfire
drought
blizzard
earthquake
pestilence
```

## 确定性管线接入

默认确定性内核会注册：

```text
natural.world
```

该系统运行在 `before` 阶段，优先级为 `100`，早于同阶段的普通扩展系统，也早于人口、经济、智能体和文明系统。

读取：

```text
locations
natural
```

写入：

```text
natural
locations
memory
```

输出报告：

```text
calendar
climate
weather
resources
disasters
```

可通过内核选项关闭：

```js
const kernel = createDeterministicSimulationKernel({
  includeNaturalWorld: false,
});
```

可通过模拟选项跳过执行，但保留系统注册和调度统计：

```js
runDeterministicSimulationTick(world, {
  simulation: {
    autoNatural: false,
  },
}, kernel);
```

## 生物群系解析

自然世界会先读取地点上的 `biome` 和 `terrain`，再读取 `meta` 里的同名字段。若通用地点 schema 没保留这些字段，就用地点名称和 ID 推断，例如 `Old Forest`、`Red Desert`、`West Coast` 会分别识别为森林、沙漠和海岸。最终兜底为 `plains`。

## 下一步

```text
1. 生态系统：物种栖息地、食物链、疾病和承载力
2. 人口系统读取天气、灾害、疾病和资源压力
3. 经济系统读取资源再生、灾害损耗和交通季节性
4. 城市系统读取水源、粮食、灾害和基础设施维护压力
5. 世界一致性检查接入自然状态和地点资源容量
```
