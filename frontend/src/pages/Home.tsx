import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import type { Me } from '../App'

interface Mat {
  id: number
  title: string
  source_type: string
  user_note: string
}

export default function Home({ me }: { me: Me }) {
  const [mats, setMats] = useState<Mat[]>([])

  useEffect(() => {
    api('/materials').then((d) => setMats(d.materials))
  }, [])

  return (
    <div>
      <div className="mb-6 border border-neutral-300 px-4 py-3 text-sm">
        固定搭档：<b>{me.partner?.username}</b>
      </div>

      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-base font-semibold">资料合集</h2>
        <Link
          to="/upload"
          className="border border-neutral-800 bg-neutral-800 px-3 py-1.5 text-sm text-white"
        >
          导入资料
        </Link>
      </div>

      {mats.length === 0 ? (
        <p className="text-sm text-neutral-500">
          还没有资料。点「导入资料」粘贴链接或文本，并写上学习备注。
        </p>
      ) : (
        <ul className="space-y-2">
          {mats.map((m) => (
            <li key={m.id} className="border border-neutral-300">
              <Link to={`/material/${m.id}`} className="block px-4 py-3">
                <div className="text-sm font-medium">{m.title}</div>
                <div className="text-xs text-neutral-500">
                  {m.source_type === 'link' ? '链接' : '文本'}
                  {m.user_note ? ` · 备注：${m.user_note}` : ''}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
