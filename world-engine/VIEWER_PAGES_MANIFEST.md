# Viewer Pages Manifest

新增 viewer 页面清单。

## File

```text
viewer/pages.json
```

## Current pages

```text
./index.html
./database-report.html
```

## Purpose

这个文件用于集中记录 viewer 可访问页面，后续可以由页面脚本读取后生成导航。

## Coverage

```text
viewer-test.js
```

覆盖：

```text
pages.json exists
version is 1
contains ./index.html
contains ./database-report.html
```
