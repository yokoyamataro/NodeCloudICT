import { useState, useMemo } from 'react'
import { MapPin, Settings, Download, Merge, Hash, Navigation, Target, Square, Map } from 'lucide-react'
import { useUnderdrainStore } from '@/stores/underdrainStore'
import { PipeMap, type SurveyPointData } from '@/components/map/PipeMap'

// 測点命名設定
interface NamingSettings {
  upstream: string    // 最上流の記号 (デフォルト: C)
  downstream: string  // 最下流の記号 (デフォルト: A)
  middle: string      // 中間の記号 (デフォルト: B)
}

// 計算された測点
interface SurveyPoint {
  id: string
  pipeId: string
  pipeNumber: string
  position: 'upstream' | 'downstream' | 'middle'
  middleIndex?: number  // 中間点の場合のインデックス（下流から）
  name: string          // 生成された名前（例: 1C, 1A, 1B1）
  mergedName?: string   // 集約後の名前（例: 1A.2C）
  x: number
  y: number
  z: number | null
}

// 同一点集約結果
interface MergedPoint {
  id: string
  originalPoints: SurveyPoint[]
  mergedName: string
  x: number
  y: number
  z: number | null
}

// 同一点判定の閾値（メートル）
const MERGE_THRESHOLD = 0.1 // 10cm

