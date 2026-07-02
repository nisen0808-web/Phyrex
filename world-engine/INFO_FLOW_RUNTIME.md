# Info Flow Runtime Integration

本层把 info-flow 网络接入 deterministic runtime。

## Files

```text
core/info-flow-system-engine.js
core/info-flow-runtime-engine.js
tests/info-flow-runtime-test.js
```

## System

新增 modular pipeline system：

```text
knowledge.info_flow
```

默认 phase：

```text
knowledge
```

默认顺序：

```text
after knowledge.religion
before civilization.civilization
```

读写范围：

```text
reads: information, memories, cultures, religions, entities, organizations, cities
writes: infoFlow, information, memories, cultures, religions, entities
```

## Runtime helper

```text
createInfoFlowDeterministicKernel(options)
attachInfoFlowSystemToKernel(kernel, options)
runDeterministicSimulationTickWithInfoFlow(world, options, kernel)
```

这套 helper 不直接修改 deterministic runtime 主文件，而是通过现有 kernel registry 机制注册 `knowledge.info_flow`。

## Report

运行后写入：

```text
report.infoFlow
world.infoFlow
```

并更新 simulation counters：

```text
infoFlowLinks
infoFlowShared
infoFlowMemories
infoFlowCulture
infoFlowReligion
```

## Options

默认启用：

```text
autoInfoFlow !== false
```

可通过以下配置传入 info-flow 参数：

```text
infoFlow: {
  minShareScore,
  memoryConfidenceThreshold,
  cultureConfidenceThreshold,
  religionConfidenceThreshold
}
```

## Test

新增：

```text
info-flow-runtime-test.js
```

覆盖：

```text
kernel 注册 knowledge.info_flow
schedule order 包含 knowledge.info_flow
report.infoFlow 输出
信息通过 runtime 传播
本地信仰连接
```
