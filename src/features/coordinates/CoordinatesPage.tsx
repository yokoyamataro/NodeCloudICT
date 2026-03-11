import { useState, useEffect } from 'react'
import { Upload, Download, Plus, Trash2, FileText } from 'lucide-react'
import { JGD2011_ZONES, COORDINATE_TYPE_NAMES } from '@/lib/coordinates'
import { useCoordinateStore } from '@/stores/coordinateStore'
import { useProjectStore } from '@/stores/projectStore'
import { ZoneRegistration } from './ZoneRegistration'
import { AreaCalculationSheet } from './AreaCalculationSheet'
import { CoordinateMap } from '@/components/map/CoordinateMap'
import { loadSimaFile } from '@/lib/sima-parser'
import type { CoordinateType, AreaCalculationSheet as AreaCalculationSheetType } from '@/types/database'

type TabType = 'coordinates' | 'zones'

export function CoordinatesPage() {
  const [activeTab, setActiveTab] = useState<TabType>('coordinates')
  const [calculationSheet, setCalculationSheet] = useState<AreaCalculationSheetType | null>(null)
  const [selectedPointId, setSelectedPointId] = useState<string | null>(null)
  const [editingZoneId, setEditingZoneId] = useState<string | null>(null)

  const { currentProject } = useProjectStore()
  const {
    zone,
    setZone,
    coordinates,
    fetchCoordinates,
    fetchZones,
    addCoordinate,
    updateCoordinate,
    deleteCoordinate,
    importCoordinates,
    selectedType,
    setSelectedType,
    calculateZoneArea,
    addPointToZone,
  } = useCoordinateStore()

  // プロジェクト選択時にデータを読み込む
  useEffect(() => {
    if (currentProject) {
      // プロジェクトの座標系を設定
      setZone(currentProject.coordinate_zone)
      // Supabaseからデータを読み込む
      fetchCoordinates(currentProject.id)
      fetchZones(currentProject.id)
    }
  }, [currentProject, setZone, fetchCoordinates, fetchZones])

  const handleAddCoordinate = () => {
    addCoordinate(selectedType)
  }

  const handleImportCSV = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return

    const reader = new FileReader()
    reader.onload = (e) => {
      const text = e.target?.result as string
      const lines = text.split('\n').filter(line => line.trim())

      const newCoords = lines.slice(1).map((line, idx) => {
        const [pointNumber, x, y, z] = line.split(',').map(s => s.trim())
        return {
          pointNumber: pointNumber || `P${idx + 1}`,
          x: parseFloat(x) || 0,
          y: parseFloat(y) || 0,
          z: z ? parseFloat(z) : null,
          type: selectedType,
        }
      })

      importCoordinates(newCoords)
    }
    reader.readAsText(file)
    event.target.value = ''
  }

  const handleImportSIMA = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return

    try {
      const result = await loadSimaFile(file)

      const newCoords = result.coordinates.map((coord) => ({
        pointNumber: coord.pointNumber,
        x: coord.x,
        y: coord.y,
        z: coord.z,
        type: selectedType,
      }))

      importCoordinates(newCoords)

      // SIMAファイルに座標系情報があれば設定
      if (result.system !== null) {
        setZone(result.system)
      }
    } catch (error) {
      console.error('SIMAファイルの読み込みに失敗しました:', error)
      alert('SIMAファイルの読み込みに失敗しました')
    }

    event.target.value = ''
  }

  const handleExportCSV = () => {
    const header = '点番号,X,Y,Z,緯度,経度,種類\n'
    const rows = coordinates.map(c =>
      `${c.pointNumber},${c.x},${c.y},${c.z ?? ''},${c.lat ?? ''},${c.lng ?? ''},${COORDINATE_TYPE_NAMES[c.type]}`
    ).join('\n')

    const blob = new Blob([header + rows], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'coordinates.csv'
    a.click()
    URL.revokeObjectURL(url)
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
        <h1 className="text-xl font-bold">座標管理</h1>
        <p className="text-sm text-muted-foreground">平面直角座標の登録・区域設定・面積計算</p>
      </div>

      {/* タブナビゲーション */}
      <div className="border-b bg-white px-4">
        <nav className="flex gap-4">
          <button
            onClick={() => setActiveTab('coordinates')}
            className={`px-4 py-2 border-b-2 font-medium transition-colors ${
              activeTab === 'coordinates'
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            座標登録
          </button>
          <button
            onClick={() => setActiveTab('zones')}
            className={`px-4 py-2 border-b-2 font-medium transition-colors ${
              activeTab === 'zones'
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            区域・面積計算
          </button>
        </nav>
      </div>

      {/* 区域編集中の案内 */}
      {editingZoneId && (
        <div className="px-4 py-2 bg-blue-50 border-b text-sm text-blue-700 flex items-center justify-between">
          <span>区域編集中: 座標一覧または地図上の点をクリックして追加</span>
          <button
            onClick={() => setEditingZoneId(null)}
            className="px-2 py-1 text-xs bg-blue-100 hover:bg-blue-200 rounded"
          >
            編集終了
          </button>
        </div>
      )}

      {/* メインコンテンツ */}
      <div className="flex-1 flex overflow-hidden">
        {/* 左側: テーブル/フォーム */}
        <div className="w-1/2 flex flex-col overflow-hidden border-r">
          {/* 座標登録タブ */}
          {activeTab === 'coordinates' && (
            <div className="flex-1 flex flex-col overflow-hidden">
              {/* 設定パネル */}
              <div className="p-4 border-b bg-slate-50">
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium mb-1">座標系</label>
                    <select
                      value={zone}
                      onChange={(e) => setZone(parseInt(e.target.value))}
                      className="w-full px-2 py-1.5 text-sm border rounded"
                    >
                      {Object.entries(JGD2011_ZONES).map(([num, info]) => (
                        <option key={num} value={num}>
                          {info.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1">座標種類</label>
                    <select
                      value={selectedType}
                      onChange={(e) => setSelectedType(e.target.value as CoordinateType)}
                      className="w-full px-2 py-1.5 text-sm border rounded"
                    >
                      {Object.entries(COORDINATE_TYPE_NAMES).map(([type, name]) => (
                        <option key={type} value={type}>
                          {name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <div className="flex gap-2 mt-3">
                  <label className="flex-1">
                    <div className="relative">
                      <input
                        type="file"
                        accept=".sim,.SIM"
                        onChange={handleImportSIMA}
                        className="absolute inset-0 opacity-0 cursor-pointer"
                      />
                      <button className="w-full flex items-center justify-center gap-1 px-3 py-1.5 text-sm border rounded hover:bg-white">
                        <FileText className="h-3.5 w-3.5" />
                        SIMA読込
                      </button>
                    </div>
                  </label>
                  <label className="flex-1">
                    <div className="relative">
                      <input
                        type="file"
                        accept=".csv"
                        onChange={handleImportCSV}
                        className="absolute inset-0 opacity-0 cursor-pointer"
                      />
                      <button className="w-full flex items-center justify-center gap-1 px-3 py-1.5 text-sm border rounded hover:bg-white">
                        <Upload className="h-3.5 w-3.5" />
                        CSV読込
                      </button>
                    </div>
                  </label>
                  <button
                    onClick={handleExportCSV}
                    className="flex-1 flex items-center justify-center gap-1 px-3 py-1.5 text-sm border rounded hover:bg-white"
                    disabled={coordinates.length === 0}
                  >
                    <Download className="h-3.5 w-3.5" />
                    CSV出力
                  </button>
                  <button
                    onClick={handleAddCoordinate}
                    className="flex items-center gap-1 px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded hover:bg-primary/90"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    追加
                  </button>
                </div>
              </div>

              {/* 座標テーブル */}
              <div className="flex-1 overflow-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-100 sticky top-0">
                    <tr>
                      <th className="px-2 py-2 text-left font-medium">点番号</th>
                      <th className="px-2 py-2 text-right font-medium">X (m)</th>
                      <th className="px-2 py-2 text-right font-medium">Y (m)</th>
                      <th className="px-2 py-2 text-right font-medium">Z (m)</th>
                      <th className="px-2 py-2 text-right font-medium">緯度</th>
                      <th className="px-2 py-2 text-right font-medium">経度</th>
                      <th className="px-2 py-2 text-left font-medium">種類</th>
                      <th className="px-2 py-2 w-8"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {coordinates.map((coord) => (
                      <tr
                        key={coord.id}
                        className={`hover:bg-slate-50 cursor-pointer ${
                          selectedPointId === coord.id ? 'bg-blue-50' : ''
                        }`}
                        onClick={() => handlePointClick(coord.id)}
                      >
                        <td className="px-2 py-1">
                          <input
                            type="text"
                            value={coord.pointNumber}
                            onChange={(e) => updateCoordinate(coord.id, 'pointNumber', e.target.value)}
                            onClick={(e) => e.stopPropagation()}
                            className="w-16 px-1 py-0.5 border rounded text-sm"
                          />
                        </td>
                        <td className="px-2 py-1">
                          <input
                            type="number"
                            value={coord.x.toFixed(3)}
                            onChange={(e) => updateCoordinate(coord.id, 'x', parseFloat(e.target.value) || 0)}
                            onClick={(e) => e.stopPropagation()}
                            className="w-24 px-1 py-0.5 border rounded text-right text-sm"
                            step="0.001"
                          />
                        </td>
                        <td className="px-2 py-1">
                          <input
                            type="number"
                            value={coord.y.toFixed(3)}
                            onChange={(e) => updateCoordinate(coord.id, 'y', parseFloat(e.target.value) || 0)}
                            onClick={(e) => e.stopPropagation()}
                            className="w-24 px-1 py-0.5 border rounded text-right text-sm"
                            step="0.001"
                          />
                        </td>
                        <td className="px-2 py-1">
                          <input
                            type="number"
                            value={coord.z?.toFixed(3) ?? ''}
                            onChange={(e) => updateCoordinate(coord.id, 'z', parseFloat(e.target.value) || null)}
                            onClick={(e) => e.stopPropagation()}
                            className="w-20 px-1 py-0.5 border rounded text-right text-sm"
                            step="0.001"
                            placeholder="-"
                          />
                        </td>
                        <td className="px-2 py-1 text-right text-xs text-muted-foreground font-mono">
                          {coord.lat?.toFixed(6) ?? '-'}
                        </td>
                        <td className="px-2 py-1 text-right text-xs text-muted-foreground font-mono">
                          {coord.lng?.toFixed(6) ?? '-'}
                        </td>
                        <td className="px-2 py-1">
                          <select
                            value={coord.type}
                            onChange={(e) => updateCoordinate(coord.id, 'type', e.target.value)}
                            onClick={(e) => e.stopPropagation()}
                            className="px-1 py-0.5 border rounded text-xs"
                          >
                            {Object.entries(COORDINATE_TYPE_NAMES).map(([type, name]) => (
                              <option key={type} value={type}>{name}</option>
                            ))}
                          </select>
                        </td>
                        <td className="px-2 py-1">
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              deleteCoordinate(coord.id)
                            }}
                            className="p-1 text-red-500 hover:bg-red-50 rounded"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </td>
                      </tr>
                    ))}
                    {coordinates.length === 0 && (
                      <tr>
                        <td colSpan={8} className="px-4 py-8 text-center text-muted-foreground">
                          座標データがありません
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              {/* ステータスバー */}
              <div className="px-4 py-2 bg-slate-50 border-t text-xs text-muted-foreground">
                {coordinates.length} 点登録済み
              </div>
            </div>
          )}

          {/* 区域・面積計算タブ */}
          {activeTab === 'zones' && (
            <div className="flex-1 overflow-auto p-4">
              <ZoneRegistration
                onCalculateArea={handleCalculateArea}
                editingZoneId={editingZoneId}
                onEditZone={setEditingZoneId}
              />
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
