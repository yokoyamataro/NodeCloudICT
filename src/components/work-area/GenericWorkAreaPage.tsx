import { useState, useEffect, useCallback } from 'react'
import {
  Plus,
  Trash2,
  GripVertical,
  Calculator,
  Download,
  X,
  Clipboard,
  MapPin,
} from 'lucide-react'
import { MapContainer, TileLayer, Marker, Polygon, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { useWorkAreaStore, type WorkAreaPoint } from '@/stores/workAreaStore'
import { useFarmStore } from '@/stores/farmStore'
import type { WorkType, AreaCalculationSheet as AreaCalculationSheetType } from '@/types/database'
import { WORK_TYPE_NAMES } from '@/types/database'
import { exportAreaCalculationToCSV } from '@/lib/area-calculation'

// マーカーアイコン
const createMarkerIcon = (isSelected: boolean): L.DivIcon => {
  return L.divIcon({
    className: 'custom-marker',
    html: `<div style="
      background-color: ${isSelected ? '#ef4444' : '#3b82f6'};
      width: 20px;
      height: 20px;
      border-radius: 50%;
      border: 3px solid white;
      box-shadow: 0 2px 6px rgba(0,0,0,0.4);
    "></div>`,
    iconSize: [20, 20],
    iconAnchor: [10, 10],
  })
}

// 地図の境界を自動調整
function FitBounds({ points }: { points: WorkAreaPoint[] }) {
  const map = useMap()

  useEffect(() => {
    if (points.length === 0) return

    const validPoints = points.filter(p => p.lat !== null && p.lng !== null)
    if (validPoints.length === 0) return

    const bounds = L.latLngBounds(
      validPoints.map(p => [p.lat!, p.lng!] as [number, number])
    )
    map.fitBounds(bounds, { padding: [50, 50], maxZoom: 16 })
  }, [map, points])

  return null
}

// 面積計算簿コンポーネント
function AreaCalculationSheet({
  sheet,
  onClose,
}: {
  sheet: AreaCalculationSheetType
  onClose: () => void
}) {
  const handleExportCSV = () => {
    const csv = exportAreaCalculationToCSV(sheet)
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `面積計算簿_${sheet.zone_number}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center" style={{ zIndex: 9999 }}>
      <div className="bg-white rounded-lg shadow-xl max-w-4xl w-full mx-4 max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between p-4 border-b">
          <div>
            <h2 className="text-lg font-bold">面積計算簿</h2>
            <p className="text-sm text-muted-foreground">直角座標法による面積計算</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleExportCSV}
              className="flex items-center gap-2 px-3 py-1.5 text-sm border rounded-lg hover:bg-slate-50"
            >
              <Download className="h-4 w-4" />
              CSV出力
            </button>
            <button onClick={onClose} className="p-2 hover:bg-slate-100 rounded-lg">
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        <div className="p-4 bg-slate-50 border-b">
          <div className="grid grid-cols-3 gap-4 text-sm">
            <div>
              <span className="text-muted-foreground">区域番号:</span>{' '}
              <span className="font-medium">{sheet.zone_number}</span>
            </div>
            <div>
              <span className="text-muted-foreground">区域名:</span>{' '}
              <span className="font-medium">{sheet.zone_name}</span>
            </div>
            <div>
              <span className="text-muted-foreground">計算日時:</span>{' '}
              <span className="font-medium">{new Date(sheet.calculated_at).toLocaleString('ja-JP')}</span>
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-auto p-4">
          <table className="w-full text-sm">
            <thead className="bg-slate-100 sticky top-0">
              <tr>
                <th className="px-3 py-2 text-left font-medium border">No.</th>
                <th className="px-3 py-2 text-left font-medium border">点番号</th>
                <th className="px-3 py-2 text-right font-medium border">X座標 (m)</th>
                <th className="px-3 py-2 text-right font-medium border">Y座標 (m)</th>
                <th className="px-3 py-2 text-right font-medium border">Xi × Yi+1</th>
                <th className="px-3 py-2 text-right font-medium border">Xi+1 × Yi</th>
                <th className="px-3 py-2 text-right font-medium border">倍面積</th>
              </tr>
            </thead>
            <tbody>
              {sheet.rows.map((row, index) => (
                <tr key={index} className="hover:bg-slate-50">
                  <td className="px-3 py-2 border text-muted-foreground">{index + 1}</td>
                  <td className="px-3 py-2 border font-medium">{row.point_number}</td>
                  <td className="px-3 py-2 border text-right font-mono">{row.x.toFixed(3)}</td>
                  <td className="px-3 py-2 border text-right font-mono">{row.y.toFixed(3)}</td>
                  <td className="px-3 py-2 border text-right font-mono">{row.xi_yi1.toFixed(3)}</td>
                  <td className="px-3 py-2 border text-right font-mono">{row.xi1_yi.toFixed(3)}</td>
                  <td className="px-3 py-2 border text-right font-mono">{row.double_area.toFixed(3)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="bg-slate-100 font-medium">
              <tr>
                <td colSpan={6} className="px-3 py-2 border text-right">倍面積合計</td>
                <td className="px-3 py-2 border text-right font-mono">{sheet.total_double_area.toFixed(3)}</td>
              </tr>
            </tfoot>
          </table>
        </div>

        <div className="p-4 bg-green-50 border-t">
          <h3 className="text-sm font-medium mb-3">計算結果</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="bg-white p-3 rounded-lg border">
              <div className="text-xs text-muted-foreground mb-1">面積 (m²)</div>
              <div className="text-lg font-bold font-mono">{sheet.area_sqm.toFixed(3)}</div>
            </div>
            <div className="bg-white p-3 rounded-lg border">
              <div className="text-xs text-muted-foreground mb-1">面積 (ha)</div>
              <div className="text-lg font-bold font-mono">{sheet.area_ha.toFixed(6)}</div>
            </div>
            <div className="bg-white p-3 rounded-lg border">
              <div className="text-xs text-muted-foreground mb-1">面積 (a)</div>
              <div className="text-lg font-bold font-mono">{(sheet.area_sqm / 100).toFixed(4)}</div>
            </div>
            <div className="bg-white p-3 rounded-lg border">
              <div className="text-xs text-muted-foreground mb-1">周長 (m)</div>
              <div className="text-lg font-bold font-mono">{sheet.perimeter_m.toFixed(3)}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// TSV貼り付けダイアログ
function TSVPasteDialog({
  onImport,
  onClose,
}: {
  onImport: (tsv: string) => void
  onClose: () => void
}) {
  const [tsvData, setTsvData] = useState('')

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const text = e.clipboardData.getData('text')
    setTsvData(text)
  }, [])

  const handleImport = () => {
    if (tsvData.trim()) {
      onImport(tsvData)
      onClose()
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center" style={{ zIndex: 9999 }}>
      <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full mx-4">
        <div className="flex items-center justify-between p-4 border-b">
          <div>
            <h2 className="text-lg font-bold">座標の貼り付け</h2>
            <p className="text-sm text-muted-foreground">
              TSV形式（タブ区切り）またはCSV形式（カンマ区切り）で座標を貼り付け
            </p>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-slate-100 rounded-lg">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="p-4">
          <div className="mb-4">
            <label className="block text-sm font-medium mb-2">
              形式: 点番号, X座標, Y座標, Z座標（任意）
            </label>
            <div className="text-xs text-muted-foreground mb-2">
              例:<br />
              P1{'\t'}12345.678{'\t'}67890.123{'\t'}45.6<br />
              P2{'\t'}12346.789{'\t'}67891.234{'\t'}46.7<br />
              または X, Y のみ、X, Y, Z のみでも可
            </div>
            <textarea
              value={tsvData}
              onChange={(e) => setTsvData(e.target.value)}
              onPaste={handlePaste}
              placeholder="ここにデータを貼り付け（Ctrl+V）"
              className="w-full h-48 p-3 border rounded-lg font-mono text-sm resize-none"
            />
          </div>

          <div className="flex justify-end gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm border rounded-lg hover:bg-slate-50"
            >
              キャンセル
            </button>
            <button
              onClick={handleImport}
              disabled={!tsvData.trim()}
              className="px-4 py-2 text-sm bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              インポート
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// メイン工事区域ページコンポーネント
interface GenericWorkAreaPageProps {
  workType: WorkType
}

export function GenericWorkAreaPage({ workType }: GenericWorkAreaPageProps) {
  const [calculationSheet, setCalculationSheet] = useState<AreaCalculationSheetType | null>(null)
  const [editingAreaId, setEditingAreaId] = useState<string | null>(null)
  const [showTSVDialog, setShowTSVDialog] = useState(false)
  const [tsvTargetAreaId, setTsvTargetAreaId] = useState<string | null>(null)
  const [importMessage, setImportMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  const { currentFarm } = useFarmStore()
  const {
    loading,
    fetchWorkAreas,
    addWorkArea,
    updateWorkArea,
    deleteWorkArea,
    addPoint,
    removePoint,
    reorderPoints,
    importPointsFromTSV,
    calculateArea,
    getWorkAreasByType,
  } = useWorkAreaStore()

  // 圃場が変更されたらデータを取得
  useEffect(() => {
    if (currentFarm) {
      fetchWorkAreas(currentFarm.id)
    }
  }, [currentFarm, fetchWorkAreas])

  const areas = getWorkAreasByType(workType)
  const workTypeName = WORK_TYPE_NAMES[workType]

  const handleAddArea = async () => {
    const newArea = await addWorkArea(workType)
    if (newArea) {
      setEditingAreaId(newArea.id)
    }
  }

  const handleCalculateArea = (areaId: string) => {
    const sheet = calculateArea(areaId)
    if (sheet) {
      setCalculationSheet(sheet)
    }
  }

  const handleDragStart = (e: React.DragEvent, pointId: string) => {
    e.dataTransfer.setData('pointId', pointId)
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
  }

  const handleDrop = (e: React.DragEvent, areaId: string, dropIndex: number) => {
    e.preventDefault()
    const pointId = e.dataTransfer.getData('pointId')
    if (!pointId) return

    const area = areas.find(a => a.id === areaId)
    if (!area) return

    const pointIds = area.points.map(p => p.id)
    const currentIndex = pointIds.indexOf(pointId)
    if (currentIndex === -1) return

    const newPointIds = [...pointIds]
    newPointIds.splice(currentIndex, 1)
    newPointIds.splice(dropIndex, 0, pointId)

    reorderPoints(areaId, newPointIds)
  }

  const handleOpenTSVDialog = (areaId: string) => {
    setTsvTargetAreaId(areaId)
    setShowTSVDialog(true)
  }

  const handleTSVImport = (tsv: string) => {
    if (!tsvTargetAreaId) return

    const result = importPointsFromTSV(tsvTargetAreaId, tsv)
    if (result.success) {
      setImportMessage({ type: 'success', text: `${result.count}点をインポートしました` })
    } else {
      setImportMessage({ type: 'error', text: result.error || 'インポートに失敗しました' })
    }

    setTimeout(() => setImportMessage(null), 3000)
  }

  const handleAddManualPoint = (areaId: string) => {
    const area = areas.find(a => a.id === areaId)
    if (!area) return

    const pointNumber = `P${area.points.length + 1}`
    addPoint(areaId, {
      pointNumber,
      x: 0,
      y: 0,
      z: null,
    })
  }

  // 現在編集中の区域
  const editingArea = editingAreaId ? areas.find(a => a.id === editingAreaId) : null

  // 地図の中心座標を計算
  const getMapCenter = (): [number, number] => {
    if (editingArea && editingArea.points.length > 0) {
      const validPoints = editingArea.points.filter(p => p.lat !== null && p.lng !== null)
      if (validPoints.length > 0) {
        const avgLat = validPoints.reduce((sum, p) => sum + p.lat!, 0) / validPoints.length
        const avgLng = validPoints.reduce((sum, p) => sum + p.lng!, 0) / validPoints.length
        return [avgLat, avgLng]
      }
    }
    // デフォルト位置（北海道中央部）
    return [43.06, 141.35]
  }

  if (!currentFarm) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center text-muted-foreground">
          <MapPin className="h-12 w-12 mx-auto mb-4 opacity-50" />
          <p>圃場を選択してください</p>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col">
      <div className="p-4 border-b bg-white">
        <h1 className="text-xl font-bold">{workTypeName} - 工事区域</h1>
        <p className="text-sm text-muted-foreground">
          {workTypeName}の工事区域を設定・面積計算
        </p>
      </div>

      {/* インポートメッセージ */}
      {importMessage && (
        <div className={`px-4 py-2 text-sm ${importMessage.type === 'success' ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
          {importMessage.text}
        </div>
      )}

      {/* 区域編集中の案内 */}
      {editingAreaId && (
        <div className="px-4 py-2 bg-blue-50 border-b text-sm text-blue-700 flex items-center justify-between">
          <span>区域編集中: 座標を追加・編集できます</span>
          <button
            onClick={() => setEditingAreaId(null)}
            className="px-2 py-1 text-xs bg-blue-100 hover:bg-blue-200 rounded"
          >
            編集終了
          </button>
        </div>
      )}

      <div className="flex-1 flex overflow-hidden">
        {/* 左側: 区域一覧 */}
        <div className="w-1/2 flex flex-col overflow-hidden border-r p-4">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold">区域登録</h3>
            <button
              onClick={handleAddArea}
              disabled={loading}
              className="flex items-center gap-2 px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded hover:bg-primary/90 disabled:opacity-50"
            >
              <Plus className="h-4 w-4" />
              区域追加
            </button>
          </div>

          {areas.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground border rounded-lg">
              区域がありません。「区域追加」ボタンで追加してください。
            </div>
          ) : (
            <div className="flex-1 overflow-auto space-y-2">
              {areas.map((area) => {
                const isEditing = editingAreaId === area.id

                return (
                  <div
                    key={area.id}
                    className={`border rounded-lg bg-white ${isEditing ? 'ring-2 ring-primary' : ''}`}
                  >
                    {/* 区域ヘッダー */}
                    <div
                      className={`p-3 flex items-center gap-3 cursor-pointer hover:bg-slate-50 ${isEditing ? 'bg-blue-50' : ''}`}
                      onClick={() => setEditingAreaId(isEditing ? null : area.id)}
                    >
                      <div className="flex-1 grid grid-cols-4 gap-2 text-sm">
                        <input
                          type="text"
                          value={area.zoneNumber}
                          onChange={(e) => {
                            e.stopPropagation()
                            updateWorkArea(area.id, { zoneNumber: e.target.value })
                          }}
                          onClick={(e) => e.stopPropagation()}
                          className="px-2 py-1 border rounded"
                          placeholder="番号"
                        />
                        <input
                          type="text"
                          value={area.name}
                          onChange={(e) => {
                            e.stopPropagation()
                            updateWorkArea(area.id, { name: e.target.value })
                          }}
                          onClick={(e) => e.stopPropagation()}
                          className="px-2 py-1 border rounded"
                          placeholder="区域名"
                        />
                        <div className="px-2 py-1 text-muted-foreground">
                          {area.points.length} 点
                        </div>
                        <div className="px-2 py-1">
                          {area.areaHa !== null ? `${area.areaHa.toFixed(4)} ha` : '-'}
                        </div>
                      </div>

                      <div className="flex items-center gap-1">
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            handleCalculateArea(area.id)
                          }}
                          disabled={area.points.length < 3}
                          className="flex items-center gap-1 px-2 py-1 text-xs border rounded hover:bg-slate-100 disabled:opacity-50 disabled:cursor-not-allowed"
                          title="面積計算"
                        >
                          <Calculator className="h-3.5 w-3.5" />
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            deleteWorkArea(area.id)
                            if (isEditing) setEditingAreaId(null)
                          }}
                          className="p-1 text-red-500 hover:bg-red-50 rounded"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>

                    {/* 編集中の区域: 座標点リスト */}
                    {isEditing && (
                      <div className="border-t px-3 py-2 bg-slate-50">
                        <div className="flex items-center justify-between mb-2">
                          <span className="text-xs text-muted-foreground">
                            構成点（ドラッグで順序変更）
                          </span>
                          <div className="flex gap-1">
                            <button
                              onClick={() => handleOpenTSVDialog(area.id)}
                              className="flex items-center gap-1 px-2 py-1 text-xs bg-green-50 text-green-700 border border-green-200 rounded hover:bg-green-100"
                              title="TSV/CSVから貼り付け"
                            >
                              <Clipboard className="h-3 w-3" />
                              貼り付け
                            </button>
                            <button
                              onClick={() => handleAddManualPoint(area.id)}
                              className="flex items-center gap-1 px-2 py-1 text-xs bg-blue-50 text-blue-700 border border-blue-200 rounded hover:bg-blue-100"
                            >
                              <Plus className="h-3 w-3" />
                              点追加
                            </button>
                          </div>
                        </div>

                        {area.points.length === 0 ? (
                          <div className="py-4 text-center text-sm text-muted-foreground border border-dashed rounded">
                            「貼り付け」または「点追加」で座標を追加
                          </div>
                        ) : (
                          <div className="max-h-64 overflow-auto">
                            <table className="w-full text-xs">
                              <thead className="bg-slate-100 sticky top-0">
                                <tr>
                                  <th className="w-6 px-1 py-1"></th>
                                  <th className="px-2 py-1 text-left">点番号</th>
                                  <th className="px-2 py-1 text-right">X</th>
                                  <th className="px-2 py-1 text-right">Y</th>
                                  <th className="px-2 py-1 text-right">Z</th>
                                  <th className="w-6 px-1 py-1"></th>
                                </tr>
                              </thead>
                              <tbody>
                                {area.points.map((point, index) => (
                                  <tr
                                    key={point.id}
                                    draggable
                                    onDragStart={(e) => handleDragStart(e, point.id)}
                                    onDragOver={handleDragOver}
                                    onDrop={(e) => handleDrop(e, area.id, index)}
                                    className="hover:bg-slate-100 cursor-move"
                                  >
                                    <td className="px-1 py-1 text-muted-foreground">
                                      <GripVertical className="h-3 w-3" />
                                    </td>
                                    <td className="px-2 py-1 font-medium">{point.pointNumber}</td>
                                    <td className="px-2 py-1 text-right font-mono">{point.x.toFixed(3)}</td>
                                    <td className="px-2 py-1 text-right font-mono">{point.y.toFixed(3)}</td>
                                    <td className="px-2 py-1 text-right font-mono">
                                      {point.z !== null ? point.z.toFixed(3) : '-'}
                                    </td>
                                    <td className="px-1 py-1">
                                      <button
                                        onClick={() => removePoint(area.id, point.id)}
                                        className="p-0.5 text-red-500 hover:bg-red-50 rounded"
                                      >
                                        <Trash2 className="h-3 w-3" />
                                      </button>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}

                        {/* 面積情報 */}
                        {area.areaSqm !== null && (
                          <div className="mt-3 p-2 bg-green-50 border border-green-200 rounded text-xs">
                            <div className="grid grid-cols-3 gap-2">
                              <div>
                                <span className="text-muted-foreground">面積:</span>{' '}
                                <span className="font-medium">{area.areaSqm.toFixed(2)} m²</span>
                              </div>
                              <div>
                                <span className="text-muted-foreground">面積:</span>{' '}
                                <span className="font-medium">{area.areaHa?.toFixed(4)} ha</span>
                              </div>
                              <div>
                                <span className="text-muted-foreground">周長:</span>{' '}
                                <span className="font-medium">{area.perimeterM?.toFixed(2)} m</span>
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* 右側: 地図 */}
        <div className="w-1/2 bg-slate-100">
          <MapContainer
            center={getMapCenter()}
            zoom={13}
            className="h-full w-full"
          >
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />

            {editingArea && editingArea.points.length > 0 && (
              <FitBounds points={editingArea.points} />
            )}

            {/* 全区域のポリゴンを表示 */}
            {areas.map((area) => {
              const validPoints = area.points.filter(p => p.lat !== null && p.lng !== null)
              if (validPoints.length < 3) return null

              const positions = validPoints.map(p => [p.lat!, p.lng!] as [number, number])
              const isEditing = area.id === editingAreaId

              return (
                <Polygon
                  key={area.id}
                  positions={positions}
                  pathOptions={{
                    color: isEditing ? '#3b82f6' : '#6b7280',
                    fillColor: isEditing ? '#3b82f6' : '#6b7280',
                    fillOpacity: isEditing ? 0.2 : 0.1,
                    weight: isEditing ? 2 : 1,
                  }}
                />
              )
            })}

            {/* 編集中の区域の点を表示 */}
            {editingArea?.points.map((point) => {
              if (point.lat === null || point.lng === null) return null
              return (
                <Marker
                  key={point.id}
                  position={[point.lat, point.lng]}
                  icon={createMarkerIcon(false)}
                />
              )
            })}
          </MapContainer>
        </div>
      </div>

      {/* 面積計算簿モーダル */}
      {calculationSheet && (
        <AreaCalculationSheet
          sheet={calculationSheet}
          onClose={() => setCalculationSheet(null)}
        />
      )}

      {/* TSV貼り付けダイアログ */}
      {showTSVDialog && (
        <TSVPasteDialog
          onImport={handleTSVImport}
          onClose={() => {
            setShowTSVDialog(false)
            setTsvTargetAreaId(null)
          }}
        />
      )}
    </div>
  )
}
