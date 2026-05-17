import express from 'express'
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import os from 'node:os'
import { db } from './db.js'
import { now, auth, myPartnership, ensureParsed, completePiece } from './lib.js'
import { playRouter } from './play.js'

const here = dirname(fileURLToPath(import.meta.url))
const app = express()
app.use(express.json({ limit: '2mb' }))

// API 请求日志：method path → status (ms)
app.use('/api', (req, res, next) => {
  const t0 = Date.now()
  res.on('finish', () => {
    const ms = Date.now() - t0
    const tag = res.statusCode >= 500 ? '✖' : res.statusCode >= 400 ? '·' : '✓'
    console.log(`${tag} ${req.method} ${req.originalUrl} → ${res.statusCode} (${ms}ms)`)
  })
  next()
})

function hash(pw, salt) {
  return scryptSync(pw, salt, 64).toString('hex')
}

// ---- 链接抓取：拿网页 HTML → 抽出 TOC 链接 / 标题 / 正文 ----
async function fetchLinkContent(url) {
  try {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 8000)
    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) CoStudy/0.1',
        Accept: 'text/html,*/*',
      },
      signal: ac.signal,
    })
    clearTimeout(timer)
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` }
    const html = (await res.text()).slice(0, 1_500_000)
    const cleaned = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
    const headings = [
      ...cleaned.matchAll(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi),
    ]
      .map((m) =>
        m[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(),
      )
      .filter((t) => t.length > 1 && t.length < 80)
    const links = extractInternalLinks(cleaned, url)
    const text = cleaned
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    return { ok: true, headings, links, text }
  } catch (e) {
    return { ok: false, reason: e.message }
  }
}

// 抽出所有同源 <a> 的 {href,label}（按文档顺序、去重）
function extractInternalLinks(html, baseUrl) {
  let baseHost
  try {
    baseHost = new URL(baseUrl).host
  } catch {
    return []
  }
  const out = []
  const seen = new Set()
  const aRe = /<a\b[^>]*\bhref\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
  let m
  while ((m = aRe.exec(html)) !== null) {
    let href = m[1]
    const label = m[2]
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (!label || label.length > 80) continue
    if (/^(#|javascript:|mailto:|tel:)/i.test(href)) continue
    try {
      const u = new URL(href, baseUrl)
      if (u.host !== baseHost) continue
      href = u.pathname + u.search
    } catch {
      continue
    }
    if (href === '/' || href === '') continue
    const k = label + '|' + href
    if (seen.has(k)) continue
    seen.add(k)
    out.push({ href, label })
    if (out.length >= 500) break
  }
  return out
}

// 找"目录簇"：按路径首段分组，取最大的一组当 TOC
function pickTocCluster(links) {
  const groups = new Map()
  for (const l of links) {
    const seg = (l.href.split('/').filter(Boolean)[0] || '').toLowerCase()
    if (!seg) continue
    if (!groups.has(seg)) groups.set(seg, [])
    groups.get(seg).push(l)
  }
  let best = []
  for (const [, arr] of groups) if (arr.length > best.length) best = arr
  return best
}

// ---- "AI 粗分" stub：返回 chunks=[{title, pieces:[{title, source_url?, content_text?}]}] ----
function splitMaterial({ sourceType, sourceValue, fetched, materialTitle }) {
  // 1) 链接 + TOC：按 URL 第二段（章名）分组成 chunks
  if (sourceType === 'link' && fetched?.links?.length) {
    const cluster = pickTocCluster(fetched.links)
    if (cluster.length >= 5) {
      const seenLabel = new Set()
      const byChunk = new Map() // 保持首次出现顺序
      let total = 0
      for (const l of cluster) {
        if (seenLabel.has(l.label)) continue
        seenLabel.add(l.label)
        const segs = l.href.split('/').filter(Boolean)
        let chunkKey = ''
        if (segs.length >= 3) {
          try {
            chunkKey = decodeURIComponent(segs[1])
          } catch {
            chunkKey = segs[1]
          }
        }
        if (!chunkKey) chunkKey = materialTitle
        let abs = null
        try {
          abs = new URL(l.href, sourceValue).toString()
        } catch {}
        if (!byChunk.has(chunkKey)) byChunk.set(chunkKey, [])
        byChunk.get(chunkKey).push({ title: l.label, source_url: abs })
        total++
        if (total >= 100) break
      }
      return [...byChunk.entries()].map(([title, pieces]) => ({ title, pieces }))
    }
  }
  // 2) 文本：Markdown 多级标题 → # 当 chunk，## 当 piece
  if (sourceValue) {
    const lines = sourceValue.split(/\r?\n/)
    const heads = []
    lines.forEach((l, i) => {
      const m = l.match(/^(#{1,6})\s+(.+)$/)
      if (m) heads.push({ level: m[1].length, title: m[2].trim(), idx: i })
    })
    const haveH1 = heads.some((h) => h.level === 1)
    const haveH2 = heads.some((h) => h.level === 2)
    if (haveH1 && haveH2) {
      const chunks = []
      let cur = null
      for (let k = 0; k < heads.length; k++) {
        const h = heads[k]
        if (h.level === 1) {
          cur = { title: h.title, pieces: [] }
          chunks.push(cur)
        } else if (h.level === 2 && cur) {
          const start = h.idx + 1
          const end = k + 1 < heads.length ? heads[k + 1].idx : lines.length
          const body = lines.slice(start, end).join('\n').trim()
          cur.pieces.push({ title: h.title.slice(0, 80), content_text: body })
        }
      }
      const filtered = chunks.filter((c) => c.pieces.length)
      if (filtered.length) return filtered
    }
    if (heads.length >= 1) {
      // 单级标题：每个标题 = piece，全放进一个默认 chunk
      const pieces = []
      for (let k = 0; k < heads.length; k++) {
        const h = heads[k]
        const start = h.idx + 1
        const end = k + 1 < heads.length ? heads[k + 1].idx : lines.length
        const body = lines.slice(start, end).join('\n').trim()
        pieces.push({ title: h.title.slice(0, 80), content_text: body })
      }
      return [{ title: materialTitle, pieces }]
    }
    // 无标题：按长度切
    if (sourceValue.length > 200) {
      const n = Math.min(6, Math.max(2, Math.ceil(sourceValue.length / 1500)))
      const per = Math.ceil(sourceValue.length / n)
      const pieces = []
      for (let i = 0; i < n; i++) {
        const chunk = sourceValue.slice(i * per, (i + 1) * per)
        const first =
          chunk.split(/[。.!?！？\n]/)[0].slice(0, 40).trim() ||
          `部分 ${i + 1}`
        pieces.push({ title: first, content_text: chunk })
      }
      return [{ title: materialTitle, pieces }]
    }
  }
  // 3) 兜底：单 chunk + 单 piece
  return [
    {
      title: materialTitle,
      pieces: [
        {
          title: materialTitle,
          source_url: sourceType === 'link' ? sourceValue : null,
          content_text: sourceType === 'text' ? sourceValue : null,
        },
      ],
    },
  ]
}

// ================= API =================

app.post('/api/register', (req, res) => {
  const { username, password } = req.body || {}
  if (!username || !password)
    return res.status(400).json({ error: '用户名/密码必填' })
  if (db.prepare('SELECT 1 FROM users WHERE username=?').get(username))
    return res.status(400).json({ error: '用户名已存在' })
  const salt = randomBytes(16).toString('hex')
  const r = db
    .prepare(
      'INSERT INTO users(username,pass_hash,salt,created_at) VALUES(?,?,?,?)',
    )
    .run(username, hash(password, salt), salt, now())
  const token = randomBytes(24).toString('hex')
  db.prepare('INSERT INTO tokens(token,user_id,created_at) VALUES(?,?,?)').run(
    token,
    r.lastInsertRowid,
    now(),
  )
  res.json({ token, username })
})

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {}
  const u = db.prepare('SELECT * FROM users WHERE username=?').get(username)
  if (!u) return res.status(400).json({ error: '用户不存在' })
  const ok =
    Buffer.from(hash(password, u.salt)).length ===
      Buffer.from(u.pass_hash).length &&
    timingSafeEqual(Buffer.from(hash(password, u.salt)), Buffer.from(u.pass_hash))
  if (!ok) return res.status(400).json({ error: '密码错误' })
  const token = randomBytes(24).toString('hex')
  db.prepare('INSERT INTO tokens(token,user_id,created_at) VALUES(?,?,?)').run(
    token,
    u.id,
    now(),
  )
  res.json({ token, username: u.username })
})

app.get('/api/me', auth, (req, res) => {
  const u = db.prepare('SELECT id,username FROM users WHERE id=?').get(req.userId)
  const p = myPartnership(req.userId)
  let partner = null
  if (p && p.status === 'active') {
    const otherId = p.user_a === req.userId ? p.user_b : p.user_a
    partner = db.prepare('SELECT username FROM users WHERE id=?').get(otherId)
  }
  res.json({
    user: u,
    partnership: p
      ? { id: p.id, status: p.status, invite_code: p.invite_code }
      : null,
    partner,
  })
})

app.post('/api/partner/create', auth, (req, res) => {
  if (myPartnership(req.userId))
    return res.status(400).json({ error: '已有搭档关系' })
  const code = randomBytes(3).toString('hex').toUpperCase()
  db.prepare(
    'INSERT INTO partnerships(user_a,invite_code,status,created_at) VALUES(?,?,?,?)',
  ).run(req.userId, code, 'pending', now())
  res.json({ invite_code: code })
})

// 取消自己发起的、还在 pending 的邀请（被卡住的出口）
app.post('/api/partner/cancel', auth, (req, res) => {
  const mine = myPartnership(req.userId)
  if (!mine || mine.status !== 'pending')
    return res.status(400).json({ error: '没有待确认的邀请可取消' })
  if (mine.user_a !== req.userId)
    return res.status(400).json({ error: '只有发起方能取消' })
  db.prepare('DELETE FROM partnerships WHERE id=?').run(mine.id)
  res.json({ ok: true })
})

app.post('/api/partner/join', auth, (req, res) => {
  const { code } = req.body || {}
  // 允许一种情况：我自己也只是 pending 的邀请 → 自动取消我的，去加入对方
  const mine = myPartnership(req.userId)
  if (mine && mine.status === 'pending' && mine.user_a === req.userId) {
    db.prepare('DELETE FROM partnerships WHERE id=?').run(mine.id)
  } else if (mine) {
    return res.status(400).json({ error: '已有搭档关系' })
  }
  const p = db
    .prepare("SELECT * FROM partnerships WHERE invite_code=? AND status='pending'")
    .get((code || '').toUpperCase())
  if (!p) return res.status(400).json({ error: '邀请码无效' })
  if (p.user_a === req.userId)
    return res.status(400).json({ error: '不能和自己绑定' })
  db.prepare("UPDATE partnerships SET user_b=?, status='active' WHERE id=?").run(
    req.userId,
    p.id,
  )
  res.json({ ok: true })
})

// 待处理的对局邀请（全局通知用）：进来的 / 自己发出的
app.get('/api/invites', auth, (req, res) => {
  const p = myPartnership(req.userId)
  if (!p || p.status !== 'active')
    return res.json({ incoming: [], outgoing: [] })
  const rows = db
    .prepare(
      `SELECT s.id AS session_id, s.mode, s.invited_by, s.piece_id,
              pc.title AS piece_title, pc.material_id
         FROM play_sessions s
         JOIN pieces pc ON pc.id = s.piece_id
        WHERE s.partnership_id=? AND s.status='invited'
        ORDER BY s.id DESC`,
    )
    .all(p.id)
  const incoming = []
  const outgoing = []
  for (const r of rows) {
    const item = {
      session_id: r.session_id,
      mode: r.mode,
      piece_title: r.piece_title,
      material_id: r.material_id,
      inviter_name: db
        .prepare('SELECT username FROM users WHERE id=?')
        .get(r.invited_by)?.username,
    }
    if (r.invited_by === req.userId) outgoing.push(item)
    else incoming.push(item)
  }
  res.json({ incoming, outgoing })
})

app.get('/api/materials', auth, (req, res) => {
  const p = myPartnership(req.userId)
  if (!p || p.status !== 'active') return res.json({ materials: [] })
  const list = db
    .prepare(
      'SELECT id,title,source_type,user_note,created_at FROM materials WHERE partnership_id=? ORDER BY id DESC',
    )
    .all(p.id)
  res.json({ materials: list })
})

app.post('/api/materials', auth, async (req, res, next) => {
  try {
    const p = myPartnership(req.userId)
    if (!p || p.status !== 'active')
      return res.status(400).json({ error: '请先绑定固定搭档' })
    const { title, sourceType, sourceValue, note } = req.body || {}
    if (!title || !sourceValue)
      return res.status(400).json({ error: '标题与内容/链接必填' })
    const r = db
      .prepare(
        'INSERT INTO materials(partnership_id,owner_id,title,source_type,source_value,user_note,created_at) VALUES(?,?,?,?,?,?,?)',
      )
      .run(
        p.id,
        req.userId,
        title,
        sourceType === 'link' ? 'link' : 'text',
        sourceValue,
        note || '',
        now(),
      )
    const materialId = r.lastInsertRowid

    // 链接型先抓首页拿 TOC；文本型直接用原文
    let fetched = null
    if (sourceType === 'link') {
      const got = await fetchLinkContent(sourceValue)
      if (got.ok) fetched = got
      else console.log('[material] 抓取失败：', got.reason)
    }
    const chunks = splitMaterial({
      sourceType,
      sourceValue,
      fetched,
      materialTitle: title,
    })

    let pieceSeq = 1
    for (let ci = 0; ci < chunks.length; ci++) {
      const ch = chunks[ci]
      const cr = db
        .prepare(
          'INSERT INTO chunks(material_id,seq,title,created_at) VALUES(?,?,?,?)',
        )
        .run(materialId, ci + 1, ch.title.slice(0, 80), now())
      for (const pc of ch.pieces) {
        const pr2 = db
          .prepare(
            'INSERT INTO pieces(material_id,chunk_id,seq,title,source_url,content_text,parse_status,created_at) VALUES(?,?,?,?,?,?,?,?)',
          )
          .run(
            materialId,
            cr.lastInsertRowid,
            pieceSeq,
            pc.title.slice(0, 120),
            pc.source_url || null,
            pc.content_text || null,
            'pending',
            now(),
          )
        db.prepare(
          'INSERT INTO progress(partnership_id,piece_id,state,updated_at) VALUES(?,?,?,?)',
        ).run(p.id, pr2.lastInsertRowid, pieceSeq === 1 ? 'available' : 'locked', now())
        pieceSeq++
      }
    }
    res.json({ id: materialId })
  } catch (e) {
    next(e)
  }
})

app.get('/api/materials/:id', auth, (req, res) => {
  const p = myPartnership(req.userId)
  if (!p || p.status !== 'active')
    return res.status(400).json({ error: '请先绑定固定搭档' })
  const m = db
    .prepare('SELECT * FROM materials WHERE id=? AND partnership_id=?')
    .get(req.params.id, p.id)
  if (!m) return res.status(404).json({ error: '资料不存在' })
  const chunks = db
    .prepare('SELECT id,seq,title FROM chunks WHERE material_id=? ORDER BY seq')
    .all(m.id)
  const pieces = db
    .prepare(
      'SELECT id,chunk_id,seq,title,parse_status FROM pieces WHERE material_id=? ORDER BY seq',
    )
    .all(m.id)
    .map((pc) => {
      const pr = db
        .prepare(
          'SELECT state FROM progress WHERE partnership_id=? AND piece_id=?',
        )
        .get(p.id, pc.id)
      // 同伴关系下，此 piece 是否有待处理的对局邀请（来自我或对方）
      const invited = db
        .prepare(
          "SELECT id, invited_by, mode FROM play_sessions WHERE partnership_id=? AND piece_id=? AND status='invited' ORDER BY id DESC LIMIT 1",
        )
        .get(p.id, pc.id)
      const skip = db
        .prepare(
          'SELECT requester_id FROM skip_requests WHERE partnership_id=? AND piece_id=?',
        )
        .get(p.id, pc.id)
      return {
        ...pc,
        state: pr?.state || 'locked',
        pending_invite: invited
          ? {
              session_id: invited.id,
              invited_by: invited.invited_by,
              mode: invited.mode,
              from_me: invited.invited_by === req.userId,
            }
          : null,
        pending_skip: skip
          ? {
              requester_id: skip.requester_id,
              from_me: skip.requester_id === req.userId,
            }
          : null,
      }
    })
  const grouped = chunks.map((c) => ({
    ...c,
    pieces: pieces.filter((pc) => pc.chunk_id === c.id),
  }))
  res.json({
    material: {
      id: m.id,
      title: m.title,
      source_type: m.source_type,
      source_value: m.source_value,
      user_note: m.user_note,
    },
    chunks: grouped,
  })
})

// 删除资料：级联清掉 pieces/questions/progress/对局/跳过申请/chunks
app.delete('/api/materials/:id', auth, (req, res) => {
  const p = myPartnership(req.userId)
  if (!p || p.status !== 'active')
    return res.status(400).json({ error: '请先绑定固定搭档' })
  const m = db
    .prepare('SELECT id FROM materials WHERE id=? AND partnership_id=?')
    .get(req.params.id, p.id)
  if (!m) return res.status(404).json({ error: '资料不存在' })
  const pieceIds = db
    .prepare('SELECT id FROM pieces WHERE material_id=?')
    .all(m.id)
    .map((x) => x.id)
  if (pieceIds.length) {
    const ph = pieceIds.map(() => '?').join(',')
    const sessionIds = db
      .prepare(`SELECT id FROM play_sessions WHERE piece_id IN (${ph})`)
      .all(...pieceIds)
      .map((x) => x.id)
    if (sessionIds.length) {
      const sp = sessionIds.map(() => '?').join(',')
      db.prepare(`DELETE FROM play_answers WHERE session_id IN (${sp})`).run(
        ...sessionIds,
      )
      db.prepare(`DELETE FROM play_sessions WHERE id IN (${sp})`).run(
        ...sessionIds,
      )
    }
    db.prepare(`DELETE FROM questions WHERE piece_id IN (${ph})`).run(
      ...pieceIds,
    )
    db.prepare(`DELETE FROM progress WHERE piece_id IN (${ph})`).run(
      ...pieceIds,
    )
    db.prepare(`DELETE FROM skip_requests WHERE piece_id IN (${ph})`).run(
      ...pieceIds,
    )
  }
  db.prepare('DELETE FROM pieces WHERE material_id=?').run(m.id)
  db.prepare('DELETE FROM chunks WHERE material_id=?').run(m.id)
  db.prepare('DELETE FROM materials WHERE id=?').run(m.id)
  res.json({ ok: true })
})

// 懒解析（用于将来想单独"学一节但不开对局"的场景；当前对局会自动懒解析）
app.post('/api/pieces/:id/start', auth, async (req, res, next) => {
  try {
    const p = myPartnership(req.userId)
    if (!p || p.status !== 'active')
      return res.status(400).json({ error: '请先绑定固定搭档' })
    const piece = db
      .prepare('SELECT * FROM pieces WHERE id=?')
      .get(req.params.id)
    if (!piece) return res.status(404).json({ error: '不存在' })
    const pr = db
      .prepare(
        'SELECT state FROM progress WHERE partnership_id=? AND piece_id=?',
      )
      .get(p.id, piece.id)
    if (!pr || pr.state === 'locked')
      return res.status(403).json({ error: '请先学完前面的部分' })
    const qs = await ensureParsed(piece)
    res.json({ questions: qs })
  } catch (e) {
    next(e)
  }
})

app.post('/api/pieces/:id/complete', auth, (req, res) => {
  const p = myPartnership(req.userId)
  if (!p || p.status !== 'active')
    return res.status(400).json({ error: '请先绑定固定搭档' })
  const piece = db.prepare('SELECT * FROM pieces WHERE id=?').get(req.params.id)
  if (!piece) return res.status(404).json({ error: '不存在' })
  const nextUnlocked = completePiece(p.id, piece, false)
  res.json({ ok: true, nextUnlocked })
})

// ============ 跳过投票 ============
// 一方申请 → 写入 skip_requests
app.post('/api/pieces/:id/skip/request', auth, (req, res) => {
  const p = myPartnership(req.userId)
  if (!p || p.status !== 'active')
    return res.status(400).json({ error: '请先绑定固定搭档' })
  const piece = db.prepare('SELECT * FROM pieces WHERE id=?').get(req.params.id)
  if (!piece) return res.status(404).json({ error: '不存在' })
  const pr = db
    .prepare('SELECT state FROM progress WHERE partnership_id=? AND piece_id=?')
    .get(p.id, piece.id)
  if (pr?.state === 'done' || pr?.state === 'skipped')
    return res.status(400).json({ error: '本节已完成，无需跳过' })
  db.prepare(
    'INSERT OR REPLACE INTO skip_requests(partnership_id,piece_id,requester_id,created_at) VALUES(?,?,?,?)',
  ).run(p.id, piece.id, req.userId, now())
  res.json({ ok: true })
})

// 申请人取消自己的申请
app.post('/api/pieces/:id/skip/cancel', auth, (req, res) => {
  const p = myPartnership(req.userId)
  if (!p) return res.status(400).json({ error: '无搭档' })
  db.prepare(
    'DELETE FROM skip_requests WHERE partnership_id=? AND piece_id=? AND requester_id=?',
  ).run(p.id, req.params.id, req.userId)
  res.json({ ok: true })
})

// 对方同意 → 标记 skipped 并解锁下一个
app.post('/api/pieces/:id/skip/approve', auth, (req, res) => {
  const p = myPartnership(req.userId)
  if (!p) return res.status(400).json({ error: '无搭档' })
  const piece = db.prepare('SELECT * FROM pieces WHERE id=?').get(req.params.id)
  if (!piece) return res.status(404).json({ error: '不存在' })
  const sr = db
    .prepare(
      'SELECT requester_id FROM skip_requests WHERE partnership_id=? AND piece_id=?',
    )
    .get(p.id, piece.id)
  if (!sr) return res.status(400).json({ error: '没有跳过申请' })
  if (sr.requester_id === req.userId)
    return res.status(400).json({ error: '不能同意自己发起的申请' })
  db.prepare(
    'DELETE FROM skip_requests WHERE partnership_id=? AND piece_id=?',
  ).run(p.id, piece.id)
  const nextUnlocked = completePiece(p.id, piece, true)
  res.json({ ok: true, nextUnlocked })
})

// 对方拒绝 → 删除申请
app.post('/api/pieces/:id/skip/decline', auth, (req, res) => {
  const p = myPartnership(req.userId)
  if (!p) return res.status(400).json({ error: '无搭档' })
  db.prepare(
    'DELETE FROM skip_requests WHERE partnership_id=? AND piece_id=?',
  ).run(p.id, req.params.id)
  res.json({ ok: true })
})

// 对局玩法路由
app.use('/api', playRouter)

// 把任何未捕获错误变成可读的 JSON，并打印请求上下文 + 堆栈
app.use('/api', (err, req, res, _next) => {
  console.error(`[API ERROR] ${req.method} ${req.originalUrl}`)
  console.error('  body:', JSON.stringify(req.body))
  console.error(err?.stack || err)
  res.status(500).json({ error: err?.message || '服务器内部错误' })
})

// ---- serve built frontend (single port, LAN reachable) ----
const dist = join(here, '..', 'frontend', 'dist')
if (existsSync(dist)) {
  app.use(express.static(dist))
  app.get('*', (_req, res) => res.sendFile(join(dist, 'index.html')))
}

const PORT = process.env.PORT || 3000
app.listen(PORT, '0.0.0.0', () => {
  const ips = Object.values(os.networkInterfaces())
    .flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal)
    .map((n) => n.address)
  console.log(`\nCoStudy server running (db: server/data/costudy.db)`)
  console.log(`  Local:    http://localhost:${PORT}`)
  ips.forEach((ip) => console.log(`  Network:  http://${ip}:${PORT}`))
  console.log()
})
