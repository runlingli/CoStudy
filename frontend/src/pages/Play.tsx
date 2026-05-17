import { useCallback, useEffect, useRef, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { api } from '../api'

/* eslint-disable @typescript-eslint/no-explicit-any */

export default function Play() {
  const { sid } = useParams()
  const nav = useNavigate()
  const [st, setSt] = useState<any>(null)
  const [pick, setPick] = useState<number | null>(null)
  const [coPicks, setCoPicks] = useState<Record<number, number>>({})
  const [err, setErr] = useState('')
  const stoppedRef = useRef(false)

  const poll = useCallback(() => {
    api(`/play/${sid}`)
      .then((d) => {
        setSt(d)
        if (d.status === 'finished') stoppedRef.current = true
        // 不对称：揭晓后切到下一题时清掉本地选择
        if (d.status === 'playing' && d.mode === 'asymmetric_choice' && !d.revealed) {
          if (d.myChoice == null) setPick(null)
          else setPick(d.myChoice)
        }
      })
      .catch((e) => setErr((e as Error).message))
  }, [sid])

  useEffect(() => {
    poll()
    const t = setInterval(() => {
      if (!stoppedRef.current) poll()
    }, 1500)
    return () => clearInterval(t)
  }, [poll])

  async function accept() {
    setErr('')
    try {
      await api(`/play/${sid}/accept`, {})
      poll()
    } catch (e) {
      setErr((e as Error).message)
    }
  }
  async function cancelInvite() {
    setErr('')
    try {
      await api(`/play/${sid}/cancel`, {})
      nav('/')
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  async function submitAsym(choice: number) {
    setPick(choice)
    try {
      await api(`/play/${sid}/answer`, { qIndex: st.curQ, choice })
      poll()
    } catch (e) {
      setErr((e as Error).message)
    }
  }
  async function nextQ() {
    setErr('')
    try {
      await api(`/play/${sid}/next`, {})
      setPick(null)
      poll()
    } catch (e) {
      setErr((e as Error).message)
    }
  }
  async function answerCo(qi: number, choice: number) {
    setCoPicks((m) => ({ ...m, [qi]: choice }))
    try {
      await api(`/play/${sid}/answer`, { qIndex: qi, choice })
      poll()
    } catch (e) {
      setErr((e as Error).message)
    }
  }
  async function finishCo() {
    setErr('')
    try {
      await api(`/play/${sid}/finish`, {})
      poll()
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  if (!st) return <p className="text-sm text-neutral-500">加载中…</p>

  const headerLeft = (
    <div className="text-base font-semibold">{st.piece?.title}</div>
  )
  const headerRight = (
    <span className="text-xs text-neutral-500">
      {st.mode === 'co_choice'
        ? '共答选择题'
        : `不对称 · 你是${st.role === 'narrator' ? '讲解者' : '选择者'}`}
    </span>
  )

  // ============ 结算 ============
  if (st.status === 'finished') {
    const r = st.result
    const mid = st.piece?.material_id
    return (
      <div>
        <h2 className="text-base font-semibold">本关结算 · {st.piece?.title}</h2>
        <div className="mt-3 border border-neutral-800 p-5 text-center">
          <div className="text-5xl font-bold">{r.grade}</div>
          {r.mode === 'co_choice' ? (
            <div className="mt-3 text-sm">
              {r.players.map((p: any) => (
                <div key={p.name}>
                  {p.name}：{p.correct}/{r.total}（{p.pct}）
                </div>
              ))}
              <div className="mt-2 text-neutral-500">
                平均 {r.avg} · 分差 {r.gap}（按分差封顶 {r.capByGap}）
              </div>
            </div>
          ) : (
            <div className="mt-3 text-sm text-neutral-600">
              你们配合答对 {r.passed}/{r.total}
            </div>
          )}
          <p className="mt-3 text-sm text-neutral-700">{r.message}</p>
        </div>
        <h3 className="mt-6 mb-2 text-sm font-semibold">逐题揭晓</h3>
        <ul className="space-y-3">
          {r.reveal.map((q: any, i: number) => (
            <li key={i} className="border border-neutral-300 p-3 text-sm">
              <div className="mb-1">
                {i + 1}. {q.stem}
              </div>
              {q.options.map((o: string, oi: number) => (
                <div
                  key={oi}
                  className={oi === q.answer ? 'text-green-700' : 'text-neutral-600'}
                >
                  {oi === q.answer ? '✓ ' : '　'}
                  {o}
                  {Object.entries(q.choices)
                    .filter(([, c]) => c === oi)
                    .map(([n]) => ` ←${n}`)
                    .join('')}
                </div>
              ))}
            </li>
          ))}
        </ul>
        {r.nextUnlocked && (
          <p className="mt-4 text-sm text-green-700">已解锁下一个 component。</p>
        )}
        <div className="mt-5 flex gap-4 text-sm">
          {mid && (
            <Link
              to={`/material/${mid}`}
              className="border border-neutral-800 bg-neutral-800 px-4 py-2 text-white"
            >
              回资料
            </Link>
          )}
          <button
            className="border border-neutral-400 px-4 py-2"
            onClick={() => nav('/')}
          >
            回首页
          </button>
        </div>
      </div>
    )
  }

  // ============ 邀请中 ============
  if (st.status === 'invited') {
    return (
      <div>
        <div className="mb-3 flex items-center justify-between">
          {headerLeft}
          {headerRight}
        </div>
        <div className="border border-neutral-300 p-5 text-sm">
          <p className="mb-4">
            {st.mode === 'co_choice'
              ? '玩法：双方各自答同一批题，按分差评分（分差大压等级）。'
              : st.role === 'narrator'
              ? '你是讲解者：只看到题干，把题目讲给搭档。一题一揭。'
              : '你是选择者：看不到题干和原文，听讲解者讲后从选项里选。一题一揭。'}
          </p>
          {st.iAmInviter ? (
            <div>
              <p className="mb-3 text-neutral-600">
                已邀请 <b>{st.peerName}</b>，等 TA 接受…
              </p>
              <button
                onClick={cancelInvite}
                className="border border-neutral-400 px-4 py-2"
              >
                撤销邀请
              </button>
            </div>
          ) : (
            <div>
              <p className="mb-3 text-neutral-600">
                <b>{st.inviterName}</b> 邀请你一起玩。
              </p>
              <div className="flex gap-3">
                <button
                  onClick={accept}
                  className="border border-neutral-800 bg-neutral-800 px-4 py-2 text-white"
                >
                  接受，开始
                </button>
                <button
                  onClick={cancelInvite}
                  className="border border-neutral-400 px-4 py-2"
                >
                  拒绝
                </button>
              </div>
            </div>
          )}
        </div>
        {err && <p className="mt-3 text-sm text-red-600">{err}</p>}
      </div>
    )
  }

  // 左侧"原网页/原文"面板：iframe 优先，否则文本，否则占位
  const sourcePanel = (
    <div className="md:col-span-7">
      {st.piece?.source_url ? (
        <div className="overflow-hidden border border-neutral-200">
          <iframe
            src={st.piece.source_url}
            className="block h-[80vh] w-full"
            referrerPolicy="no-referrer"
            loading="lazy"
            title={st.piece.title || ''}
          />
          <div className="border-t border-neutral-100 bg-neutral-50 px-3 py-1 text-xs text-neutral-500">
            原页面：
            <a
              href={st.piece.source_url}
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              在新标签打开（部分站点禁止嵌入时改用此处）
            </a>
          </div>
        </div>
      ) : st.piece?.content_text != null ? (
        <div className="border border-neutral-200 p-4">
          <div className="mb-2 text-xs text-neutral-500">本节原文</div>
          <div className="h-[78vh] overflow-auto whitespace-pre-wrap text-sm text-neutral-700">
            {st.piece.content_text || '（这一节还没抓到正文）'}
          </div>
        </div>
      ) : (
        <div className="flex h-[80vh] items-center justify-center border border-dashed border-neutral-300 text-sm text-neutral-400">
          你看不到本节内容，听讲解者讲
        </div>
      )}
    </div>
  )

  // ============ 进行中 · 不对称：一题一揭 ============
  if (st.mode === 'asymmetric_choice') {
    const q = st.question || {}
    const reveal = st.reveal
    return (
      <div>
        <div className="mb-3 flex items-center justify-between">
          {headerLeft}
          {headerRight}
        </div>
        <div className="mb-3 text-xs text-neutral-500">
          第 {st.curQ + 1} / {st.total} 题
        </div>
        <div className="grid gap-4 md:grid-cols-10">
          {sourcePanel}
          <div className="md:col-span-3 border border-neutral-300 p-4 text-sm">
            <div className="mb-3 text-xs text-neutral-500">
              {st.role === 'narrator'
                ? '题干（你能看；讲给搭档听）'
                : '选项（你只能看到选项，听讲解后选）'}
            </div>
            {st.role === 'narrator' ? (
              <div className="mb-3 text-base">{q.stem}</div>
            ) : (
              <div>
                {(q.options || []).map((o: string, oi: number) => (
                  <label key={oi} className="block py-1">
                    <input
                      type="radio"
                      name="cur"
                      className="mr-2"
                      disabled={st.revealed}
                      checked={pick === oi}
                      onChange={() => submitAsym(oi)}
                    />
                    {o}
                  </label>
                ))}
              </div>
            )}

            {reveal && (
              <div className="mt-4 border-t border-neutral-200 pt-3">
                <div
                  className={
                    reveal.passed
                      ? 'mb-2 text-sm text-green-700'
                      : 'mb-2 text-sm text-red-600'
                  }
                >
                  {reveal.passed ? '你们配合答对了 ✓' : '答错了，下一题继续'}
                </div>
                <div className="mb-1 text-xs text-neutral-500">题干 / 答案：</div>
                <div className="mb-2 text-neutral-700">{reveal.stem}</div>
                {reveal.options.map((o: string, oi: number) => (
                  <div
                    key={oi}
                    className={
                      oi === reveal.answer
                        ? 'text-green-700'
                        : oi === reveal.selectorChoice
                        ? 'text-red-600'
                        : 'text-neutral-600'
                    }
                  >
                    {oi === reveal.answer ? '✓ ' : '　'}
                    {o}
                    {oi === reveal.selectorChoice ? ' ←选了' : ''}
                  </div>
                ))}
                <button
                  onClick={nextQ}
                  className="mt-3 border border-neutral-800 bg-neutral-800 px-4 py-2 text-white"
                >
                  {st.curQ + 1 >= st.total ? '结算' : '下一题 →'}
                </button>
              </div>
            )}

            {!reveal && st.role === 'narrator' && (
              <p className="mt-3 text-xs text-neutral-500">
                等选择者作答…讲清楚一点 :)
              </p>
            )}
          </div>
        </div>
        {err && <p className="mt-3 text-sm text-red-600">{err}</p>}
      </div>
    )
  }

  // ============ 进行中 · 共答选择题 ============
  const qs: any[] = st.questions || []
  const mineDone = st.myAnswered?.length || 0
  const canFinish = mineDone >= st.total && st.peerAnsweredCount >= st.total
  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        {headerLeft}
        {headerRight}
      </div>
      <div className="mb-3 border border-neutral-300 bg-neutral-50 px-3 py-2 text-xs text-neutral-600">
        各自作答同一批题。分差越小评级越高——带着搭档一起对，别一个人 carry。
      </div>
      <div className="mb-3 text-xs text-neutral-500">
        我已答 {mineDone}/{st.total} · 搭档（{st.peerName}）已答{' '}
        {st.peerAnsweredCount}/{st.total}
      </div>
      <div className="grid gap-4 md:grid-cols-10">
        {sourcePanel}
        <div className="md:col-span-3 max-h-[80vh] overflow-auto border border-neutral-300 p-3">
          <ul className="space-y-3">
            {qs.map((q, i) => (
              <li key={i} className="border border-neutral-200 p-3 text-sm">
                <div className="mb-2">
                  {i + 1}. {q.stem}
                </div>
                {q.options.map((o: string, oi: number) => (
                  <label key={oi} className="block py-0.5">
                    <input
                      type="radio"
                      className="mr-2"
                      name={`q${i}`}
                      checked={coPicks[i] === oi}
                      onChange={() => answerCo(i, oi)}
                    />
                    {o}
                  </label>
                ))}
              </li>
            ))}
          </ul>
          <button
            disabled={!canFinish}
            onClick={finishCo}
            className="mt-4 w-full border border-neutral-800 bg-neutral-800 px-4 py-2 text-sm text-white disabled:opacity-40"
          >
            {canFinish ? '结算本关' : '等双方答完…'}
          </button>
        </div>
      </div>
      {err && <p className="mt-3 text-sm text-red-600">{err}</p>}
    </div>
  )
}
