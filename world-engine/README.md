# Persistent Civilization Simulator / Universal World Engine

这是一个主题无关的持续运行世界模拟器。

它不是为了服务单独玩家的传统 RPG，也不是一个只在玩家上线时才运转的游戏世界。它的核心目标是创建一个即使没有任何玩家参与，也会持续运行、持续演化、持续产生历史、传奇和小说的文明模拟器。

玩家不是世界中心，玩家只是进入这个世界的一个 Character。NPC 也不是“配角”，所有角色都是自己人生的主角。区别只在于控制权：有些 Character 由 AI 决策，有些 Character 由玩家控制。

最终目标不是“创造剧情”，而是创造一个会自己产生剧情的世界。

---

## 核心原则

### 1. World First

世界优先于游戏。

任何系统都必须通过一个检验：如果没有玩家，这个系统是否还能继续运行？

如果不能，说明这个系统仍然是玩家中心设计；如果能，才符合持续文明模拟器的目标。

例如：

- 人口会自己出生、成长、死亡。
- 家族会自己延续、衰落、灭亡。
- 组织会自己招募、扩张、分裂、解散。
- 经济会自己生产、消费、涨价、短缺。
- 城市会自己成长、衰落、升级。
- 历史会自己沉淀。
- 传奇会从历史里自然出现。
- 小说只是历史和传奇的副产品。

### 2. Character, not NPC

世界里不应该从底层区分 Player 与 NPC。

所有人都是 Character。

玩家只是控制权来自玩家的 Character；其他人是控制权来自 AI / Simulation 的 Character。

因此：

- 玩家死亡不是 Game Over，只是一个 Character 的死亡事件。
- 玩家后代可以继续存在。
- 玩家家族可以继续发展。
- 玩家不在线时，世界继续运行。

### 3. Every Character is the Protagonist of Their Own Life

每一个人都是自己故事的主角。

每个 Character 都拥有：

- 出生
- 年龄
- 种族
- 家族
- 关系
- 目标
- 梦想
- 行为
- 记忆
- 历史
- 传记

但不是每个人都会被写成小说。

系统会根据 Narrative Score 自动判断谁值得进入图书馆，谁值得写传记，谁值得写长篇小说，谁值得写成世界级史诗。

### 4. Civilization over Character

人物会死亡，文明会继续。

世界的长期主角不是某一个人，而是：

- 家族
- 组织
- 城市
- 国家
- 种族
- 文明

一个人物死后，财富、声望、债务、仇恨、梦想和权力可以通过 Legacy Engine 继续传递给后代或继承人。

### 5. Novel is Output, not Input

小说不是世界的原因，小说是世界运行后的结果。

正确链路是：

```text
World Simulation
↓
Population / Family / Organization / Economy / City / Contract / Legacy
↓
Event
↓
History
↓
Narrative Score
↓
Novel Blueprint
↓
Library / Reader
```

不是为了小说设计世界，而是让世界自然产生历史，再从历史里长出小说。

### 6. Theme Pack is Skin

修仙、废土、赛博朋克、神学、中世纪、星际等都只是主题包。

底层统一使用抽象概念：

- Entity / Character
- Species
- Location
- Settlement
- Family
- Organization
- Contract
- Resource
- Industry
- Event
- History
- Narrative
- Novel

例如同一个概念在不同主题中的解释：

```text
energy
- 修仙：灵气
- 废土：体力 / 辐射抗性
- 赛博朋克：电量 / 神经负载
- 神学：信仰 / 圣力

organization
- 修仙：宗门
- 废土：聚落 / 军阀
- 赛博朋克：公司 / 帮派
- 神学：教会 / 异端组织

contract
- 修仙：师徒、主仆、灵兽契约
- 废土：雇佣、奴役、保护契约
- 赛博朋克：公司雇佣、债务绑定、实验体协议
- 神学：信徒契约、教会契约、誓约
```

---

## 当前目录

