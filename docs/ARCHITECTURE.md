# CoStudy 架构说明（读码起点）

> 给第一次进仓库的人看的"地图"。比 `PLAN.md` 实在：讲**现在的代码**怎么跑、文件怎么分工、一次请求怎么走完一圈。
>
> 看完这页应该能：找到任何功能对应的文件、知道改某个表/字段要动哪几处、能给新功能想出落点。

---

## 1. 进程与端口

CoStudy 是一个**双进程**项目，没有数据库守护进程（SQLite 是嵌入式的）：

```
┌────────────────────────────────────┐      ┌────────────────────────────────────┐
│  后端 Express 进程 (Node)           │      │  前端 Vite dev 进程 (Node)          │
│  - 监听 0.0.0.0:3000                │◀────▶│  - 监听 0.0.0.0:5173                │
│  - REST /api/*                      │ HTTP │  - HMR + 反向代理 /api → :3000      │
│  - node:sqlite 直读写 db 文件        │      │  - 浏览器访问的是这个               │
│  - 出题时 spawn `claude -p` 子进程   │      └────────────────────────────────────┘
└──────────────┬─────────────────────┘
               │
        server/data/costudy.db        ← 本机文件，gitignored
```

**只有"DB 主"那台**跑后端（`npm run dev:server`），其他协作者只跑前端（`npm run dev:web`），前端代理把 `/api/*` 转到 DB 主的 :3000，多人共用一份 SQLite。

生产/单机使用：`npm run build && npm start` → 单个 Express 进程同时服务 API 和编译好的前端，单端口 :3000。

---

## 2. 仓库结构

```
CoStudy/
├── server/                 后端
│   ├── index.js            Express app、HTTP 路由、错误中间件、SPA 静态服务
│   ├── play.js             对局玩法路由（独立 Router）
│   ├── lib.js              共享逻辑：auth、partnership、ensureParsed、claude 子进程
│   ├── db.js               SQLite 连接 + 全部建表语句（schema 单一来源）
│   └── data/costudy.db     运行时数据库（gitignored）
│
├── frontend/               React + TypeScript + Tailwind v4 + Vite
│   ├── src/
│   │   ├── App.tsx         路由 + 鉴权/绑搭档门禁 + Shell 布局
│   │   ├── api.ts          fetch 包装：token、错误规范化
│   │   └── pages/
│   │       ├── Login.tsx
│   │       ├── Partner.tsx 绑定固定搭档
│   │       ├── Home.tsx    资料列表
│   │       ├── Import.tsx  导入资料
│   │       ├── Material.tsx 资料详情（章/节列表、邀请、跳过、删除）
│   │       └── Play.tsx    对局（一题一揭/共答/揭晓/结算，全状态都在这）
│   └── vite.config.ts      读 BACKEND_URL（.env.local 或 shell 环境）
│
├── scripts/dev.mjs         同时起前后端的脚本（npm run dev 调用）
├── package.json            root 脚本：dev / dev:server / dev:web / build / start
└── docs/                   PLAN / PLAN-DESIGN / PAGES（愿景）+ 本文（实现）
```

---

## 3. 数据模型（实现现状）

完整 schema 在 [server/db.js](../server/db.js)。读这一节比 PLAN.md §2 准。

```
users               (id, username, pass_hash, salt)
  └── tokens        (token, user_id)            鉴权：Authorization: Bearer <token>

partnerships        (user_a, user_b, invite_code, status: pending|active)
  └── pair_stats (未启用，规划中)

materials           (partnership_id, title, source_type: link|text, source_value, user_note)
  └── chunks        (material_id, seq, title)               章（父分组）
      └── pieces    (material_id, chunk_id, seq, title,
                     source_url, content_text, parse_status: pending|parsed)
          ├── questions (piece_id, qjson)                   懒解析后写入
          └── progress  (partnership_id, piece_id,
                         state: locked|available|done|skipped)

play_sessions       (partnership_id, piece_id, mode: co_choice|asymmetric_choice,
                     status: invited|playing|finished, invited_by,
                     cur_q, cur_revealed, result_json)
  └── play_answers  (session_id, user_id, q_index, choice, correct)

skip_requests       (partnership_id, piece_id, requester_id)  跳过投票
```

几条关键约束（读代码时要记住）：

