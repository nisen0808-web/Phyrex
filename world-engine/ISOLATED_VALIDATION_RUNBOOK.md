# 隔离环境验收与运行手册

当前用户选择先完成隔离测试环境验证。本轮不创建收费资源或开放公网服务。测试环境为 CI 的一次性 PostgreSQL 18 容器；每个 SQL 专项使用随机独立 schema 并在结束后清理。测试数据均为固定种子构建的合成世界。

## 复现完整测试

需要 Linux、Node 20 或 22、npm 和单独的 PostgreSQL 18 测试数据库。配置 WORLD_ENGINE_TEST_DATABASE_URL，数据库名必须以 _ci 或 _test 结尾。不要使用业务库或业务凭据。命令从仓库根目录执行：

```sh
set -euo pipefail
npm ci --prefix world-engine --ignore-scripts
mkdir -p world-engine/output
npm --prefix world-engine run engine:verify -- --suite all --list
npm --prefix world-engine run engine:verify -- --suite all --report output/isolated-verification-new.json
```

报告文件必须不存在。all 顺序执行 22 个门禁，第一项失败立即停止；子进程退出码和实际完成标记必须同时通过，数据库不可用不跳过。Node 20/22 的正式 CI 将这些门禁分成 14 个作业并包含 root/nested 的重复入口校验；下载实际日志核验 checkout tree、完成标记和 pipefail。

Windows 可以运行普通回归；完整 SIGTERM 进程关机专项必须在 Linux。无需在用户本机安装或启动数据库，就能审查本包附带的真实 CI 日志；不能将此表述成本机已运行 PostgreSQL 或 Docker。

## 隔离环境验收项目

| 项目 | 实际执行入口 |
|---|---|
| 初始化、迁移、导入、成员归属持久化 | test:postgres:quickstart；使用独立 CLI 子进程 |
| 管理账户、私有 token 文件、HTTP 权限、只读组织统计 | quickstart、account-admin、service；未授权 401 / 越权 403 |
| 启服、健康检查、提交命令、读取已提交结果 | test:postgres:service；HTTP + 隔离 Worker + 真实 SQL |
| SIGTERM 停机、待处理命令恢复、已完成命令不重放 | service 与 runtime 专项 |
| 完整备份、摘要验证、空 schema 恢复、恢复后继续执行 | quickstart、backup、maintenance 专项 |
| 数据库不可用及 revision 冲突 | readiness 503、停止接受新命令；错误不输出连接串或 token |
| 长期运行与容量 | endurance 1000 tick、三种规模 x 两个 Node、恢复摘要相等、32 MiB 上限 |

## 后续常驻环境配置清单

选择服务器和 PostgreSQL 托管位置后，先在独立常驻测试环境按 ENGINE_QUICKSTART.md 从空库启动。明确服务域名/网络入口、世界 ID、数据库专用 schema、密钥注入方式、单写实例和服务管理器；API 默认绑定回环地址，公网入口应通过受控 HTTPS 网关。不得将测试容器密码移用到生产。

运行监控至少包括 live/ready 状态、运行器 blocked 状态与提交失败、命令积压、auditFailures、存档大小和容量压力、数据库空间及最近一次成功备份时间。日志只记录安全错误码与请求 ID，避免原始 token、完整命令输入和连接信息。

备份计划须明确保留周期、异地存储、加密和访问权限，并定期在空 schema 做恢复演练。先备份再做有破坏性的保留维护；不要凭 sequence 范围删除审计，也不要删掉幂等 receipts。已有备份文件不覆盖，恢复后检查最新 revision、pending/applied 命令及继续推进的结果。

升级时停止唯一写入器 → 完整备份并验证 → 更新代码与锁定依赖 → 根据发布说明决定是否需要显式 runtime 升级 → 健康/权限/命令烟测 → 恢复流量。回退须使用兼容代码和备份，不能在旧代码上直接重放新版本已提交命令。

本文件是运行手册；只有对应环境实际执行并保存证据后，才可将常驻测试或生产部署标记为完成。