export function PipeCoordinateCalcPage() {
  const { pipes } = useUnderdrainStore()

  // 命名設定
  const [namingSettings, setNamingSettings] = useState<NamingSettings>({
    upstream: 'C',
    downstream: 'A',
    middle: 'B',
  })

  // 設定パネルの表示
  const [showSettings, setShowSettings] = useState(false)

  // 同一点集約を実行するか
  const [enableMerge, setEnableMerge] = useState(true)

  // 選択中の点
  const [selectedPointId, setSelectedPointId] = useState<string | null>(null)

  // 地図表示設定
  const [showLabels, setShowLabels] = useState(true)
  const [showDirection, setShowDirection] = useState(true)
  const [showSurveyPoints, setShowSurveyPoints] = useState(true)
  const [showZones, setShowZones] = useState(false)
  const [showCoordinates, setShowCoordinates] = useState(false)

  // 測点を生成
  const surveyPoints = useMemo(() => {
    const points: SurveyPoint[] = []

    for (const pipe of pipes) {
      if (pipe.vertices.length < 2) continue

      const vertices = pipe.vertices

      // 最上流（始点）
      points.push({
        id: `${pipe.id}-upstream`,
        pipeId: pipe.id,
        pipeNumber: pipe.number,
        position: 'upstream',
        name: `${pipe.number}${namingSettings.upstream}`,
        x: vertices[0].x,
        y: vertices[0].y,
        z: vertices[0].z,
      })

      // 中間点（下流から順にB1, B2, B3...）
      if (vertices.length > 2) {
        // 中間点のインデックス（終点を除く、始点を除く）
        // vertices[1] から vertices[length-2] まで
        const middleCount = vertices.length - 2
        for (let i = 0; i < middleCount; i++) {
          // 下流から順なので、実際の配列インデックスは逆順
          const vertexIndex = vertices.length - 2 - i
          const middleIndex = i + 1 // B1, B2, B3...

          points.push({
            id: `${pipe.id}-middle-${middleIndex}`,
            pipeId: pipe.id,
            pipeNumber: pipe.number,
            position: 'middle',
            middleIndex,
            name: `${pipe.number}${namingSettings.middle}${middleIndex}`,
            x: vertices[vertexIndex].x,
            y: vertices[vertexIndex].y,
            z: vertices[vertexIndex].z,
          })
        }
      }

      // 最下流（終点）
      const lastVertex = vertices[vertices.length - 1]
      points.push({
        id: `${pipe.id}-downstream`,
        pipeId: pipe.id,
        pipeNumber: pipe.number,
        position: 'downstream',
        name: `${pipe.number}${namingSettings.downstream}`,
        x: lastVertex.x,
        y: lastVertex.y,
        z: lastVertex.z,
      })
    }

    return points
  }, [pipes, namingSettings])

  // 同一点を集約
  const mergedPoints = useMemo(() => {
    if (!enableMerge) {
      // 集約しない場合はそのまま返す
      return surveyPoints.map(point => ({
        id: point.id,
        originalPoints: [point],
        mergedName: point.name,
        x: point.x,
        y: point.y,
        z: point.z,
      }))
    }

    const result: MergedPoint[] = []
    const processed = new Set<string>()

    for (const point of surveyPoints) {
      if (processed.has(point.id)) continue

      // この点と同一位置の点を探す
      const samePoints = surveyPoints.filter(p => {
        if (processed.has(p.id)) return false
        const dx = p.x - point.x
        const dy = p.y - point.y
        return Math.sqrt(dx * dx + dy * dy) <= MERGE_THRESHOLD
      })

      // 集約名を生成（ピリオドで連結）
      const mergedName = samePoints.map(p => p.name).join('.')

      // 処理済みにマーク
      for (const p of samePoints) {
        processed.add(p.id)
      }

      // Z座標は最初の非nullを使用
      const z = samePoints.find(p => p.z !== null)?.z ?? null

      result.push({
        id: samePoints.map(p => p.id).join('-'),
        originalPoints: samePoints,
        mergedName,
        x: point.x,
        y: point.y,
        z,
      })
    }

    return result
  }, [surveyPoints, enableMerge])

  // 地図表示用の測点データを生成
  const mapSurveyPoints: SurveyPointData[] = useMemo(() => {
    return mergedPoints.map(point => ({
      id: point.id,
      name: point.mergedName,
      x: point.x,
      y: point.y,
      z: point.z,
      isMerged: point.originalPoints.length > 1,
      originalCount: point.originalPoints.length,
    }))
  }, [mergedPoints])

  // CSVエクスポート
  const handleExportCSV = () => {
    const header = '点名,X,Y,Z\n'
    const rows = mergedPoints
      .map(p => `${p.mergedName},${p.x.toFixed(3)},${p.y.toFixed(3)},${p.z?.toFixed(3) ?? ''}`)
      .join('\n')

    const blob = new Blob([header + rows], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'pipe_coordinates.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="h-full flex flex-col">
      {/* ヘッダー */}
      <div className="p-4 border-b bg-white flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2">
            <MapPin className="h-5 w-5" />
            座標計算
          </h1>
          <p className="text-sm text-muted-foreground">
            管路の頂点から測点座標を生成・同一点を集約
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowSettings(!showSettings)}
            className={`flex items-center gap-1 px-3 py-1.5 text-sm border rounded hover:bg-slate-50 ${
              showSettings ? 'bg-blue-50 border-blue-300' : ''
            }`}
          >
            <Settings className="h-4 w-4" />
            命名設定
          </button>
          <button
            onClick={handleExportCSV}
            disabled={mergedPoints.length === 0}
            className="flex items-center gap-1 px-3 py-1.5 text-sm border rounded hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Download className="h-4 w-4" />
            CSV出力
          </button>
        </div>
      </div>

      {/* 設定パネル */}
      {showSettings && (
        <div className="p-4 bg-blue-50 border-b">
          <h3 className="text-sm font-medium mb-3">測点命名規則</h3>
          <div className="grid grid-cols-3 gap-4 max-w-lg">
            <div>
              <label className="block text-xs text-muted-foreground mb-1">最上流</label>
              <input
                type="text"
                value={namingSettings.upstream}
                onChange={(e) => setNamingSettings(prev => ({ ...prev, upstream: e.target.value }))}
                className="w-full px-2 py-1.5 border rounded text-sm"
                placeholder="C"
              />
              <p className="text-xs text-muted-foreground mt-1">例: 1C</p>
            </div>
            <div>
              <label className="block text-xs text-muted-foreground mb-1">最下流</label>
              <input
                type="text"
                value={namingSettings.downstream}
                onChange={(e) => setNamingSettings(prev => ({ ...prev, downstream: e.target.value }))}
                className="w-full px-2 py-1.5 border rounded text-sm"
                placeholder="A"
              />
              <p className="text-xs text-muted-foreground mt-1">例: 1A</p>
            </div>
            <div>
              <label className="block text-xs text-muted-foreground mb-1">中間</label>
              <input
                type="text"
                value={namingSettings.middle}
                onChange={(e) => setNamingSettings(prev => ({ ...prev, middle: e.target.value }))}
                className="w-full px-2 py-1.5 border rounded text-sm"
                placeholder="B"
              />
              <p className="text-xs text-muted-foreground mt-1">例: 1B1, 1B2...</p>
            </div>
          </div>
          <div className="mt-3 flex items-center gap-2">
            <input
              type="checkbox"
              id="enableMerge"
              checked={enableMerge}
              onChange={(e) => setEnableMerge(e.target.checked)}
              className="h-4 w-4"
            />
            <label htmlFor="enableMerge" className="text-sm">
              同一点を集約（{MERGE_THRESHOLD * 100}cm以内の点を統合）
            </label>
          </div>
        </div>
      )}

      {/* メインコンテンツ */}
      <div className="flex-1 flex overflow-hidden">
        {/* 左側: 座標一覧 */}
        <div className="w-1/2 flex flex-col overflow-hidden border-r">
          {/* 統計情報 */}
          <div className="p-3 bg-slate-50 border-b text-sm flex items-center gap-4">
            <span>管路数: {pipes.length}</span>
            <span>測点数: {surveyPoints.length}</span>
            {enableMerge && (
              <span className="text-blue-600">
                <Merge className="h-3.5 w-3.5 inline mr-1" />
                集約後: {mergedPoints.length}点
              </span>
            )}
          </div>

          {/* テーブル */}
          <div className="flex-1 overflow-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-100 sticky top-0 z-10">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">点名</th>
                  <th className="px-3 py-2 text-right font-medium">X (m)</th>
                  <th className="px-3 py-2 text-right font-medium">Y (m)</th>
                  <th className="px-3 py-2 text-right font-medium">Z (m)</th>
                  {enableMerge && (
                    <th className="px-3 py-2 text-center font-medium">集約</th>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y">
                {mergedPoints.map((point) => {
                  const isMerged = point.originalPoints.length > 1
                  return (
                    <tr
                      key={point.id}
                      className={`hover:bg-slate-50 cursor-pointer ${
                        selectedPointId === point.id ? 'bg-blue-50' : ''
                      } ${isMerged ? 'bg-yellow-50' : ''}`}
                      onClick={() => setSelectedPointId(point.id)}
                    >
                      <td className="px-3 py-2 font-mono">
                        {point.mergedName}
                      </td>
                      <td className="px-3 py-2 text-right font-mono">
                        {point.x.toFixed(3)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono">
                        {point.y.toFixed(3)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono">
                        {point.z?.toFixed(3) ?? '-'}
                      </td>
                      {enableMerge && (
                        <td className="px-3 py-2 text-center">
                          {isMerged && (
                            <span className="inline-flex items-center px-2 py-0.5 text-xs bg-yellow-200 text-yellow-800 rounded">
                              {point.originalPoints.length}点
                            </span>
                          )}
                        </td>
                      )}
                    </tr>
                  )
                })}
                {mergedPoints.length === 0 && (
                  <tr>
                    <td colSpan={enableMerge ? 5 : 4} className="px-4 py-8 text-center text-muted-foreground">
                      管路データがありません。CAD解析で管路を登録してください。
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* 右側: 地図 */}
        <div className="w-1/2 flex flex-col bg-slate-100">
          {/* 地図表示ボタン */}
          <div className="p-2 bg-white border-b flex items-center gap-2">
            <button
              onClick={() => setShowLabels(!showLabels)}
              className={`flex items-center gap-1 px-3 py-1.5 text-sm border rounded hover:bg-slate-50 ${
                showLabels ? 'bg-blue-50 border-blue-300 text-blue-700' : ''
              }`}
            >
              <Hash className="h-4 w-4" />
              番号表示
            </button>
            <button
              onClick={() => setShowDirection(!showDirection)}
              className={`flex items-center gap-1 px-3 py-1.5 text-sm border rounded hover:bg-slate-50 ${
                showDirection ? 'bg-blue-50 border-blue-300 text-blue-700' : ''
              }`}
            >
              <Navigation className="h-4 w-4" />
              方向表示
            </button>
            <button
              onClick={() => setShowSurveyPoints(!showSurveyPoints)}
              className={`flex items-center gap-1 px-3 py-1.5 text-sm border rounded hover:bg-slate-50 ${
                showSurveyPoints ? 'bg-green-50 border-green-300 text-green-700' : ''
              }`}
            >
              <Target className="h-4 w-4" />
              測点表示
            </button>
            <div className="border-l h-6 mx-1" />
            <button
              onClick={() => setShowZones(!showZones)}
              className={`flex items-center gap-1 px-3 py-1.5 text-sm border rounded hover:bg-slate-50 ${
                showZones ? 'bg-purple-50 border-purple-300 text-purple-700' : ''
              }`}
            >
              <Square className="h-4 w-4" />
              区域
            </button>
            <button
              onClick={() => setShowCoordinates(!showCoordinates)}
              className={`flex items-center gap-1 px-3 py-1.5 text-sm border rounded hover:bg-slate-50 ${
                showCoordinates ? 'bg-orange-50 border-orange-300 text-orange-700' : ''
              }`}
            >
              <Map className="h-4 w-4" />
              座標
            </button>
          </div>
          {/* 地図 */}
          <div className="flex-1">
            <PipeMap
              showLabels={showLabels}
              showDirection={showDirection}
              showSurveyPoints={showSurveyPoints}
              surveyPoints={mapSurveyPoints}
              showZones={showZones}
              showCoordinates={showCoordinates}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
