# 真实运行剖析与确定性性能优化

本页记录第一批优化。基于 441d2d0 的下一批索引、连接选择与状态复制优化，见 [KNOWLEDGE_SCALE_PERFORMANCE.md](KNOWLEDGE_SCALE_PERFORMANCE.md)。

此层承接 a89b0e0 的单写引擎 v1，优化人口增长后的重复计算，并提供独立的真实耗时诊断。原 PERFORMANCE_BUDGET.md 的 load 是确定性估算，不能解释为毫秒；新工具使用实际单调时钟，数据只进入诊断报告。

## 已实现的优化

1. 记忆保留：已排好且未超上限的 owner bucket 不重复排序/构造集合；全局仅超出一条时，线性寻找最后一个最低分记录，保持旧稳定排序的并列取舍；批量超限和不规则输入保留原算法回退。清理仍删除无效引用，不放大容量上限、不减少记忆事件。
2. 欲望更新：在一个不会修改关系表的阶段内，按原边顺序一次累计参与者的关系分数，替代每个人重新扫描全部边。自环只计一次，浮点相加顺序不变，阶段结束即丢弃结果，不缓存到下一个 tick。单独调用 updateDesireProfile 仍读取当前关系表。
3. 状态规范化：每次遍历只解析一次 hash options，不为每个叶节点重复复制配置；特殊值、Map/Set、路径排除与循环错误语义保持原样。

没有跳过任何模拟系统、减少出生率、改变随机流、关闭状态摘要或放宽数据库容量/一致性门禁。

## 本地实测

同一台 Windows、Node 22.23.3；128 个创始人物，seed 为 performance-population-128-v1，world ID 为 performance-world。先生成相同的第 20 tick 世界，再分别在旧版本 a89b0e0 和新版本推进 10 tick。两组各运行三次，不同时运行其他本地测试，计时区间不含启动、文件读取和最终摘要计算。

| 版本 | 第一次 ms | 第二次 ms | 第三次 ms | 中位数 ms |
|---|---:|---:|---:|---:|
| a89b0e0 | 17,251.697 | 17,488.765 | 18,365.483 | 17,488.765 |
| 本层优化 | 5,757.873 | 5,931.606 | 5,778.896 | 5,778.896 |

此场景中位数约 **3.03 倍速度，耗时减少 66.96%**。六次输出均为 7,237,808 bytes，完整世界 SHA-256 均为：

```text
acabe58e74fca86311df627ffdc15c524ebadb1c53b120514c482e1305594aae
```

这是具体场景、具体硬件的测量，不是所有世界的通用倍数或线上服务承诺。数据库提交、网络、API 延迟不在该纯演化计时区间内。初始 CPU 采样还包括 20 tick 预热，不把其总耗时拿来与只测 10 tick 的结果比较。

## 剖析命令

从仓库根目录执行，Windows 用 npm.cmd，其他系统用 npm。output 目录应先存在。

```sh
npm --prefix world-engine run engine:init -- --output output/profile-world.json --world-id performance-world --population 128 --seed performance-population-128-v1
npm --prefix world-engine run engine:profile -- --input output/profile-world.json --warmup 20 --ticks 10 --output output/runtime-profile.json
```

以上真实 CLI 已实际执行，结束摘要与上述对照一致。也可以直接生成一个诊断世界：

```sh
npm --prefix world-engine run engine:profile -- --population 12 --seed diagnostic-example --ticks 10 --output output/new-profile.json
```

输入为本地存档（现有 save envelope 或旧版裸 world），上限 32 MiB，拒绝未知 future schema。--input 不可与 --population/--seed 混用。ticks 为 1–1000，warmup 为 0–1000，生成世界 population 为 2–1000。输出必须是新文件；不覆盖原存档或已有报告。复杂世界选择较小 ticks 开始，因为离线诊断也需要实际执行全部系统。

工具复制世界后运行，不连接数据库，不推进业务运行器，不修改输入文件。报告只包含规模、摘要和时间指标，不写出世界内容、账户或会话数据。programmatic profileEngineWorld 的返回值还包含演化后的内存副本，CLI 只序列化 report。

## 报告口径

- start/end：tick、实体总数、存活数、序列化字节数、完整状态摘要。
- warmupMs：预热耗时；elapsedMs：测量阶段的总时间，不包含读取/复制、开始/结束摘要等准备工作。
- normalizationMs：每 tick 修复与排序捕获，用于保持 JSONB 恢复顺序一致。
- simulationMs：整个确定性 tick，包括系统、scheduler 与摘要。
- systemsMs / systems：各系统调用体及契约验证的耗时和调用数、失败数、平均与最大值。
- schedulerAndIntegrityMs：simulationMs 扣除系统调用体，包含 scheduler 管理、结果摘要和整世界摘要等开销。
- samples：每个 tick 的上述分项；min/median/p95/max 基于 tick 总时间，采用 nearest-rank 分位数。

systemsMs 是 simulationMs 的组成部分，不能把两者相加。分项都是外部测量，不进入 world、调度报告、数据库或随机决策，因此 profileEngineWorld 与 advanceDeterministicBatch 的完整状态必须一致。跨机器耗时不能直接比较；报告包含 Node 版本、平台和架构。

## 验证

本地完整发现回归 108/108。新增：

- 1000 个确定性输入、每个三轮记忆保留，与冻结的 a89b0e0 算法逐项比较删除顺序、剩余记录和 owner 引用；覆盖分数并列、缺失/重复引用、特殊上限和非有限输入回退。
- 欲望阶段对照旧逐实体扫描，覆盖自环、浮点数累加、死亡人物与两次调用之间的关系修改。
- canonical integrity 对照旧实现，覆盖特殊类型、共享引用、排除规则和循环路径错误。
- 剖析工具验证世界副本完全相同、原输入不变、时间不进入状态、报告无原始数据、CLI 参数边界和不覆盖文件。
- 六组 Node 20/22 scale 门禁在既有容量/恢复断言上增加固定的 v1 全世界摘要；优化不能改变任一字段。普通回归、100/1000 tick、全部真实 PostgreSQL 与多进程 endurance 保留。

最终 CI 状态和日志以对应交付提交的证据为准；ENGINE_ACCEPTANCE.md 中的 106/106 是上一版本历史基线。本层没有改变任何 PostgreSQL migration。
