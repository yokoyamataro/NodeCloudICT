import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth } from '@/contexts/AuthContext'
import { AppLayout } from '@/components/layout/AppLayout'
import { LoginPage } from '@/features/auth/LoginPage'
import { ProjectListPage } from '@/features/projects/ProjectListPage'
import { CoordinatesPage } from '@/features/coordinates/CoordinatesPage'
import { WorkAreaPage } from '@/features/underdrain/WorkAreaPage'
import { CadAnalysisPage } from '@/features/underdrain/CadAnalysisPage'
import { PipeCoordinateCalcPage } from '@/features/underdrain/PipeCoordinateCalcPage'
import { SurveyImportPage } from '@/features/underdrain/SurveyImportPage'
import { PipeWiringPage } from '@/features/underdrain/PipeWiringPage'
import { DepthCalcPage } from '@/features/underdrain/DepthCalcPage'
import { LandXMLPage } from '@/features/underdrain/LandXMLPage'
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

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
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
          <Route path="work-area" element={<WorkAreaPage />} />
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
        <Route path="hydraulics" element={<PlaceholderPage title="水理計算" />} />
        <Route path="settings" element={<PlaceholderPage title="設定" />} />
      </Route>
    </Routes>
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
