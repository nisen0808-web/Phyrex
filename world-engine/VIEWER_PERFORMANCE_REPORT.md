# Viewer Performance Report Entry

本层为静态 viewer 增加性能报告展示入口。

## Files

```text
viewer/index.html
viewer/app.js
viewer/styles.css
viewer/serve-viewer.js
```

## Usage

先生成 snapshot：

```text
npm run snapshot
```

再生成性能报告：

```text
npm run performance:report -- output/runtime-world-save.json output/performance-report.json --mode operations
```

启动 viewer：

```text
npm run viewer
```

打开：

```text
http://localhost:8787/viewer/index.html
```

默认性能报告路径：

```text
../output/performance-report.json
```

## Viewer sections

新增两个卡片：

```text
Performance Report
Performance Recommendations
```

`Performance Report` 会显示：

```text
Trend
Pressure Scenarios
Top Systems
```

`Performance Recommendations` 会显示 operations report 中的建议。

## Notes

该改动不改变 snapshot schema，也不改变 viewer server 的路由逻辑。性能报告作为独立 JSON 文件加载，缺失时只显示空状态，不影响 snapshot 查看。
