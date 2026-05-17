const TOKEN_KEY = 'costudy_token'

export const getToken = () => localStorage.getItem(TOKEN_KEY)
export const setToken = (t: string) => localStorage.setItem(TOKEN_KEY, t)
export const clearToken = () => localStorage.removeItem(TOKEN_KEY)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function api(path: string, body?: unknown, method = 'GET'): Promise<any> {
  const res = await fetch(`/api${path}`, {
    method: body ? 'POST' : method,
    headers: {
      'Content-Type': 'application/json',
      ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  // 容错：若不是 JSON 就退回到文本，避免 500 时丢失服务器信息
  const text = await res.text()
  let data: { error?: string } = {}
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    data = { error: text.slice(0, 200) }
  }
  if (!res.ok)
    throw new Error(data.error || `请求失败 (${res.status}) ${text.slice(0, 80)}`)
  return data
}
