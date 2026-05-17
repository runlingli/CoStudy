import { useEffect, useState } from 'react'
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
  partnership: { id: number; status: string; invite_code?: string } | null
  partner: { username: string } | null
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
          <button
            className="ml-3 text-neutral-500 underline"
            onClick={() => {
              clearToken()
              reload()
              nav('/')
            }}
          >
            退出
          </button>
        </div>
      </header>
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
