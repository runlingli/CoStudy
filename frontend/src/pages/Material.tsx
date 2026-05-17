import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { api } from '../api'

/* eslint-disable @typescript-eslint/no-explicit-any */

const MODES = [
  {
    key: 'co_choice',
    name: '共答选择题',
    desc: '双方各自答同一批题，按"分差更重要"评 S/A/B/C',
  },
  {
    key: 'asymmetric_choice',
    name: '不对称选择题',
    desc: '讲解者只看题干 / 选择者只看选项，合作答对',
  },
]
const modeLabel = (m: string) =>
  m === 'asymmetric_choice' ? '不对称' : '共答'

export default function Material() {
  const { id } = useParams()
  const nav = useNavigate()
  const [mat, setMat] = useState<any>(null)
  const [chunks, setChunks] = useState<any[]>([])
  const [pickFor, setPickFor] = useState<number | null>(null)
  const [launching, setLaunching] = useState(false)
  const [err, setErr] = useState('')
  const [currentSeq, setCurrentSeq] = useState<number | null>(null)
  const [points, setPoints] = useState(0)
  const [pendingJump, setPendingJump] = useState<any>(null)
  const stoppedRef = useRef(false)

  const load = useCallback(() => {
    api(`/materials/${id}`)
      .then((d) => {
        setMat(d.material)
        setChunks(d.chunks || [])
        setCurrentSeq(d.currentSeq ?? null)
        setPoints(d.points ?? 0)
        setPendingJump(d.pending_jump ?? null)
      })
      .catch((e) => {
        setErr((e as Error).message)
        stoppedRef.current = true
      })
  }, [id])
  useEffect(() => {
    load()
    const t = setInterval(() => {
      if (!stoppedRef.current) load()
    }, 3000)
    return () => clearInterval(t)
  }, [load])

  async function launch(pieceId: number, mode: string) {
    setErr('')
    setLaunching(true)
    try {
      const d = await api(`/pieces/${pieceId}/play`, { mode })
      nav(`/play/${d.sessionId}`)
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setLaunching(false)
    }
  }
  async function requestJump(targetPieceId: number) {
    setErr('')
    try {
      await api('/jump/request', { targetPieceId })
      load()
    } catch (e) {
      setErr((e as Error).message)
    }
  }
  async function jumpAction(reqId: number, action: 'approve' | 'cancel') {
    setErr('')
    try {
      await api(`/jump/${reqId}/${action}`, {})
      load()
    } catch (e) {
      setErr((e as Error).message)
    }
  }
  async function delMaterial() {
    if (!confirm(`删除「${mat?.title}」？所有进度、对局、题目都会清掉。`)) return
    try {
      await api(`/materials/${id}`, undefined, 'DELETE')
      stoppedRef.current = true
      nav('/')
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  const stateLabel = (s: string) =>
    s === 'done'
      ? '已完成'
      : s === 'skipped'
      ? '已跳过'
      : s === 'available'
      ? '可学习'
      : '未解锁'

  if (err && !mat)
    return (
      <div>
        <Link to="/" className="text-sm text-neutral-500 underline">
          ← 回首页
        </Link>
        <p className="mt-3 text-sm text-red-600">{err}</p>
      </div>
    )
  if (!mat) return <p className="text-sm text-neutral-500">加载中…</p>

  const pieceCount = chunks.reduce((n, c) => n + c.pieces.length, 0)

  return (
    <div>
      <div className="flex items-center justify-between">
        <Link to="/" className="text-sm text-neutral-500 underline">
          ← 首页
        </Link>
        <button
          onClick={delMaterial}
          className="text-xs text-red-600 hover:underline"
        >
          删除此资料
        </button>
      </div>
      <h2 className="mt-2 text-base font-semibold">{mat.title}</h2>
      {mat.user_note && (
        <p className="mb-1 text-xs text-neutral-500">备注：{mat.user_note}</p>
      )}
      <p className="mb-3 text-xs text-neutral-400">
        共 {chunks.length} 章 / {pieceCount} 节 · 共享积分 {points}。
        <b>「AI 出题 + 邀请」</b>首次让 AI 出题（约 10–30s）然后邀请搭档；
        通过一关后下一节会自动免费解锁。要直接跳到后面某一节，点那一节旁
        <b>「跳到这里」</b>，按跳过节数扣 100/节，并需要搭档同意。
      </p>
      {pendingJump && (
        <div className="mb-3 border border-amber-300 bg-amber-50 px-3 py-2 text-xs">
          {pendingJump.from_me ? (
            <div className="flex items-center justify-between">
              <span>
                你提议快进到下方的某一节（消耗 {pendingJump.cost} 分），等搭档同意…
              </span>
              <button
                onClick={() => jumpAction(pendingJump.id, 'cancel')}
                className="text-neutral-500 underline"
              >
                撤销
              </button>
            </div>
          ) : (
            <div className="flex items-center justify-between">
              <span>
                搭档提议快进到下方某节，消耗 <b>{pendingJump.cost}</b> 分（你们当前 {points}）。同意？
              </span>
              <div className="flex gap-2">
                <button
                  onClick={() => jumpAction(pendingJump.id, 'approve')}
                  disabled={points < pendingJump.cost}
                  className="border border-neutral-800 bg-neutral-800 px-3 py-1 text-white disabled:opacity-40"
                >
                  同意
                </button>
                <button
                  onClick={() => jumpAction(pendingJump.id, 'cancel')}
                  className="border border-neutral-400 px-3 py-1"
                >
                  不同意
                </button>
              </div>
            </div>
          )}
        </div>
      )}
      {err && <p className="mb-3 text-sm text-red-600">{err}</p>}

      <div className="space-y-5">
        {chunks.map((ch) => (
          <section key={ch.id} className="border border-neutral-300">
            <div className="border-b border-neutral-200 bg-neutral-50 px-4 py-2 text-sm font-semibold">
              {ch.seq}. {ch.title}
              <span className="ml-2 text-xs font-normal text-neutral-400">
                {ch.pieces.length} 节
              </span>
            </div>
            <ul>
              {ch.pieces.map((pc: any) => {
                const open = pickFor === pc.id
                const locked = pc.state === 'locked'
                const finished = pc.state === 'done' || pc.state === 'skipped'
                return (
                  <li
                    key={pc.id}
                    className="border-b border-neutral-100 px-4 py-3 text-sm last:border-b-0"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <span className="text-neutral-400">{pc.seq}.</span>{' '}
                        {pc.title}
                        <span className="ml-2 text-xs text-neutral-400">
                          [{stateLabel(pc.state)}]
                        </span>
                      </div>
                      <div className="flex shrink-0 gap-2">
                        {locked ? (
                          (() => {
                            const cs = currentSeq
                            const cost =
                              cs != null && pc.seq > cs
                                ? (pc.seq - cs) * 100
                                : null
                            const isJumpTarget =
                              pendingJump?.target_piece_id === pc.id
                            return (
                              <>
                                <span className="text-xs text-neutral-400">🔒</span>
                                {cost != null && !pendingJump && (
                                  <button
                                    onClick={() => requestJump(pc.id)}
                                    disabled={points < cost}
                                    title={
                                      points < cost
                                        ? `积分不够：需要 ${cost} 分（你们当前 ${points}）`
                                        : `提议跳到这里：消耗 ${cost} 分（${pc.seq - (cs ?? 0)} 节 × 100）`
                                    }
                                    className="border border-amber-700 px-2 py-1 text-xs text-amber-800 disabled:opacity-40"
                                  >
                                    跳到这里 -{cost}
                                  </button>
                                )}
                                {isJumpTarget && (
                                  <span className="text-xs text-amber-700">
                                    ← 快进目标
                                  </span>
                                )}
                              </>
                            )
                          })()
                        ) : (
                          <>
                            <button
                              onClick={() => setPickFor(open ? null : pc.id)}
                              className="border border-neutral-800 bg-neutral-800 px-3 py-1 text-white"
                              title={
                                pc.parse_status === 'parsed'
                                  ? '已出题，直接邀请'
                                  : '首次会让 AI 出题（约 10–30s），然后邀请搭档'
                              }
                            >
                              {finished
                                ? '再玩一次'
                                : pc.parse_status === 'parsed'
                                ? '邀请对玩'
                                : 'AI 出题 + 邀请'}
                            </button>
                          </>
                        )}
                      </div>
                    </div>

                    {/* 待办行：邀请 / 跳过 */}
                    {pc.pending_invite && (
                      <div className="mt-2 flex items-center justify-between gap-2 border border-amber-300 bg-amber-50 px-3 py-2 text-xs">
                        {pc.pending_invite.from_me ? (
                          <>
                            <span>
                              已发出邀请（{modeLabel(pc.pending_invite.mode)}）
                              ，等搭档接受…
                            </span>
                            <div className="flex gap-2">
                              <Link
                                to={`/play/${pc.pending_invite.session_id}`}
                                className="underline"
                              >
                                进等待页
                              </Link>
                              <button
                                onClick={async () => {
                                  await api(
                                    `/play/${pc.pending_invite.session_id}/cancel`,
                                    {},
                                  )
                                  load()
                                }}
                                className="text-neutral-500 underline"
                              >
                                撤销
                              </button>
                            </div>
                          </>
                        ) : (
                          <>
                            <span>
                              搭档邀请你玩（
                              {modeLabel(pc.pending_invite.mode)}）
                            </span>
                            <div className="flex gap-2">
                              <button
                                onClick={async () => {
                                  await api(
                                    `/play/${pc.pending_invite.session_id}/accept`,
                                    {},
                                  )
                                  nav(
                                    `/play/${pc.pending_invite.session_id}`,
                                  )
                                }}
                                className="border border-neutral-800 bg-neutral-800 px-3 py-1 text-white"
                              >
                                接受
                              </button>
                              <button
                                onClick={async () => {
                                  await api(
                                    `/play/${pc.pending_invite.session_id}/cancel`,
                                    {},
                                  )
                                  load()
                                }}
                                className="border border-neutral-400 px-3 py-1"
                              >
                                拒绝
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    )}

                    {/* 展开：选玩法 */}
                    {open && (
                      <div className="mt-3 space-y-2 border-t border-neutral-200 pt-3">
                        <div className="text-xs text-neutral-500">
                          选玩法发起邀请（搭档接受才开始）
                          {pc.parse_status !== 'parsed' && (
                            <span className="ml-1 text-amber-700">
                              · 本节还没出题，点下面任意玩法会先让 AI 出题（约 10–30s）
                            </span>
                          )}
                          ：
                        </div>
                        {MODES.map((m) => (
                          <button
                            key={m.key}
                            disabled={launching}
                            onClick={() => launch(pc.id, m.key)}
                            className="block w-full border border-neutral-300 px-3 py-2 text-left hover:bg-neutral-50 disabled:opacity-40"
                          >
                            <div className="font-medium">{m.name}</div>
                            <div className="text-xs text-neutral-500">
                              {m.desc}
                            </div>
                          </button>
                        ))}
                        {launching && (
                          <p className="pt-1 text-xs text-neutral-500">
                            {pc.parse_status === 'parsed'
                              ? '建立邀请中…'
                              : 'AI 出题中（10–30s），然后会自动跳到等待页…'}
                          </p>
                        )}
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          </section>
        ))}
      </div>
    </div>
  )
}
