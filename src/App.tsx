import { useEffect } from 'react'
import { BrowserRouter, Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { getDisplayModeOverride, isMobileDevice } from '@/lib/displayMode'
import { AuthProvider, useAuth } from '@/contexts/AuthContext'
import { AppLayout } from '@/components/layout/AppLayout'
import { LoginPage } from '@/features/auth/LoginPage'
import { ResetPasswordPage } from '@/features/auth/ResetPasswordPage'
import { AcceptInvitePage } from '@/features/auth/AcceptInvitePage'
import { ShareFarmViewPage } from '@/features/share/ShareFarmViewPage'
import { LandingPage } from '@/features/marketing/LandingPage'
import { ApplyPage } from '@/features/marketing/ApplyPage'
import { TermsPage } from '@/features/marketing/TermsPage'
import { PrivacyPage } from '@/features/marketing/PrivacyPage'
import { AdminSignupsPage } from '@/features/admin/AdminSignupsPage'
import { AdminOrganizationsPage } from '@/features/admin/AdminOrganizationsPage'
import { AdminAnnouncementsPage } from '@/features/admin/AdminAnnouncementsPage'
import { AdminParcelMapsPage } from '@/features/admin/AdminParcelMapsPage'
import { ProjectListPage } from '@/features/projects/ProjectListPage'
import { ProjectChooserPage } from '@/features/projects/ProjectChooserPage'
import { CoordinatesPage } from '@/features/coordinates/CoordinatesPage'
import { SiteMapWindowPage } from '@/features/coordinates/SiteMapWindowPage'
// スマホ画面
import { MobileTopPage } from '@/features/mobile/MobileTopPage'
import { MobileProjectChooserPage } from '@/features/mobile/MobileProjectChooserPage'
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
import { FarmMemosPage } from '@/features/memo/FarmMemosPage'
// 境界測量
import { BoundarySurveyWorkAreaPage } from '@/features/boundary-survey/BoundarySurveyWorkAreaPage'
import { LandownersPage } from '@/features/boundary-survey/LandownersPage'
// オルソ画像
import { OrthophotoPage } from '@/features/orthophoto/OrthophotoPage'
// 新規工種
import { SoilImportWorkAreaPage } from '@/features/soil-import/SoilImportWorkAreaPage'
import { SoilImportStripPlanPage } from '@/features/soil-import/SoilImportStripPlanPage'
import { SimpleGradingWorkAreaPage } from '@/features/simple-grading/SimpleGradingWorkAreaPage'
import { GradingWorkAreaPage } from '@/features/grading/GradingWorkAreaPage'
import { SubsoilWorkAreaPage } from '@/features/subsoil/SubsoilWorkAreaPage'
import { StoneRemovalWorkAreaPage } from '@/features/stone-removal/StoneRemovalWorkAreaPage'
import { OpenChannelAlignmentPage } from '@/features/open-channel/OpenChannelAlignmentPage'
import { TrashPage } from '@/features/trash/TrashPage'
// 個人設定
import { RegistryCredentialsPage } from '@/features/settings/RegistryCredentialsPage'
import { PasswordSettingsPage } from '@/features/settings/PasswordSettingsPage'
import { FarmSettingsPage } from '@/features/settings/FarmSettingsPage'
// モビリティ (社員/車両/重機の位置管理) - 現状はサイトオーナーのみプレビュー
import { MobilityHomePage } from '@/features/mobility/MobilityHomePage'
import { MobilityVehiclePage } from '@/features/mobility/MobilityVehiclePage'
import { MobilityFleetMapPage } from '@/features/mobility/MobilityFleetMapPage'
import { MobilityDriverPage } from '@/features/mobility/MobilityDriverPage'
import { Loader2 } from 'lucide-react'
import { isAdmin } from '@/lib/admin'

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

// サイトオーナー限定ルート。非オーナーは /coordinates に飛ばす
function SiteOwnerRoute({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth()

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
      </div>
    )
  }

  if (!user) return <Navigate to="/login" replace />
  if (!isAdmin(user.email)) return <Navigate to="/coordinates" replace />

  return <>{children}</>
}

// モバイル端末を自動判定して /mobile へリダイレクト
// ユーザーがトグルボタンで選択した場合（localStorage の override）はそれを尊重
function MobileAutoRedirect() {
  const location = useLocation()
  const navigate = useNavigate()
  const { user } = useAuth()

  useEffect(() => {
    // 未ログインは紹介(/)・ログイン・申込ページを見せたいので自動遷移しない
    if (!user) return
    const path = location.pathname
    if (
      path === '/login' ||
      path === '/site-map' ||
      path === '/lp' ||
      path === '/apply' ||
      path === '/terms' ||
      path === '/privacy' ||
      path === '/accept-invite' ||
      path.startsWith('/admin') ||
      path.startsWith('/mobile') ||
      // モビリティは PC/モバイル共通で /mobility 配下を使うので自動リダイレクト対象外。
      //   注意: '/mobility'.startsWith('/mobile') は false (7 文字目が 'i' vs 'e')
      //   なので '/mobile' 検査で誤って包含されない
      path.startsWith('/mobility') ||
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
  }, [location.pathname, navigate, user])

  return null
}

// ルート(/)のゲート: 未ログインは紹介ページ、ログイン済みはアプリ本体。
function HomeGate() {
  const { user, loading } = useAuth()
  const location = useLocation()
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
      </div>
    )
  }
  if (!user) {
    // ルートは紹介ページ、それ以外の保護パスはログインへ
    if (location.pathname === '/') return <LandingPage />
    return <Navigate to="/login" replace />
  }
  return <AppLayout />
}

