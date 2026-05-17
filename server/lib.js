import { spawn } from 'node:child_process'
import { db } from './db.js'

export const now = () => new Date().toISOString()

export function auth(req, res, next) {
  const t = (req.headers.authorization || '').replace('Bearer ', '')
  const row = db.prepare('SELECT user_id FROM tokens WHERE token=?').get(t)
  if (!row) return res.status(401).json({ error: '未登录' })
  req.userId = row.user_id
  next()
}

export function myPartnership(userId) {
  return db
    .prepare(
      'SELECT * FROM partnerships WHERE user_a=? OR user_b=? ORDER BY id DESC LIMIT 1',
    )
    .get(userId, userId)
}

// 抓单页正文（用于链接型 component 懒解析时取本节内容）
export async function fetchSectionText(url) {
  try {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 8000)
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (CoStudy/0.1)',
        Accept: 'text/html,*/*',
      },
      signal: ac.signal,
    })
    clearTimeout(timer)
    if (!res.ok) return ''
    const html = (await res.text()).slice(0, 1_500_000)
    // 去掉脚本/样式/导航/页头/页脚，再优先取 <article>/<main>
    const cleaned = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    const m = cleaned.match(/<(article|main)\b[^>]*>([\s\S]*?)<\/\1>/i)
    const body = m ? m[2] : cleaned
    return body
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  } catch {
    return ''
  }
}

// stub 出题（兜底）：题数按内容字数算（≈100 字/题，3~20 题）
export function makeQuestions(componentTitle, contentText = '') {
  const len = (contentText || '').length
  const count = Math.max(3, Math.min(20, Math.ceil(len / 100)))
  return Array.from({ length: count }, (_, i) => ({
    stem: `关于「${componentTitle}」的第 ${i + 1} 题（占位，AI 未生成）`,
    options: ['选项 A', '选项 B', '选项 C', '选项 D'],
    answer: 1,
  }))
}

// 校验 AI 返回的题目 JSON，只保留结构合法的
function validateAiQuestions(arr) {
  if (!Array.isArray(arr)) return null
  const out = []
  for (const q of arr) {
    if (typeof q?.stem !== 'string') continue
    if (!Array.isArray(q.options) || q.options.length !== 4) continue
    if (!q.options.every((x) => typeof x === 'string' && x.length > 0)) continue
    const a = Number(q.answer)
    if (!Number.isInteger(a) || a < 0 || a > 3) continue
    out.push({
      stem: q.stem,
      options: q.options,
      answer: a,
      explanation:
        typeof q.explanation === 'string' ? q.explanation.slice(0, 500) : '',
    })
  }
  return out.length ? out : null
}

function extractJsonArray(text) {
  if (!text) return null
  let s = text.trim()
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) s = fence[1].trim()
  const m = s.match(/\[\s*\{[\s\S]*\}\s*\]/)
  return m ? m[0] : null
}

