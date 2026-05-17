import express from 'express'
import { db } from './db.js'
import {
  now,
  auth,
  myPartnership,
  ensureParsed,
  completePiece,
  addPoints,
} from './lib.js'

export const playRouter = express.Router()

const ORDER = ['C', 'B', 'A', 'S'] // 越后越好
const worse = (a, b) => (ORDER.indexOf(a) <= ORDER.indexOf(b) ? a : b)

function rolesOf(partnership) {
  return { narrator: partnership.user_a, selector: partnership.user_b }
}
function uname(id) {
  return db.prepare('SELECT username FROM users WHERE id=?').get(id)?.username
}
function fullQuestions(pieceId) {
  return db
    .prepare('SELECT qjson FROM questions WHERE piece_id=? ORDER BY id')
    .all(pieceId)
    .map((r) => JSON.parse(r.qjson))
}
function roleFor(session, partnership, userId) {
  if (session.mode !== 'asymmetric_choice') return 'player'
  const r = rolesOf(partnership)
  return userId === r.narrator ? 'narrator' : 'selector'
}

// ============ A 发起邀请：建对局 → invited，等 B 接受 ============
playRouter.post('/pieces/:id/play', auth, async (req, res, next) => {
  try {
    const mode =
      req.body?.mode === 'asymmetric_choice' ? 'asymmetric_choice' : 'co_choice'
    const p = myPartnership(req.userId)
    if (!p || p.status !== 'active')
      return res.status(400).json({ error: '请先绑定固定搭档' })
    const piece = db
      .prepare('SELECT * FROM pieces WHERE id=?')
      .get(req.params.id)
    if (!piece) return res.status(404).json({ error: 'piece 不存在' })
    const pr = db
      .prepare(
        'SELECT state FROM progress WHERE partnership_id=? AND piece_id=?',
      )
      .get(p.id, piece.id)
    if (!pr || pr.state === 'locked')
      return res.status(403).json({ error: '请先学完前面的部分' })

    await ensureParsed(piece) // 邀请时就把这一节解析好（更快开场）

    // 复用：① 同 piece + 同玩法 + 还在 invited 阶段的，幂等返回
    let s = db
      .prepare(
        "SELECT * FROM play_sessions WHERE partnership_id=? AND piece_id=? AND mode=? AND status='invited' ORDER BY id DESC LIMIT 1",
      )
      .get(p.id, piece.id, mode)
    // ② 若有 playing 会话：只在双方最近都还在线时复用；否则视为废弃
    if (!s) {
      const playing = db
        .prepare(
          "SELECT * FROM play_sessions WHERE partnership_id=? AND piece_id=? AND mode=? AND status='playing' ORDER BY id DESC LIMIT 1",
        )
        .get(p.id, piece.id, mode)
      if (playing) {
        const STALE_MS = 30000
        const seen = (uid) => {
          const t = db
            .prepare(
              'SELECT last_seen FROM session_presence WHERE session_id=? AND user_id=?',
            )
            .get(playing.id, uid)?.last_seen
          return t ? Date.now() - new Date(t).getTime() < STALE_MS : false
        }
        if (seen(p.user_a) && seen(p.user_b)) {
          s = playing
        } else {
          // 双方至少一方早就离开，把这个僵尸 session 标记为废弃
          db.prepare(
            "UPDATE play_sessions SET status='finished', result_json=? WHERE id=?",
          ).run(
            JSON.stringify({
              mode: playing.mode,
              total: 0,
              abandoned: true,
              message: '中途离开，对局已废弃',
            }),
            playing.id,
          )
        }
      }
    }
    if (!s) {
      const r = db
        .prepare(
          "INSERT INTO play_sessions(partnership_id,piece_id,mode,status,invited_by,cur_q,cur_revealed,created_at) VALUES(?,?,?,'invited',?,0,0,?)",
        )
        .run(p.id, piece.id, mode, req.userId, now())
      s = db.prepare('SELECT * FROM play_sessions WHERE id=?').get(r.lastInsertRowid)
    }
    res.json({ sessionId: s.id })
  } catch (e) {
    next(e)
  }
})

// 每道题预算 60 秒；accept 时按总题数算出本局总倒计时
const SECONDS_PER_QUESTION = 60

