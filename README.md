# 水豚噜噜 · WorkBuddy 桌面宠物

一只住在你桌面上的水豚「噜噜」：透明无边框置顶小窗、可拖拽、可点击互动，还能被 WorkBuddy（AI）远程逗——任务完成时让它蹦起来撒花，久坐时让它提醒你休息。

> 形象来源：噜噜是国产 3D 动画《平头哥》的 IP 角色（版权归铁罐(北京)文化传媒有限公司）。本项目为个人学习使用的二创桌宠，非商用。

## 这是什么

WorkBuddy 官方没有"桌宠"这类扩展位，所以噜噜由三件套组成：

| 部件 | 位置 | 作用 |
|---|---|---|
| 桌宠本体 | `src/main/` + `src/pet/` | Electron 透明窗口 + 官方 IP 姿势图（PNG 透明底）+ CSS 状态机动画 |
| MCP server | `src/mcp/server.js` | 写入 `~/.workbuddy/mcp.json`，AI 通过工具调用远程逗宠 |
| 技能 | `skill/lulu-pet/SKILL.md` | 教 AI 何时调用（完成庆祝/久坐提醒/卖萌） |

接入后**重启 WorkBuddy**，并在连接器管理页把 lulu-pet 点「信任」。MCP 一连上就会自动把噜噜唤醒到桌面上，之后随时说："任务完成啦，让噜噜庆祝一下"。

## 快速开始

```bash
# 1. 安装依赖（已装过可跳过）
npm install

# 2. 一键接入 WorkBuddy（装 skill + 写 mcp.json + 唤醒噜噜）
node scripts/install.js

# 3. 以后随时手动启动桌宠
npm start
```

## 噜噜的技能（MCP 工具）

| 工具 | 作用 |
|---|---|
| `lulu_say` | 气泡说话，如 "搞定！噜噜给你撒花~" |
| `lulu_act` | 动作：celebrate 庆祝 / jump 弹跳 / sleep 睡觉 / wake 唤醒 / walk 散步 / idle 待机 |
| `lulu_joke` | 随机讲一个水豚冷笑话 |
| `lulu_status` | 查询运行状态与屏幕坐标 |

## 桌宠交互（鼠标）

- **左键拖拽**：把噜噜提到任何地方（松手保存位置）
- **左键点击**：开心弹跳 + 卖萌一句
- **双击**：原地庆祝
- **右键**：摸摸头 / 讲个笑话 / 散散步 / 睡觉唤醒 / 开机自启 / 回右下角 / 退出
- 鼠标移到噜噜身上才可交互，其余区域**点击穿透**到桌面，不挡事
- 5 分钟无操作自动打瞌睡

## 噜噜的形象与动作

形象直接采用网络下载的官方 IP 素材：从「水豚噜噜鼠标指针皮肤」海报（`refs/r6-cursor.png`）中抠出 12 个姿势（奶油底颜色键 + 最大连通域提取，自动剔除装饰元素），按状态映射到 `src/pet/assets/`：

| 状态 | 姿势图 | 表现 |
|---|---|---|
| 待机 idle | 站立正面 | 呼吸起伏 + 偶尔歪头 + 每 7-13 秒换站姿"张望" |
| 开心 click | 叉腰 | squash & stretch 弹一下 |
| 庆祝 celebrate | 跳跃欢呼 | 三连跳 + 星星粒子 |
| 拖拽 drag | 双手举起 | 被拎起来左右摇摆 |
| 睡觉 sleep | 趴姿 | 慢呼吸 + Zzz 飘浮 |
| 散步 walk | 前扑迈步 | 身体摇摆起伏，沿屏幕底部走到边 |
| 说话 say | 双手张开 | 气泡台词 + 轻微点头 |

## 目录结构

```
├── src/
│   ├── main/main.js      # 主进程：窗口/穿透轮询/右键菜单/HTTP 控制端(127.0.0.1:18731)
│   ├── pet/              # 渲染进程：姿势图 + 状态机动画 + 拖拽交互
│   │   └── assets/       # 12 张透明底 PNG（idle/click/drag/walk/sleep/celebrate/say/error…）
│   └── mcp/server.js     # MCP stdio server：4 个工具，桌宠没起时自动唤醒（MCP 连接即唤醒）
├── refs/                 # 形象素材（Bing 搜索下载，含指针皮肤海报与表情包 GIF）
├── scripts/
│   ├── start.js          # 启动器（自动清除 ELECTRON_RUN_AS_NODE，见下方坑）
│   ├── install.js        # 一键接入 WorkBuddy（支持 --exe 安装单文件版）
│   └── smoke-test.js     # 模拟 WorkBuddy 跑 JSON-RPC 全链路测试
└── skill/lulu-pet/       # 技能包（SKILL.md + .codebuddy-plugin 元数据）
```

## 打包分发

```bash
npx electron-builder --win portable -c.win.signAndEditExecutable=false -c.directories.output=dist4
# 产出 dist4/lulu-pet-portable.exe（单文件，约 72MB）
```

把 portable exe 拷贝给别的机器后：

```bash
node scripts/install.js --exe dist4/lulu-pet-portable.exe
```

> 本次构建产物：项目根目录 `lulu-pet-portable.exe`（图片版形象）。若打包遇到 `rcedit` 报 "Unable to commit changes"，加 `-c.win.signAndEditExecutable=false`；若输出目录的 app.asar 被占用（`正在被另一进程使用`），换一个新输出目录（dist2/dist3/dist4）重试。

## 已知坑（本机实测）

1. **`ELECTRON_RUN_AS_NODE=1`**：本机全局设了这个环境变量，会让 `electron.exe` 退化成普通 node（`require('electron')` 拿不到 `app`，报 `Cannot read properties of undefined`）。`scripts/start.js` 和 MCP server 启动桌宠时都会自动清除它；如果你用别的方式启动遇到这个报错，先检查这个变量。
2. **Git Bash 里桌宠会被连带杀掉**：bash 命令结束时会清理整个进程树（job object），所以终端里跑完 `npm start` 噜噜会消失。WorkBuddy 场景（MCP server 经 WorkBuddy 进程树拉起）和双击 exe 不受影响。
3. **WorkBuddy 大版本升级后噜噜无响应**：升级可能更换内置 node 路径，重跑一次 `node scripts/install.js` 即可。

## 技术说明

- 动画：姿势图切换 + CSS 关键帧（呼吸/歪头/张望换图/吊摆/散步摇摆/睡觉 Zzz/庆祝跳跃撒星），切图带 90ms 淡出防生硬
- 点击穿透：主进程 90ms 轮询光标位置，仅"水豚区域"接收鼠标事件，其余 `setIgnoreMouseEvents(forward)` 穿透到桌面
- 通信：MCP server → HTTP(127.0.0.1:18731, token 鉴权) → 桌宠主进程 → IPC → 渲染层状态机
- 位置记忆：`%APPDATA%/lulu-pet/lulu-pos.json`，token 同目录
