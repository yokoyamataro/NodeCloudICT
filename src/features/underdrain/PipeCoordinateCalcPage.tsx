import { useState, useMemo, useEffect } from 'react'
import { MapPin, Settings, Download, Merge, Hash, Navigation, Target, Square, Map, FileText, MousePointer, X, ArrowUp, ArrowDown, Route } from 'lucide-react'
import { useUnderdrainStore } from '@/stores/underdrainStore'
import { useCoordinateStore } from '@/stores/coordinateStore'
import { CoordinateConverter } from '@/lib/coordinates'
import { useProjectStore } from '@/stores/projectStore'
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

// 座標管理からの点
interface CoordinatePoint {
  id: string
  pointNumber: string
  x: number
  y: number
  z: number | null
  type: string
}

// 選択された出力点
interface ExportPoint {
  id: string
  name: string
  x: number
  y: number
  z: number | null
  source: 'pipe' | 'coordinate'  // 管路からか座標管理からか
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
  const { pipes, fetchPipes } = useUnderdrainStore()
  const { coordinates, fetchCoordinates } = useCoordinateStore()
  const { currentProject } = useProjectStore()

  // プロジェクト選択時にデータを読み込む
  useEffect(() => {
    if (currentProject) {
      fetchPipes(currentProject.id)
      fetchCoordinates(currentProject.id)
    }
  }, [currentProject, fetchPipes, fetchCoordinates])

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
  const [showCoordinates, setShowCoordinates] = useState(true)
  const [showSelectedRoute, setShowSelectedRoute] = useState(true)

  // 出力点選択モード
  const [isSelectMode, setIsSelectMode] = useState(false)
  const [exportPoints, setExportPoints] = useState<ExportPoint[]>([])

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

  // 座標管理からの点を変換
  const coordinatePoints: CoordinatePoint[] = useMemo(() => {
    return coordinates.map(coord => ({
      id: coord.id,
      pointNumber: coord.pointNumber,
      x: coord.x,
      y: coord.y,
      z: coord.z,
      type: coord.type,
    }))
  }, [coordinates])

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

  // 選択中の出力点IDセット
  const selectedPointIdsSet = useMemo(() => {
    return new Set(exportPoints.map(p => p.id))
  }, [exportPoints])

  // 選択した点を結ぶルートの座標（緯度経度）を計算
  const { zone } = useCoordinateStore()
  const selectedPointRoute = useMemo(() => {
    if (exportPoints.length < 2) return []

    const converter = new CoordinateConverter(zone)

    return exportPoints.map(point => {
      const { lat, lng } = converter.toLatLng(point.x, point.y)
      return [lat, lng] as [number, number]
    })
  }, [exportPoints, zone])

  // 点をクリックして出力リストに追加
  const handlePointClick = (pointId: string) => {
    if (!isSelectMode) {
      setSelectedPointId(pointId)
      return
    }

    // 管路測点から探す
    const pipePoint = mergedPoints.find(p => p.id === pointId)
    if (pipePoint) {
      // 既に追加済みか確認
      if (exportPoints.some(p => p.id === pointId)) {
        return
      }
      setExportPoints(prev => [...prev, {
        id: pipePoint.id,
        name: pipePoint.mergedName,
        x: pipePoint.x,
        y: pipePoint.y,
        z: pipePoint.z,
        source: 'pipe',
      }])
      return
    }

    // 座標管理から探す
    const coordPoint = coordinatePoints.find(p => p.id === pointId)
    if (coordPoint) {
      // 既に追加済みか確認
      if (exportPoints.some(p => p.id === pointId)) {
        return
      }
      setExportPoints(prev => [...prev, {
        id: coordPoint.id,
        name: coordPoint.pointNumber,
        x: coordPoint.x,
        y: coordPoint.y,
        z: coordPoint.z,
        source: 'coordinate',
      }])
    }
  }

  // 出力点の順序変更
  const moveExportPoint = (index: number, direction: 'up' | 'down') => {
    const newIndex = direction === 'up' ? index - 1 : index + 1
    if (newIndex < 0 || newIndex >= exportPoints.length) return

    const newPoints = [...exportPoints]
    const temp = newPoints[index]
    newPoints[index] = newPoints[newIndex]
    newPoints[newIndex] = temp
    setExportPoints(newPoints)
  }

  // 出力点の削除
  const removeExportPoint = (index: number) => {
    setExportPoints(prev => prev.filter((_, i) => i !== index))
  }

  // 出力点のクリア
  const clearExportPoints = () => {
    setExportPoints([])
  }