// ============ B 接受邀请 → playing ============
playRouter.post('/play/:sid/accept', auth, (req, res) => {
  const s = db.prepare('SELECT * FROM play_sessions WHERE id=?').get(req.params.sid)
  if (!s) return res.status(404).json({ error: '对局不存在' })
  const p = myPartnership(req.userId)
  if (!p || s.partnership_id !== p.id)
    return res.status(403).json({ error: '无权访问' })
  if (s.status !== 'invited')
    return res.status(400).json({ error: '对局状态不可接受' })
  if (s.invited_by === req.userId)
    return res.status(400).json({ error: '邀请发起方无需接受，等对方' })
  // 进 playing 时定截止时间
  const full = fullQuestions(s.piece_id)
  const deadlineMs = Date.now() + full.length * SECONDS_PER_QUESTION * 1000
  db.prepare(
    "UPDATE play_sessions SET status='playing', deadline_at=? WHERE id=?",
  ).run(new Date(deadlineMs).toISOString(), s.id)
  res.json({ ok: true })
})

// 邀请方撤回（或被邀请方拒绝）
playRouter.post('/play/:sid/cancel', auth, (req, res) => {
  const s = db.prepare('SELECT * FROM play_sessions WHERE id=?').get(req.params.sid)
  if (!s) return res.status(404).json({ error: '对局不存在' })
  const p = myPartnership(req.userId)
  if (!p || s.partnership_id !== p.id)
    return res.status(403).json({ error: '无权访问' })
  if (s.status !== 'invited')
    return res.status(400).json({ error: '只能撤销邀请中的对局' })
  db.prepare('DELETE FROM play_sessions WHERE id=?').run(s.id)
  res.json({ ok: true })
})

// 是否在线：peer 最近一次拉 /play 的时间在 PRESENCE_WINDOW 内
const PRESENCE_WINDOW_MS = 8000

