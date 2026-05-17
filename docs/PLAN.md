# CoStudy 项目规划

> 双人合作闯关式学习。两人上传一份资料，AI 出题，通过"信息不对称"的协作玩法共同闯关。
>
> 本文档是**架构与数据规范**，不含实现代码。用于指导后续设计稿与开发。

---

## 0. 核心决策（已确认）

| 维度 | 决策 | 对架构的含义 |
|---|---|---|
| 平台 | Web 优先，后期扩展移动端 | 所有业务逻辑下沉到 API 层，前端只是消费者；移动端复用同一套 API |
| AI 出题 | 现阶段用 Claude Code 离线/半自动生成；后期转 API | **出题管线**与**对局运行时**彻底解耦，题库表与生成方式无关 |
| 实时性 | 强实时 | 需要房间服务 + WebSocket；服务端按玩家角色裁剪下发数据 |

**最重要的一条架构原则**：所有资料（视频 / PDF / 文本 / Markdown）最终都被归一化成统一的「知识块（Knowledge Chunk）」。AI 只面向知识块出题；题目可回链到原始资料的精确位置（时间戳 / 页码 / 行号）。整个系统围绕这个抽象展开。

---

## 0.5 当前实现现状（demo，2026-05 起持续更新）

本文档中很多内容是 **完整愿景**；这一节是 **现在真的跑起来的**。两者会随实现推进逐步收敛。

| 概念 | 文档原名 | 实现现名 | 备注 |
|---|---|---|---|
| 资料 | `materials` | `materials` | 加了 `user_note`（上传时学习意图）|
| 段（章级） | `material_segments` | `chunks` | 父分组：链接型按 URL 第二段切；text 按 `#` 切 |
| 节（学习单位） | `material_segments` / `component` | `pieces` | 最小学习单位；可被「跳过投票」标 `skipped` |
| 知识块 | `knowledge_chunks` | （暂未独立成表） | 当前 piece 直接持 `content_text`；后期需要更细粒度时再加 |
| AI 总结 | `ai_summaries` | （未实现） | 后续 |
| 对局会话 | `game_sessions` | `play_sessions` | 状态 `invited｜playing｜finished`（不再有 lobby/ready）|
| 就绪 / 准备 | `play_ready` 表 | （移除） | 改为「**邀请-接受**」：发起方建 session（invited），搭档接受才进 playing |
| 跳过投票 | （新增） | `skip_requests` | 一方申请 → 另一方同意 → piece 标 `skipped` 并解锁下一节 |
| 进度 | `progress` | `progress` | 状态加 `skipped`（done 之外的"算完成"）|
| 实时 | WebSocket 强同步 | **轮询 1.5–3s** | demo 先做到能玩，WebSocket 后续替换 |
| AI 出题 | 计划：`claude -p` 桥 | **已接通** | `spawn('claude','-p','--output-format','json','--model','haiku',...)`；首次 piece 解析 10–30s；UTF-8 用 `Buffer.concat` 处理跨块字符 |
| 资料来源 | upload / link / 多格式 | 已支持 link（含 TOC 抽取）+ text/markdown | YouTube/Bilibili/PDF/视频文件 还未做 |

**新增的实现机制**（文档原本没写、demo 已经有的）：

- **TOC 自动抽取**：抓首页 HTML → 所有内部 `<a>` → 按 URL 第一段分组取最大簇当目录 → 第二段当 chunk 名 → 链接 label 当 piece 名（不依赖框架识别）。
- **逐节懒抓 + 懒解析**：邀请发起时 `await ensureParsed(piece)`，链接型 piece 此刻才抓本节 URL → 拿正文 → 调 `claude -p` 出题。
- **题数按字数**：≈100 字/题，clamp 3~20。
- **Piece 删除**：资料级 DELETE，级联清 pieces/questions/progress/skip/对局/答案。
- **iframe 嵌入原页**：对局页左 7/10 嵌 `source_url`，右 3/10 题目；选择者看不到原页与正文。

---

## 1. 系统整体架构

```
┌─────────────┐     ┌─────────────┐
│  Web 前端   │     │  移动端(后期) │     消费者层（只调 API / WS）
└──────┬──────┘     └──────┬──────┘
       │   HTTPS / WSS     │
       └─────────┬─────────┘
                 ▼
        ┌──────────────────┐
        │   API 网关 / BFF  │   认证、路由、按角色裁剪下发
        └────────┬─────────┘
                 │
   ┌─────────────┼──────────────┬───────────────┐
   ▼             ▼              ▼               ▼
┌────────┐ ┌──────────┐ ┌─────────────┐ ┌──────────────┐
│ 资料服务 │ │ 解析管线  │ │ 实时房间服务 │ │ 出题管线(异步)│
│ 上传/元 │ │ 归一化为  │ │ WebSocket   │ │ Claude Code  │
│ 数据     │ │ 知识块    │ │ 房间状态机   │ │ → 题库       │
└───┬────┘ └────┬─────┘ └──────┬──────┘ └──────┬───────┘
    │           │              │               │
    ▼           ▼              ▼               ▼
┌──────────────────────────────────────────────────────┐
│  关系型数据库 (PostgreSQL)  +  对象存储 (S3/本地)        │
│  结构化数据、题库、对局         视频/PDF/大文件原件        │
└──────────────────────────────────────────────────────┘
```

