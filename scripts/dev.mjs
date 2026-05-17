// 一条命令同时起后端 + 前端 dev，避免"只开一个导致 /api 500"
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const procs = []

function run(name, cmd, args, cwd) {
  const p = spawn(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })
  p.on('exit', (code) => {
    console.log(`[${name}] 退出 (${code})`)
    procs.forEach((x) => x !== p && x.kill())
    process.exit(code ?? 0)
  })
  procs.push(p)
}

run('server', 'node', ['index.js'], join(root, 'server'))
run('web', 'npm', ['run', 'dev'], join(root, 'frontend'))

process.on('SIGINT', () => {
  procs.forEach((p) => p.kill())
  process.exit(0)
})
