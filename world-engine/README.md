# Universal World Engine

这是一个主题无关的世界引擎，不直接绑定修仙、废土、赛博朋克或神学题材。

它只负责模拟世界：

- 时间如何推进
- 地点如何连接
- 实体如何行动
- 关系如何变化
- 资源如何流动
- 事件如何发生
- 因果如何积累
- 阵营如何冲突
- 世界如何在没有玩家操作时继续演化

主题只负责解释这些抽象概念。

例如同一个 `energy`：

- 修仙主题叫灵气
- 废土主题叫体力或辐射抗性
- 赛博朋克主题叫电量或神经负载
- 神学主题叫信仰或圣力

同一个 `faction`：

- 修仙主题叫宗门
- 废土主题叫聚落
- 赛博朋克主题叫公司或帮派
- 神学主题叫教会或异端组织

## 目录

```text
world-engine/
  core/
    schema.js
    world-engine.js
    action-engine.js
    event-engine.js
    causality-engine.js
    relationship-engine.js
    faction-engine.js
    resource-engine.js
    combat-engine.js
  themes/
    xianxia/theme.js
    wasteland/theme.js
    cyberpunk/theme.js
    theology/theme.js
  examples/
    xianxia-demo.js
  docs/
    architecture.md
```

## 核心目标

第一目标不是做一个界面，而是做一个可以被任何前端、桌面端、移动端或服务器调用的世界模拟核心。

UI 只读取世界状态，不直接决定世界逻辑。

## 当前版本

V0.1 Universal Engine Skeleton

已包含：

- 世界创建
- 时间推进
- 实体注册
- 地点注册
- 行为执行
- 关系变化
- 资源变化
- 随机事件
- 因果记录
- 主题适配