**四个独立子系统：**

1. **资料服务**：处理上传，写文件元数据，原件存对象存储。
2. **解析管线**（异步）：把任意格式的文件转成知识块。可重跑。
3. **出题管线**（异步，当前由 Claude Code 驱动）：读知识块 → 生成题目 JSON → 写题库。
4. **实时房间服务**：管理对局、玩家角色、按角色裁剪数据、推送事件。

子系统之间只通过数据库 + 任务队列通信，互不直接依赖——这样"出题"那一步将来从 Claude Code 换成 API 调用时，其他部分零改动。

---

## 2. 数据库设计

数据库选型建议：**PostgreSQL**（关系约束 + `JSONB` 存灵活结构 + 全文检索 + 后期可上 `pgvector` 做语义检索）。大文件**不进数据库**，只存对象存储，库里存 URL/key。

下面是核心表。类型用 PostgreSQL 语义描述。

### 2.1 用户与身份

```
users
  id            UUID  PK
  display_name  TEXT
  email         TEXT  UNIQUE
  created_at    TIMESTAMPTZ
```

### 2.2 资料：包 → 文件 → 知识块（三层）

一次"上传一份资料"= 一个 **material（资料包）**，包内可含多个 **material_file（文件）**，每个文件解析后产生多个 **knowledge_chunk（知识块）**。

```
materials                       -- 一份学习资料（一个"课程包"）
  id            UUID  PK
  owner_id      UUID  FK→users
  title         TEXT
  description   TEXT
  user_note     TEXT         -- 用户上传时的备注/学习意图（如"这网页含很多子链接，要学全部"）
                             -- 作为第一遍粗分 component 的引导，见 §4.4
  status        TEXT  -- draft | parsing | ready | failed
  created_at    TIMESTAMPTZ

material_files                  -- 包内的单个原始文件
  id            UUID  PK
  material_id   UUID  FK→materials
  kind          TEXT  -- video | audio | pdf | markdown | text | image
  original_name TEXT
  storage_key   TEXT  -- 对象存储 key，原件位置
  mime_type     TEXT
  size_bytes    BIGINT
  duration_sec  INT       NULL  -- 视频/音频时长
  page_count    INT       NULL  -- PDF 页数
  parse_status  TEXT  -- pending | parsing | done | failed
  parse_error   TEXT      NULL
  created_at    TIMESTAMPTZ

knowledge_chunks                -- 归一化知识块（系统的核心抽象）
  id            UUID  PK
  material_id   UUID  FK→materials   -- 冗余便于按包查询
  file_id       UUID  FK→material_files
  seq           INT          -- 在文件内的顺序
  text          TEXT         -- 归一化后的纯文本内容
  token_estimate INT         -- 估算 token，供出题时控制上下文
  source_ref    JSONB        -- 回链定位，见下
  embedding     VECTOR  NULL -- 后期语义检索用（pgvector）
  created_at    TIMESTAMPTZ
```

`source_ref` 按文件类型存不同定位信息，**这是题目能"跳回原文"的关键**：

```jsonc
// 视频/音频
{ "type": "timestamp", "start_sec": 132.5, "end_sec": 168.0 }
// PDF
{ "type": "page", "page": 7, "bbox": [x0,y0,x1,y1] }   // bbox 可选
// Markdown / 文本
{ "type": "line", "start_line": 40, "end_line": 58, "heading_path": ["第2章","2.3 索引"] }
```

### 2.3 题库（与出题方式无关）

```
question_sets                   -- 针对某份资料的一批题
  id            UUID  PK
  material_id   UUID  FK→materials
  generated_by  TEXT  -- claude_code | api | manual   （记录来源，不影响读取）
  generator_meta JSONB         -- 模型版本、prompt 版本、生成时间等
  status        TEXT  -- draft | published
  created_at    TIMESTAMPTZ

questions
  id            UUID  PK
  set_id        UUID  FK→question_sets
  game_mode     TEXT  -- asymmetric_choice | ... （玩法标识，决定 payload 结构）
  difficulty    INT   -- 1..5
  payload       JSONB -- 玩法相关结构，见 §6
  visibility    JSONB -- 字段→角色 的可见性映射（强实时裁剪用），见 §6
  source_chunk_ids UUID[]  -- 这道题依据哪些知识块（可回链原文）
  created_at    TIMESTAMPTZ
```

