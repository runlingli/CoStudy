import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
// 真实 db 默认在 server/data/costudy.db；测试时设 COSTUDY_DB 指到别处
const dbPath =
  process.env.COSTUDY_DB || join(here, 'data', 'costudy.db')
mkdirSync(dirname(dbPath), { recursive: true })

export const db = new DatabaseSync(dbPath)

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  pass_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tokens (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

-- 固定搭档关系（注册后绑定，持久）
CREATE TABLE IF NOT EXISTS partnerships (
  id INTEGER PRIMARY KEY,
  user_a INTEGER NOT NULL,
  user_b INTEGER,
  invite_code TEXT UNIQUE,
  status TEXT NOT NULL,            -- pending | active
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS materials (
  id INTEGER PRIMARY KEY,
  partnership_id INTEGER NOT NULL,
  owner_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  source_type TEXT NOT NULL,       -- link | text
  source_value TEXT NOT NULL,
  user_note TEXT,
  created_at TEXT NOT NULL
);

-- 章（父分组）。一份资料下面 1..N 个 chunk
CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY,
  material_id INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- 节（最小学习单位）。每个 piece 属于一个 chunk
CREATE TABLE IF NOT EXISTS pieces (
  id INTEGER PRIMARY KEY,
  material_id INTEGER NOT NULL,
  chunk_id INTEGER NOT NULL,
  seq INTEGER NOT NULL,            -- 全资料范围的顺序（用于解锁下一个）
  title TEXT NOT NULL,
  source_url TEXT,
  content_text TEXT,
  parse_status TEXT NOT NULL,      -- pending | parsed
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY,
  piece_id INTEGER NOT NULL,
  qjson TEXT NOT NULL
);

-- 进度按"固定搭档"维度记录；锁/可学/完成/跳过
CREATE TABLE IF NOT EXISTS progress (
  partnership_id INTEGER NOT NULL,
  piece_id INTEGER NOT NULL,
  state TEXT NOT NULL,             -- locked | available | done | skipped
  updated_at TEXT NOT NULL,
  PRIMARY KEY (partnership_id, piece_id)
);

-- 一局对局：A 邀请 → B 接受 → playing
CREATE TABLE IF NOT EXISTS play_sessions (
  id INTEGER PRIMARY KEY,
  partnership_id INTEGER NOT NULL,
  piece_id INTEGER NOT NULL,
  mode TEXT NOT NULL,              -- co_choice | asymmetric_choice
  status TEXT NOT NULL,            -- invited | playing | finished
  invited_by INTEGER NOT NULL,     -- 发起邀请的人
  cur_q INTEGER NOT NULL DEFAULT 0,        -- 不对称：本轮 4 题的起点（0,4,8,...）
  cur_revealed INTEGER NOT NULL DEFAULT 0,
  round_shuffle TEXT,              -- 不对称：本轮 4 答案的乱序映射 (JSON array)
  result_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS play_answers (
  session_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  q_index INTEGER NOT NULL,
  choice INTEGER NOT NULL,
  correct INTEGER NOT NULL,
  PRIMARY KEY (session_id, user_id, q_index)
);

-- 跳过投票：一方申请 → 另一方同意，piece 标 skipped
CREATE TABLE IF NOT EXISTS skip_requests (
  partnership_id INTEGER NOT NULL,
  piece_id INTEGER NOT NULL,
  requester_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (partnership_id, piece_id)
);
`)

// 兼容旧 db：给已有表加新列（demo 级 migration）
try {
  db.exec('ALTER TABLE play_sessions ADD COLUMN round_shuffle TEXT')
} catch {
  /* 已有该列就跳过 */
}
