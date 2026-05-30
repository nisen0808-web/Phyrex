# MUD Xianxia World

一个先从 Windows 本地运行开始的文字 MUD / 修仙世界原型。

当前目标：

- 世界即使没有玩家在线也能推进。
- 角色可以离线执行命令，例如打坐、修炼、赚钱、探索。
- NPC 与玩家、NPC 与 NPC 之间都有情感值。
- 情感值影响组队、索要物品、帮助、道侣、偷袭成功率与防备程度。
- 危险行动可能带来收益，也可能导致重伤或死亡。

## 没有 Python 时怎么测试

你现在不需要 Python。

直接用浏览器打开：

```text
mud-xianxia-world/web/index.html
```

如果是从 GitHub 下载 zip：

1. 打开 GitHub 仓库页面。
2. 点绿色 `Code`。
3. 点 `Download ZIP`。
4. 解压。
5. 进入 `mud-xianxia-world/web/`。
6. 双击 `index.html`。

## 当前版本能做什么

- 创建一个本地修仙世界。
- 看到玩家与 NPC 状态。
- 给玩家下达离线行动：修炼、打坐、赚钱、探索、社交、索要物品、邀请组队、偷袭。
- 推进一天或连续推进十天。
- 看到 NPC 自主行动。
- 看到 NPC 与 NPC、玩家与 NPC 的情感变化。
- 死亡角色会停止行动。
- 所有数据保存在浏览器本地 localStorage 中。

## 文件结构

```text
mud-xianxia-world/
  README.md
  web/
    index.html
    style.css
    game.js
  docs/
    design.md
    test-guide.md
```

## 下一步

- 增加门派、城市、地图与资源点。
- 增加功法、境界突破、寿命、因果、仇恨、声望。
- 增加更完整的 NPC 决策系统。
- 后续再迁移到 Tauri / Electron，做成 Windows 桌面版。
- 再之后才考虑 iOS、Android 与跨端同步。