function AppRoutes() {
  return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        {/* 招待リンク受領（Supabase Auth がセッション付きでここへ戻す） */}
        <Route path="/accept-invite" element={<AcceptInvitePage />} />
        {/* パスワード再設定のコールバック (メールリンククリック後) */}
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        {/* 公開: 紹介・申し込みページ（認証不要） */}
        <Route path="/lp" element={<LandingPage />} />
        <Route path="/apply" element={<ApplyPage />} />
        <Route path="/terms" element={<TermsPage />} />
        <Route path="/privacy" element={<PrivacyPage />} />
        {/* 管理者: 申し込み管理（要ログイン＋管理者メール） */}
        <Route
          path="/admin/signups"
          element={
            <ProtectedRoute>
              <AdminSignupsPage />
            </ProtectedRoute>
          }
        />
        {/* 旧 /admin/users は /admin/organizations に統合 (メンバー管理は組織単位のビュー内) */}
        <Route path="/admin/users" element={<Navigate to="/admin/organizations" replace />} />
        {/* 管理者: 組織・メンバー管理 */}
        <Route
          path="/admin/organizations"
          element={
            <ProtectedRoute>
              <AdminOrganizationsPage />
            </ProtectedRoute>
          }
        />
        {/* 管理者: お知らせ管理 */}
        <Route
          path="/admin/announcements"
          element={
            <ProtectedRoute>
              <AdminAnnouncementsPage />
            </ProtectedRoute>
          }
        />
        {/* 管理者: 地番マップ (法務省地図データ) */}
        <Route
          path="/admin/parcel-maps"
          element={
            <ProtectedRoute>
              <AdminParcelMapsPage />
            </ProtectedRoute>
          }
        />
        {/* 個人設定: 登記情報提供サービスの認証情報 (Phase 1 はサイトオーナー限定) */}
        <Route
          path="/settings/registry"
          element={
            <SiteOwnerRoute>
              <RegistryCredentialsPage />
            </SiteOwnerRoute>
          }
        />
        {/* 個人設定: パスワード変更 */}
        <Route
          path="/settings/password"
          element={
            <ProtectedRoute>
              <PasswordSettingsPage />
            </ProtectedRoute>
          }
        />
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
              <MobileProjectChooserPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/mobile/farms/:projectId"
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
        <Route path="/" element={<HomeGate />}>
        <Route index element={<ProjectChooserPage />} />
        <Route path="projects/:projectId" element={<ProjectListPage />} />
        <Route path="coordinates" element={<CoordinatesPage />} />
        {/* スマホで記録した測設記録の一覧（工区横断のトップレベル経路） */}
        <Route path="staking-records" element={<StakingRecordsPage />} />
        {/* 工区メモ */}
        <Route path="memos" element={<FarmMemosPage />} />
        {/* 境界測量 */}
        <Route path="boundary-survey">
          <Route path="work-area" element={<BoundarySurveyWorkAreaPage />} />
          <Route path="landowners" element={<LandownersPage />} />
        </Route>
        {/* オルソ画像 */}
        <Route path="orthophoto" element={<OrthophotoPage />} />
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
        <Route path="settings" element={<FarmSettingsPage />} />
        <Route path="trash" element={<TrashPage />} />
        {/* モビリティ (開発中): サイトオーナーだけが入れる。ページ側でも判定するが二重にゲート */}
        <Route
          path="mobility"
          element={
            <SiteOwnerRoute>
              <MobilityHomePage />
            </SiteOwnerRoute>
          }
        />
        <Route
          path="mobility/vehicles/:vehicleId"
          element={
            <SiteOwnerRoute>
              <MobilityVehiclePage />
            </SiteOwnerRoute>
          }
        />
        <Route
          path="mobility/map"
          element={
            <SiteOwnerRoute>
              <MobilityFleetMapPage />
            </SiteOwnerRoute>
          }
        />
        </Route>
        {/* モビリティのドライバー地図画面: AppLayout をバイパスして全画面表示。
            スマホ乗車中はサイドバー/組織情報などの装飾は不要なので、内部で
            最小ヘッダ「NodeCloud」+ 車両状態のみを描画する。 */}
        <Route
          path="/mobility/drive"
          element={
            <SiteOwnerRoute>
              <MobilityDriverPage />
            </SiteOwnerRoute>
          }
        />
      </Routes>
  )
}

// Google Analytics 4: ルーター変更ごとに page_view を送信する SPA トラッカー。
// gtag 本体は index.html で読み込み済み。send_page_view: false にしてあるので
// 初期含めここから明示的に送る。
function GATracker() {
  const location = useLocation()
  useEffect(() => {
    const w = window as unknown as {
      gtag?: (
        cmd: string,
        eventOrId: string,
        params?: Record<string, unknown>,
      ) => void
    }
    if (typeof w.gtag !== 'function') return
    const path = location.pathname + location.search
    w.gtag('event', 'page_view', {
      page_path: path,
      page_location: window.location.origin + path,
      page_title: document.title,
    })
  }, [location.pathname, location.search])
  return null
}

function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <GATracker />
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
