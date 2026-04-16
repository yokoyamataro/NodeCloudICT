import { useState, useEffect, useCallback, useRef } from 'react'
import { Upload, Download, Plus, Trash2, FileText, Eye, EyeOff, ExternalLink, Clipboard } from 'lucide-react'
import { JGD2011_ZONES, COORDINATE_TYPE_NAMES } from '@/lib/coordinates'
import { useCoordinateStore } from '@/stores/coordinateStore'
import { useFarmStore } from '@/stores/farmStore'
import { CoordinateMap, type BaseLayerType } from '@/components/map/CoordinateMap'
import { loadSimaFile } from '@/lib/sima-parser'
import { PageHeader } from '@/components/layout/PageHeader'
import type { CoordinateType } from '@/types/database'

// 数値入力用コンポーネント（入力中はフォーマットしない）
function NumberInput({
  value,
  onChange,
  onClick,
  className,
  placeholder,
  decimals = 3,
}: {
  value: number | null
  onChange: (value: number | null) => void
  onClick?: (e: React.MouseEvent) => void
  className?: string
  placeholder?: string
  decimals?: number
}) {
  const [localValue, setLocalValue] = useState<string>('')
  const [isFocused, setIsFocused] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  // 外部の値が変更されたとき（フォーカスしていないときのみ更新）
  useEffect(() => {
    if (!isFocused) {
      if (value === null) {
        setLocalValue('')
      } else {
        setLocalValue(value.toFixed(decimals))
      }
    }
  }, [value, isFocused, decimals])

  const handleFocus = () => {
    setIsFocused(true)
    // フォーカス時は現在の数値をそのまま表示（末尾の0を削除）
    if (value !== null) {
      setLocalValue(String(value))
    }
  }

  const handleBlur = () => {
    setIsFocused(false)
    // フォーカスが外れたら数値に変換して親に通知
    if (localValue === '' || localValue === '-') {
      onChange(null)
      setLocalValue('')
    } else {
      const num = parseFloat(localValue)
      if (!isNaN(num)) {
        onChange(num)
        setLocalValue(num.toFixed(decimals))
      } else {
        // 不正な値は元に戻す
        setLocalValue(value !== null ? value.toFixed(decimals) : '')
      }
    }
  }

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setLocalValue(e.target.value)
  }

  return (
    <input
      ref={inputRef}
      type="text"
      inputMode="decimal"
      value={localValue}
      onChange={handleChange}
      onFocus={handleFocus}
      onBlur={handleBlur}
      onClick={onClick}
      className={className}
      placeholder={placeholder}
    />
  )
}