// 用本地 Claude Code（claude -p）出题。设 COSTUDY_AI=off 可关。
export async function generateQuestionsWithClaude(title, contentText, count) {
  if (process.env.COSTUDY_AI === 'off') return null
  if (!contentText || contentText.trim().length < 30) return null
  const prompt = `你是一个学习题出题助手。根据下面的"学习内容"，出 ${count} 道单选题。
要求：
- 每题恰好 4 个选项；answer 是正确选项的下标（0-3 的整数）。
- 题目必须真实考查该内容；不要编造内容里没有的东西；不要重复或凑数。
- 仅输出严格的 JSON 数组，不要 markdown 代码块、不要解释、不要前后文字。

【小节标题】${title}
【学习内容】
${contentText.slice(0, 12000)}

JSON 结构示例：
[
  {"stem":"…?","options":["A","B","C","D"],"answer":0,"explanation":"为什么对"}
]`
  return await new Promise((resolve) => {
    let proc
    try {
      proc = spawn(
        'claude',
        [
          '-p',
          '--output-format',
          'json',
          '--model',
          'haiku',
          '--no-session-persistence',
        ],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      )
    } catch (e) {
      console.error('[ai] spawn claude failed:', e.message)
      return resolve(null)
    }
    const outChunks = []
    const errChunks = []
    const killTimer = setTimeout(() => {
      try {
        proc.kill('SIGTERM')
      } catch {}
    }, 180000)
    // 用 Buffer 收集，最后再 toString —— 防止 UTF-8 多字节字符跨块被截
    proc.stdout.on('data', (d) => outChunks.push(d))
    proc.stderr.on('data', (d) => errChunks.push(d))
    proc.on('error', (e) => {
      clearTimeout(killTimer)
      console.error('[ai] claude proc error:', e.message)
      resolve(null)
    })
    proc.on('exit', () => {
      clearTimeout(killTimer)
      const stdout = Buffer.concat(outChunks).toString('utf8')
      const stderr = Buffer.concat(errChunks).toString('utf8')
      try {
        const outer = JSON.parse(stdout)
        if (outer.is_error) {
          console.error('[ai] claude returned error:', outer.result)
          return resolve(null)
        }
        const inner = typeof outer.result === 'string' ? outer.result : ''
        const arr = extractJsonArray(inner)
        const qs = arr ? validateAiQuestions(JSON.parse(arr)) : null
        if (qs)
          console.log(
            `[ai] "${title}" → ${qs.length} 题 ($${(outer.total_cost_usd ?? 0).toFixed(3)})`,
          )
        else
          console.error(
            '[ai] no valid questions parsed. raw:',
            inner.slice(0, 200),
            'stderr:',
            stderr.slice(0, 200),
          )
        resolve(qs)
      } catch (e) {
        console.error('[ai] outer JSON parse failed:', e.message)
        resolve(null)
      }
    })
    proc.stdin.write(prompt)
    proc.stdin.end()
  })
}

// 懒解析：本 piece 第一次被学到时才（按需抓内容 + 深解析出题），返回题目数组
export async function ensureParsed(piece) {
  // 链接 piece 还没抓过内容 → 现在抓
  if (!piece.content_text && piece.source_url) {
    const text = await fetchSectionText(piece.source_url)
    if (text) {
      db.prepare('UPDATE pieces SET content_text=? WHERE id=?').run(
        text,
        piece.id,
      )
      piece.content_text = text
    }
  }
  if (piece.parse_status === 'pending') {
    const len = (piece.content_text || '').length
    const count = Math.max(3, Math.min(20, Math.ceil(len / 100)))
    let qs = await generateQuestionsWithClaude(
      piece.title,
      piece.content_text || '',
      count,
    )
    if (!qs || qs.length === 0) {
      console.warn(
        `[ai] fallback to stub for "${piece.title}" (set COSTUDY_AI=off to silence)`,
      )
      qs = makeQuestions(piece.title, piece.content_text || '')
    }
    for (const q of qs)
      db.prepare('INSERT INTO questions(piece_id,qjson) VALUES(?,?)').run(
        piece.id,
        JSON.stringify(q),
      )
    db.prepare("UPDATE pieces SET parse_status='parsed' WHERE id=?").run(
      piece.id,
    )
  }
  return db
    .prepare('SELECT qjson FROM questions WHERE piece_id=? ORDER BY id')
    .all(piece.id)
    .map((r) => JSON.parse(r.qjson))
}

// 完成或跳过一个 piece → 标记 + 解锁下一个
export function completePiece(partnershipId, piece, asSkipped = false) {
  const state = asSkipped ? 'skipped' : 'done'
  db.prepare(
    'UPDATE progress SET state=?, updated_at=? WHERE partnership_id=? AND piece_id=?',
  ).run(state, now(), partnershipId, piece.id)
  const next = db
    .prepare('SELECT id FROM pieces WHERE material_id=? AND seq=?')
    .get(piece.material_id, piece.seq + 1)
  if (next) {
    db.prepare(
      "UPDATE progress SET state='available', updated_at=? WHERE partnership_id=? AND piece_id=? AND state='locked'",
    ).run(now(), partnershipId, next.id)
  }
  return !!next
}