> 设计要点：`payload` 用 `JSONB` 是因为不同玩法题目结构差异大；用 `game_mode` 区分 schema。新增玩法 = 新增一个 `game_mode` 取值 + 约定它的 payload/visibility 结构，**不改表**。

### 2.4 对局 / 房间（强实时）

```
game_sessions                   -- 一局对局
  id            UUID  PK
  partnership_id UUID FK→partnerships  -- 固定搭档关系；注册时已绑定，不每局邀请
  material_id   UUID  FK→materials
  piece_id      UUID  FK→pieces        -- 本局学哪一节（见 §2.5/§4.4）
  set_id        UUID  FK→question_sets
  game_mode     TEXT  -- asymmetric_choice | co_choice | ...（本局玩法，见 §6）
  status        TEXT  -- invited | playing | finished | aborted（demo: 无 lobby/ready）
  invited_by    UUID  FK→users         -- 发起邀请的人；搭档接受才进 playing
  cur_q         INT   DEFAULT 0        -- 不对称：当前题序号
  cur_revealed  BOOL  DEFAULT false    -- 不对称：当前题是否揭晓
  config        JSONB -- 关卡数、限时等
  created_at    TIMESTAMPTZ
  finished_at   TIMESTAMPTZ NULL

session_players                 -- 房间内玩家（双人，可扩展多人）
  session_id    UUID  FK→game_sessions
  user_id       UUID  FK→users
  role          TEXT  -- 见 §6，例如 narrator | selector
  joined_at     TIMESTAMPTZ
  PRIMARY KEY (session_id, user_id)

session_rounds                  -- 每一关/每一题的进度与结果
  id            UUID  PK
  session_id    UUID  FK→game_sessions
  round_no      INT
  question_id   UUID  FK→questions
  state         TEXT  -- pending | active | revealed | passed | failed
  answer        JSONB      NULL  -- 双方提交内容
  passed        BOOLEAN    NULL
  started_at    TIMESTAMPTZ NULL
  ended_at      TIMESTAMPTZ NULL

realtime_events                 -- 事件日志（可选，用于回放/复盘/反作弊）
  id            BIGSERIAL PK
  session_id    UUID  FK→game_sessions
  actor_id      UUID  NULL
  type          TEXT
  payload       JSONB
  created_at    TIMESTAMPTZ
```

### 2.5 增量表：AI 产物 + 运维 + 成就

> 以下为后续讨论补充的表，是对 §2 的**增量**，不改动以上任何已有表。

```
ai_summaries                    -- AI 对资料的总结（与转录/知识块并列展示）
  id            UUID  PK
  scope         TEXT  -- material | file （整包总结 / 单个视频文件总结）
  scope_id      UUID  -- materials.id 或 material_files.id
  kind          TEXT  -- tldr | outline | key_points | glossary
  content_md    TEXT         -- Markdown 正文（前端直接渲染）
  source_refs   JSONB        -- 每个要点回链的 chunk/时间戳，见下
  generated_by  TEXT  -- claude_code | api
  generator_meta JSONB
  version       INT          -- 可重生成、保留历史版本
  created_at    TIMESTAMPTZ

generation_jobs                 -- 出题/总结的异步任务（触发桥用，见 §5.2）
  id            UUID  PK
  material_id   UUID  FK→materials
  job_type      TEXT  -- question_set | summary
  status        TEXT  -- pending | running | done | failed
  attempts      INT   DEFAULT 0
  input_hash    TEXT         -- 关联知识块内容 hash，做幂等防重复烧 token
  result_ref    UUID  NULL   -- 产出的 question_sets.id 或 ai_summaries.id
  error         TEXT  NULL
  created_at    TIMESTAMPTZ
  updated_at    TIMESTAMPTZ

achievements                    -- 成就目录（静态配置）
  code          TEXT  PK  -- first_clear | full_combo | no_hint | speed_run ...
  title         TEXT
  description   TEXT
  rule          JSONB        -- 判定规则（服务端结算时计算）

session_achievements            -- 某局解锁的成就（归属"这对搭档"，非个人）
  session_id    UUID  FK→game_sessions
  achievement_code TEXT FK→achievements
  earned_at     TIMESTAMPTZ
  PRIMARY KEY (session_id, achievement_code)

partnerships                    -- 固定搭档关系（注册后绑定，持久；一般一人一个 active）
  id            UUID  PK
  user_a_id     UUID  FK→users  -- 规范化：始终 a_id < b_id
  user_b_id     UUID  FK→users
  status        TEXT  -- pending（已邀请待接受）| active | dissolved
  created_at    TIMESTAMPTZ
  UNIQUE (user_a_id, user_b_id)

chunks                          -- 章（父分组）：一份资料下若干 chunk
  id            UUID  PK
  material_id   UUID  FK→materials
  seq           INT
  title         TEXT
  created_at    TIMESTAMPTZ

pieces                          -- 节（最小学习单位，原 material_segments / component）
  id            UUID  PK
  material_id   UUID  FK→materials
  chunk_id      UUID  FK→chunks
  seq           INT                  -- 全资料范围的顺序（用于解锁下一个）
  title         TEXT
  source_url    TEXT  NULL           -- 链接型 piece 的本节 URL（懒解析时去抓）
  content_text  TEXT  NULL           -- 本节正文（文本型导入时填；链接型懒解析时填）
  parse_status  TEXT  -- pending | parsed
  created_at    TIMESTAMPTZ

skip_requests                   -- 跳过投票：一方申请 → 另一方同意 → piece 标 skipped
  partnership_id UUID FK→partnerships
  piece_id       UUID FK→pieces
  requester_id   UUID FK→users
  created_at     TIMESTAMPTZ
  PRIMARY KEY (partnership_id, piece_id)

session_player_scores           -- 每局每个玩家的个人得分（评分模型用，见 §6.3）
  session_id    UUID  FK→game_sessions
  user_id       UUID  FK→users
  score         INT
  PRIMARY KEY (session_id, user_id)

pair_stats                      -- 固定搭档的累计关系指标（"默契值"）
  partnership_id UUID PK FK→partnerships
  sync_score    INT          -- 默契值，由历次对局派生累加
  sessions_done INT
  materials_done INT
  best_combo    INT
  avg_grade     TEXT         -- 历史平均评分（已含分差惩罚，见 §6.3）
  updated_at    TIMESTAMPTZ
```

