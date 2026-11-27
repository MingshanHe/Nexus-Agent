import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

// 内容安全策略只在打包时注入：开发模式下 Vite 的热更新需要内联脚本
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'"
const injectCsp: Plugin = {
  name: 'nexus-inject-csp',
  apply: 'build',
  transformIndexHtml: (html) =>
    html.replace('<!--csp-->', `<meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
}

// 主进程和预加载脚本的入口用 electron-vite 的默认约定：
// src/main/index.ts、src/preload/index.ts、src/renderer/index.html
export default defineConfig({
  main: {},
  preload: {
    build: {
      // 沙箱化的预加载脚本必须是 CommonJS
      rolldownOptions: { output: { format: 'cjs' } },
    },
  },
  renderer: {
    plugins: [react(), injectCsp],
  },
})
