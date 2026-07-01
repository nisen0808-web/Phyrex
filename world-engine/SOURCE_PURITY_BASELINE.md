# Source Purity Baseline

本文件说明 `world-engine` 的源码纯度 baseline。

## Purpose

源码纯度 baseline 用来保护核心模拟目录，避免新的非确定性写法进入引擎层。

当前扫描目录：

```text
world-engine/core
```

当前 baseline 文件：

```text
world-engine/SOURCE_PURITY_BASELINE.json
```

## Test

CI 通过下面的测试检查 baseline：

```text
world-engine/tests/source-purity-baseline-test.js
```

该测试会：

```text
1. 扫描 world-engine/core。
2. 忽略源码纯度工具自身文件。
3. 把扫描结果转换为相对路径。
4. 与 SOURCE_PURITY_BASELINE.json 比对。
5. 如果出现新的 finding，测试失败。
```

## Baseline format

baseline 使用相对路径，避免 GitHub Actions 工作目录变化导致误报。

```json
{
  "version": 1,
  "root": "world-engine/core",
  "summary": {},
  "allowed": []
}
```

## Current status

当前 baseline 为空，表示在当前扫描口径下，核心目录没有已知需要豁免的源码纯度 finding。

测试中额外加入了文件数量断言，避免因为扫描路径错误导致空扫描通过。

## Updating baseline

如果未来确实需要保留已有 finding，应该先审查原因，再把明确条目加入 `allowed`。不应为了让测试通过而无条件放宽规则。
