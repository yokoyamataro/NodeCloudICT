import { useState } from 'react'
import { Plus, Trash2, GripVertical, Calculator, Download, X } from 'lucide-react'
import { useCoordinateStore, type CoordinateRow } from '@/stores/coordinateStore'
import { CoordinateMap } from '@/components/map/CoordinateMap'
import type { AreaCalculationSheet as AreaCalculationSheetType } from '@/types/database'
import { exportAreaCalculationToCSV } from '@/lib/area-calculation'

// 面積計算簿コンポーネント（AreaCalculationSheetから流用）
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
        {/* ヘッダー */}
        <div className="flex items-center justify-between p-4 border-b">
          <div>
            <h2 className="text-lg font-bold">面積計算簿</h2>
            <p className="text-sm text-muted-foreground">
              直角座標法による面積計算
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={handleExportCSV}
              className="flex items-center gap-2 px-3 py-1.5 text-sm border rounded-lg hover:bg-slate-50"
            >
              <Download className="h-4 w-4" />
              CSV出力
            </button>
            <button
              onClick={onClose}
              className="p-2 hover:bg-slate-100 rounded-lg"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* 区域情報 */}
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
              <span className="font-medium">
                {new Date(sheet.calculated_at).toLocaleString('ja-JP')}
              </span>
            </div>
          </div>
        </div>

        {/* 計算表 */}
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
                  <td className="px-3 py-2 border text-muted-foreground">
                    {index + 1}
                  </td>
                  <td className="px-3 py-2 border font-medium">
                    {row.point_number}
                  </td>
                  <td className="px-3 py-2 border text-right font-mono">
                    {row.x.toFixed(3)}
                  </td>
                  <td className="px-3 py-2 border text-right font-mono">
                    {row.y.toFixed(3)}
                  </td>
                  <td className="px-3 py-2 border text-right font-mono">
                    {row.xi_yi1.toFixed(3)}
                  </td>
                  <td className="px-3 py-2 border text-right font-mono">
                    {row.xi1_yi.toFixed(3)}
                  </td>
                  <td className="px-3 py-2 border text-right font-mono">
                    {row.double_area.toFixed(3)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot className="bg-slate-100 font-medium">
              <tr>
                <td colSpan={6} className="px-3 py-2 border text-right">
                  倍面積合計
                </td>
                <td className="px-3 py-2 border text-right font-mono">
                  {sheet.total_double_area.toFixed(3)}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>

        {/* 結果サマリー */}
        <div className="p-4 bg-green-50 border-t">
          <h3 className="text-sm font-medium mb-3">計算結果</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="bg-white p-3 rounded-lg border">
              <div className="text-xs text-muted-foreground mb-1">
                面積 (m²)
              </div>
              <div className="text-lg font-bold font-mono">
                {sheet.area_sqm.toFixed(3)}
              </div>
            </div>
            <div className="bg-white p-3 rounded-lg border">
              <div className="text-xs text-muted-foreground mb-1">
                面積 (ha)
              </div>
              <div className="text-lg font-bold font-mono">
                {sheet.area_ha.toFixed(6)}
              </div>
            </div>
            <div className="bg-white p-3 rounded-lg border">
              <div className="text-xs text-muted-foreground mb-1">
                面積 (a)
              </div>
              <div className="text-lg font-bold font-mono">
                {(sheet.area_sqm / 100).toFixed(4)}
              </div>
            </div>
            <div className="bg-white p-3 rounded-lg border">
              <div className="text-xs text-muted-foreground mb-1">
                周長 (m)
              </div>
              <div className="text-lg font-bold font-mono">
                {sheet.perimeter_m.toFixed(3)}
              </div>
            </div>
          </div>

          {/* 計算式の説明 */}
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

export function WorkAreaPage() {
  const [calculationSheet, setCalculationSheet] = useState<AreaCalculationSheetType | null>(null)
  const [selectedPointId, setSelectedPointId] = useState<string | null>(null)
  const [editingZoneId, setEditingZoneId] = useState<string | null>(null)

  const {
    zones,
    coordinates,
    addZone,
    updateZone,
    deleteZone,
    removePointFromZone,
    reorderZonePoints,
    calculateZoneArea,
    addPointToZone,
  } = useCoordinateStore()

  const getZonePoints = (zoneId: string): CoordinateRow[] => {
    const zone = zones.find((z) => z.id === zoneId)
    if (!zone) return []
    return zone.pointIds
      .map((id) => coordinates.find((c) => c.id === id))
      .filter((c): c is CoordinateRow => c !== undefined)
  }

  const handleAddZone = () => {
    addZone()
    // 新しく追加した区域を編集モードにする
    const newZones = useCoordinateStore.getState().zones
    if (newZones.length > 0) {
      setEditingZoneId(newZones[newZones.length - 1].id)
    }
  }

  const handleDragStart = (e: React.DragEvent, pointId: string) => {
    e.dataTransfer.setData('pointId', pointId)
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
  }

  const handleDrop = (e: React.DragEvent, zoneId: string, dropIndex: number) => {
    e.preventDefault()
    const pointId = e.dataTransfer.getData('pointId')
    if (!pointId) return

    const zone = zones.find((z) => z.id === zoneId)
    if (!zone) return

    const currentIndex = zone.pointIds.indexOf(pointId)
    if (currentIndex === -1) return

    const newPointIds = [...zone.pointIds]
    newPointIds.splice(currentIndex, 1)
    newPointIds.splice(dropIndex, 0, pointId)

    reorderZonePoints(zoneId, newPointIds)
  }

  const handleCalculateArea = (zoneId: string) => {
    const sheet = calculateZoneArea(zoneId)
    if (sheet) {
      setCalculationSheet(sheet)
    }
  }

  // 点がクリックされたとき
  const handlePointClick = (id: string) => {
    setSelectedPointId(id)

    // 区域編集中なら、その区域に点を追加
    if (editingZoneId) {
      addPointToZone(editingZoneId, id)
    }
  }

  return (
    <div className="h-full flex flex-col">
      <div className="p-4 border-b bg-white">
        <h1 className="text-xl font-bold">工事区域</h1>
        <p className="text-sm text-muted-foreground">
          座標管理に登録した座標を使って暗渠の工事区域を設定・面積計算
        </p>
      </div>

      {/* 区域編集中の案内 */}
      {editingZoneId && (
        <div className="px-4 py-2 bg-blue-50 border-b text-sm text-blue-700 flex items-center justify-between">
          <span>区域編集中: 地図上の点をクリックして追加</span>
          <button
            onClick={() => setEditingZoneId(null)}
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

      {/* メインコンテンツ */}
      <div className="flex-1 flex overflow-hidden">
        {/* 左側: 区域登録 */}
        <div className="w-1/2 flex flex-col overflow-hidden border-r p-4">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold">区域登録</h3>
            <button
              onClick={handleAddZone}
              disabled={coordinates.length === 0}
              className="flex items-center gap-2 px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Plus className="h-4 w-4" />
              区域追加
            </button>
          </div>

          {zones.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground border rounded-lg">
              区域がありません。「区域追加」ボタンで追加してください。
            </div>
          ) : (
            <div className="flex-1 overflow-auto space-y-2">
              {zones.map((zone) => {
                const isEditing = editingZoneId === zone.id
                const zonePoints = getZonePoints(zone.id)

                return (
                  <div
                    key={zone.id}
                    className={`border rounded-lg bg-white ${isEditing ? 'ring-2 ring-primary' : ''}`}
                  >
                    {/* 区域ヘッダー */}
                    <div
                      className={`p-3 flex items-center gap-3 cursor-pointer hover:bg-slate-50 ${isEditing ? 'bg-blue-50' : ''}`}
                      onClick={() => setEditingZoneId(isEditing ? null : zone.id)}
                    >
                      <div className="flex-1 grid grid-cols-4 gap-2 text-sm">
                        <input
                          type="text"
                          value={zone.zoneNumber}
                          onChange={(e) => {
                            e.stopPropagation()
                            updateZone(zone.id, 'zoneNumber', e.target.value)
                          }}
                          onClick={(e) => e.stopPropagation()}
                          className="px-2 py-1 border rounded"
                          placeholder="番号"
                        />
                        <input
                          type="text"
                          value={zone.name}
                          onChange={(e) => {
                            e.stopPropagation()
                            updateZone(zone.id, 'name', e.target.value)
                          }}
                          onClick={(e) => e.stopPropagation()}
                          className="px-2 py-1 border rounded"
                          placeholder="区域名"
                        />
                        <div className="px-2 py-1 text-muted-foreground">
                          {zone.pointIds.length} 点
                        </div>
                        <div className="px-2 py-1">
                          {zone.areaHa !== null ? `${zone.areaHa.toFixed(4)} ha` : '-'}
                        </div>
                      </div>

                      <div className="flex items-center gap-1">
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            handleCalculateArea(zone.id)
                          }}
                          disabled={zone.pointIds.length < 3}
                          className="flex items-center gap-1 px-2 py-1 text-xs border rounded hover:bg-slate-100 disabled:opacity-50 disabled:cursor-not-allowed"
                          title="面積計算"
                        >
                          <Calculator className="h-3.5 w-3.5" />
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            deleteZone(zone.id)
                            if (isEditing) setEditingZoneId(null)
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
                        {zonePoints.length === 0 ? (
                          <div className="py-4 text-center text-sm text-muted-foreground border border-dashed rounded">
                            点を選択してください
                          </div>
                        ) : (
                          <ul className="space-y-1">
                            {zonePoints.map((point, index) => (
                              <li
                                key={point.id}
                                draggable
                                onDragStart={(e) => handleDragStart(e, point.id)}
                                onDragOver={handleDragOver}
                                onDrop={(e) => handleDrop(e, zone.id, index)}
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
                                  onClick={() => removePointFromZone(zone.id, point.id)}
                                  className="ml-auto p-0.5 text-red-500 hover:bg-red-50 rounded"
                                >
                                  <Trash2 className="h-3 w-3" />
                                </button>
                              </li>
                            ))}
                          </ul>
                        )}

                        {/* 面積情報 */}
                        {zone.areaSqm !== null && (
                          <div className="mt-3 p-2 bg-green-50 border border-green-200 rounded text-xs">
                            <div className="grid grid-cols-3 gap-2">
                              <div>
                                <span className="text-muted-foreground">面積:</span>{' '}
                                <span className="font-medium">{zone.areaSqm.toFixed(2)} m²</span>
                              </div>
                              <div>
                                <span className="text-muted-foreground">面積:</span>{' '}
                                <span className="font-medium">{zone.areaHa?.toFixed(4)} ha</span>
                              </div>
                              <div>
                                <span className="text-muted-foreground">周長:</span>{' '}
                                <span className="font-medium">{zone.perimeterM?.toFixed(2)} m</span>
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
            showZonePolygons={true}
            editingZoneId={editingZoneId}
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
