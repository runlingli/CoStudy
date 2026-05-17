import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// 后端地址优先级：shell 环境 > frontend/.env.local > 默认本机
// 同事一次性写 frontend/.env.local（被 git 忽略）即可，以后只跑 npm run dev:web
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const backend = process.env.BACKEND_URL || env.BACKEND_URL || 'http://localhost:3000'
  return {
    plugins: [react(), tailwindcss()],
    server: {
      host: true,
      proxy: { '/api': backend },
    },
  }
})
