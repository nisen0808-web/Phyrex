# Culture Belief Flow

本层为文化和信仰增加独立的扩散网络。

## Core module

```text
world-engine/core/culture-belief-flow-engine.js
```

主要能力：

```text
processCultureBeliefFlowTick(world, options)
buildCultureBeliefLinks(world, options)
applyCultureTraitTransfers(world, links, options)
applyBeliefCultureInfluence(world, options)
linkBeliefOrganizations(world, options)
```

## State

运行状态写入：

```text
world.cultureBeliefFlow
```

结构包括：

```text
version
links
events
stats.linksCreated
stats.cultureTransfers
stats.beliefCultureInfluences
stats.organizationLinks
```

## Links

当前网络会构建以下链接：

```text
city culture -> organization culture
organization culture -> city culture
belief -> city culture
city culture -> belief
belief -> organization culture
```

## Effects

本层会产生三类效果：

```text
1. 城市和本地组织之间转移文化 traits。
2. 本地信仰会强化城市的 faith、legacy、order 等 traits。
3. 教会或高 faith 组织会接入本地信仰 organizationIds。
```

## Test

新增测试：

```text
culture-belief-flow-test.js
```

覆盖：

```text
城市到组织文化传播
组织到城市文化传播
信仰影响城市文化
组织接入信仰网络
cultureBeliefFlow events 和 stats
```