  // CSVエクスポート
  const handleExportCSV = () => {
    const pointsToExport = exportPoints.length > 0 ? exportPoints : mergedPoints.map(p => ({
      name: p.mergedName,
      x: p.x,
      y: p.y,
      z: p.z,
    }))

    const header = '点名,X,Y,Z\n'
    const rows = pointsToExport
      .map(p => `${p.name},${p.x.toFixed(3)},${p.y.toFixed(3)},${p.z?.toFixed(3) ?? ''}`)
      .join('\n')

    const blob = new Blob([header + rows], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'pipe_coordinates.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  // SIMAエクスポート
  const handleExportSIMA = () => {
    const pointsToExport = exportPoints.length > 0 ? exportPoints : mergedPoints.map(p => ({
      name: p.mergedName,
      x: p.x,
      y: p.y,
      z: p.z,
    }))

    const projectName = currentProject?.name || 'NoName'

    // SIMA形式の行を生成
    const lines: string[] = []
    lines.push(`G00,04,${projectName},`)
    lines.push('Z00, /* 座標データ */,')
    lines.push('Z01,2,')
    lines.push('A00,')

    pointsToExport.forEach((point, index) => {
      // 点名は20文字固定幅（左詰め、スペース埋め）
      const paddedName = point.name.padEnd(20, ' ')
      // 座標は10桁固定幅（小数点以下3桁）
      const xStr = point.x.toFixed(3).padStart(10, ' ')
      const yStr = point.y.toFixed(3).padStart(10, ' ')
      const zStr = point.z !== null ? point.z.toFixed(3).padStart(10, ' ') : ''
      const numStr = (index + 1).toString().padStart(5, ' ')

      lines.push(`A01,${numStr},${paddedName},${xStr},${yStr},${zStr},`)
    })

    lines.push('A99,')

    // Shift_JISでエンコード
    const content = lines.join('\r\n')

    // TextEncoderでShift_JISにエンコード（ブラウザ対応のため）
    // 注: 完全なShift_JIS対応にはライブラリが必要だが、ここでは簡易的にUTF-8で出力
    // 本格的な対応が必要な場合はencoding.jsなどを使用
    const blob = new Blob([content], { type: 'text/plain;charset=shift_jis' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${projectName}_coordinates.sim`
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
      </div>

      {/* メインコンテンツ */}
      <div className="flex-1 flex overflow-hidden">
        {/* 左側: 座標一覧 */}
        <div className="w-1/2 flex flex-col overflow-hidden border-r">
          {/* 統計情報と出力ボタン */}
          <div className="p-3 bg-slate-50 border-b text-sm flex items-center justify-between">
            <div className="flex items-center gap-4">
              <span>管路数: {pipes.length}</span>
              <span>測点数: {surveyPoints.length}</span>
              {enableMerge && (
                <span className="text-blue-600">
                  <Merge className="h-3.5 w-3.5 inline mr-1" />
                  集約後: {mergedPoints.length}点
                </span>
              )}
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
                disabled={mergedPoints.length === 0 && exportPoints.length === 0}
                className="flex items-center gap-1 px-3 py-1.5 text-sm border rounded hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Download className="h-4 w-4" />
                CSV出力
              </button>
              <button
                onClick={handleExportSIMA}
                disabled={mergedPoints.length === 0 && exportPoints.length === 0}
                className="flex items-center gap-1 px-3 py-1.5 text-sm border rounded hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <FileText className="h-4 w-4" />
                SIMA出力
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

          {/* 出力点選択パネル */}
          <div className="p-3 bg-green-50 border-b">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-medium flex items-center gap-1">
                <MousePointer className="h-4 w-4" />
                出力点選択
                {isSelectMode && <span className="text-green-600 ml-2">（選択中）</span>}
              </h3>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setIsSelectMode(!isSelectMode)}
                  className={`px-3 py-1 text-sm rounded ${
                    isSelectMode
                      ? 'bg-green-600 text-white'
                      : 'border border-green-600 text-green-600 hover:bg-green-50'
                  }`}
                >
                  {isSelectMode ? '選択終了' : '地図から選択'}
                </button>
                {exportPoints.length > 0 && (
                  <button
                    onClick={clearExportPoints}
                    className="px-3 py-1 text-sm border border-red-300 text-red-600 rounded hover:bg-red-50"
                  >
                    クリア
                  </button>
                )}
              </div>
            </div>
            {isSelectMode && (
              <p className="text-xs text-green-700 mb-2">
                地図上の測点または座標管理の点をクリックして出力順序を指定してください
              </p>
            )}
            {exportPoints.length > 0 && (
              <div className="bg-white rounded border max-h-32 overflow-auto">
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 sticky top-0">
                    <tr>
                      <th className="px-2 py-1 text-left w-8">#</th>
                      <th className="px-2 py-1 text-left">点名</th>
                      <th className="px-2 py-1 text-left w-16">種別</th>
                      <th className="px-2 py-1 w-16"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {exportPoints.map((point, index) => (
                      <tr key={`${point.id}-${index}`} className="hover:bg-slate-50">
                        <td className="px-2 py-1 font-mono">{index + 1}</td>
                        <td className="px-2 py-1 font-mono">{point.name}</td>
                        <td className="px-2 py-1">
                          <span className={`px-1.5 py-0.5 rounded text-xs ${
                            point.source === 'pipe' ? 'bg-blue-100 text-blue-700' : 'bg-orange-100 text-orange-700'
                          }`}>
                            {point.source === 'pipe' ? '測点' : '座標'}
                          </span>
                        </td>
                        <td className="px-2 py-1">
                          <div className="flex items-center gap-1">
                            <button
                              onClick={() => moveExportPoint(index, 'up')}
                              disabled={index === 0}
                              className="p-0.5 hover:bg-slate-200 rounded disabled:opacity-30"
                            >
                              <ArrowUp className="h-3 w-3" />
                            </button>
                            <button
                              onClick={() => moveExportPoint(index, 'down')}
                              disabled={index === exportPoints.length - 1}
                              className="p-0.5 hover:bg-slate-200 rounded disabled:opacity-30"
                            >
                              <ArrowDown className="h-3 w-3" />
                            </button>
                            <button
                              onClick={() => removeExportPoint(index)}
                              className="p-0.5 hover:bg-red-100 rounded text-red-500"
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {exportPoints.length === 0 && !isSelectMode && (
              <p className="text-xs text-slate-500">
                出力点を選択しない場合、全ての測点が表の順序で出力されます
              </p>
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
                  const isInExport = exportPoints.some(p => p.id === point.id)
                  return (
                    <tr
                      key={point.id}
                      className={`hover:bg-slate-50 cursor-pointer ${
                        selectedPointId === point.id ? 'bg-blue-50' : ''
                      } ${isMerged ? 'bg-yellow-50' : ''} ${isInExport ? 'bg-green-50' : ''}`}
                      onClick={() => handlePointClick(point.id)}
                    >
                      <td className="px-3 py-2 font-mono">
                        {isInExport && (
                          <span className="inline-flex items-center justify-center w-4 h-4 text-xs bg-green-600 text-white rounded-full mr-1">
                            {exportPoints.findIndex(p => p.id === point.id) + 1}
                          </span>
                        )}
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

                {/* 座標管理の点も表示（選択モード中は特に目立つように） */}
                {coordinatePoints.length > 0 && (
                  <>
                    <tr className="bg-orange-100">
                      <td colSpan={enableMerge ? 5 : 4} className="px-3 py-2 text-sm font-medium text-orange-800">
                        座標管理の点
                      </td>
                    </tr>
                    {coordinatePoints.map((point) => {
                      const isInExport = exportPoints.some(p => p.id === point.id)
                      return (
                        <tr
                          key={point.id}
                          className={`hover:bg-slate-50 cursor-pointer ${
                            selectedPointId === point.id ? 'bg-blue-50' : ''
                          } ${isInExport ? 'bg-green-50' : ''}`}
                          onClick={() => handlePointClick(point.id)}
                        >
                          <td className="px-3 py-2 font-mono">
                            {isInExport && (
                              <span className="inline-flex items-center justify-center w-4 h-4 text-xs bg-green-600 text-white rounded-full mr-1">
                                {exportPoints.findIndex(p => p.id === point.id) + 1}
                              </span>
                            )}
                            {point.pointNumber}
                            <span className="ml-2 text-xs text-orange-600">({point.type})</span>
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
                          {enableMerge && <td></td>}
                        </tr>
                      )
                    })}
                  </>
                )}

                {mergedPoints.length === 0 && coordinatePoints.length === 0 && (
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
            {exportPoints.length >= 2 && (
              <button
                onClick={() => setShowSelectedRoute(!showSelectedRoute)}
                className={`flex items-center gap-1 px-3 py-1.5 text-sm border rounded hover:bg-slate-50 ${
                  showSelectedRoute ? 'bg-orange-50 border-orange-300 text-orange-700' : ''
                }`}
              >
                <Route className="h-4 w-4" />
                ルート
              </button>
            )}
          </div>
          {/* 選択モード表示 */}
          {isSelectMode && (
            <div className="px-3 py-2 bg-green-100 border-b text-sm text-green-800 flex items-center gap-2">
              <MousePointer className="h-4 w-4" />
              地図上の点をクリックして出力順序を指定
            </div>
          )}
          {/* 地図 */}
          <div className="flex-1">
            <PipeMap
              showLabels={showLabels}
              showDirection={showDirection}
              showSurveyPoints={showSurveyPoints}
              surveyPoints={mapSurveyPoints}
              showZones={showZones}
              showCoordinates={showCoordinates}
              onPointClick={isSelectMode ? handlePointClick : undefined}
              selectablePoints={isSelectMode}
              selectedPointIds={selectedPointIdsSet}
              selectedPointRoute={selectedPointRoute}
              showSelectedRoute={showSelectedRoute}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