`ai_summaries.source_refs` 让总结的每个要点都能跳回原文/原片：

```jsonc
[
  { "point": "哈希表平均查找 O(1)", "chunk_id": "…", "ref": {"type":"timestamp","start_sec":132.5,"end_sec":168.0} },
  { "point": "哈希冲突的两类解决法",   "chunk_id": "…", "ref": {"type":"timestamp","start_sec":201.0,"end_sec":255.0} }
]
```

---

## 3. 文件上传规范

### 3.1 支持格式与限制（建议初版）

资料来源不止"上传文件"。`materials.source_type` / `material_files.source_type` 取值：`upload | youtube | bilibili | web_url`，但**解析后都归一到同一套知识块**，下游零差异。

| 类别 | 来源/格式 | 单文件上限（建议） | 处理方式 |
|---|---|---|---|
| 视频文件 | mp4, mov, webm | 2 GB | 转码探测 + 抽音轨 + ASR 转录 |
| 视频链接 | YouTube / Bilibili URL | — | 优先取官方字幕；无字幕则抽音轨 ASR（见 §3.3） |
| 音频 | mp3, m4a, wav | 500 MB | ASR 转录 |
| 文档 | pdf, docx, pptx, epub | 100 MB | 文本/版面提取，无文本层走 OCR |
| 文本 | txt, md, markdown | 10 MB | 直接读取 |
| 网页链接 | 文章/教程 URL | — | 正文抽取（去导航/广告）→ 当文本处理（见 §3.3） |
| 图片 | png, jpg | 20 MB | OCR / 多模态描述（后期） |

### 3.2 上传流程（直传对象存储，后端不中转大文件）

```
1. 前端请求上传凭证       POST /materials/{id}/files:presign
                          → 返回对象存储预签名 URL + storage_key
2. 前端直传原件到对象存储  PUT  {presigned_url}     （大文件分片上传）
3. 前端通知上传完成       POST /materials/{id}/files:complete
                          → 后端写 material_files 行，parse_status=pending
4. 后端投递解析任务到队列  （异步，前端不阻塞）
```

要点：
- 大文件**绝不**经过后端内存——用预签名直传 + 分片。
- 服务端二次校验：MIME 嗅探（不信任扩展名）、大小、时长/页数上限。
- 每个文件一个幂等的 `storage_key`（含 material_id / file_id / 内容 hash），重传不污染。

### 3.3 链接来源接入（YouTube / Bilibili / 网页）

不走文件直传，走"提交链接 → 后端抓取归一化"：

```
1. 前端提交 URL          POST /materials/{id}/ingest:url   { url, source_type }
2. 后端识别来源类型并抓取：
   · YouTube/Bilibili → 优先官方字幕/CC（带时间戳，直接成转录）
                        无字幕 → 下载音轨 → 走 §4 ASR 管线
   · 网页文章          → 正文抽取（readability 类，去导航/广告/评论）→ 当文本
3. 归一化为 material_files 行（source_type 标记来源，storage_key 存抓取产物）
4. 之后与上传文件**完全相同**：解析 → 分段 → 知识块 → AI 管线
```

