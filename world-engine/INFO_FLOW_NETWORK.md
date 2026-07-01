# Info Flow Network

本层为信息、记忆、文化和信仰系统增加一个可审计的信息流网络。

## Core module

```text
world-engine/core/info-flow-engine.js
```

主要能力：

```text
processInfoFlowTick(world, options)
buildInfoFlowLinks(world, options)
shareInformationAcrossLinks(world, links, options)
consolidateInformationMemories(world, options)
applyInformationCultureInfluence(world, options)
applyInformationReligionLinks(world, options)
```

## State

运行状态写入：

```text
world.infoFlow
```

结构包括：

```text
version
links
events
stats.linksCreated
stats.informationShared
stats.memoriesCreated
stats.cultureInfluences
stats.religionLinks
```

## Link model

当前网络会构建以下 owner 链接：

```text
entity -> entity，同地点实体之间
entity -> organization，成员到组织
organization -> entity，组织到成员
entity -> city，实体到所在城市
city -> entity，城市到本地实体
organization -> city，组织到所在城市
```

链接只描述传播路径，不直接改变模拟状态。状态改变由后续阶段完成。

## Pipeline

`processInfoFlowTick` 分为四步：

```text
1. buildInfoFlowLinks
2. shareInformationAcrossLinks
3. consolidateInformationMemories
4. applyInformationCultureInfluence
5. applyInformationReligionLinks
```

## Effects

信息流可以产生三类后续影响：

```text
1. 高置信信息会成为 owner memory。
2. 城市和组织会根据信息标签调整文化 traits。
3. 本地实体接触到 ritual、religion、faith、ancestor 等信息后，可以与本地信仰建立连接。
```

## Test

新增测试：

```text
info-flow-test.js
```

测试覆盖：

```text
同地点信息共享
实体到组织和城市的信息共享
信息沉淀为记忆
信息影响城市文化
本地信仰连接
infoFlow events 和 stats
```
