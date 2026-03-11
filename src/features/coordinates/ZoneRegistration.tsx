import { Plus, Trash2, GripVertical, Calculator } from 'lucide-react'
import { useCoordinateStore, type CoordinateRow } from '@/stores/coordinateStore'

interface ZoneRegistrationProps {
  onCalculateArea: (zoneId: string) => void
  editingZoneId: string | null
  onEditZone: (zoneId: string | null) => void
}

export function ZoneRegistration({ onCalculateArea, editingZoneId, onEditZone }: ZoneRegistrationProps) {
  const {
    zones,
    coordinates,
    addZone,
    updateZone,
    deleteZone,
    removePointFromZone,
    reorderZonePoints,
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
      onEditZone(newZones[newZones.length - 1].id)
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

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold">区域登録</h3>
        <button
          onClick={handleAddZone}
          className="flex items-center gap-2 px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded hover:bg-primary/90"
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
                  onClick={() => onEditZone(isEditing ? null : zone.id)}
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
                        onCalculateArea(zone.id)
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
                        if (isEditing) onEditZone(null)
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
                      構成点（地図または座標一覧から点をクリックして追加）
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
  )
}