要点：
- 抓取失败/无字幕/受限内容要有明确状态与回退（提示用户改上传文件）。
- 合规：仅抓取用户有权学习的内容，遵守平台条款；不做规模化爬取。
- 链接来源同样进 §4.4 分段（长视频/长文一样要切段）。

---

## 4. 资料解析规范（→ 知识块）

目标：**无论什么格式，产物都是带 `source_ref` 的 `knowledge_chunks` 行**。解析任务必须**可重跑且幂等**（重跑前清掉该 file 的旧 chunk）。

### 4.1 各格式管线

| 格式 | 步骤 | 产出 chunk 的切分依据 | source_ref |
|---|---|---|---|
| Markdown | 解析 AST → 按标题层级切段 | 标题 / 段落，保留 `heading_path` | line + heading_path |
| 文本 txt | 按空行/句群切段，目标 300–800 token/块 | 语义段落 | line 范围 |
| PDF | 提取文本层；缺失则 OCR；按页+版面块切 | 页 + 版面块 | page (+bbox) |
| 音频 | ASR 转录（带词级时间戳）→ 按停顿/语义切句群 | 时间窗（如 20–60s/块） | timestamp 区间 |
| 视频 | ffmpeg 抽音轨 → 同音频管线；（后期）关键帧 OCR 补充板书 | 时间窗 | timestamp 区间 |
| 图片 | OCR / 多模态描述 → 作为单块 | 整图 | image ref |

### 4.2 切块原则（关键）

- 每块控制在 **约 300–800 token**：太小缺上下文出不了好题，太大浪费且定位不精。
- **不跨语义边界硬切**：优先在标题、段落、句子、说话停顿处断开。
- 保留**结构路径**（章节标题链 / PDF 页 / 视频时间），让题目能"指回原文这一段"。
- 解析产物只是纯文本 + 定位；**解析阶段不调用 AI、不出题、不总结**——AI 产物都在下一个独立管线。

### 4.3 视频 / 音频：转录 + AI 总结（双产物）

视频/音频解析完，前端要同时呈现**两样东西**：

| 产物 | 来源 | 存储 | 用途 |
|---|---|---|---|
| 逐字转录 transcript | ASR，带时间戳 | `knowledge_chunks`（按时间窗切块） | 精确查证、点击跳转原片、出题依据 |
| AI 总结 summary | 总结管线（AI，见 §5） | `ai_summaries`（scope=file） | 快速了解全貌、要点回链、复习抓手 |

```
视频/音频
  → ASR 转录 → knowledge_chunks（带 timestamp，原样可查）
  → 总结任务入队 generation_jobs(job_type=summary)
  → AI 读这些 chunks 产出 ai_summaries：
       · tldr 一句话           · outline 章节大纲（带时间戳）
       · key_points 要点清单   · glossary 术语表
  → 每个要点写 source_refs，回链到对应 chunk 的时间区间
```

要点：
- 转录是"事实层"（不改写、可追溯），总结是"理解层"（AI 提炼、可重生成）——**两者分开存、分开展示**，不要用总结替代转录。
- 总结**不在解析阶段做**，而是和出题一样走 §5 的 AI 管线（同一个触发桥、同一个 JSON Schema 闸门），`generation_jobs.job_type` 区分 `summary` / `question_set`。
- 总结要点带 `source_refs`：前端"总结里点一句 → 跳到视频 12:32"——这是把"快速看懂"和"回原片查证"打通的关键体验。
- 纯文本/PDF/Markdown 同样可选生成 `ai_summaries`（scope=material 或 file），机制完全一致。

### 4.4 两阶段：先粗分 chunk/piece，再逐节懒解析（demo 已实现）

用户常一次性传一个大教程（2 小时长视频、整本书、含很多子链接的网页）。**不能也不必一上来就深解析整份资料**——慢、贵、用户也只先学第一块。两阶段：

```
阶段一（导入即做，便宜，无 AI）：
  · 链接型：抓首页 HTML → 同源内部 <a> → 按 URL 第一段聚类取最大簇当 TOC
            → 第二段当 chunk 名，链接 label 当 piece 标题
  · 文本型：# 当 chunk，## 当 piece；只有单级标题就全部归到默认 chunk
  · 产物：chunks + pieces；每个 piece parse_status=pending；首节 progress=available 其余 locked

阶段二（懒解析，按需，AI）：
  · 用户邀请玩某 piece → ensureParsed(piece)：
      · 若 piece 是链接型且本节正文未抓 → fetchSectionText(source_url) → 写 content_text
      · 调 claude -p 出题（题数按内容字数 ≈100 字/题，clamp 3..20）
      · 失败/未启用 → 退回占位题
  · 学完（或被双方同意跳过）→ piece state=done/skipped，自动解锁下一个 seq
```

