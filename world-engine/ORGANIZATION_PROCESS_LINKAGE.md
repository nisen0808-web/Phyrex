# Organization Process Linkage

本层让 `organization-engine` 读取活跃的 `governance_response` 过程，并把公共过程转成组织层面的成员吸纳、能力调整和组织记忆。

## Pipeline

```text
governance process execution
-> organization process linkage
-> organization goals and stats
```

组织系统会在 `processOrganizationsTick` 中先读取关联过程，再执行原有组织目标。

## Inputs

```text
world.processes.byId[*].type = governance_response
world.governance.governments
world.organizations.byId
world.entities
```

## Role mapping

```text
relief process      -> relief_worker
logistics process   -> logistics
works process       -> worker or engineer
order process       -> guard or member
mobilize process    -> auxiliary or member
```

组织会优先选择同地点、健康状态较好，并且能力与角色匹配的实体。

## Effects

过程会影响组织状态：

```text
reputation
cohesion
authority
assets.currency
```

成员变化继续使用原有 `addOrganizationMember`，因此会自动写入组织成员关系、实体组织列表、服务契约、人生事件和组织记忆。

## Stats

组织统计新增：

```text
world.organizations.stats.processLinkedRecruits
world.organizations.stats.processSupportActions
```

组织记忆新增：

```text
organization.process_link
```

## Tests

新增测试：

```text
organization-process-linkage-test.js
```

覆盖内容：

```text
1. 组织可以读取关联治理过程。
2. 组织会根据过程类型吸纳不同角色。
3. 组织 reputation、authority、cohesion 等状态会随过程变化。
4. 组织记忆和统计会记录过程联动。
5. deterministic modular pipeline 中 social.organizations 可以执行该联动，且 Contract 零违规。
```
