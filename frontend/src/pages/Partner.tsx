import { useEffect, useState } from 'react'
import { api, clearToken } from '../api'

export default function Partner({
  reload,
  forced,
}: {
  reload: () => void
  forced?: boolean
}) {
  const [code, setCode] = useState('')
  const [myCode, setMyCode] = useState('')
  const [err, setErr] = useState('')

  // 已发起但搭档还没接受时，轮询直到绑定成功
  useEffect(() => {
    api('/me')
      .then((d) => {
        if (d.partnership?.status === 'pending')
          setMyCode(d.partnership.invite_code || '')
      })
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (!myCode) return
    const t = setInterval(() => {
      api('/me').then((d) => {
        if (d.partner) {
          clearInterval(t)
          reload()
        }
      })
    }, 2000)
    return () => clearInterval(t)
  }, [myCode, reload])

  async function create() {
    setErr('')
    try {
      const d = await api('/partner/create', {})
      setMyCode(d.invite_code)
    } catch (e) {
      setErr((e as Error).message)
    }
  }
  async function join() {
    setErr('')
    try {
      await api('/partner/join', { code })
      reload()
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  async function switchAccount() {
    // 如果有 pending 邀请先取消，避免账号留着脏数据
    if (myCode) {
      try {
        await api('/partner/cancel', {})
      } catch {
        /* ignore */
      }
    }
    clearToken()
    reload()
  }

  return (
    <div className="mx-auto max-w-sm px-5 py-16">
      {forced && (
        <button
          onClick={switchAccount}
          className="mb-4 text-xs text-neutral-500 hover:underline"
        >
          ← 切换/重新注册账号
        </button>
      )}
      <h1 className="text-lg font-semibold">绑定固定搭档</h1>
      <p className="mb-6 text-sm text-neutral-500">
        {forced ? '注册后第一步：' : ''}和一个长期搭档绑定，之后一起学。
      </p>

      {myCode ? (
        <div>
          <button
            className="mb-3 text-sm text-neutral-500 hover:underline"
            onClick={async () => {
              setErr('')
              try {
                await api('/partner/cancel', {})
              } catch {
                /* 没有 pending 也无所谓，回退即可 */
              }
              setMyCode('')
            }}
          >
            ← 返回
          </button>
          <div className="border border-neutral-300 p-4 text-sm">
            把这个邀请码发给搭档，让 TA 在另一台设备输入：
            <div className="my-3 text-2xl font-mono tracking-widest">
              {myCode}
            </div>
            <p className="text-neutral-500">等待搭档加入…（自动刷新）</p>
          </div>
        </div>
      ) : (
        <div className="space-y-6">
          <div>
            <button
              className="w-full border border-neutral-800 bg-neutral-800 px-3 py-2 text-sm text-white"
              onClick={create}
            >
              生成我的邀请码
            </button>
          </div>
          <div className="text-center text-xs text-neutral-400">或</div>
          <div className="space-y-2">
            <input
              className="w-full border border-neutral-300 px-3 py-2 text-sm uppercase"
              placeholder="输入搭档的邀请码"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
            <button
              className="w-full border border-neutral-400 px-3 py-2 text-sm"
              onClick={join}
            >
              加入
            </button>
          </div>
        </div>
      )}
      {err && <p className="mt-4 text-sm text-red-600">{err}</p>}
    </div>
  )
}
