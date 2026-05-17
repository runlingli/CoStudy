import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'

export default function Import() {
  const nav = useNavigate()
  const [title, setTitle] = useState('')
  const [sourceType, setType] = useState<'link' | 'text'>('link')
  const [sourceValue, setValue] = useState('')
  const [note, setNote] = useState('')
  const [err, setErr] = useState('')

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setErr('')
    try {
      const d = await api('/materials', { title, sourceType, sourceValue, note })
      nav(`/material/${d.id}`)
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  return (
    <div>
      <h2 className="mb-4 text-base font-semibold">导入资料</h2>
      <form onSubmit={submit} className="space-y-4 text-sm">
        <div>
          <label className="mb-1 block text-neutral-500">标题</label>
          <input
            className="w-full border border-neutral-300 px-3 py-2"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>

        <div>
          <label className="mb-1 block text-neutral-500">来源</label>
          <div className="mb-2 flex gap-4">
            {(['link', 'text'] as const).map((t) => (
              <label key={t} className="flex items-center gap-1">
                <input
                  type="radio"
                  checked={sourceType === t}
                  onChange={() => setType(t)}
                />
                {t === 'link' ? '粘贴链接' : '粘贴文本'}
              </label>
            ))}
          </div>
          {sourceType === 'link' ? (
            <input
              className="w-full border border-neutral-300 px-3 py-2"
              placeholder="https://… （网页/教程/视频链接）"
              value={sourceValue}
              onChange={(e) => setValue(e.target.value)}
            />
          ) : (
            <textarea
              className="h-32 w-full border border-neutral-300 px-3 py-2"
              placeholder="粘贴文本/Markdown 内容"
              value={sourceValue}
              onChange={(e) => setValue(e.target.value)}
            />
          )}
        </div>

        <div>
          <label className="mb-1 block text-neutral-500">
            备注（你想学这份资料的什么）
          </label>
          <textarea
            className="h-20 w-full border border-neutral-300 px-3 py-2"
            placeholder="例：这个网页有很多子链接，我要学里面的全部内容"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <p className="mt-1 text-xs text-neutral-400">
            备注会作为 AI 第一遍粗分 component 的学习意图引导。
          </p>
        </div>

        {err && <p className="text-red-600">{err}</p>}
        <button className="border border-neutral-800 bg-neutral-800 px-4 py-2 text-white">
          导入并粗分
        </button>
      </form>
    </div>
  )
}