// ============ 对局状态（轮询，按角色裁剪） ============
playRouter.get('/play/:sid', auth, (req, res) => {
  let s = db.prepare('SELECT * FROM play_sessions WHERE id=?').get(req.params.sid)
  if (!s) return res.status(404).json({ error: '对局不存在' })
  const p = myPartnership(req.userId)
  if (!p || s.partnership_id !== p.id)
    return res.status(403).json({ error: '无权访问' })
  // 心跳：标记我"在线"
  db.prepare(
    'INSERT OR REPLACE INTO session_presence(session_id,user_id,last_seen) VALUES(?,?,?)',
  ).run(s.id, req.userId, now())
  // 超时自动结算
  s = autoFinalizeIfTimedOut(s, p)
  const role = roleFor(s, p, req.userId)
  const piece = db
    .prepare('SELECT id,title,material_id,content_text,source_url FROM pieces WHERE id=?')
    .get(s.piece_id)
  const r = rolesOf(p)
  const peerId = req.userId === p.user_a ? p.user_b : p.user_a
  const peerName = uname(peerId)
  const canSeeContent = true // 两边都看得到原文
  // 搭档心跳：最近 8 秒内见过算在线
  const peerSeen = db
    .prepare('SELECT last_seen FROM session_presence WHERE session_id=? AND user_id=?')
    .get(s.id, peerId)?.last_seen
  const peerLastSeen = peerSeen ? new Date(peerSeen).getTime() : 0
  const peerOnline = peerLastSeen > 0 && Date.now() - peerLastSeen < PRESENCE_WINDOW_MS
  const peerLastSeenSec = peerLastSeen
    ? Math.floor((Date.now() - peerLastSeen) / 1000)
    : null

  if (s.status === 'finished')
    return res.json({
      status: 'finished',
      mode: s.mode,
      role,
      piece: { id: piece.id, title: piece.title, material_id: piece.material_id },
      result: JSON.parse(s.result_json),
    })

  if (s.status === 'invited')
    return res.json({
      status: 'invited',
      mode: s.mode,
      role,
      piece: { id: piece.id, title: piece.title, material_id: piece.material_id },
      iAmInviter: s.invited_by === req.userId,
      inviterName: uname(s.invited_by),
      peerName,
      peerOnline,
      peerLastSeenSec,
      deadline_at: s.deadline_at || null,
    })

  // playing
  const full = fullQuestions(s.piece_id)
  const total = full.length

  if (s.mode === 'asymmetric_choice') {
    // 一题一揭：A 看题干 + 选 A/B/C/D（盲选，依赖搭档报选项）；B 看选项不作答
    const q = full[s.cur_q] || {}
    const myAns = db
      .prepare(
        'SELECT choice,correct FROM play_answers WHERE session_id=? AND user_id=? AND q_index=?',
      )
      .get(s.id, r.narrator, s.cur_q)
    let reveal = null
    if (s.cur_revealed) {
      reveal = {
        stem: q.stem,
        options: q.options,
        answer: q.answer,
        narratorChoice: myAns?.choice ?? null,
        passed: myAns?.correct === 1,
        explanation: q.explanation || '',
      }
    }
    return res.json({
      status: 'playing',
      mode: s.mode,
      role,
      piece: {
        id: piece.id,
        title: piece.title,
        material_id: piece.material_id,
        source_url: piece.source_url || null,
        content_text: piece.content_text || '',
      },
      curQ: s.cur_q,
      total,
      // 看题的人（narrator）才作答；他盲选 ABCD，看选项的（selector）只给搭档报选项
      iAnswer: role === 'narrator' && !s.cur_revealed,
      question:
        role === 'narrator' ? { stem: q.stem } : { options: q.options },
      myChoice: myAns?.choice ?? null,
      revealed: !!s.cur_revealed,
      reveal,
      peerName,
      peerOnline,
      peerLastSeenSec,
      deadline_at: s.deadline_at || null,
    })
  }

  // co_choice
  const mine = db
    .prepare('SELECT q_index FROM play_answers WHERE session_id=? AND user_id=?')
    .all(s.id, req.userId)
    .map((x) => x.q_index)
  const peerCount = db
    .prepare('SELECT COUNT(*) n FROM play_answers WHERE session_id=? AND user_id=?')
    .get(s.id, peerId).n
  res.json({
    status: 'playing',
    mode: s.mode,
    role,
    piece: {
      id: piece.id,
      title: piece.title,
      material_id: piece.material_id,
      content_text: canSeeContent ? piece.content_text || '' : null,
    },
    total,
    iAnswer: true,
    questions: full.map((q) => ({ stem: q.stem, options: q.options })),
    myAnswered: mine,
    peerAnsweredCount: peerCount,
    peerName,
    peerOnline,
    peerLastSeenSec,
    deadline_at: s.deadline_at || null,
  })
})

// ============ 作答 ============
playRouter.post('/play/:sid/answer', auth, (req, res) => {
  let s = db.prepare('SELECT * FROM play_sessions WHERE id=?').get(req.params.sid)
  if (!s) return res.status(404).json({ error: '对局不存在' })
  const p = myPartnership(req.userId)
  if (!p || s.partnership_id !== p.id)
    return res.status(403).json({ error: '无权访问' })
  s = autoFinalizeIfTimedOut(s, p)
  if (s.status !== 'playing')
    return res.status(400).json({ error: '对局不可作答（可能已超时或结束）' })
  const r = rolesOf(p)
  const full = fullQuestions(s.piece_id)

  if (s.mode === 'asymmetric_choice') {
    if (req.userId !== r.narrator)
      return res.status(400).json({ error: '看选项的人不作答；让看题目的搭档来选' })
    if (s.cur_revealed)
      return res.status(400).json({ error: '本题已揭晓' })
    const { qIndex, choice } = req.body || {}
    if (qIndex !== s.cur_q)
      return res.status(400).json({ error: '请回答当前题' })
    if (!Number.isInteger(choice) || choice < 0 || choice > 3)
      return res.status(400).json({ error: '参数错误' })
    const correct = full[s.cur_q].answer === choice ? 1 : 0
    db.prepare(
      'INSERT OR REPLACE INTO play_answers(session_id,user_id,q_index,choice,correct) VALUES(?,?,?,?,?)',
    ).run(s.id, req.userId, s.cur_q, choice, correct)
    db.prepare('UPDATE play_sessions SET cur_revealed=1 WHERE id=?').run(s.id)
    return res.json({ ok: true })
  }

  // co_choice：保持原行为
  const { qIndex, choice } = req.body || {}
  if (qIndex == null || qIndex < 0 || qIndex >= full.length || choice == null)
    return res.status(400).json({ error: '参数错误' })
  const correct = full[qIndex].answer === choice ? 1 : 0
  db.prepare(
    'INSERT OR REPLACE INTO play_answers(session_id,user_id,q_index,choice,correct) VALUES(?,?,?,?,?)',
  ).run(s.id, req.userId, qIndex, choice, correct)
  res.json({ ok: true })
})