```text
world-engine/
  README.md
  core/
    schema.js
    world-engine.js
    goal-engine.js
    action-engine.js
    relationship-engine.js
    event-engine.js
    population-engine.js
    family-engine.js
    legacy-engine.js
    species-engine.js
    contract-engine.js
    organization-engine.js
    economy-engine.js
    city-engine.js
    history-engine.js
    narrative-score-engine.js
    novel-engine.js
    simulation-engine.js
```

---

## 已开发核心引擎

### 1. Schema Engine

文件：`core/schema.js`

定义世界最底层的数据结构。

包括：

- World State
- Entity
- Location
- Faction / Organization 基础结构
- Event
- Action
- Relationship
- 通用工具函数

Schema Engine 是所有模块共享的数据协议层。

---

### 2. World Engine

文件：`core/world-engine.js`

负责创建和管理世界状态。

能力：

- 创建世界
- 注册实体
- 注册地点
- 连接地点
- 注册阵营 / 组织基础
- 推进世界时间
- 维护世界日历
- 移动实体
- 修改实体资源
- 修改实体属性
- 记录世界记忆
- 记录因果
- 维护地点索引和组织索引

World Engine 不是游戏逻辑层，而是世界状态容器和基础操作层。

---

### 3. Goal Engine

文件：`core/goal-engine.js`

负责让每个 Character 拥有目标。

目标分为三层：

```text
Need
Goal
Dream
```

当前支持：

- survive
- recover
- gain_resources
- build_relationship
- gain_power
- lead_faction

能力：

- 给实体分配目标
- 自动种下默认目标
- 计算目标完成度
- 目标完成后生成后续目标
- 从目标生成 Action Intent
- 为所有实体规划行为

核心链路：

```text
Goal
↓
Action Intent
↓
Action Queue
```

Goal Engine 是世界自我驱动的基础。如果没有目标，世界就只是随机模拟器；有了目标，人物才会有“人生”。

---

### 4. Action Engine

文件：`core/action-engine.js`

负责执行行为。

当前支持：

- move
- gather
- rest
- work
- interact
- transfer
- damage

能力：

- 处理 Action Queue
- 检查行为前置条件
- 执行行为
- 生成事件
- 产生资源变化
- 产生状态变化

Action Engine 不直接写故事，它只负责把目标转化为世界事实。

---

### 5. Relationship Engine

文件：`core/relationship-engine.js`

负责实体之间的关系。

关系维度：

```text
affection   好感
trust       信任
fear        恐惧
hatred      仇恨
debt        债务
loyalty     忠诚
```

能力：

- 获取关系
- 修改关系
- 根据事件自动修改关系
- 关系衰减
- 关系传播
- 计算合作意愿
- 计算敌意
- 计算防备程度
- 计算义务感

关系不是单纯好感度，而是社会结构的基础。

---

### 6. Event Engine

文件：`core/event-engine.js`

负责事件处理。

能力：

- 处理 pending events
- 将事件标记为 resolved / cancelled
- 根据事件修改关系
- 记录事件记忆
- 记录因果
- 生成后续连锁事件
- 支持随机世界事件

核心链路：

```text
Action
↓
Event
↓
Relationship
↓
Causality
↓
New Event
```

Event Engine 让世界开始出现因果链，而不是孤立日志。

---

### 7. Population Engine

文件：`core/population-engine.js`

负责人口生命周期。

每个实体拥有 Demographics：

```text
birthTick
deathTick
age
ageGroup
sex
generation
fatherId
motherId
childrenIds
fertility
lifeExpectancy
familyId
```

能力：

- 初始化人口属性
- 年龄推进
- 判断年龄阶段
- 自然死亡
- 生育
- 创建子代
- 继承父母特质
- 人口统计

人口阶段：

```text
child
youth
adult
elder
```

这是世界从静态 NPC 集合变成生命系统的关键。

---

### 8. Family Engine

文件：`core/family-engine.js`

负责血缘与家族。

Family 拥有：

- 创始人
- 建立时间
- 世代
- 财富
- 声望
- 成员
- 长老
- 继承人
- 家族传统
- 盟友
- 宿敌
- 家族记忆