- **一份 `partnership_id` = 一对固定搭档**。绝大多数业务表都按 partnership 维度隔离。
- **`pieces.seq` 是全资料范围连续编号**——解锁下一节就是 `WHERE material_id=? AND seq=?+1`。
- **`pieces.parse_status='pending'`** 表示**还没出题**；首次邀请对局时 `ensureParsed` 会触发抓正文 + 调 AI 写入 `questions`，并置 `parsed`。
- **可见性**：`questions.qjson` 包含 answer，**绝不**直接发给前端；服务端按角色和揭晓状态过滤后才下发。

---

## 4. 请求流向（典型路径）

### 4.1 注册 → 绑搭档 → 导入资料

```
浏览器                          后端                            DB
  ──POST /api/register────────▶  insert users, tokens          ──insert──▶
  ◀──{token}──────────────────
  ──POST /api/partner/create──▶  insert partnerships (pending)
  ◀──{invite_code}─────────────
  （另一台）POST /api/partner/join {code}
                                 update partnerships set status='active', user_b
  ──POST /api/materials {title, sourceType:'link', sourceValue:URL, note}
                                 ① 抓首页 HTML → 内部 <a> → TOC 聚类
                                 ② splitMaterial → chunks[{title, pieces[...]}]
                                 ③ 建 chunks 行 + pieces 行（parse_status=pending）
                                 ④ progress: 首节 available，其余 locked
  ◀──{id}─────────────────────
```

### 4.2 邀请 → 接受 → 答题 → 揭晓 → 结算

```
A 端                           后端                                  B 端
 POST /api/pieces/:id/play
   ① 检查 progress=available
   ② await ensureParsed(piece)
      └─ 链接型且 content_text 空 → fetchSectionText(source_url)
      └─ spawn 'claude -p' 子进程
         → JSON schema 校验通过 → 写 questions, parse_status='parsed'
   ③ create play_sessions (status='invited', invited_by=A)
 ◀ {sessionId}

                                                  GET /api/materials/:id  ← Material 轮询每 3s
                                                  ← pieces[*].pending_invite = {session_id, ...}
                                                  POST /api/play/:sid/accept
                                                  → status='playing'
 GET /api/play/:sid (1.5s 轮询)                       (B 也是 1.5s 轮询)
   ← 不对称：narrator 只看到 cur_q 的 stem
              selector 只看到 cur_q 的 options
              加上 piece.source_url + content_text（仅 narrator）

                                                  POST /api/play/:sid/answer {qIndex, choice}
                                                  → 写 play_answers，cur_revealed=1
 GET /play/:sid  → reveal: {answer, selectorChoice, passed}
 POST /play/:sid/next
   → cur_q++, cur_revealed=0
   → 最后一题：finalizeAsymmetric → status=finished + completePiece
```

每次轮询服务端按 `(mode, role, status, cur_revealed)` 重新裁剪 `qjson`，前端不存敏感字段。

### 4.3 跳过投票

```
A:  POST /api/pieces/:id/skip/request     → insert skip_requests
B:  GET /api/materials/:id                ← pieces[*].pending_skip = {requester_id, from_me:false}
B:  POST /api/pieces/:id/skip/approve
    → delete skip_requests
    → completePiece(partnership, piece, asSkipped=true)
       └─ progress.state='skipped'
       └─ 下一 seq 的 piece.progress.state: locked → available
```

---

## 5. AI 出题：claude -p 子进程

实现在 [server/lib.js](../server/lib.js) 的 `generateQuestionsWithClaude`。

```
ensureParsed(piece)
  → fetchSectionText 若是链接型且没抓过
  → 题数 = clamp(content_text.length / 100, 3, 20)
  → spawn('claude', ['-p','--output-format','json','--model','haiku','--no-session-persistence'])
  → stdin 写 prompt（含标题+正文+严格 JSON 模板要求）
  → stdout 收 Buffer 数组（**不能边收边 toString，UTF-8 中文会被截**）
  → exit: Buffer.concat → toString('utf8') → JSON.parse outer → outer.result
  → 抽 [...] 数组 → 过 schema 校验 → 入 questions 表
  → 失败 → 退回 stub 题（占位 A/B/C/D），不阻塞流程
```

环境变量 `COSTUDY_AI=off` 跳过 AI 直接用 stub（demo 调试时快很多）。

后续要换 OpenAI/Anthropic API 只换 `generateQuestionsWithClaude` 一个函数，其他地方零改动——这是 PLAN §5.1 的抽象原则。

---

## 6. 状态机速查

