import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

// https://vite.dev/config/
// 開発サーバー用: /m/* を mobility.html に流す。
// 本番は vercel.json の rewrite が同じ役割を持つが、vite dev はそれを見ないため
// npm run dev で /m/drive を開くと 404 になってしまう。
function mobilityDevRewrite() {
  return {
    name: 'mobility-dev-rewrite',
    configureServer(server: { middlewares: { use: (fn: (req: { url?: string }, res: unknown, next: () => void) => void) => void } }) {
      server.middlewares.use((req, _res, next) => {
        if (req.url && /^\/m(\/|$|\?)/.test(req.url)) req.url = '/mobility.html'
        next()
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), mobilityDevRewrite()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    rollupOptions: {
      // 2 エントリ構成。
      //   index.html    … NodeCloud ICT (測量土木 + モビリティ管理画面)
      //   mobility.html … NodeCloud モビリティ (運転手用クライアント)
      // 実行時に 機能を 隠すのではなく、そもそも 相手側の コードを 積まない。
      input: {
        main: path.resolve(__dirname, 'index.html'),
        mobility: path.resolve(__dirname, 'mobility.html'),
      },
    },
  },
  define: {
    __BUILD_TIME__: JSON.stringify(new Date().toLocaleString('ja-JP', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })),
  },
})