能力：

- 创建家族
- 分配成员
- 从人口系统同步家族
- 自动选择继承人
- 自动选择长老
- 计算家族财富
- 计算家族声望
- 记录家族记忆
- 判断家族存续或灭亡
- 生成家族编年史

Family Engine 让人物死亡后，血缘和家族继续存在。

---

### 9. Legacy Engine

文件：`core/legacy-engine.js`

负责死亡后的传承。

Legacy Record 保存：

- 财富
- 物品
- 关系
- 梦想
- 声望
- 家族地位
- 未完成目标

能力：

- 为近期死亡者创建遗产记录
- 选择继承人
- 继承资源
- 继承关系
- 继承仇恨
- 继承债务
- 继承忠诚
- 继承梦想
- 继承声望
- 处理遗产纠纷
- 查询个人遗产史
- 查询家族遗产史

Legacy Engine 让死亡不再是终点，而是下一代故事的起点。

---

### 10. Species Engine

文件：`core/species-engine.js`

负责多种族世界。

默认种族：

```text
human
spirit_beast
demon
dragon
```

每个 Species 定义：

- 成年年龄
- 老年年龄
- 平均寿命
- 最大寿命
- 繁殖率
- 死亡倍率
- 基础特质
- 文化倾向
- 可繁殖对象
- 驯化能力
- 被驯化能力

能力：

- 注册种族
- 给实体分配种族
- 应用种族默认值
- 判断种族兼容性
- 设置种族关系
- 查询种族关系
- 应用种族关系偏置
- 统计各种族人口

Species Engine 让世界不再默认是人类社会，而是多种族文明模拟器。

---

### 11. Contract Engine

文件：`core/contract-engine.js`

负责契约与权力结构。

支持契约类型：

```text
employment       雇佣
apprenticeship   师徒
service          主仆
bond             绑定 / 奴役 / 强制义务
vassalage        附庸
 domestication    驯化
alliance         联盟
marriage         婚约
```

每个 Contract 拥有：

- controller
- subject
- authority
- protection
- obligations
- rights
- duration
- compliance
- satisfaction
- dependency

能力：

- 创建契约
- 创建驯化契约
- 处理契约 Tick
- 判断到期
- 判断违约
- 处理破裂
- 处理取消
- 处理完成
- 根据契约修改关系
- 计算权力分数
- 查询实体契约

Contract Engine 将主人、仆从、师徒、雇佣、附庸、驯化、婚姻等统一为一种可模拟的社会关系。

---

### 12. Organization Engine

文件：`core/organization-engine.js`

负责跨家族组织。

支持组织类型：

```text
guild      商会
sect       宗门 / 学派
gang       帮派
state      国家 / 政权
church     教会
company    公司
school     学院
house      贵族家族组织
```

组织拥有：

- 类型
- 领袖
- 成员
- 角色
- 资产
- 声望
- 权威
- 凝聚力
- 文化
- 目标
- 盟友
- 敌人
- 记忆

能力：

- 创建组织
- 添加成员
- 移除成员
- 自动招募
- 处理组织目标
- 自动积累财富
- 自动扩大影响力
- 组织衰退
- 组织解散
- 组织关系
- 组织编年史

Organization Engine 让世界从个人和家族进入社会结构层。

---

### 13. Economy Engine

文件：`core/economy-engine.js`

负责资源、行业、市场和价格。

基础资源：

```text
food
wood
stone
metal
fuel
luxury
knowledge
service
currency
```

行业类型：

```text
agriculture
mining
craft
trade
service
entertainment
education
religion
```

能力：

- 创建市场
- 创建产业
- 产业生产
- 产业销售
- 人口消费
- 市场价格更新
- 供需变化
- 交易记录
- 组织自动生成产业
- 市场快照

Economy Engine 让世界拥有资源短缺、价格变化、产业扩张和财富流动。

---

### 14. City Engine

文件：`core/city-engine.js`

负责聚落和城市演化。

