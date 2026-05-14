import { useEffect } from 'react'
import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { getDisplayModeOverride, isMobileDevice } from '@/lib/displayMode'
import { AuthProvider, useAuth } from '@/contexts/AuthContext'
import { AppLayout } from '@/components/layout/AppLayout'
import { LoginPage } from '@/features/auth/LoginPage'
import { ShareFarmViewPage } from '@/features/share/ShareFarmViewPage'
import { ProjectListPage } from '@/features/projects/ProjectListPage'
import { ProjectChooserPage } from '@/features/projects/ProjectChooserPage'
import { CoordinatesPage } from '@/features/coordinates/CoordinatesPage'
import { SiteMapWindowPage } from '@/features/coordinates/SiteMapWindowPage'
// スマホ画面
import { MobileTopPage } from '@/features/mobile/MobileTopPage'
import { MobileDetailMapPage } from '@/features/mobile/MobileDetailMapPage'
import { MobileStakingPage } from '@/features/mobile/MobileStakingPage'
import { MobileUnderdrainConstructionPage } from '@/features/mobile/MobileUnderdrainConstructionPage'
// 暗渠工事
import { UnderdrainWorkAreaPage } from '@/features/underdrain/UnderdrainWorkAreaPage'
import { CadAnalysisPage } from '@/features/underdrain/CadAnalysisPage'
import { PipeCoordinateCalcPage } from '@/features/underdrain/PipeCoordinateCalcPage'
import { SurveyImportPage } from '@/features/underdrain/SurveyImportPage'
import { PipeWiringPage } from '@/features/underdrain/PipeWiringPage'
import { DepthCalcPage } from '@/features/underdrain/DepthCalcPage'
import { LandXMLPage } from '@/features/underdrain/LandXMLPage'
import { CadExportPage } from '@/features/underdrain/CadExportPage'
import { ReportsPage } from '@/features/underdrain/ReportsPage'
import { StakingRecordsPage } from '@/features/underdrain/StakingRecordsPage'
// 新規工種
import { SoilImportWorkAreaPage } from '@/features/soil-import/SoilImportWorkAreaPage'
import { SoilImportStripPlanPage } from '@/features/soil-import/SoilImportStripPlanPage'
import { SimpleGradingWorkAreaPage } from '@/features/simple-grading/SimpleGradingWorkAreaPage'
import { GradingWorkAreaPage } from '@/features/grading/GradingWorkAreaPage'
import { SubsoilWorkAreaPage } from '@/features/subsoil/SubsoilWorkAreaPage'
import { StoneRemovalWorkAreaPage } from '@/features/stone-removal/StoneRemovalWorkAreaPage'
import { OpenChannelAlignmentPage } from '@/features/open-channel/OpenChannelAlignmentPage'
import { Loader2 } from 'lucide-react'

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

// モバイル端末を自動判定して /mobile へリダイレクト
// ユーザーがトグルボタンで選択した場合（localStorage の override）はそれを尊重
function MobileAutoRedirect() {
  const location = useLocation()
  const navigate = useNavigate()

  useEffect(() => {
    const path = location.pathname
    if (
      path === '/login' ||
      path === '/site-map' ||
      path.startsWith('/mobile') ||
      path.startsWith('/share')
    ) {
      return
    }

    const override = getDisplayModeOverride()
    if (override === 'pc') return
    if (override === 'mobile') {
      navigate('/mobile', { replace: true })
      return
    }
    if (isMobileDevice()) {
      navigate('/mobile', { replace: true })
    }
  }, [location.pathname, navigate])

  return null
}

function AppRoutes() {
  return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        {/* 公開共有ビュー: 認証不要・読み取り専用 */}
        <Route path="/share/farm/:farmId" element={<ShareFarmViewPage />} />
        {/* 別ウィンドウ: 現場地図のみ全画面表示（AppLayout を介さない） */}
        <Route
          path="/site-map"
          element={
            <ProtectedRoute>
              <SiteMapWindowPage />
            </ProtectedRoute>
          }
        />
        {/* スマホ画面（AppLayout を介さない、ボタンで切替） */}
        <Route
          path="/mobile"
          element={
            <ProtectedRoute>
              <MobileTopPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/mobile/map"
          element={
            <ProtectedRoute>
              <MobileDetailMapPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/mobile/staking"
          element={
            <ProtectedRoute>
              <MobileStakingPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/mobile/construction"
          element={
            <ProtectedRoute>
              <MobileUnderdrainConstructionPage />
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
        <Route index element={<ProjectChooserPage />} />
        <Route path="projects/:projectId" element={<ProjectListPage />} />
        <Route path="coordinates" element={<CoordinatesPage />} />
        {/* 暗渠工事 */}
        <Route path="underdrain">
          <Route path="work-area" element={<UnderdrainWorkAreaPage />} />
          <Route path="cad-analysis" element={<CadAnalysisPage />} />
          <Route path="coordinate-calc" element={<PipeCoordinateCalcPage />} />
          <Route path="pipe-wiring" element={<PipeWiringPage />} />
          <Route path="survey-import" element={<SurveyImportPage />} />
          <Route path="depth-calc" element={<DepthCalcPage />} />
          <Route path="cad-export" element={<CadExportPage />} />
          <Route path="landxml" element={<LandXMLPage />} />
          <Route path="field-data" element={<StakingRecordsPage />} />
          <Route path="reports" element={<ReportsPage />} />
        </Route>
        {/* 客土工事 */}
        <Route path="soil-import">
          <Route path="work-area" element={<SoilImportWorkAreaPage />} />
          <Route path="strip-plan" element={<SoilImportStripPlanPage />} />
          <Route path="heap-plan" element={<PlaceholderPage title="坪置計画作成" />} />
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
        {/* 線形物（水路・道路） */}
        <Route path="open-channel">
          <Route path="alignment" element={<OpenChannelAlignmentPage />} />
        </Route>
        <Route path="settings" element={<PlaceholderPage title="設定" />} />
        </Route>
      </Routes>
  )
}

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <MobileAutoRedirect />
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