要点：
- `material_segments` 即 component；新增 `parse_status (pending|parsing|parsed)`，进度按固定搭档维度记 `locked | available | done`（仅 seq=1 初始 available）。
- 阶段一的粗分依据：**优先资料自带结构**（视频章节 / PPT 分节 / 文档标题 / PDF 书签 / 网页子链接与小标题），无结构则按主题切变；`user_note` 作为"学哪些、按什么粒度"的引导。
- 每个 component 目标"一局对局可消化"（≈ 一个章节 / 5–15 分钟）。
- 收益：导入快、成本只在真正学到时才付；天然契合 §5 触发桥——懒解析时才入 `generation_jobs`。
- 对局 `game_sessions.segment_id` 指定本局学哪个 component。

---

## 5. AI 出题与总结管线（当前 Claude Code，后期 API）

> **实现现状（2026-05）**：出题已接通 `claude -p --output-format json --model haiku --no-session-persistence`，prompt 包含 piece 标题 + 本节正文 + 严格 JSON 模板；产出过 schema 校验（每题 stem + 4 个非空 options + answer ∈ [0,3]）才入库，失败退回占位 stub。集成在 `server/lib.js#generateQuestionsWithClaude`，调用点在 `ensureParsed`。总结（`ai_summaries`）尚未接通。
> 
> **重要坑**：`spawn` 的 stdout 默认 chunked 流，每块单独 `.toString()` 会把跨块的 UTF-8 中文字符破坏成 `�`，进而让外层 JSON 解析失败 → 一定要 `Buffer.concat(chunks).toString('utf8')` 在 exit 时一次性解码。

把"生成"做成一个**可替换的步骤**，输入输出固定，中间换谁都行：

```
输入：某 material 的 knowledge_chunks（按需筛选/分组）
       + 玩法规格（game_mode 对应的 payload/visibility schema）
       + 出题配置（数量、难度分布、玩法组合）
        │
        ▼
[生成器]  现阶段：Claude Code 读取导出的 chunks，按规格产出题目 JSON
          后期：同样的输入输出，换成后端调 API
        │
        ▼
输出：符合 questions.payload / visibility schema 的 JSON 数组
        │
        ▼
[导入器] 校验 JSON schema → 写入 question_sets + questions
         （generated_by 记录来源；schema 不合法直接拒绝）
```

**规范要求**：
- 定义一份**机器可校验的题目 JSON Schema**（每个 `game_mode` 一份）。生成器产出必须过 schema 校验才能入库——这样 Claude Code 手动生成和将来 API 生成走的是同一个闸门。
- 生成器必须输出 `source_chunk_ids`，保证每题可追溯到原文。
- `generator_meta` 记录 prompt 版本/模型版本，便于将来对比题目质量、回滚。

### 5.1 抽象原则（出题与总结共用）

出题（`question_set`）和总结（`summary`）是同一管线的两种 `job_type`：输入是知识块，输出是过 JSON Schema 校验的 JSON，中间的生成器可替换。

### 5.2 触发桥：Web 上传 → Claude Code（关键）

现实约束：Claude Code 是交互式 CLI/agent，不是能在上传接口里直接调用的服务端 API。桥的设计如下，做到**个人阶段全自动**且**后期无痛换 API**：

```
入口：Web 上传页（产品形态，个人阶段你即唯一用户），走 §3 预签名直传
  → 解析成知识块 → 系统建 generation_jobs(status=pending)
        │
        ▼
本地常驻 worker（与 Claude Code 同机）轮询 pending 任务
  ├─ 用知识块拼 prompt 包（含对应 job_type 的 JSON Schema、"只输出 JSON"约束）
  ├─ 调 Claude Code 无头模式 `claude -p "<prompt>"`，捕获 stdout
  ├─ 输出过 JSON Schema 校验（不合法 → status=failed，attempts+1，可重试）
  └─ 通过 → 写 question_sets/questions 或 ai_summaries，status=done
```

- 走的是 Claude Code 订阅而非 API 计费；后期把 `claude -p` 那一行换成 API 调用，worker 与其余部分零改动（即 §5.1 的可替换生成器）。
- `generation_jobs.input_hash` 做幂等：同一批知识块不重复出题/总结，防烧 token。
- **手动兜底**：一个命令导出 prompt 文件 → 你在 Claude Code 交互界面生成 → 另一命令校验导入。无头模式异常时用，不阻塞流程。

---

## 6. 玩法数据模型

玩法的差异全部收敛到 `questions.payload` 与 `questions.visibility` 两个 JSONB 字段，外加 `session_players.role`。新增玩法不改表结构。

### 6.1 玩法一：不对称选择题 `asymmetric_choice`（你描述的核心玩法）

