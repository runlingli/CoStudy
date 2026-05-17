import { useState } from 'react'
import { api, setToken } from '../api'

export default function Login({ onAuthed }: { onAuthed: () => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('register')
  const [username, setU] = useState('')
  const [password, setP] = useState('')
  const [err, setErr] = useState('')

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setErr('')
    try {
      const d = await api(`/${mode}`, { username, password })
      setToken(d.token)
      onAuthed()
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  return (
    <div className="mx-auto max-w-sm px-5 py-16">
      <h1 className="text-lg font-semibold">CoStudy</h1>
      <p className="mb-6 text-sm text-neutral-500">
        和固定搭档一起学（本地 demo）
      </p>
      <form onSubmit={submit} className="space-y-3">
        <input
          className="w-full border border-neutral-300 px-3 py-2 text-sm"
          placeholder="用户名"
          value={username}
          onChange={(e) => setU(e.target.value)}
        />
        <input
          className="w-full border border-neutral-300 px-3 py-2 text-sm"
          type="password"
          placeholder="密码"
          value={password}
          onChange={(e) => setP(e.target.value)}
        />
        {err && <p className="text-sm text-red-600">{err}</p>}
        <button className="w-full border border-neutral-800 bg-neutral-800 px-3 py-2 text-sm text-white">
          {mode === 'register' ? '注册' : '登录'}
        </button>
      </form>
      <button
        className="mt-4 text-sm text-neutral-500 underline"
        onClick={() => setMode(mode === 'register' ? 'login' : 'register')}
      >
        {mode === 'register' ? '已有账号？去登录' : '没有账号？去注册'}
      </button>
    </div>
  )
}
