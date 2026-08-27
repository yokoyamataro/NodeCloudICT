// NodeCloud モビリティ (運転手用クライアント) のルータ。
//
// ICT 本体 (src/App.tsx) とは 別バンドル。ドライバーが 他機能に 迷い込まないよう
// 実行時ガードで 弾いていたのを やめ、そもそも 積まない 形にした。
// 管理画面 (車両 / ユーザー / 運行ログ / 実績) は ICT 側に 残している。
//
// パスは basename '/m' の 下に 置く。vercel.json で /m/* を mobility.html に
// rewrite する 1 本で 済ませるため。

import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { AuthProvider, useAuth } from '@/contexts/AuthContext'
import { LoginPage } from '@/features/auth/LoginPage'
import { ResetPasswordPage } from '@/features/auth/ResetPasswordPage'
import { AcceptInvitePage } from '@/features/auth/AcceptInvitePage'
import { MobilityDriverPage } from '@/features/mobility/MobilityDriverPage'

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth()
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
      </div>
    )
  }
  if (!user) return <Navigate to="/login" replace />
  return <>{children}</>
}

function MobilityRoutes() {
  return (
    <Routes>
      {/* 認証系のみ 併設。招待受領と パスワード再設定は メールリンクから 飛んでくる */}
      <Route path="/login" element={<LoginPage />} />
      <Route path="/accept-invite" element={<AcceptInvitePage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route
        path="/drive"
        element={
          <ProtectedRoute>
            <MobilityDriverPage />
          </ProtectedRoute>
        }
      />
      {/* それ以外は ドライバー画面へ。ガードで 弾くのではなく 行き先が 1 つしか無い */}
      <Route path="*" element={<Navigate to="/drive" replace />} />
    </Routes>
  )
}

export default function MobilityApp() {
  return (
    <BrowserRouter basename="/m">
      <AuthProvider>
        <MobilityRoutes />
      </AuthProvider>
    </BrowserRouter>
  )
}
