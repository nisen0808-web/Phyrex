# Conflict Governance Process Linkage

本层让 `conflict-engine` 读取治理过程执行层产生的 `governance_response` 过程，并把治理行动映射到冲突强度变化。

## Pipeline

```text
governance.environment
-> governance process execution
-> conflict governance process linkage
```

治理响应先写入：

```text
world.governance.responseLog
```

过程系统消费后生成：

```text
world.processes.byId[*].type = governance_response
```

冲突系统会在 `processConflictTick` 中读取活跃治理过程。

## Supported process inputs

```text
security_crackdown
mobilization
```

## Effects

### security_crackdown

当活跃治理过程是 `security_crackdown`，并且冲突类型是同一政府相关的 `revolt` 时：

```text
conflict.intensity decreases
conflict.tags adds governance_suppressed
conflict.causes adds security_crackdown
conflict.memory records conflict.governance_process.suppress_revolt
```

### mobilization

当活跃治理过程是 `mobilization`，并且冲突涉及同一政府或组织时：

```text
conflict.intensity increases
conflict.tags adds governance_mobilization
conflict.causes adds mobilization
conflict.memory records conflict.governance_process.mobilize_conflict
```

## Stats

`getConflictStats(world)` now returns:

```text
governanceProcessEffects
governanceSuppressions
governanceMobilizations
```

`processConflictTick` also returns:

```text
governanceProcessEffects
```

## Test

新增测试：

```text
conflict-governance-process-test.js
```

覆盖内容：

```text
1. security_crackdown lowers related revolt intensity.
2. mobilization raises related organization conflict intensity.
3. conflict memory, tags and causes record governance process effects.
4. deterministic modular pipeline can run civilization.conflict with zero contract violations.
```