// 貼り付けモーダルコンポーネント
function PasteModal({
  isOpen,
  onClose,
  onPaste
}: {
  isOpen: boolean
  onClose: () => void
  onPaste: (text: string, type: CoordinateType) => void
}) {
  const [pasteText, setPasteText] = useState('')
  const [pasteType, setPasteType] = useState<CoordinateType>('boundary')

  if (!isOpen) return null

  const handleSubmit = () => {
    if (pasteText.trim()) {
      onPaste(pasteText, pasteType)
      setPasteText('')
      onClose()
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg p-6 w-full max-w-2xl">
        <h3 className="text-lg font-semibold mb-4">座標データの貼り付け</h3>

        <div className="mb-4">
          <label className="block text-sm font-medium mb-2">点種</label>
          <select
            value={pasteType}
            onChange={(e) => setPasteType(e.target.value as CoordinateType)}
            className="w-full px-3 py-2 border rounded"
          >
            {Object.entries(COORDINATE_TYPE_NAMES).map(([type, name]) => (
              <option key={type} value={type}>{name}</option>
            ))}
          </select>
        </div>

        <div className="mb-4">
          <label className="block text-sm font-medium mb-2">
            座標データ（Excel/CSVからコピーして貼り付け）
          </label>
          <textarea
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            placeholder="点番号,X,Y,Z の形式でデータを貼り付けてください&#10;例:&#10;P1,-100.000,200.000,50.000&#10;P2,-150.000,250.000,51.000"
            className="w-full h-64 px-3 py-2 border rounded font-mono text-sm"
          />
        </div>

        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm border rounded hover:bg-gray-50"
          >
            キャンセル
          </button>
          <button
            onClick={handleSubmit}
            disabled={!pasteText.trim()}
            className="px-4 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
          >
            貼り付け
          </button>
        </div>
      </div>
    </div>
  )
}

export function CoordinatesPage() {
  const [selectedPointId, setSelectedPointId] = useState<string | null>(null)
  const [showLabels, setShowLabels] = useState(true)
  const [visibleTypes, setVisibleTypes] = useState<Set<string>>(
    new Set(Object.keys(COORDINATE_TYPE_NAMES))
  )
  const [baseLayer, setBaseLayer] = useState<BaseLayerType>('osm')
  const [showPasteModal, setShowPasteModal] = useState(false)

  // URLパラメータをチェック（ポップアウトモード）
  const urlParams = new URLSearchParams(window.location.search)
  const viewMode = urlParams.get('view') // 'map' または 'table'

  const { currentFarm } = useFarmStore()
  const {
    zone,
    setZone,
    coordinates,
    fetchCoordinates,
    addCoordinate,
    updateCoordinate,
    deleteCoordinate,
    importCoordinates,
    selectedType,
    setSelectedType,
  } = useCoordinateStore()

  // 圃場選択時にデータを読み込む
  useEffect(() => {
    if (currentFarm) {
      // 圃場の座標系を設定
      setZone(currentFarm.coordinate_zone)
      // Supabaseからデータを読み込む
      fetchCoordinates(currentFarm.id)
    }
  }, [currentFarm, setZone, fetchCoordinates])

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
    const rows = coordinates.map(c => {
      // 型の互換性のため、古い型の値をフォールバック
      const typeName = COORDINATE_TYPE_NAMES[c.type as keyof typeof COORDINATE_TYPE_NAMES] || '不明'
      return `${c.pointNumber},${c.x},${c.y},${c.z ?? ''},${c.lat ?? ''},${c.lng ?? ''},${typeName}`
    }).join('\n')

    const blob = new Blob([header + rows], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'coordinates.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  // モーダルからのペースト処理
  const handleModalPaste = useCallback((text: string, pasteType: CoordinateType) => {
    if (!text) return

    // TSV（タブ区切り）またはCSV（カンマ区切り）を検出
    const lines = text.split('\n').filter(line => line.trim())
    if (lines.length === 0) return

    // 区切り文字を判定（タブが多ければTSV、そうでなければCSV）
    const firstLine = lines[0]
    const tabCount = (firstLine.match(/\t/g) || []).length
    const commaCount = (firstLine.match(/,/g) || []).length
    const delimiter = tabCount >= commaCount ? '\t' : ','

    const newCoords = lines.map((line, idx) => {
      const parts = line.split(delimiter).map(s => s.trim())
      // 最低2列（X, Y）が必要
      if (parts.length < 2) return null

      // 列数で判定: 2列=X,Y、3列=X,Y,Z または 点番号,X,Y、4列=点番号,X,Y,Z
      let pointNumber: string
      let x: number
      let y: number
      let z: number | null = null

      if (parts.length === 2) {
        // X, Y のみ
        pointNumber = `P${coordinates.length + idx + 1}`
        x = parseFloat(parts[0]) || 0
        y = parseFloat(parts[1]) || 0
      } else if (parts.length === 3) {
        // 最初の列が数値かどうかで判定
        const firstIsNumber = !isNaN(parseFloat(parts[0])) && parts[0].match(/^-?\d+\.?\d*$/)
        if (firstIsNumber) {
          // X, Y, Z
          pointNumber = `P${coordinates.length + idx + 1}`
          x = parseFloat(parts[0]) || 0
          y = parseFloat(parts[1]) || 0
          z = parseFloat(parts[2]) || null
        } else {
          // 点番号, X, Y
          pointNumber = parts[0] || `P${coordinates.length + idx + 1}`
          x = parseFloat(parts[1]) || 0
          y = parseFloat(parts[2]) || 0
        }
      } else {
        // 4列以上: 点番号, X, Y, Z
        pointNumber = parts[0] || `P${coordinates.length + idx + 1}`
        x = parseFloat(parts[1]) || 0
        y = parseFloat(parts[2]) || 0
        z = parts[3] ? parseFloat(parts[3]) : null
      }

      return {
        pointNumber,
        x,
        y,
        z,
        type: pasteType, // 選択された点種を使用
      }
    }).filter((c): c is NonNullable<typeof c> => c !== null)

    if (newCoords.length > 0) {
      importCoordinates(newCoords)
    }
  }, [coordinates.length, importCoordinates])

  // 点がクリックされたとき
  const handlePointClick = (id: string) => {
    setSelectedPointId(id)
  }

  // ポップアウトウィンドウを開く
  const handlePopout = (mode: 'map' | 'table') => {
    const url = `${window.location.pathname}?view=${mode}`
    const features = mode === 'map'
      ? 'width=1200,height=800,left=100,top=100'
      : 'width=900,height=700,left=200,top=150'
    window.open(url, `nodecloud_${mode}`, features)
  }

  // ポップアウトモードの場合
  if (viewMode === 'map') {
    // 地図のみ表示
    return (
      <div className="h-screen flex flex-col">
        <div className="p-2 bg-white border-b flex items-center gap-4 flex-wrap">
          <h2 className="text-lg font-semibold">座標マップ</h2>
          <button
            onClick={() => setShowLabels(!showLabels)}
            className={`flex items-center gap-1 px-2 py-1 text-xs rounded border ${
              showLabels ? 'bg-blue-50 border-blue-300 text-blue-700' : 'bg-gray-50 border-gray-300'
            }`}
          >
            {showLabels ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
            点名
          </button>
          <div className="flex items-center gap-2">
            {Object.entries(COORDINATE_TYPE_NAMES).map(([type, name]) => (
              <label key={type} className="flex items-center gap-1 text-xs cursor-pointer">
                <input
                  type="checkbox"
                  checked={visibleTypes.has(type)}
                  onChange={(e) => {
                    const newTypes = new Set(visibleTypes)
                    if (e.target.checked) {
                      newTypes.add(type)
                    } else {
                      newTypes.delete(type)
                    }
                    setVisibleTypes(newTypes)
                  }}
                  className="h-3 w-3"
                />
                {name}
              </label>
            ))}
          </div>
          <select
            value={baseLayer}
            onChange={(e) => setBaseLayer(e.target.value as BaseLayerType)}
            className="px-2 py-1 text-xs border rounded bg-white"
          >
            <option value="osm">地図</option>
            <option value="gsi-photo">航空写真</option>
            <option value="gsi-std">地理院地図</option>
          </select>
        </div>
        <div className="flex-1">
          <CoordinateMap
            selectedPointId={selectedPointId}
            onPointSelect={handlePointClick}
            showLabels={showLabels}
            visibleTypes={visibleTypes}
            baseLayer={baseLayer}
          />
        </div>
      </div>
    )
  }

  if (viewMode === 'table') {
    // テーブルのみ表示
    return (
      <div className="h-screen flex flex-col">
        <div className="p-4 border-b bg-white">
          <h2 className="text-lg font-semibold mb-3">座標計算書</h2>
          <div className="grid grid-cols-2 gap-3">
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
            <button
              onClick={() => setShowPasteModal(true)}
              className="flex-1 flex items-center justify-center gap-1 px-3 py-1.5 text-sm border rounded hover:bg-gray-50"
            >
              <Clipboard className="h-3.5 w-3.5" />
              表を貼り付け
            </button>
            <label className="flex-1">
              <div className="relative">
                <input
                  type="file"
                  accept=".sim,.SIM"
                  onChange={handleImportSIMA}
                  className="absolute inset-0 opacity-0 cursor-pointer"
                />
                <button className="w-full flex items-center justify-center gap-1 px-3 py-1.5 text-sm border rounded hover:bg-gray-50">
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
                <button className="w-full flex items-center justify-center gap-1 px-3 py-1.5 text-sm border rounded hover:bg-gray-50">
                  <Upload className="h-3.5 w-3.5" />
                  CSV読込
                </button>
              </div>
            </label>
            <button
              onClick={handleExportCSV}
              className="flex-1 flex items-center justify-center gap-1 px-3 py-1.5 text-sm border rounded hover:bg-gray-50"
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
                    <NumberInput
                      value={coord.x}
                      onChange={(v) => updateCoordinate(coord.id, 'x', v ?? 0)}
                      onClick={(e) => e.stopPropagation()}
                      className="w-24 px-1 py-0.5 border rounded text-right text-sm"
                    />
                  </td>
                  <td className="px-2 py-1">
                    <NumberInput
                      value={coord.y}
                      onChange={(v) => updateCoordinate(coord.id, 'y', v ?? 0)}
                      onClick={(e) => e.stopPropagation()}
                      className="w-24 px-1 py-0.5 border rounded text-right text-sm"
                    />
                  </td>
                  <td className="px-2 py-1">
                    <NumberInput
                      value={coord.z}
                      onChange={(v) => updateCoordinate(coord.id, 'z', v)}
                      onClick={(e) => e.stopPropagation()}
                      className="w-20 px-1 py-0.5 border rounded text-right text-sm"
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
        <div className="px-4 py-2 bg-slate-50 border-t text-xs text-muted-foreground">
          {coordinates.length} 点登録済み
        </div>
      </div>
    )
  }

  // 通常表示（左右分割）
  return (
    <div className="h-full flex flex-col">
      <PageHeader title="座標管理" subtitle="平面直角座標の登録" />

      {/* メインコンテンツ */}
      <div className="flex-1 flex overflow-hidden">
        {/* 左側: テーブル/フォーム */}
        <div className="w-1/2 flex flex-col overflow-hidden border-r">
          <div className="flex-1 flex flex-col overflow-hidden">
              {/* 設定パネル */}
              <div className="p-4 border-b bg-slate-50">
                {/* ポップアウトボタン */}
                <div className="flex justify-end mb-2">
                  <button
                    onClick={() => handlePopout('table')}
                    className="flex items-center gap-1 px-2 py-1 text-xs border rounded hover:bg-white"
                    title="計算書を別ウィンドウで開く"
                  >
                    <ExternalLink className="h-3 w-3" />
                    別ウィンドウ
                  </button>
                </div>
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
                  <button
                    onClick={() => setShowPasteModal(true)}
                    className="flex-1 flex items-center justify-center gap-1 px-3 py-1.5 text-sm border rounded hover:bg-white"
                  >
                    <Clipboard className="h-3.5 w-3.5" />
                    表を貼り付け
                  </button>
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
                          <NumberInput
                            value={coord.x}
                            onChange={(v) => updateCoordinate(coord.id, 'x', v ?? 0)}
                            onClick={(e) => e.stopPropagation()}
                            className="w-24 px-1 py-0.5 border rounded text-right text-sm"
                          />
                        </td>
                        <td className="px-2 py-1">
                          <NumberInput
                            value={coord.y}
                            onChange={(v) => updateCoordinate(coord.id, 'y', v ?? 0)}
                            onClick={(e) => e.stopPropagation()}
                            className="w-24 px-1 py-0.5 border rounded text-right text-sm"
                          />
                        </td>
                        <td className="px-2 py-1">
                          <NumberInput
                            value={coord.z}
                            onChange={(v) => updateCoordinate(coord.id, 'z', v)}
                            onClick={(e) => e.stopPropagation()}
                            className="w-20 px-1 py-0.5 border rounded text-right text-sm"
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
        </div>

        {/* 右側: 地図 */}
        <div className="w-1/2 bg-slate-100 flex flex-col">
          {/* 表示設定パネル */}
          <div className="p-2 bg-white border-b flex items-center gap-4 flex-wrap">
            <button
              onClick={() => handlePopout('map')}
              className="flex items-center gap-1 px-2 py-1 text-xs border rounded hover:bg-gray-50"
              title="地図を別ウィンドウで開く"
            >
              <ExternalLink className="h-3 w-3" />
              別ウィンドウ
            </button>
            <button
              onClick={() => setShowLabels(!showLabels)}
              className={`flex items-center gap-1 px-2 py-1 text-xs rounded border ${
                showLabels ? 'bg-blue-50 border-blue-300 text-blue-700' : 'bg-gray-50 border-gray-300'
              }`}
            >
              {showLabels ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
              点名
            </button>
            <div className="flex items-center gap-2">
              {Object.entries(COORDINATE_TYPE_NAMES).map(([type, name]) => (
                <label key={type} className="flex items-center gap-1 text-xs cursor-pointer">
                  <input
                    type="checkbox"
                    checked={visibleTypes.has(type)}
                    onChange={(e) => {
                      const newTypes = new Set(visibleTypes)
                      if (e.target.checked) {
                        newTypes.add(type)
                      } else {
                        newTypes.delete(type)
                      }
                      setVisibleTypes(newTypes)
                    }}
                    className="h-3 w-3"
                  />
                  {name}
                </label>
              ))}
            </div>
            <select
              value={baseLayer}
              onChange={(e) => setBaseLayer(e.target.value as BaseLayerType)}
              className="px-2 py-1 text-xs border rounded bg-white"
            >
              <option value="osm">地図</option>
              <option value="gsi-photo">航空写真</option>
              <option value="gsi-std">地理院地図</option>
            </select>
          </div>
          <div className="flex-1">
            <CoordinateMap
              selectedPointId={selectedPointId}
              onPointSelect={handlePointClick}
              showLabels={showLabels}
              visibleTypes={visibleTypes}
              baseLayer={baseLayer}
            />
          </div>
        </div>
      </div>

      {/* 貼り付けモーダル */}
      <PasteModal
        isOpen={showPasteModal}
        onClose={() => setShowPasteModal(false)}
        onPaste={handleModalPaste}
      />
    </div>
  )
}
