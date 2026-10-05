# Render 免费临时试运行

本配置用于等待本地 Mac Studio 到货期间的小规模试运行，不是持续运行保证或生产容量承诺。引擎规则、运行态 v5、Migration 1–4 不变。

## 部署前

先在同一 Render 工作区的新加坡区域创建独立 Free PostgreSQL 18。数据库与 RWA 服务独立；本 Blueprint 不创建/接管数据库，避免重复创建或变更现有资源。初始化专用 schema `phyrex_trial` 和世界 `phyrex-trial` 后再应用 Blueprint。参考 `world-engine/ENGINE_QUICKSTART.md`，初始人口使用 4，账户 token 随机生成且仅保存在私有文件中。

`WORLD_ENGINE_DATABASE_URL` 必须填入该数据库的外部连接 URL。引擎保持 `verify-full` 校验；Render 内部连接提供自签名 TLS，不能关闭证书验证来绕过现有安全策略。数据库的入站规则只允许操作员当时的单个 IP 和实际服务 Connect 菜单列出的出站网段。Render 出站网段由同区域服务共享，IP 允许列表不能替代数据库密码。

在仓库 main 上合并本文件和 render.yaml 后，通过 Render Blueprint 导入仓库，填写数据库 URL，检查只有一个 `free` Web Service。该服务启动命令不会初始化或覆盖世界。Node 版本固定为 22.23.3，单写进程，每批 1 tick，间隔 60 秒；休眠后恢复最后一次提交，不补算离线时间。平台的动态 `PORT` 必须传入 CLI，监听 `0.0.0.0`。就绪检查使用 `/health/ready`，它失败时不能以 `/health/live` 代替掩盖数据库/运行器故障。

## 验收

检查实际部署提交；验证健康接口、未登录 401、普通玩家越权 403、玩家状态读取、指令 pending → applied、相同 ID 同内容幂等和不同内容 409，以及管理员审计。再次启动后读取同一个指令结果，不能重放已完成指令。保存真实 HTTP/SQL 结果和部署日志，不把 `live` 状态单独视为验收完成。

## 免费额度与存档

同一工作区共享每月 750 小时免费实例运行时；流量和构建额度也共享，以账单页面为准。允许服务自然休眠，不发送保活请求。免费 PostgreSQL 1 GB，创建后 30 天到期，需要在到期前迁移和另存备份。数据库历史 checkpoint 默认不会自动删除，因此世界容量限制并不等于数据库总容量限制。保持小人口和慢速 tick，按实际增长及时停止和维护。

完整备份使用 `database:backup export`，随后 `verify`。备份包含世界、历史、命令、幂等凭据、审计与序列高水位，包含私有业务状态及 token hash，应保管到服务之外。不得把备份或原始 token 放进仓库。

## 更新与 Mac Studio 迁移

自动部署保持关闭。更新前先暂停现有服务并确认旧进程退出，再备份、更新和启动。不要用滚动部署并行运行两个写入器；revision fence 不能代替选主。

Mac 安装 Node 22 与 PostgreSQL 18 后：停止 Render 写入器 → 导出并验证最后备份 → 迁移对应代码和私有访问凭据 → 在全新专用 schema 执行 migrate → 完整 restore → 对比 revision/tick/玩家/命令结果 → 仅在 Mac 启动一个写入器。端口默认只绑定本机。首次 Apple Silicon 运行仍需实机验收；Linux CI 和云端验收不能代替它。

恢复和继续执行成功、备份另存后再处理 Render 资源。不要提前删除源数据库。完整说明见 `world-engine/POSTGRES_BACKUP.md`、`world-engine/POSTGRES_MAINTENANCE.md`、`world-engine/ENGINE_SERVICE.md`。
