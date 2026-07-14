import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { AppErrorBoundary } from '@/components/layout/AppErrorBoundary'
import { installChunkReloadHandler } from '@/lib/chunkReload'

// デプロイ直後、古い chunk ハッシュを取りに行って 404 になると画面が真っ白
// なるので、グローバルエラーを監視して 1 回だけ自動リロードする。
installChunkReloadHandler()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>,
)
