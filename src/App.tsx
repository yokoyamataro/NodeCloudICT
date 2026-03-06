import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { AppLayout } from '@/components/layout/AppLayout'
import { ProjectListPage } from '@/features/projects/ProjectListPage'
import { CoordinatesPage } from '@/features/coordinates/CoordinatesPage'

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<AppLayout />}>
          <Route index element={<ProjectListPage />} />
          <Route path="coordinates" element={<CoordinatesPage />} />
          <Route path="work-zones" element={<PlaceholderPage title="作業区域" />} />
          <Route path="hydraulics" element={<PlaceholderPage title="水理計算" />} />
          <Route path="settings" element={<PlaceholderPage title="設定" />} />
        </Route>
      </Routes>
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