// ============ 下一题（不对称专用） ============
playRouter.post('/play/:sid/next', auth, (req, res) => {
  let s = db.prepare('SELECT * FROM play_sessions WHERE id=?').get(req.params.sid)
  if (!s) return res.status(404).json({ error: '对局不存在' })
  const p = myPartnership(req.userId)
  if (!p || s.partnership_id !== p.id)
    return res.status(403).json({ error: '无权访问' })
  s = autoFinalizeIfTimedOut(s, p)
  if (s.mode !== 'asymmetric_choice')
    return res.status(400).json({ error: '该玩法不需要逐题推进' })
  if (s.status !== 'playing' || !s.cur_revealed)
    return res.status(400).json({ error: '当前题尚未揭晓或已超时' })
  const full = fullQuestions(s.piece_id)
  const nextQ = s.cur_q + 1
  if (nextQ >= full.length) {
    const result = finalizeAsymmetric(s, p)
    return res.json({ result })
  }
  db.prepare(
    'UPDATE play_sessions SET cur_q=?, cur_revealed=0 WHERE id=?',
  ).run(nextQ, s.id)
  res.json({ ok: true, curQ: nextQ })
})

function scoreUser(sid, uid, total) {
  const correct = db
    .prepare(
      'SELECT COUNT(*) n FROM play_answers WHERE session_id=? AND user_id=? AND correct=1',
    )
    .get(sid, uid).n
  return { correct, pct: total ? Math.round((correct / total) * 100) : 0 }
}
function buildReveal(sid, full) {
  return full.map((q, i) => {
    const picks = db
      .prepare(
        'SELECT user_id,choice FROM play_answers WHERE session_id=? AND q_index=?',
      )
      .all(sid, i)
    return {
      stem: q.stem,
      options: q.options,
      answer: q.answer,
      explanation: q.explanation || '',
      choices: Object.fromEntries(picks.map((x) => [uname(x.user_id), x.choice])),
    }
  })
}
function finalizeAsymmetric(s, p) {
  const r = rolesOf(p)
  const full = fullQuestions(s.piece_id)
  const total = full.length
  // 看题的 narrator 是作答方
  const nar = scoreUser(s.id, r.narrator, total)
  const pct = nar.pct
  const grade = pct >= 90 ? 'S' : pct >= 70 ? 'A' : pct >= 50 ? 'B' : 'C'
  const result = {
    mode: s.mode,
    total,
    cooperative: true,
    passed: nar.correct,
    pct,
    grade,
    message: `你们配合答对 ${nar.correct}/${total}（看题的人盲选 ABCD，看选项的人报答案）`,
    reveal: buildReveal(s.id, full),
  }
  // 积分奖励：100 基础 + 10 × 正确数
  const pointsAwarded = 100 + 10 * nar.correct
  result.pointsAwarded = pointsAwarded
  result.points = addPoints(p.id, pointsAwarded)
  db.prepare(
    "UPDATE play_sessions SET status='finished', result_json=? WHERE id=?",
  ).run(JSON.stringify(result), s.id)
  const piece = db.prepare('SELECT * FROM pieces WHERE id=?').get(s.piece_id)
  result.nextUnlocked = completePiece(p.id, piece, false)
  return result
}

