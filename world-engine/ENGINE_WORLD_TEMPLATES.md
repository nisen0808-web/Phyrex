# 用配置创建正式引擎世界

现在可以用一份 UTF-8 JSON 配置建立自己的地点、道路、初始人物、组织、资源、行动收益和初始商店，生成可导入 PostgreSQL 的全新存档。此入口用于管理员在受信任环境创建新世界；不会连接数据库、覆盖已有文件或重置运行中的世界。

## 从中文样例开始

从仓库根目录运行。Windows 使用 `npm.cmd`，macOS/Linux 使用 `npm`。

```sh
npm ci --prefix world-engine --ignore-scripts
npm --prefix world-engine run engine:template -- --input templates/river-valley.json
npm --prefix world-engine run engine:init -- --template-file templates/river-valley.json --world-id my-valley --seed my-valley-v1 --output output/my-valley.json
```

请先创建 `world-engine/output/` 目录。`npm --prefix world-engine run` 的参数相对 `world-engine/` 解析。复制 `templates/river-valley.json` 后可修改中文名称、道路、资源和人物；原样例提供河畔村庄、松林、石岭关、四位人物、两个组织与村庄商店。旧 `templates/tiny-island.json` 也可以通过此入口生成。

检查成功输出 `valid: true` 和所选模板的数量摘要。错误报告给出字段位置、稳定错误码和中文原因，不回显错误字段值；退出码为 1。JSON 格式/编码错误、文件超限或文件读取失败返回通用安全错误，不包含文件内容。`--output NEW_REPORT` 可将校验结果写入一个尚不存在的报告文件。仅校验不生成世界、不推进 tick。

多模板包必须使用 `--template-id` 明确选择；整个包都必须有效，不能把损坏模板隐藏在未选择项中。初始化时允许 `--world-id` 和 `--seed` 覆盖目标身份；不能混用固定样例的 `--population`、`--commerce` 或 `--player-rules` 参数。模板的 `playerRules` 使用现有服务端行动规则约束。

生成后按 [ENGINE_QUICKSTART.md](ENGINE_QUICKSTART.md) 配置专用数据库/schema、执行 migrations 并导入。首次导入使用 `--expected-revision 0` 和新的请求编号；发现目标世界已存在时停止，不能用现有 revision 覆盖试用世界。之后创建账户、绑定内置的 `observer` 玩家、发行会话，再启动 `engine:serve`。生成文件没有账户或令牌。

```sh
npm --prefix world-engine run database:postgres -- import --input output/my-valley.json --expected-revision 0 --request-id bootstrap-my-valley
```

## 配置范围

格式沿用已有模板的 `{ id, name, version, definition }`，也接受含 `schemaVersion: 1`、`packId`、`packName`、`templates` 的包。正式入口有严格字段白名单，历史演示 API 的任意字段不会被静默接受。

| 字段 | 用途与边界 |
|---|---|
| definition.world | id、seed、可选 calendar；日历字段按实际边界校验 |
| definition.locations | 1–128 个；id、name、type、resources、danger、tags |
| definition.connections | 最多 2048 条 `[起点ID, 终点ID]` 双向道路；拒绝缺失地点、自环、重复与反向重复 |
| definition.entities | 最多 1000 位；id、name、species、locationId、traits、stats、resources、demographics、tags |
| definition.organizations | 最多 128 个；id/key、type、name、leaderId、homeLocationId、currency、members、roles |
| definition.organizationRelations | 最多 512 条有向 ally/rival；value 为 1–100，默认 50；拒绝无效引用与重复别名关系 |
| definition.resources | 世界级资源；有限、非负数值 |
| observerLocationId | 观察者初始地点；默认第一处地点 |
| starterShops | 最多 8 个地点；由现有商店规则生成初始商品，不引入新的商品规则 |
| playerRules | 现有行动规则，例如 workYield、gatherYield；见 PLAYER_ACTION_RULES.md |
| seedTicks | 0–100，默认 0；初始化完成后使用正式确定性运行器预推进 |

ID 为 1–128 位 ASCII 字母、数字、下划线、点或短横线，以字母或数字开头；拒绝原型保留键。人物不能占用 `observer_character_正整数` 编号空间，以免阻塞内置 observer 玩家创建角色。名称支持中文。每包最多 16 个模板，输入上限 1 MiB，诊断最多 64 条。数值不接受字符串转换、NaN、Infinity、负资源或生命高于上限。角色初始为存活；demographics 只接受 age、sex、generation，不能伪造已有家族或死亡历史。

组织显式 id 优先，否则使用 key 作为实际 id。成员必须存在，首领角色固定为 leader，其他成员只可为 member/student。全部组织编号与别名先校验，再构建索引；不会跳过错误成员或关系。

此入口固定采用 ENGINE_V1_PROFILE 的长期运行与历史保留配置，不接受任意 simulation、脚本、账户、会话、玩家归属、元数据或历史动作注入。自定义种族/物品定义、运行中热编辑和网页编辑器尚不属于此入口；需要更底层定制时使用受信任 SDK。容量上限不是满规模性能保证，较大世界或预推进应先运行 `engine:profile` 测量。

## SDK 与一致性

```js
const engine = require('./world-engine');
const pack = require('./world-engine/templates/river-valley.json');
const check = engine.validateEngineTemplate(pack);
if (!check.valid) throw new Error(JSON.stringify(check.issues));
const world = engine.createEngineWorldFromTemplate(pack, { worldId: 'my-valley', seed: 'my-seed' });
```

校验不修改输入；构建先完成整个配置校验，再建立独立候选世界。保存模板编号、版本、格式与有效配置摘要。相同配置和 seed 的世界内容一致，文件外层保存时间不同不算世界内容差异。最终存档上限仍为 32 MiB。

不新增 SQL migration，不改变 runtime v5 或 postgres-inventory-v4。导入后继续使用现有 revision fence、授权、限流、幂等、提交后发布和重试不重放。旧 `createSampleWorld` 与演示模板接口保持兼容。

验收包括错误引用/重复/容量/特殊 JSON、中文提示脱敏、确定性生成、存档恢复、CLI 禁止覆盖，以及真实 PostgreSQL 中配置生成 → 导入 → 角色创建 → 待移动命令 → 完整备份 → 空库恢复 → 新进程结算 → 同编号重试。quickstart 专项由 6 组扩为 8 组，原有全部检查保留；普通回归新增两个脚本。发布结果须核对对应提交的原始日志与 pipefail 门禁。
