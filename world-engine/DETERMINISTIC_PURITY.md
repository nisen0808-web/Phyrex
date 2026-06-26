# Deterministic Source Purity

`source-purity-engine.js` 用于审计核心引擎源码中的隐式随机数和系统时间调用。

## 目标

```text
核心模拟逻辑不能直接调用 Math.random
核心模拟逻辑不能直接调用 Date.now
核心模拟逻辑不能直接依赖 new Date、performance.now 或 process.hrtime
新模块应显式使用 context.random、random-engine 和世界级确定性时间
审计结果可生成 baseline，后续只阻断新增违规
```

## 默认规则

```text
implicit_math_random       error    Math.random()
implicit_date_now          error    Date.now()
implicit_new_date          warning  new Date()
implicit_performance_now   warning  performance.now()
implicit_process_hrtime    warning  process.hrtime()
```

`Math.random` 和 `Date.now` 默认是错误级别，因为这两类调用会直接破坏同 seed 重放。

`new Date`、`performance.now` 和 `process.hrtime` 默认是警告级别，因为部分场景可能只是外层日志、格式化或诊断，但仍应隔离在模拟外层。

## 使用方式

```js
const {
  scanSourceDirectory,
  assertSourcePurity,
} = require('./core/source-purity-engine');

const report = scanSourceDirectory('world-engine/core');
assertSourcePurity(report, { maxErrors: 0 });
```

## Baseline

现有大型代码库可以先生成 baseline：

```js
const {
  scanSourceDirectory,
  createPurityBaseline,
  compareToPurityBaseline,
} = require('./core/source-purity-engine');

const report = scanSourceDirectory('world-engine/core');
const baseline = createPurityBaseline(report);

const nextReport = scanSourceDirectory('world-engine/core');
const drift = compareToPurityBaseline(nextReport, baseline);
```

`drift.newFindings` 表示新增违规。`drift.resolved` 表示已经被清理的旧违规。

## 行内豁免

极少数必须保留的调用可以加行内注释：

```js
Date.now(); // source-purity-allow: implicit_date_now
```

也可以允许整行所有规则：

```js
Math.random(); // source-purity-allow: all
```

行内豁免应只用于：

```text
确定性兼容层自身
非模拟路径的日志或诊断
测试 fixture
外部协议时间戳格式化
```

## 接入状态

当前批次完成：

```text
源码扫描器
目录扫描
注释剥离
行内豁免
文件/行/rule allowlist
baseline 生成和漂移比较
错误/警告统计
回归测试 source-purity-engine-test.js
```

下一批迁移将基于该审计器逐个清理核心模块中的隐式调用，并逐步把门禁从 fixture 测试升级为核心目录 baseline 检查。
