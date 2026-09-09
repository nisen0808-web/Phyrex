# Engine Development Progress

当前主线是 MUD 世界模拟和持久化可靠性，不继续扩展 UI、登录或部署功能。

## 当前阶段：数据库启动恢复与 CI 真实验收

本轮新增数据库启动恢复、存档结构校验、CLI 入口和 10 组专项回归，均在 PR #61 的 feature/database-startup-recovery 分支。PR 暂为草稿，未合并。

PR #60 已合并到 main（6c1b1f6c01833ccc1e71247a2a33d0e48655d383）。当时 GitHub 工作流返回 success，但随后逐行核查日志发现同样存在 5 个失败。此前仅凭绿色状态判断完整测试通过不可靠，本文件撤回该验收判断。

## 验证发现

两个 workflow 原本使用 `npm test | tee ...`，没有显式 bash / pipefail。tee 的成功退出码掩盖了测试的失败。Node 20/22 的 World Engine CI 原本也只执行根目录 npm test，未覆盖 world-engine/package.json 追加的测试链。

本分支已修正：

- 两个 workflow 使用 `defaults.run.shell: bash`，使管道失败正确传递。
- Node 20/22 完整套件执行 `npm --prefix world-engine test`。
- 数据库启动恢复专项独立执行，主回归失败不再使新专项完全未运行。
- 保留全部原有断言，未将失败测试移除、跳过或标记为容许失败。

校正后的执行结果（cab41fbdb50158b4c52089b1f3df2bd11e0e4fa4）：数据库恢复专项在 Node 20、Node 22 均通过；完整套件正确返回 failure。最后新增文档后的 CI 状态以 PR 最新 head 为准。

## 已确认的 5 个历史阻塞

这些失败同时出现在 #60 的旧 Node 22 日志和 #61 的初次 Node 22 日志，不是仅依据本次失败推测为历史问题。

| 测试 | 日志中的失败 |
|---|---|
| governance-environment-response-test.js | 6 个治理响应仅得到 1 个唯一 ID。 |
| ecology-engine-test.js | dragon 在 desert / forest 的 suitability 比较不符合断言。 |
| city-environment-pressure-test.js | 压力场景预期 maintenance gap，实际为 0。 |
| world-consistency-engine-test.js | 修复后的索引预期 ['human']，实际 undefined。 |
| world-consistency-pipeline-test.js | ecology.world 遇到 version undefined，在修复完成前失败。 |

主回归日志统计为 57 项，52 通过、5 失败。world-engine 的后续 && 测试链因此尚未完整执行，不能把所有模块都标成已经验收。上述问题本轮尚未修复。

## 当前功能进度

| 能力 | 实现状态 | 验收状态 |
|---|---|---|
| 自然、生态、人口、城市、经济、AI 环境联动 | 主干已有实现 | 生态和城市有失败，需修复后复验。 |
| 治理、过程、冲突、机会、组织联动 | 主干已有实现 | 治理响应 ID 唯一性阻塞。 |
| 信息、记忆、文化、信仰网络 | 已有模块及 runtime helper | 尚需补全默认入口和完整测试链验证。 |
| 确定性随机数与世界级 ID | 主干已有实现 | 数据库恢复专项续接通过，治理 ID 仍有问题。 |
| 一致性检查与修复 | 主干已有实现 | 两个一致性测试阻塞。 |
| JSONL 存档、事件、API 和自动保存 | 原型链路已建立 | 不等于事务化生产数据库。 |
| 数据库启动恢复 | 本轮代码与 CLI 完成 | 10 组专项在 Node 20/22 通过，#61 未合并。 |
| 数据库恢复策略 | off / if-present / required、显式 world ID、按 sequence 选择 | 专项已覆盖。 |
| 存档结构门禁 | JSON、ID、sequence、tick、schema、envelope/world 一致性 | 专项已覆盖；不替代业务 Contract。 |
| 真实进程重启 | tick 17 恢复、HTTP 推进并保存到 18、另一进程恢复 18 | 专项已覆盖。 |
| CI 失败状态传递 | 本分支已修复 | 已观察到正确的红色失败结果。 |
| SQLite / PostgreSQL | 仅有配置占位 | 驱动、真实连接、事务与迁移尚未实现。 |
| 备份、并发写、容量和灾备 | 尚未完成生产方案 | 尚未验收。 |
| 文明、科技、基础设施 | 基础模块已存在 | 扩散、依赖网络、时代演化待深化。 |

## 进度口径

早期 75%、88%、96%、100% 等数字属于各模块原定范围的粗略估算，没有统一分母，并非自动测量或生产验收。数据库此前 96% 仅反映 JSONL 原型及管理入口，不能代表关系数据库完成。现阶段以实现范围、实际执行结果和阻塞问题记录进度。

## 主要文件

```text
core/database-startup-engine.js
core/database-engine.js
demo/api-server.js
tests/database-startup-recovery-test.js
package.json
.github/workflows/world-engine-ci.yml
.github/workflows/world-engine-tests.yml
DATABASE_STARTUP_RECOVERY.md
CI_VALIDATION_STATUS.md
```

## 后续顺序

先修复这 5 个历史失败并跑完完整测试链，再允许合并 #61。主回归可靠后推进实际关系数据库、事务化存档和并发写保护，随后回到文明科技扩散与默认模拟管线收敛。