Settlement 类型：

```text
camp
village
town
city
metropolis
capital
```

城市由人口自动形成。

阈值：

```text
1       camp
50      village
500     town
5000    city
50000   metropolis
120000  capital
```

每个 Settlement 拥有：

- 人口
- 财富
- 基础设施
- 治安
- 文化
- 市场
- 统治组织
- 组织列表
- 产业列表
- 城市记忆

能力：

- 创建聚落
- 从世界人口同步城市
- 城市升级
- 城市衰落
- 计算城市财富
- 计算城市治安
- 接入组织
- 接入产业
- 生成城市编年史

City Engine 让 Location 从静态地点变成会成长、衰退、记录历史的文明节点。

---

### 15. History Engine

文件：`core/history-engine.js`

负责将世界记忆转化为人生节点。

不是普通日志系统。

Life Event 类型：

```text
birth
goal_assigned
goal_completed
moved
worked
gathered
rested
relationship_changed
resource_transferred
damaged
death
world_event
```

能力：

- 创建 Life Event
- 记录 Life Event
- 从 World Memory 摄取历史
- 将事件转成人生节点
- 推断人生阶段
- 生成 Life Arc
- 查询人物传记
- 汇总传记

Life Stage：

```text
origin
youth
growth
peak
decline
```

History Engine 是小说、传记、传奇度和图书馆的基础。

---

### 16. Narrative Score Engine

文件：`core/narrative-score-engine.js`

负责判断谁值得被写成小说。

评分来源：

- 人生事件总重要度
- 重大事件数量
- Arc 多样性
- 目标完成数量
- 梦想完成数量
- 关系网络
- 敌意网络
- 因果权重
- 组织 / 家族影响力
- 生存跨度
- 死亡节点

小说等级：

```text
none          不选中
biography     传记，约 3 万字
short_novel   短篇小说，约 20 万字
long_novel    长篇小说，约 100 万字
epic          史诗，约 500 万字
world_legend  世界传奇，约 1000 万字
```

能力：

- 计算单个实体传奇度
- 计算全部实体传奇度
- 获取传奇榜
- 获取小说候选池
- 解释传奇度原因

Narrative Score Engine 实现“每个人都是自己人生的主角，但只写最厉害的人”。

---

### 17. Novel Engine

文件：`core/novel-engine.js`

负责将人物历史和传奇度转成小说蓝图。

不是直接生成正文。

Novel Blueprint 包括：

- 小说 ID
- 主角
- 标题
- 状态
- 小说等级
- 目标字数
- 当前估计字数
- 预计章节数
- 主题
- Premise
- Volume
- Chapter Blueprint
- Supporting Characters
- Major Conflicts
- Source Events

小说状态：

```text
serializing
completed
paused
not_started
```

能力：

- 创建或更新小说蓝图
- 批量更新小说蓝图
- 自动生成工作标题
- 构造 Premise
- 推断主题
- 根据 Life Arc 生成卷
- 根据事件生成章节蓝图
- 发现配角
- 发现重大冲突
- 维护图书馆条目

Novel Engine 是历史的阅读接口，而不是世界的主因。

---

### 18. Simulation Engine

文件：`core/simulation-engine.js`

负责统一世界循环。

这是目前最关键的总调度层。

Simulation Loop：

```text
Population
↓
Family
↓
Legacy
↓
Goal Planning
↓
Action Queue
↓
World Tick
↓
History
↓
Narrative
↓
Novel
↓
Next Tick
```

能力：

- 初始化模拟
- 推进单 Tick
- 推进多 Tick
- 自动处理人口
- 自动同步家族
- 自动处理遗产
- 自动生成行动计划
- 自动推进世界
- 自动摄取历史
- 定期更新传奇度
- 定期更新小说蓝图
- 输出模拟报告

Simulation Engine 是“即使所有玩家离开，世界依旧运行”的技术实现。

---

## 当前已经形成的核心链路

### 个体链路