规则：一道选择题，**A（narrator）只看到题干，看不到选项**；**B（selector）只看到四个选项，看不到题干**。A 向 B 讲解题目，B 在听讲后选出正确项，两人合作答对才过关。

```jsonc
// questions.payload
{
  "stem": "下列哪种数据结构的查找平均时间复杂度是 O(1)?",
  "options": [
    { "key": "A", "text": "二叉搜索树" },
    { "key": "B", "text": "哈希表" },
    { "key": "C", "text": "链表" },
    { "key": "D", "text": "数组（按值查找）" }
  ],
  "answer": "B",
  "explanation": "哈希表通过哈希函数定位桶，平均 O(1)。"
}

// questions.visibility —— 服务端据此按角色裁剪下发，前端永远拿不到不该看的字段
{
  "narrator": ["stem"],                 // 讲解者：只下发题干
  "selector": ["options"],              // 选择者：只下发选项（无题干）
  "after_reveal": ["answer","explanation"]  // 揭晓后双方都可见
}
```

**强实时的核心机制**：题目数据**永远不整份发给前端**。房间服务在推送时，按当前请求者的 `role` 用 `visibility` 做字段裁剪，只发其能看的部分。`answer`/`explanation` 只在 round 进入 `revealed` 状态后下发。这样防止前端抓包看到答案，也是这个游戏成立的前提。

> **demo 实现细节（2026-05）**：
> - 不对称玩法采用"**一题一揭**"——服务端只下发 `cur_q` 这一题，选择者选 → `cur_revealed=1` → 双方看到答案与谁选了 → 任一方按"下一题" → `cur_q++` `cur_revealed=0`；最后一题揭晓后点结算自动 finalize。
> - 此外，讲解者侧还会下发 `piece.source_url` + `content_text`，前端用 `<iframe>` 把原页嵌进左侧 7/10、右侧 3/10 显示当前题；选择者两者都收到 `null`，看不到原文。

### 6.2 玩法二：共答选择题 `co_choice`（近期实现）

规则：双方**都能看到完整题目与选项**，各自独立作答（也可设"需达成一致才提交"变体）。题目正常出，无可见性裁剪——`visibility` 为空即"双方全可见"。这是不依赖讲解的轻量玩法，主要靠 §6.3 评分模型驱动"共同进步"。

```jsonc
// questions.payload 与 6.1 同结构（stem/options/answer/explanation）
// questions.visibility
{ "after_reveal": ["answer","explanation"] }   // 题干选项双方始终可见，仅答案揭晓后给
```

### 6.3 评分模型（鼓励共同进步，分差更重要）

`co_choice` 等"双方各自计分"的玩法，结算不只看总分，**分差权重更高**：

- 记两人得分 `s1, s2`（满分 `S`）。`total = s1 + s2`，`gap = |s1 − s2|`。
- 最终评分 = 总分表现 **乘以** 一个随分差快速衰减的系数：
  `grade_score = (total / 2S) × penalty(gap)`，其中 `penalty` 随 `gap` 增大而显著下降（如 `gap` 占满分一定比例即封顶在"良"以下）。
- 含义：**一个人很高、另一个人很低 → 分差大 → 拿不到好成绩**；只有两人都不错且接近，才评优。
- 评分等级（示例）：S / A / B / C；分差超阈值时无论总分多高，等级被强制压低。
- 落点：每人分写 `session_player_scores`；最终等级与 `gap`/`total` 由结算服务计算，写入对局结果并累进 `pair_stats.avg_grade`。
- `asymmetric_choice` 是合作单一结果（过/不过），不走分差评分；分差模型针对"各自作答"类玩法。

> 设计意图：奖励"带着对方一起变好"，而非"一个人 carry"。这一点要在结算页明确传达（见 PAGES）。

### 6.4 玩法可扩展位（后期，先占坑不实现）

- `relay_blank`：接龙填空，A 填前半 B 补后半。
- `time_attack_quiz`：限时抢答，双方累计分。
- `explain_then_quiz`：一方限时讲解知识块，另一方答 AI 据该块出的题。
- `mistake_hunt`：AI 给一段含错误的"笔记"，两人协作找茬。

每种新玩法的交付物 = 一份 `payload` schema + 一份 `visibility` 规则 + 角色定义（+ 是否走 §6.3 分差评分），其余系统不动。

---

## 7. 强实时协作协议

### 7.1 房间状态机

> **demo 实现已经简化为 invite/accept**（详见 §0.5）。下面这套 `lobby/ready` 是产品化目标，做出 WebSocket 时再恢复。

```
demo 实际：
  invited ──对方 accept──▶ playing ──结算──▶ finished
     │
     └─发起方 cancel / 对方拒绝──▶ 删除

产品目标：
  lobby ──两人就绪──▶ playing ──全部关卡结束──▶ finished
    │                   │
    └──超时/退出──▶ aborted ◀──主动结束──┘
```

