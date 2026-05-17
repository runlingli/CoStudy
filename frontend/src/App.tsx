import { useCallback, useEffect, useRef, useState } from 'react'
import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
  Link,
  useNavigate,
} from 'react-router-dom'
import { api, clearToken, getToken } from './api'
import Login from './pages/Login'
import Partner from './pages/Partner'
import Home from './pages/Home'
import Import from './pages/Import'
import Material from './pages/Material'
import Play from './pages/Play'

export interface Me {
  user: { id: number; username: string }
  partnership: {
    id: number
    status: string
    invite_code?: string
    points?: number
  } | null
  partner: { username: string } | null
  points?: number
}

/* eslint-disable @typescript-eslint/no-explicit-any */

// 短促两声提示音；浏览器禁止自动播放时静默失败
function playInviteBeep() {
  try {
    const AC =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext
    if (!AC) return
    const ctx = new AC()
    const beep = (when: number, freq: number) => {
      const o = ctx.createOscillator()
      const g = ctx.createGain()
      o.type = 'sine'
      o.frequency.value = freq
      g.gain.setValueAtTime(0.0001, ctx.currentTime + when)
      g.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + when + 0.02)
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + when + 0.28)
      o.connect(g).connect(ctx.destination)
      o.start(ctx.currentTime + when)
      o.stop(ctx.currentTime + when + 0.3)
    }
    beep(0, 880)
    beep(0.18, 1175)
  } catch {
    /* no-op */
  }
}

// 全局邀请通知：右下角浮动，直到接受/拒绝/稍后
function InviteBanner() {
  const nav = useNavigate()
  const [incoming, setIncoming] = useState<any[]>([])
  const dismissedRef = useRef<Set<number>>(new Set())
  const seenRef = useRef<Set<number>>(new Set())

  const poll = useCallback(() => {
    api('/invites')
      .then((d) => setIncoming(d.incoming || []))
      .catch(() => {})
  }, [])

  useEffect(() => {
    poll()
    const t = setInterval(poll, 3000)
    return () => clearInterval(t)
  }, [poll])

  // 检测到新邀请就响一下
  useEffect(() => {
    for (const inv of incoming) {
      if (!seenRef.current.has(inv.session_id)) {
        seenRef.current.add(inv.session_id)
        if (!dismissedRef.current.has(inv.session_id)) playInviteBeep()
      }
    }
  }, [incoming])

  const inv = incoming.find((x) => !dismissedRef.current.has(x.session_id))
  if (!inv) return null
  const modeLabel = inv.mode === 'asymmetric_choice' ? '不对称' : '共答'
  return (
    <div className="fixed bottom-4 right-4 z-30 w-80 max-w-[calc(100vw-2rem)] rounded-md border border-amber-400 bg-amber-50 p-4 shadow-lg">
      <div className="mb-1 text-xs text-amber-700">📩 新邀请</div>
      <div className="text-sm leading-snug">
        <b>{inv.inviter_name}</b> 邀请你玩
        <br />
        「{inv.piece_title}」（{modeLabel}）
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          onClick={async () => {
            try {
              await api(`/play/${inv.session_id}/accept`, {})
              nav(`/play/${inv.session_id}`)
            } catch {
              poll()
            }
          }}
          className="border border-neutral-800 bg-neutral-800 px-3 py-1 text-sm text-white"
        >
          接受
        </button>
        <button
          onClick={async () => {
            try {
              await api(`/play/${inv.session_id}/cancel`, {})
            } catch {
              /* ignore */
            }
            poll()
          }}
          className="border border-neutral-400 px-3 py-1 text-sm"
        >
          拒绝
        </button>
        <button
          onClick={() => {
            dismissedRef.current.add(inv.session_id)
            setIncoming([...incoming])
          }}
          className="text-xs text-neutral-500 underline"
          title="本次会话内忽略此邀请"
        >
          稍后
        </button>
      </div>
    </div>
  )
}

function Shell({ me, reload }: { me: Me; reload: () => void }) {
  const nav = useNavigate()
  return (
    <div className="min-h-screen bg-white text-neutral-800">
      <header className="flex items-center justify-between border-b border-neutral-300 px-5 py-3 text-sm">
        <Link to="/" className="font-semibold">
          CoStudy
        </Link>
        <div className="text-neutral-500">
          {me.user.username}
          {me.partner ? ` · 搭档 ${me.partner.username}` : ' · 未绑定搭档'}
          {me.partner && (
            <span className="ml-2 text-amber-700">
              · 积分 {me.points ?? 0}
            </span>
          )}
          <button
            className="ml-3 text-neutral-500 underline"
            onClick={async () => {
              // 先告诉服务端关闭所有 playing 对局 + 让 token 失效
              try {
                await api('/logout', {})
              } catch {
                /* ignore */
              }
              clearToken()
              reload()
              nav('/')
            }}
          >
            退出
          </button>
        </div>
      </header>
      <InviteBanner />
      <main className="mx-auto max-w-6xl px-5 py-6">
        <Routes>
          <Route path="/" element={<Home me={me} />} />
          <Route
            path="/onboarding/partner"
            element={<Partner reload={reload} />}
          />
          <Route path="/upload" element={<Import />} />
          <Route path="/material/:id" element={<Material />} />
          <Route path="/play/:sid" element={<Play />} />
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </main>
    </div>
  )
}

export default function App() {
  const [me, setMe] = useState<Me | null>(null)
  const [loading, setLoading] = useState(true)

  const reload = () => {
    if (!getToken()) {
      setMe(null)
      setLoading(false)
      return
    }
    setLoading(true)
    api('/me')
      .then((d) => setMe(d))
      .catch(() => {
        clearToken()
        setMe(null)
      })
      .finally(() => setLoading(false))
  }

  useEffect(reload, [])

  if (loading)
    return <p className="p-6 text-sm text-neutral-500">加载中…</p>

  return (
    <BrowserRouter>
      {!me ? (
        <Login onAuthed={reload} />
      ) : !me.partner ? (
        <Routes>
          <Route path="*" element={<Partner reload={reload} forced />} />
        </Routes>
      ) : (
        <Shell me={me} reload={reload} />
      )}
    </BrowserRouter>
  )
}
