# CoStudy（本地 demo）

和固定搭档一起学。本地运行，数据库（账号/进度等）全部存在本机文件，
其它设备可通过局域网地址访问。

## 目录

- `frontend/` — React + TS + Tailwind 前端
- `server/`   — Express + 内置 `node:sqlite` 后端；数据库文件 `server/data/costudy.db`
- `docs/`     — 规划文档（PLAN / PLAN-DESIGN / PAGES）

## 运行（单端口，局域网可访问）

```bash
npm run setup     # 装前后端依赖（首次）
npm run build     # 构建前端
npm start         # 启动服务（默认 3000 端口，绑定 0.0.0.0）
```

启动后终端会打印：

```
本机:    http://localhost:3000
局域网:  http://<你的电脑IP>:3000   <- 其它设备（同一 WiFi）输这个
```

手机/平板等同一局域网设备，浏览器打开那个 `http://<电脑IP>:3000` 即可访问。
换端口：`PORT=8080 npm start`。

## 开发模式（热更新，一条命令）

```bash
npm run dev     # 同时起后端 + 前端，打开终端打印的 http://localhost:5173
```

> 之前注册/登录报 500，是因为只开了前端、没开后端。用 `npm run dev`
> 一条命令同时起两个就不会了。局域网用 Vite 打印的 Network 地址。

## 团队协作：两个人同改代码 + 共享一份 DB

数据库是单机 SQLite，多端同时写文件会坏；但**多端的前端可以共用同一台后端**——
DB 主在一台机器上跑后端，所有人前端 dev 都代理到那台。
代码用 git 同步，各自 push/pull。

### DB 主（保持开机、跑后端的人）

```bash
npm run dev:server    # 只起后端，监听 0.0.0.0:3000
# 拿到你的局域网 IP（例：10.0.0.42）：ipconfig getifaddr en0
```

### 同事 / 你自己的另一台机器

**首次一次性配置**：在 `frontend/.env.local` 里写一行（这文件 git 已忽略，每人自己一份）：

```
BACKEND_URL=http://10.0.0.42:3000
```

之后每次：

```bash
git pull
npm run dev:web    # 浏览器开 http://localhost:5173
```

也可临时覆盖：`BACKEND_URL=http://其它IP:3000 npm run dev:web`。

每个人都能 HMR 改前端、跑自己的 Vite，但读写都打到 **同一份 SQLite**，
所以你们能作为同一对搭档对玩、共享导入的资料。

改后端代码时：DB 主拉新代码并重启 `npm run dev:server`；想本机测后端的人临时跑
`npm run dev`（连自己 localhost），调好了 push 上去。

## 已实现的基本功能

- 注册 / 登录（账号存本地 SQLite，密码 scrypt 加盐哈希）
- 注册后绑定**固定搭档**（一方生成邀请码，另一台设备输入加入；持久关系）
- 导入资料：粘贴链接或文本，并填**学习备注**
- AI 第一遍**粗分 component**（读一遍 + 备注作意图引导，仅切分，不深解析）
- **懒解析**：只有学到某个 component 时才深解析出题；学完它才解锁下一个，
  后面的内容在此之前完全不解析
- 进度按固定搭档维度持久化

> 说明：当前 AI 粗分 / 出题是确定性 stub（占位），按 docs/PLAN.md §5 的
> 可替换生成器设计，后续接 Claude Code / API 不影响其余部分。
