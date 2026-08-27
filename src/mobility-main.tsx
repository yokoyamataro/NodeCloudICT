// モビリティ (運転手用クライアント) のエントリポイント。
// index.html / src/main.tsx とは 別バンドルとして ビルドされる。

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import MobilityApp from './MobilityApp.tsx'
import { AppErrorBoundary } from '@/components/layout/AppErrorBoundary'
import { installChunkReloadHandler } from '@/lib/chunkReload'
import { setAppVariant } from '@/lib/appVariant'

// getActiveSource() など 初期化時に 参照される 箇所があるので render より前に。
setAppVariant('mobility')

// デプロイ直後、古い chunk ハッシュを取りに行って 404 になると画面が真っ白に
// なるので、グローバルエラーを監視して 1 回だけ自動リロードする。
installChunkReloadHandler()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppErrorBoundary>
      <MobilityApp />
    </AppErrorBoundary>
  </StrictMode>,
)