// 超时自动结算：到点后任意一次 GET / 动作都会触发这里
function autoFinalizeIfTimedOut(s, p) {
  if (s.status !== 'playing' || !s.deadline_at) return s
  if (new Date(s.deadline_at).getTime() > Date.now()) return s
  const r = rolesOf(p)
  const full = fullQuestions(s.piece_id)
  const total = full.length
  let result
  if (s.mode === 'asymmetric_choice') {
    const nar = scoreUser(s.id, r.narrator, total)
    result = {
      mode: s.mode,
      total,
      cooperative: true,
      passed: nar.correct,
      pct: total ? Math.round((nar.correct / total) * 100) : 0,
      grade: 'C',
      timedOut: true,
      message: `时间到，本关失败 · 已答对 ${nar.correct}/${total}`,
      reveal: buildReveal(s.id, full),
    }
  } else {
    const a = scoreUser(s.id, p.user_a, total)
    const b = scoreUser(s.id, p.user_b, total)
    result = {
      mode: s.mode,
      total,
      timedOut: true,
      players: [
        { name: uname(p.user_a), correct: a.correct, pct: a.pct },
        { name: uname(p.user_b), correct: b.correct, pct: b.pct },
      ],
      avg: Math.round((a.pct + b.pct) / 2),
      gap: Math.abs(a.pct - b.pct),
      byAvg: 'C',
      capByGap: 'C',
      grade: 'C',
      message: '时间到，本关失败',
      reveal: buildReveal(s.id, full),
    }
  }
  // 失败：不解锁下一节、不奖励积分
  db.prepare(
    "UPDATE play_sessions SET status='finished', result_json=? WHERE id=?",
  ).run(JSON.stringify(result), s.id)
  return db.prepare('SELECT * FROM play_sessions WHERE id=?').get(s.id)
}

// ============ 结算（co_choice 专用） ============
playRouter.post('/play/:sid/finish', auth, (req, res) => {
  let s = db.prepare('SELECT * FROM play_sessions WHERE id=?').get(req.params.sid)
  if (!s) return res.status(404).json({ error: '对局不存在' })
  const p = myPartnership(req.userId)
  if (!p || s.partnership_id !== p.id)
    return res.status(403).json({ error: '无权访问' })
  s = autoFinalizeIfTimedOut(s, p)
  if (s.status === 'finished')
    return res.json({ result: JSON.parse(s.result_json) })
  if (s.mode !== 'co_choice')
    return res.status(400).json({ error: '该玩法不需要手动结算' })
  const full = fullQuestions(s.piece_id)
  const total = full.length
  const a = scoreUser(s.id, p.user_a, total)
  const b = scoreUser(s.id, p.user_b, total)
  const ansA = db
    .prepare(
      'SELECT COUNT(DISTINCT q_index) n FROM play_answers WHERE session_id=? AND user_id=?',
    )
    .get(s.id, p.user_a).n
  const ansB = db
    .prepare(
      'SELECT COUNT(DISTINCT q_index) n FROM play_answers WHERE session_id=? AND user_id=?',
    )
    .get(s.id, p.user_b).n
  if (ansA < total || ansB < total)
    return res.status(400).json({ error: '双方都答完才能结算' })
  const avg = Math.round((a.pct + b.pct) / 2)
  const gap = Math.abs(a.pct - b.pct)
  const byAvg = avg >= 90 ? 'S' : avg >= 75 ? 'A' : avg >= 60 ? 'B' : 'C'
  const capByGap = gap <= 10 ? 'S' : gap <= 25 ? 'A' : gap <= 40 ? 'B' : 'C'
  const grade = worse(byAvg, capByGap)
  const result = {
    mode: s.mode,
    total,
    players: [
      { name: uname(p.user_a), correct: a.correct, pct: a.pct },
      { name: uname(p.user_b), correct: b.correct, pct: b.pct },
    ],
    avg,
    gap,
    byAvg,
    capByGap,
    grade,
    message:
      gap > 25
        ? `分差 ${gap} 偏大 → 等级被压到 ${grade}：一起进步才上分，别一个人 carry`
        : `分差 ${gap}，配合默契，继续保持`,
    reveal: buildReveal(s.id, full),
  }
  // 积分奖励：100 基础 + 5 × 双方正确总和
  const pointsAwarded = 100 + 5 * (a.correct + b.correct)
  result.pointsAwarded = pointsAwarded
  result.points = addPoints(p.id, pointsAwarded)
  db.prepare(
    "UPDATE play_sessions SET status='finished', result_json=? WHERE id=?",
  ).run(JSON.stringify(result), s.id)
  const piece = db.prepare('SELECT * FROM pieces WHERE id=?').get(s.piece_id)
  result.nextUnlocked = completePiece(p.id, piece, false)
  res.json({ result })
})
