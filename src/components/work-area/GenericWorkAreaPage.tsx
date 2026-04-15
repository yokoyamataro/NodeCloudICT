import { useState, useEffect } from 'react'
import { Plus, Trash2, GripVertical, Calculator, Download, X, MapPin } from 'lucide-react'
import { useWorkAreaStore, type WorkAreaPoint } from '@/stores/workAreaStore'
import { useCoordinateStore, type CoordinateRow } from '@/stores/coordinateStore'
import { useFarmStore } from '@/stores/farmStore'
import { CoordinateMap, type ExternalPolygon } from '@/components/map/CoordinateMap'
import type { WorkType, AreaCalculationSheet as AreaCalculationSheetType } from '@/types/database'
import { WORK_TYPE_NAMES } from '@/types/database'
import { exportAreaCalculationToCSV } from '@/lib/area-calculation'

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

          <div className="mt-4 p-3 bg-white rounded-lg border text-sm">
            <h4 className="font-medium mb-2">直角座標法（座標法）</h4>
            <div className="text-muted-foreground space-y-1">
              <p>
                <span className="font-mono">2S = Σ(Xi × Yi+1 - Xi+1 × Yi)</span>
              </p>
              <p>
                <span className="font-mono">S = |2S| / 2 = |{sheet.total_double_area.toFixed(3)}| / 2 = {sheet.area_sqm.toFixed(3)} m²</span>
              </p>
            </div>
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
  const [selectedPointId, setSelectedPointId] = useState<string | null>(null)
  const [editingAreaId, setEditingAreaId] = useState<string | null>(null)

  const { currentFarm } = useFarmStore()
  const { coordinates, fetchCoordinates } = useCoordinateStore()
  const {
    loading,
    fetchWorkAreas,
    addWorkArea,
    updateWorkArea,
    deleteWorkArea,
    addPointFromCoordinate,
    removePoint,
    reorderPoints,
    calculateArea,
    getWorkAreasByType,
  } = useWorkAreaStore()

  // 圃場が変更されたらデータを取得
  const farmId = currentFarm?.id
  useEffect(() => {
    console.log('[GenericWorkAreaPage] useEffect triggered:', { farmId, workType })
    if (farmId) {
      fetchWorkAreas(farmId)
      fetchCoordinates(farmId)
    }
  }, [farmId, workType, fetchWorkAreas, fetchCoordinates])

  const areas = getWorkAreasByType(workType)
  console.log('[GenericWorkAreaPage] areas:', { workType, areasCount: areas.length, areas: areas.map(a => ({ id: a.id, name: a.name })) })
  const workTypeName = WORK_TYPE_NAMES[workType]

  // 区域の構成点情報を座標一覧から取得
  const getAreaPoints = (areaId: string): (WorkAreaPoint & { coord?: CoordinateRow })[] => {
    const area = areas.find(a => a.id === areaId)
    if (!area) return []
    return area.points.map(p => ({
      ...p,
      coord: coordinates.find(c => c.id === p.id),
    }))
  }

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

  // 点がクリックされたとき
  const handlePointClick = (id: string) => {
    setSelectedPointId(id)

    // 区域編集中なら、その区域に点を追加
    if (editingAreaId) {
      const coord = coordinates.find(c => c.id === id)
      if (coord) {
        addPointFromCoordinate(editingAreaId, coord.pointNumber, coord.x, coord.y, coord.z)
      }
    }
  }

  // 区域ポリゴンを生成
  const externalPolygons: ExternalPolygon[] = areas
    .filter(area => area.points.length >= 3)
    .map(area => ({
      id: area.id,
      name: area.name,
      positions: area.points
        .filter(p => p.lat !== null && p.lng !== null)
        .map(p => [p.lat!, p.lng!] as [number, number]),
    }))
    .filter(p => p.positions.length >= 3)

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
          座標管理に登録した座標を使って{workTypeName}の工事区域を設定・面積計算
        </p>
      </div>

      {/* 区域編集中の案内 */}
      {editingAreaId && (
        <div className="px-4 py-2 bg-blue-50 border-b text-sm text-blue-700 flex items-center justify-between">
          <span>区域編集中: 地図上の点をクリックして追加</span>
          <button
            onClick={() => setEditingAreaId(null)}
            className="px-2 py-1 text-xs bg-blue-100 hover:bg-blue-200 rounded"
          >
            編集終了
          </button>
        </div>
      )}

      {/* 座標未登録の案内 */}
      {coordinates.length === 0 && (
        <div className="px-4 py-3 bg-amber-50 border-b text-sm text-amber-700">
          座標が登録されていません。先に「座標管理」で座標を登録してください。
        </div>
      )}

      <div className="flex-1 flex overflow-hidden">
        {/* 左側: 区域一覧 */}
        <div className="w-1/2 flex flex-col overflow-hidden border-r p-4">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold">区域登録</h3>
            <button
              onClick={handleAddArea}
              disabled={loading || coordinates.length === 0}
              className="flex items-center gap-2 px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
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
                const areaPoints = getAreaPoints(area.id)

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

                    {/* 編集中の区域: 構成点リスト */}
                    {isEditing && (
                      <div className="border-t px-3 py-2 bg-slate-50">
                        <div className="text-xs text-muted-foreground mb-2">
                          構成点（地図上の点をクリックして追加、ドラッグで順序変更）
                        </div>
                        {areaPoints.length === 0 ? (
                          <div className="py-4 text-center text-sm text-muted-foreground border border-dashed rounded">
                            点を選択してください
                          </div>
                        ) : (
                          <ul className="space-y-1">
                            {areaPoints.map((point, index) => (
                              <li
                                key={point.id}
                                draggable
                                onDragStart={(e) => handleDragStart(e, point.id)}
                                onDragOver={handleDragOver}
                                onDrop={(e) => handleDrop(e, area.id, index)}
                                className="flex items-center gap-2 px-2 py-1.5 text-sm bg-white border rounded cursor-move hover:bg-slate-50"
                              >
                                <GripVertical className="h-3.5 w-3.5 text-muted-foreground" />
                                <span className="w-5 text-xs text-muted-foreground">
                                  {index + 1}.
                                </span>
                                <span className="font-medium">{point.pointNumber}</span>
                                <span className="text-xs text-muted-foreground">
                                  ({point.x.toFixed(1)}, {point.y.toFixed(1)})
                                </span>
                                <button
                                  onClick={() => removePoint(area.id, point.id)}
                                  className="ml-auto p-0.5 text-red-500 hover:bg-red-50 rounded"
                                >
                                  <Trash2 className="h-3 w-3" />
                                </button>
                              </li>
                            ))}
                          </ul>
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
          <CoordinateMap
            selectedPointId={selectedPointId}
            onPointSelect={handlePointClick}
            showZonePolygons={false}
            editingZoneId={null}
            externalPolygons={externalPolygons}
            editingExternalPolygonId={editingAreaId}
          />
        </div>
      </div>

      {/* 面積計算簿モーダル */}
      {calculationSheet && (
        <AreaCalculationSheet
          sheet={calculationSheet}
          onClose={() => setCalculationSheet(null)}
        />
      )}
    </div>
  )
}