```text
Species
↓
Character
↓
Need / Goal / Dream
↓
Action
↓
Event
↓
Relationship
↓
History
↓
Narrative Score
↓
Novel Blueprint
```

### 文明链路

```text
Population
↓
Family
↓
Legacy
↓
Organization
↓
Contract
↓
Economy
↓
City
↓
History
↓
Narrative
↓
Novel
```

### 世界循环

```text
World Tick
↓
Population changes
↓
Family / Legacy changes
↓
Organizations act
↓
Economy produces and consumes
↓
Cities grow or decline
↓
Events are recorded
↓
History is formed
↓
Legendary figures emerge
↓
Novels are updated
```

---

## 已找回并固化的设计方向

### 世界不是为单独玩家服务

这个模拟器不是为了服务一个玩家，而是给玩家提供一种人生选择。

玩家可以成为：

- 商人
- 学者
- 领主
- 冒险者
- 家族成员
- 组织成员
- 统治者
- 附庸
- 被契约约束者
- 普通人

但无论玩家选择什么，世界都不会围绕玩家旋转。

### 玩家只是进入世界

世界先存在，玩家只是进入其中。

玩家可以改变世界，但世界不依赖玩家。

### 生命可以跨代

玩家死亡后，后代可以继续存在。

一个玩家的体验可以从：

```text
一个人
↓
一个家庭
↓
一个家族
↓
一个组织
↓
一个国家
↓
一个文明
```

持续展开。

### 文明会自己产生历史

玩家不在时，世界仍然会：

- 出生
- 死亡
- 继承
- 结盟
- 背叛
- 组织扩张
- 组织灭亡
- 经济繁荣
- 经济衰退
- 城市成长
- 城市衰落
- 家族崛起
- 家族灭亡

### 小说只是副产品

小说不是策划写好的剧情，而是从历史里自动生长出来的长篇记录。

---

## 后续优先开发路线

### 1. Information Engine

用于模拟：

- 信息差
- 秘密
- 传闻
- 谣言
- 情报
- 知识传播

现实世界不是全知世界。谁知道什么，谁不知道什么，会直接决定商业、阴谋、战争和政治。

### 2. Memory Engine

用于模拟：

- 个人记忆
- 家族记忆
- 组织记忆
- 文明记忆
- 记忆衰减
- 记忆强化
- 创伤记忆
- 祖先记忆

History 是世界客观记录，Memory 是角色和组织主观记住的东西。

### 3. Identity Engine

用于模拟：

- 父亲
- 母亲
- 儿子
- 女儿
- 家主
- 继承人
- 长老
- 领袖
- 附庸
- 契约对象
- 组织成员
- 城市居民

身份决定权利、义务、目标和社会位置。

### 4. Culture Engine

用于模拟：

- 家族文化
- 组织文化
- 城市文化
- 种族文化
- 文明文化

文化会反过来影响 Goal Engine、Organization Engine、Economy Engine 和 Contract Engine。

### 5. Religion / Belief Engine

用于模拟：

- 祖先崇拜
- 英雄崇拜
- 神权组织
- 信仰传播
- 异端冲突
- 宗教战争

信仰不属于某个主题，任何文明都会产生信仰结构。

### 6. Industry / Trade Expansion

Economy Engine 后续应扩展：

- 多市场
- 本地价格
- 贸易路线
- 税收
- 垄断
- 商业组织
- 娱乐业
- 服务业
- 战争经济

### 7. Civilization Engine

用于将人口、家族、组织、城市、经济、文化汇聚成文明等级。

文明可能从：

```text
tribe
↓
settlement
↓
township
↓
state
↓
empire
↓
civilization
```

自然演化。

---

## 当前项目一句话定义

这是一个持续运行的文明模拟器。

它不是让玩家扮演唯一主角，而是让玩家进入一个已经存在、并且即使没有玩家也会继续运行的世界。

在这个世界里，每个人都是自己人生的主角，每个家族都有自己的历史，每个组织都有自己的兴衰，每个文明都会留下记忆，而小说只是这些真实推演历史的阅读方式。
