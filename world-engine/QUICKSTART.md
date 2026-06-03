# World Engine Quickstart

这个文件只写最短路径，方便 clone 仓库后直接运行。

## 1. 拉取代码

```bash
git clone https://github.com/nisen0808-web/Phyrex.git
cd Phyrex
```

## 2. 运行完整快速测试

在仓库根目录运行：

```bash
npm test
```

这会执行：

```text
smoke-test.js
information-memory-test.js
identity-culture-test.js
religion-civilization-test.js
desire-opportunity-test.js
process-emergence-test.js
governance-conflict-test.js
technology-infrastructure-test.js
stability-100-test.js
```

也可以进入 `world-engine` 目录运行：

```bash
cd world-engine
npm test
```

## 3. 运行 demo

在仓库根目录运行默认 100 tick demo：

```bash
npm run demo
```

也可以指定 tick 数，例如 300 tick：

```bash
node world-engine/demo/run-demo.js 300
```

在 `world-engine` 目录运行：

```bash
cd world-engine
npm run demo
```

或者：

```bash
node demo/run-demo.js 300
```

Demo 会创建一个小型修仙主题世界，包括：

```text
Qingyun City
Mist Forest
Black Iron Mine
Qingyun Sect
Black Iron Guild
Mist Forest Clan
36 个角色
组织关系
契约
城市
文明
科技
基础设施
治理
冲突
信息
记忆
过程
涌现事件
```

运行结束后会输出：

```text
World tick
Alive population
Cities
Organizations
Civilizations
Technologies unlocked
Infrastructure total / active
Governments total / unstable
Conflicts total / active
Processes total / active
World memory / 1000
Information items / 1000
Structured memories / 3000
Simulation reports / 200
Simulation counters
```

## 4. 运行 1000 tick 手动压测

默认测试不跑 1000 tick，因为部分沙箱或 CI 环境可能超时。

需要长压测时，在仓库根目录运行：

```bash
npm run stress
```

或者：

```bash
node world-engine/tests/stability-1000-test.js
```

在 `world-engine` 目录运行：

```bash
npm run stress
```

## 5. 测试策略

```text
npm test
```

用于日常开发，覆盖功能测试和 100 tick 快速稳定性测试。

```text
npm run stress
```

用于手动长周期压测，覆盖 1000 tick 稳定性。

## 6. 当前关键上限

```text
world.memory <= 1000
simulation.reports <= 200
processes.byId <= 500
information.items <= 1000
memories.byId <= 3000
```

这些限制是为了避免世界长期运行后状态无限膨胀。

## 7. 常见命令

```bash
# 根目录
npm test
npm run demo
npm run stress

# world-engine 目录
cd world-engine
npm test
npm run demo
npm run stress

# 指定 demo tick
node world-engine/demo/run-demo.js 300
node world-engine/demo/run-demo.js 1000
```