**piece progress.state**：
```
  locked ──完成上一节──▶ available ──对局结束──▶ done
                              │ ──跳过被同意──▶ skipped
```

**play_sessions.status**：
```
  invited ──对方 accept──▶ playing ──finalize──▶ finished
     │
     └──任一方 cancel──▶ 删除行
```

**对局子状态**（仅 `asymmetric_choice`）：
```
  cur_q=0 cur_revealed=0  ──selector answer──▶  cur_revealed=1
                                                     │
                       ──任一方 next──▶  cur_q++, cur_revealed=0
                                                     │
                            最后一题 next ──▶ status='finished'
```

---

## 7. 鉴权 / 可见性 / 错误处理

- **Token**：登录/注册返回 token 字符串，前端存 localStorage（`api.ts#TOKEN_KEY`），每次请求带 `Authorization: Bearer …`。`auth` middleware（[lib.js](../server/lib.js)）查 `tokens` 表挂 `req.userId`。
- **Partnership 守卫**：除注册/登录/partner 系列、`/me` 外，所有路由开头都做 `myPartnership(req.userId)` 并要求 `status='active'`，否则 400。
- **可见性裁剪**：play.js 在 GET `/play/:sid` 里按 `role` 决定下发哪些字段；`piece.content_text` 和 `piece.source_url` 在不对称玩法对选择者置 `null`。
- **错误中间件**（index.js 末尾）：任何路由的同步异常都被捕获、打印请求上下文 + 堆栈、返回 500 + JSON `{error}`，前端 `api.ts` 把 message 抛给页面。
- **请求日志**：每个 `/api/*` 在 finish 时打印 `✓/·/✖ METHOD PATH → status (ms)`，看终端就能定位问题在哪。

---

## 8. 给新人改代码的快速指引

| 想做什么 | 改哪些地方 |
|---|---|
| 加一张表 | [server/db.js](../server/db.js) → 加 `CREATE TABLE`；同事们 `rm -f server/data/costudy.db` 重启即可（demo 阶段没有 migration） |
| 加一个 API | [server/index.js](../server/index.js) 或 [server/play.js](../server/play.js) → `app.post(...)`；记得加 partnership 守卫；前端 `api.ts` 调用 |
| 加一个玩法 | [server/play.js](../server/play.js) → 在 `POST /pieces/:id/play` 接受新 mode；GET `/play/:sid` 按 mode 形如 `if (mode === 'xxx')` 加分支；[frontend/src/pages/Play.tsx](../frontend/src/pages/Play.tsx) 加渲染分支 |
| 改 piece 解锁规则 | [server/lib.js](../server/lib.js) `completePiece` |
| 改 AI 出题 prompt / 模型 | [server/lib.js](../server/lib.js) `generateQuestionsWithClaude` |
| 改 chunk/piece 切分 | [server/index.js](../server/index.js) `splitMaterial` |
| 改对局页布局 | [frontend/src/pages/Play.tsx](../frontend/src/pages/Play.tsx)（iframe 7/10 + 题 3/10 在这） |

---

## 9. 已知的"demo 简化"，正式做产品要补的

- **没有迁移**：改 schema 需删 db。要做 migration（drizzle/knex 之类）。
- **轮询而非 WebSocket**：1.5–3s polling 顶得住，但每秒都有请求；产品要换 WS。
- **AI 进程同步阻塞**：`ensureParsed` 在请求线里 await claude；用户点"开始"到出题要等。可改成预生成 + job 队列。
- **没有"重新生成"**：题目存了就是存了，要换 prompt 调优只能删 piece 重建。加个按钮即可。
- **rate limit / 配额**：没做，AI 失败/超时/超额时只是退回 stub。
- **角色固定不轮换**：不对称玩法 narrator/selector 一局内固定。规划是每题/每局轮换。
- **pair_stats / achievements**：表名在 PLAN.md 里规划过，实现里没建。

---

## 10. 协作工作流

详见 [README.md](../README.md)。一句话总结：

- **DB 主**：`npm run dev:server`，IP 告诉同事。
- **同事**：`frontend/.env.local` 写一行 `BACKEND_URL=http://<DB 主 IP>:3000`，之后 `npm run dev:web`。
- **改后端代码**：先 push，DB 主 pull 后重启 `dev:server`。
- **改前端代码**：各自 HMR，互不打扰；想看到合并后效果的人 pull + 重启 dev:web。
