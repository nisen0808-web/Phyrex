# 单写世界引擎 v1 实测验收

日期：2026-10-02（Asia/Singapore）。功能提交：`e99cb1c986dce3271db86fcb6d7fd6de80a23503`，tree：`2e55718932a2128291a5beb022fd7ae877ea51b5`。
Actions 的合并 checkout：`ac07a737693fc2bc8be042825fdc6f758565459c`，父提交包含该功能提交，与功能提交的 tree 完全一致。14 个作业均成功，并实际读取日志检查退出状态、输出标记、pipefail 与 checkout；不是只查看 CI 图标。

## 基线

| Gate | 结果 | Actions run |
|---|---|---|
| 本地 Node 22 | 106/106 | 本地 Windows 日志随交付包保存 |
| Node 20/22 discovery、1000 tick | 每个 106/106，stress 通过 | [World Engine CI](https://github.com/nisen0808-web/Phyrex/actions/runs/36902921138) |
| root/nested、100 tick | 两个入口各 106/106，100 tick 通过 | [World Engine Tests](https://github.com/nisen0808-web/Phyrex/actions/runs/36902921052) |
| PostgreSQL 18 | Node 20/22 各全部通过 | [PostgreSQL](https://github.com/nisen0808-web/Phyrex/actions/runs/36902921027) |
| SQL 多进程耐久 | 每个 Node 各 6/6 groups | [Endurance](https://github.com/nisen0808-web/Phyrex/actions/runs/36902920865) |
| 多 seed 生命周期/容量/恢复 | 六个 Node/场景组合全部通过 | [Scale](https://github.com/nisen0808-web/Phyrex/actions/runs/36902920946) |

PostgreSQL 专项内部 group 数：store 14、inbox 8、runtime 11、runtime commands 7、API 9、audit 4、audit query 10、backup 6、maintenance 8、account admin 8、quickstart 6。每个 Node 分别执行，不和 106 个独立回归脚本混加。

本机没有 PostgreSQL 或 Docker，真实 SQL 证据来自 CI；quickstart 实际运行多个 CLI 子进程和 HTTP/恢复流程。随附 Compose 是本地参考配置，不声称已在本机执行 Docker。

## 规模与恢复

| 场景 / seed | 初始人口 | tick | 出生 | 自然死亡 | 代际 | 峰值 bytes | 恢复点 |
|---|---:|---:|---:|---:|---:|---:|---:|
| small / scale-small-v1 | 4 | 1000 | 200 | 18 | 7 | 23,944,493 | 10 |
| medium / scale-medium-v1 | 12 | 600 | 28 | 5 | 3 | 8,932,401 | 6 |
| large / scale-large-v1 | 32 | 300 | 65 | 7 | 3 | 11,303,942 | 3 |

同场景 Node 20/22 的最终全世界 SHA-256 完全一致：

- small：`39ddd1460f7ba67ba4609aaf98690c7f8d4836920b01ee101bebaf0f2c4ffd1c`
- medium：`6df12d3c633dd908c60d0cfaf3f98c4dc1035ebd63ee031493c5f7cd311ed42a`
- large：`658cdcb6b942f7b64c3db06e51e8ad29f502d0200862abd3c77d30a3a1e3e76e`

长测加速到 8 tick/年、出生率 .01，默认初始化仍是 720 tick/年、.0015。自然死亡不包括战斗死亡。small 结束存活 186 人；medium 第 500 tick 已无人存活。验收覆盖状态一致性与代际，不保证所有 seed 的文明永续或数值平衡。

small CI 总耗时 Node 20 约 1329 秒、Node 22 约 978 秒；本地 Node 22 约 909 秒。第 1000 tick 的 10 tick 批次分别约 154/116/109 秒，其中包含该批恢复对照和完整状态校验，不能直接当作线上每 tick 吞吐。活跃实体增长会提高成本；这里没有承诺每秒推进一个大型世界 tick。

三个场景峰值 process 数为 872 / 862 / 306，保护导致的最大超预算数为 672 / 662 / 106。超过配置 200 的保护项明确留存并报告，没有删除活跃过程伪装固定内存。终态历史预算与实际活跃规模必须分别管理。

最初未裁剪实体终态目标的 small 长测触发 32 MiB 上限而失败；现在在相同 seed/长度/人口参数下清理可丢弃目标和失效记忆引用后通过，没有增大 checkpoint 上限。所有恢复点比较完整状态，有限数值和索引也保持硬断言。

## 交付证明与边界

该功能提交之后允许收尾验收 Markdown 文档。交付包记录测试提交、交付提交和两者差异；只有明确列出的文档允许变化，任何 JS、配置、工作流、锁文件或其他内容变化都使“复用功能验收证据”失败。整个最终 Git tree 不会被谎称等于文档更新前的 tree。

交付包包含逐 Git blob 验证的完整源码快照、可离线克隆的 Git bundle、Migration 1–4、原始日志和 SHA-256 manifest。原 #61 的假绿日志也保留：不能删除 pipefail、缩减 discovery 或以 mock 代替真实 SQL。

完成范围是单写 PostgreSQL 世界引擎 v1。main 与开放 PR 的合并状态独立于功能验收；没有生产部署、分布式领导者或托管登录服务的完成声明。更多运行约束见 ENGINE_COMPLETION.md、ENGINE_QUICKSTART.md。