### 7.2 WebSocket 事件（建议命名 —— demo 暂用 1.5–3s 轮询代替）

| 方向 | 事件 | 说明 |
|---|---|---|
| C→S | `room.join` / `room.ready` | 加入、就绪 |
| S→C | `room.state` | 房间/玩家/当前 round 快照（**已按角色裁剪**） |
| C→S | `round.start` | 主持开始本关 |
| S→C | `round.question` | 下发题目（**仅含该角色 visibility 允许的字段**） |
| C→S | `player.signal` | 玩家动作（narrator 讲解文本/语音状态、selector 选择 X） |
| S→C | `round.peer_signal` | 转发对方动作（同样按可见性过滤） |
| C→S | `round.submit` | 提交本关答案 |
| S→C | `round.reveal` | 揭晓对错 + answer/explanation + 原文回链 |
| S→C | `session.finished` | 全部结束，结算 |

### 7.3 安全/一致性要求

- **服务端权威**：判题、状态流转、可见性裁剪全在服务端；前端只渲染收到的数据。
- 所有下发数据经 `visibility` 过滤，敏感字段（答案）按 round 状态门控。
- 断线重连：以 `session_rounds` + `realtime_events` 重建当前可见状态。
- `realtime_events` 落库支持赛后复盘与反作弊审计。

---

## 8. 成就系统设计

核心原则：这个游戏的机制**强制双人互相依赖**（一人有题干、一人有选项），所以答对本质上是一次共同成就——成就感要建立在"我们"而非"我"上。

| 设计点 | 做法 | 数据落点 |
|---|---|---|
| 共同成就，不归个人 | 揭晓页显示"你们配合答对了"+双人名，不显示谁选错 | 由 `session_rounds` 渲染，不存归属个人 |
| 关系级"默契值" | 连胜/合作累积，归属"这对搭档"而非个人 | `pair_stats.sync_score`（派生累加） |
| 看得见的战果 | 通关生成共同学习报告/知识地图，每条回链原文或视频时间点 | `session_rounds` + `questions.source_chunk_ids` → `knowledge_chunks.source_ref` |
| 成就徽章 | 首杀/无提示通关/速通/满 combo/啃下 5 星/一起学完 N 份 | `achievements` + `session_achievements` |
| 即时反馈与仪式感 | 每题揭晓即放原文/原片段；结算页共享数据 + 可分享卡片 | 复用 `source_ref` 时间戳；结算由 session 派生 |
| 失败不归咎、角色轮换 | 答错框定为"再来一次"，AI 提示给思路不给答案；每关轮换 narrator/selector | `session_players.role` 每 round 轮换 |
| 复访钩子 | "你俩 N 天前学的《X》还剩 2 个易错点，要不要重战" | 由 `session_rounds` 失败题派生提醒 |

> 成就相关全部是**派生 + 增量**（表见 §2.5），不改动任何已有玩法/对局表。
>
> **成就墙**（聚合展示固定搭档历史解锁的全部徽章）作为**后续规划**，先在 Profile 占位（见 PAGES §11），数据已由 `session_achievements` 支撑，届时只做聚合视图。

---

## 9. 落地优先级（建议）

| 阶段 | 范围 |
|---|---|
| M1 数据地基 | 建库（§2 全部表，含 §2.5 增量表）、对象存储、上传流程（§3）、注册即绑定固定搭档 |
| M2 解析管线 | Markdown/文本/PDF（§4）+ 大资料分段（§4.4）；视频/音频转录与链接来源（§3.3）后置 |
| M3 AI 闭环 | JSON Schema + 触发桥 worker（§5.2）+ Claude Code 出题/总结 + 导入器 |
| M4 实时对局 | 房间服务 + `asymmetric_choice` + `co_choice` 两玩法 + 可见性裁剪 + 分差评分（§6/§7） |
| M5 体验打磨 | 视频转录+AI总结（§4.3）、共同学习报告、成就/默契值（§8）、链接来源（§3.3） |
| 产品化 | 出题换 API、移动端复用 API、成就墙、更多玩法 |

---

## 10. 待你后续定的开放问题

1. 对象存储用云（S3/OSS/R2）还是本地（个人阶段可先本地，规范不变）。
2. ASR（语音转文字）方案：本地模型 vs 云服务——影响视频解析何时上线。
3. "讲解"环节是纯文字、还是要语音/实时音视频通话（后者需额外的 WebRTC，可后置）。
4. 固定搭档绑定方式：邀请码 / 链接 / 双方互确认；以及是否允许解绑后重新绑定（`partnerships.status`）。
5. 分差评分 `penalty(gap)` 的具体曲线与等级阈值（产品手感问题，需试玩调参）。
6. 链接来源（YouTube/Bilibili/网页）抓取的合规边界与无字幕时的回退体验。
