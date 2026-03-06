import { useState } from 'react'
import { Upload, Download, Plus, Trash2 } from 'lucide-react'
import { CoordinateConverter, JGD2011_ZONES, COORDINATE_TYPE_NAMES } from '@/lib/coordinates'
import type { CoordinateType } from '@/types/database'

interface CoordinateRow {
  id: string
  pointNumber: string
  x: number
  y: number
  z: number | null
  lat: number | null
  lng: number | null
  type: CoordinateType
}

export function CoordinatesPage() {
  const [zone, setZone] = useState<number>(9) // デフォルト: 第9系（関東）
  const [coordinates, setCoordinates] = useState<CoordinateRow[]>([])
  const [selectedType, setSelectedType] = useState<CoordinateType>('control')

  const converter = new CoordinateConverter(zone)

  const handleAddCoordinate = () => {
    const newCoord: CoordinateRow = {
      id: crypto.randomUUID(),
      pointNumber: `P${coordinates.length + 1}`,
      x: 0,
      y: 0,
      z: null,
      lat: null,
      lng: null,
      type: selectedType,
    }
    setCoordinates([...coordinates, newCoord])
  }

  const handleUpdateCoordinate = (id: string, field: keyof CoordinateRow, value: string | number) => {
    setCoordinates(coords =>
      coords.map(coord => {
        if (coord.id !== id) return coord

        const updated = { ...coord, [field]: value }

        // X, Y が更新されたら緯度経度を再計算
        if (field === 'x' || field === 'y') {
          if (updated.x && updated.y) {
            const { lat, lng } = converter.toLatLng(updated.x, updated.y)
            updated.lat = lat
            updated.lng = lng
          }
        }

        return updated
      })
    )
  }

  const handleDeleteCoordinate = (id: string) => {
    setCoordinates(coords => coords.filter(c => c.id !== id))
  }

  const handleImportCSV = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return

    const reader = new FileReader()
    reader.onload = (e) => {
      const text = e.target?.result as string
      const lines = text.split('\n').filter(line => line.trim())

      // ヘッダーをスキップして座標データをパース
      const newCoords: CoordinateRow[] = lines.slice(1).map((line, idx) => {
        const [pointNumber, x, y, z] = line.split(',').map(s => s.trim())
        const xNum = parseFloat(x)
        const yNum = parseFloat(y)
        const zNum = z ? parseFloat(z) : null

        let lat: number | null = null
        let lng: number | null = null
        if (!isNaN(xNum) && !isNaN(yNum)) {
          const result = converter.toLatLng(xNum, yNum)
          lat = result.lat
          lng = result.lng
        }

        return {
          id: crypto.randomUUID(),
          pointNumber: pointNumber || `P${idx + 1}`,
          x: xNum || 0,
          y: yNum || 0,
          z: zNum,
          lat,
          lng,
          type: selectedType,
        }
      })

      setCoordinates([...coordinates, ...newCoords])
    }
    reader.readAsText(file)
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

  return (
    <div className="p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold">座標管理</h1>
        <p className="text-muted-foreground">平面直角座標の登録と変換</p>
      </div>

      {/* 設定パネル */}
      <div className="bg-white rounded-lg border p-4 mb-6">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-medium mb-1">座標系</label>
            <select
              value={zone}
              onChange={(e) => setZone(parseInt(e.target.value))}
              className="w-full px-3 py-2 border rounded-lg"
            >
              {Object.entries(JGD2011_ZONES).map(([num, info]) => (
                <option key={num} value={num}>
                  {info.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">座標種類</label>
            <select
              value={selectedType}
              onChange={(e) => setSelectedType(e.target.value as CoordinateType)}
              className="w-full px-3 py-2 border rounded-lg"
            >
              {Object.entries(COORDINATE_TYPE_NAMES).map(([type, name]) => (
                <option key={type} value={type}>
                  {name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-end gap-2">
            <label className="flex-1">
              <span className="block text-sm font-medium mb-1">CSVインポート</span>
              <div className="relative">
                <input
                  type="file"
                  accept=".csv"
                  onChange={handleImportCSV}
                  className="absolute inset-0 opacity-0 cursor-pointer"
                />
                <button className="w-full flex items-center justify-center gap-2 px-4 py-2 border rounded-lg hover:bg-slate-50">
                  <Upload className="h-4 w-4" />
                  インポート
                </button>
              </div>
            </label>
            <button
              onClick={handleExportCSV}
              className="flex items-center gap-2 px-4 py-2 border rounded-lg hover:bg-slate-50"
              disabled={coordinates.length === 0}
            >
              <Download className="h-4 w-4" />
              エクスポート
            </button>
          </div>
        </div>
      </div>

      {/* 座標テーブル */}
      <div className="bg-white rounded-lg border">
        <div className="p-4 border-b flex items-center justify-between">
          <h2 className="font-semibold">座標一覧</h2>
          <button
            onClick={handleAddCoordinate}
            className="flex items-center gap-2 px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded-lg hover:bg-primary/90"
          >
            <Plus className="h-4 w-4" />
            追加
          </button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="bg-slate-50 text-sm">
              <tr>
                <th className="px-4 py-3 text-left font-medium">点番号</th>
                <th className="px-4 py-3 text-left font-medium">種類</th>
                <th className="px-4 py-3 text-right font-medium">X (m)</th>
                <th className="px-4 py-3 text-right font-medium">Y (m)</th>
                <th className="px-4 py-3 text-right font-medium">Z (m)</th>
                <th className="px-4 py-3 text-right font-medium">緯度</th>
                <th className="px-4 py-3 text-right font-medium">経度</th>
                <th className="px-4 py-3 text-center font-medium">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {coordinates.map((coord) => (
                <tr key={coord.id} className="hover:bg-slate-50">
                  <td className="px-4 py-2">
                    <input
                      type="text"
                      value={coord.pointNumber}
                      onChange={(e) => handleUpdateCoordinate(coord.id, 'pointNumber', e.target.value)}
                      className="w-20 px-2 py-1 border rounded"
                    />
                  </td>
                  <td className="px-4 py-2">
                    <select
                      value={coord.type}
                      onChange={(e) => handleUpdateCoordinate(coord.id, 'type', e.target.value)}
                      className="px-2 py-1 border rounded text-sm"
                    >
                      {Object.entries(COORDINATE_TYPE_NAMES).map(([type, name]) => (
                        <option key={type} value={type}>{name}</option>
                      ))}
                    </select>
                  </td>
                  <td className="px-4 py-2">
                    <input
                      type="number"
                      value={coord.x}
                      onChange={(e) => handleUpdateCoordinate(coord.id, 'x', parseFloat(e.target.value) || 0)}
                      className="w-28 px-2 py-1 border rounded text-right"
                      step="0.001"
                    />
                  </td>
                  <td className="px-4 py-2">
                    <input
                      type="number"
                      value={coord.y}
                      onChange={(e) => handleUpdateCoordinate(coord.id, 'y', parseFloat(e.target.value) || 0)}
                      className="w-28 px-2 py-1 border rounded text-right"
                      step="0.001"
                    />
                  </td>
                  <td className="px-4 py-2">
                    <input
                      type="number"
                      value={coord.z ?? ''}
                      onChange={(e) => handleUpdateCoordinate(coord.id, 'z', parseFloat(e.target.value) || 0)}
                      className="w-24 px-2 py-1 border rounded text-right"
                      step="0.01"
                      placeholder="-"
                    />
                  </td>
                  <td className="px-4 py-2 text-right text-sm text-muted-foreground">
                    {coord.lat?.toFixed(6) ?? '-'}
                  </td>
                  <td className="px-4 py-2 text-right text-sm text-muted-foreground">
                    {coord.lng?.toFixed(6) ?? '-'}
                  </td>
                  <td className="px-4 py-2 text-center">
                    <button
                      onClick={() => handleDeleteCoordinate(coord.id)}
                      className="p-1 text-red-500 hover:bg-red-50 rounded"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              ))}
              {coordinates.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-muted-foreground">
                    座標データがありません。「追加」ボタンまたはCSVインポートで追加してください。
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
