import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { AuthProvider, useAuth } from '@/contexts/AuthContext'
import { AppLayout } from '@/components/layout/AppLayout'
import { LoginPage } from '@/features/auth/LoginPage'
import { ProjectListPage } from '@/features/projects/ProjectListPage'
import { CoordinatesPage } from '@/features/coordinates/CoordinatesPage'
import { SiteMapWindowPage } from '@/features/coordinates/SiteMapWindowPage'
// 暗渠工事
import { UnderdrainWorkAreaPage } from '@/features/underdrain/UnderdrainWorkAreaPage'
import { CadAnalysisPage } from '@/features/underdrain/CadAnalysisPage'
import { PipeCoordinateCalcPage } from '@/features/underdrain/PipeCoordinateCalcPage'
import { SurveyImportPage } from '@/features/underdrain/SurveyImportPage'
import { PipeWiringPage } from '@/features/underdrain/PipeWiringPage'
import { DepthCalcPage } from '@/features/underdrain/DepthCalcPage'
import { LandXMLPage } from '@/features/underdrain/LandXMLPage'
// 新規工種
import { SoilImportWorkAreaPage } from '@/features/soil-import/SoilImportWorkAreaPage'
import { SimpleGradingWorkAreaPage } from '@/features/simple-grading/SimpleGradingWorkAreaPage'
import { GradingWorkAreaPage } from '@/features/grading/GradingWorkAreaPage'
import { SubsoilWorkAreaPage } from '@/features/subsoil/SubsoilWorkAreaPage'
import { StoneRemovalWorkAreaPage } from '@/features/stone-removal/StoneRemovalWorkAreaPage'
// モバイル
import { MobileFarmMapPage } from '@/features/mobile/MobileProjectMapPage'
import { Loader2 } from 'lucide-react'

// スマホ判定
const isMobile = (): boolean => {
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) ||
    window.innerWidth <= 768
}

// 認証が必要なルートのラッパー
function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth()

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
      </div>
    )
  }

  if (!user) {
    return <Navigate to="/login" replace />
  }

  return <>{children}</>
}

// トップページでスマホならモバイルページにリダイレクト
function MobileRedirectWrapper({ children }: { children: React.ReactNode }) {
  const location = useLocation()

  // トップページ（/）かつスマホの場合はモバイルページにリダイレクト
  if (location.pathname === '/' && isMobile()) {
    return <Navigate to="/mobile/map" replace />
  }

  return <>{children}</>
}

function AppRoutes() {
  return (
    <MobileRedirectWrapper>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        {/* モバイル用現場マップ */}
        <Route
          path="/mobile/map"
          element={
            <ProtectedRoute>
              <MobileFarmMapPage />
            </ProtectedRoute>
          }
        />
        {/* 別ウィンドウ: 現場地図のみ全画面表示（AppLayout を介さない） */}
        <Route
          path="/site-map"
          element={
            <ProtectedRoute>
              <SiteMapWindowPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/"
          element={
            <ProtectedRoute>
              <AppLayout />
            </ProtectedRoute>
          }
        >
        <Route index element={<ProjectListPage />} />
        <Route path="coordinates" element={<CoordinatesPage />} />
        {/* 暗渠工事 */}
        <Route path="underdrain">
          <Route path="work-area" element={<UnderdrainWorkAreaPage />} />
          <Route path="cad-analysis" element={<CadAnalysisPage />} />
          <Route path="coordinate-calc" element={<PipeCoordinateCalcPage />} />
          <Route path="pipe-wiring" element={<PipeWiringPage />} />
          <Route path="survey-import" element={<SurveyImportPage />} />
          <Route path="depth-calc" element={<DepthCalcPage />} />
          <Route path="hydraulics" element={<PlaceholderPage title="水理計算" />} />
          <Route path="cad-export" element={<PlaceholderPage title="CAD転記" />} />
          <Route path="landxml" element={<LandXMLPage />} />
          <Route path="field-data" element={<PlaceholderPage title="現場データ" />} />
          <Route path="reports" element={<PlaceholderPage title="帳票作成" />} />
        </Route>
        {/* 客土工事 */}
        <Route path="soil-import">
          <Route path="work-area" element={<SoilImportWorkAreaPage />} />
        </Route>
        {/* 簡易整地 */}
        <Route path="simple-grading">
          <Route path="work-area" element={<SimpleGradingWorkAreaPage />} />
        </Route>
        {/* 整地 */}
        <Route path="grading">
          <Route path="work-area" element={<GradingWorkAreaPage />} />
        </Route>
        {/* 心破土改 */}
        <Route path="subsoil">
          <Route path="work-area" element={<SubsoilWorkAreaPage />} />
        </Route>
        {/* 徐礫 */}
        <Route path="stone-removal">
          <Route path="work-area" element={<StoneRemovalWorkAreaPage />} />
        </Route>
        <Route path="settings" element={<PlaceholderPage title="設定" />} />
        </Route>
      </Routes>
    </MobileRedirectWrapper>
  )
}

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </BrowserRouter>
  )
}

function PlaceholderPage({ title }: { title: string }) {
  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold mb-4">{title}</h1>
      <p className="text-muted-foreground">このページは開発中です。</p>
    </div>
  )
}

export default App
