import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// 同事协作：设 BACKEND_URL=http://<DB主机IP>:3000 就能让你的前端 dev 连同事的后端
const backend = process.env.BACKEND_URL || 'http://localhost:3000'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: true, // 局域网可访问 (dev 模式)
    proxy: { '/api': backend },
  },
})
