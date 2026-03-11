import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { Upload, Trash2, FileSearch, Download, ArrowUpDown, Edit3, X, Navigation, Link2, Merge, Split, Tag, MapPin, ChevronUp, ChevronDown, Hash, Target, Square, Map } from 'lucide-react'
import { parseDxf, calculateLineLength } from '@/lib/dxf-parser'
import { autoConnectFromOutlet } from '@/lib/pipe-connection'
import {
  useUnderdrainStore,
  EXTENDED_PIPE_TYPES,
  PIPE_DIAMETERS,
  type PipeRow,
} from '@/stores/underdrainStore'
import { PipeMap, type SurveyPointData } from '@/components/map/PipeMap'
import type { PipeType, PipeVertex } from '@/types/database'

// パース済みエンティティ（インポート前）
interface ParsedEntity {
  tempId: string
  layer: string
  vertices: PipeVertex[]
  length: number
  selected: boolean
}

// 表示モード
type ViewMode = 'import' | 'list'

// 一括訂正モードの設定
interface BulkEditSettings {
  pipeType: PipeType | null
  diameter: number | null
}

// ソートの設定
type SortKey = 'number' | 'pipeType' | 'diameter' | null
type SortDirection = 'asc' | 'desc'

// 連番設定
interface SequentialNumberSettings {
  prefix: string    // 頭文字
  startNumber: number  // 開始番号
  suffix: string    // 末尾文字
}

export function CadAnalysisPage() {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [parsedEntities, setParsedEntities] = useState<ParsedEntity[]>([])
  const [parseInfo, setParseInfo] = useState<{
    fileName: string
    entityCount: number
    layers: string[]
  } | null>(null)
  const [viewMode, setViewMode] = useState<ViewMode>('import')

  // 一括訂正モード
  const [isBulkEditMode, setIsBulkEditMode] = useState(false)
  const [bulkEditSettings, setBulkEditSettings] = useState<BulkEditSettings>({
    pipeType: null,
    diameter: null,
  })

  // 方向表示モード
  const [showDirection, setShowDirection] = useState(false)

  // 番号表示モード
  const [showLabels, setShowLabels] = useState(false)

  // 測点表示モード
  const [showSurveyPoints, setShowSurveyPoints] = useState(false)

  // 区域表示モード
  const [showZones, setShowZones] = useState(false)

  // 座標管理表示モード
  const [showCoordinates, setShowCoordinates] = useState(false)

  // 結合・分割モード
  const [editMode, setEditMode] = useState<'normal' | 'merge' | 'split'>('normal')

  // ソート設定
  const [sortKey, setSortKey] = useState<SortKey>(null)
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc')

  // 連番モード
  const [isSequentialMode, setIsSequentialMode] = useState(false)
  const [sequentialSettings, setSequentialSettings] = useState<SequentialNumberSettings>({
    prefix: '',
    startNumber: 1,
    suffix: '',
  })
  const [currentSequentialNumber, setCurrentSequentialNumber] = useState(1)

  const {
    pipes,
    addPipes,
    updatePipe,
    deletePipe,
    clearPipes,
    selectedPipeId,
    setSelectedPipeId,
    selectedPipeIds,
    togglePipeSelection,
    clearPipeSelection,
    lastImportFile,
    setLastImportFile,
    reversePipeDirection,
    mergePipes,
    splitPipe,
    autoInsertMidpoints,
    previewMidpoints,
  } = useUnderdrainStore()

  // 自動中間点設置モーダル
  const [showMidpointModal, setShowMidpointModal] = useState(false)
  const [midpointMaxLength, setMidpointMaxLength] = useState(50) // デフォルト50m
  const [midpointTargetTypes, setMidpointTargetTypes] = useState<PipeType[]>(['branch']) // デフォルトは吸水のみ
  const [midpointPreview, setMidpointPreview] = useState<import('@/types/database').PipeVertex[]>([]) // プレビュー用の中間点
  const [isPreviewMode, setIsPreviewMode] = useState(false) // プレビューモード

  // テーブルの行へのref（選択時の自動スクロール用）
  const rowRefs = useRef<Record<string, HTMLTableRowElement | null>>({})
  const tableContainerRef = useRef<HTMLDivElement | null>(null)

  // セルへのref（カーソルキー移動用）
  // key: `${pipeId}-${colIndex}` (colIndex: 0=番号, 1=管種, 2=管径, 3=設計延長, 4=接続先)
  const cellRefs = useRef<Record<string, HTMLInputElement | HTMLSelectElement | null>>({})
  const EDITABLE_COLUMNS = 5 // 編集可能な列数

  // 選択された管路が変わったときにスクロール
  useEffect(() => {
    if (selectedPipeId && rowRefs.current[selectedPipeId]) {
      const row = rowRefs.current[selectedPipeId]
      row?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    }
  }, [selectedPipeId])

  // ソート処理
  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      // 同じキーをクリック: 方向を切り替え、または解除
      if (sortDirection === 'asc') {
        setSortDirection('desc')
      } else {
        setSortKey(null)
        setSortDirection('asc')
      }
    } else {
      // 新しいキー: 昇順でソート開始
      setSortKey(key)
      setSortDirection('asc')
    }
  }

  // ソートされた管路リスト
  const sortedPipes = useMemo(() => {
    return [...pipes].sort((a, b) => {
      if (!sortKey) return 0

      const multiplier = sortDirection === 'asc' ? 1 : -1

      switch (sortKey) {
        case 'number':
          return multiplier * a.number.localeCompare(b.number, 'ja', { numeric: true })
        case 'pipeType': {
          const typeOrder = EXTENDED_PIPE_TYPES.map(t => t.value)
          const aIndex = a.pipeType ? typeOrder.indexOf(a.pipeType) : 999
          const bIndex = b.pipeType ? typeOrder.indexOf(b.pipeType) : 999
          return multiplier * (aIndex - bIndex)
        }
        case 'diameter': {
          const aDiam = a.diameter ?? -1
          const bDiam = b.diameter ?? -1
          return multiplier * (aDiam - bDiam)
        }
        default:
          return 0
      }
    })
  }, [pipes, sortKey, sortDirection])

  // 測点データを生成（同一点集約あり）
  const surveyPointsData: SurveyPointData[] = useMemo(() => {
    const MERGE_THRESHOLD = 0.1 // 10cm

    // まず全測点を生成
    const rawPoints: { id: string; name: string; x: number; y: number; z: number | null }[] = []
    for (const pipe of pipes) {
      if (pipe.vertices.length < 2) continue
      const vertices = pipe.vertices

      // 最上流（始点）
      rawPoints.push({
        id: `${pipe.id}-upstream`,
        name: `${pipe.number}C`,
        x: vertices[0].x,
        y: vertices[0].y,
        z: vertices[0].z,
      })

      // 中間点
      if (vertices.length > 2) {
        const middleCount = vertices.length - 2
        for (let i = 0; i < middleCount; i++) {
          const vertexIndex = vertices.length - 2 - i
          const middleIndex = i + 1
          rawPoints.push({
            id: `${pipe.id}-middle-${middleIndex}`,
            name: `${pipe.number}B${middleIndex}`,
            x: vertices[vertexIndex].x,
            y: vertices[vertexIndex].y,
            z: vertices[vertexIndex].z,
          })
        }
      }

      // 最下流（終点）
      const lastVertex = vertices[vertices.length - 1]
      rawPoints.push({
        id: `${pipe.id}-downstream`,
        name: `${pipe.number}A`,
        x: lastVertex.x,
        y: lastVertex.y,
        z: lastVertex.z,
      })
    }

    // 同一点集約
    const result: SurveyPointData[] = []
    const processed = new Set<string>()

    for (const point of rawPoints) {
      if (processed.has(point.id)) continue

      const samePoints = rawPoints.filter(p => {
        if (processed.has(p.id)) return false
        const dx = p.x - point.x
        const dy = p.y - point.y
        return Math.sqrt(dx * dx + dy * dy) <= MERGE_THRESHOLD
      })

      const mergedName = samePoints.map(p => p.name).join('.')

      for (const p of samePoints) {
        processed.add(p.id)
      }

      const z = samePoints.find(p => p.z !== null)?.z ?? null

      result.push({
        id: samePoints.map(p => p.id).join('-'),
        name: mergedName,
        x: point.x,
        y: point.y,
        z,
        isMerged: samePoints.length > 1,
        originalCount: samePoints.length,
      })
    }

    return result
  }, [pipes])

  // カーソルキーでセル間を移動
  const handleCellKeyDown = useCallback((
    e: React.KeyboardEvent,
    pipeId: string,
    colIndex: number
  ) => {
    const isArrowKey = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)
    if (!isArrowKey) return

    // number inputの上下キーによる値変更を防ぐ
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault()
    }

    const currentRowIndex = sortedPipes.findIndex(p => p.id === pipeId)
    if (currentRowIndex === -1) return

    let nextRowIndex = currentRowIndex
    let nextColIndex = colIndex

    switch (e.key) {
      case 'ArrowUp':
        nextRowIndex = Math.max(0, currentRowIndex - 1)
        break
      case 'ArrowDown':
        nextRowIndex = Math.min(sortedPipes.length - 1, currentRowIndex + 1)
        break
      case 'ArrowLeft':
        nextColIndex = Math.max(0, colIndex - 1)
        break
      case 'ArrowRight':
        nextColIndex = Math.min(EDITABLE_COLUMNS - 1, colIndex + 1)
        break
    }

    // 移動先が同じなら何もしない
    if (nextRowIndex === currentRowIndex && nextColIndex === colIndex) return

    const nextPipeId = sortedPipes[nextRowIndex].id
    const cellKey = `${nextPipeId}-${nextColIndex}`
    const nextCell = cellRefs.current[cellKey]
    if (nextCell) {
      nextCell.focus()
      // 行が変わった場合は管路を選択
      if (nextRowIndex !== currentRowIndex) {
        setSelectedPipeId(nextPipeId)
      }
    }
  }, [sortedPipes, setSelectedPipeId])

  // DXFファイルを読み込む
  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return

    const reader = new FileReader()
    reader.onload = (e) => {
      const content = e.target?.result as string
      const result = parseDxf(content)

      // パース結果を一時リストに格納
      const entities: ParsedEntity[] = result.entities.map((entity, idx) => ({
        tempId: `temp-${idx}`,
        layer: entity.layer,
        vertices: entity.vertices,
        length: calculateLineLength(entity.vertices),
        selected: true, // デフォルトで全て選択
      }))

      setParsedEntities(entities)
      setParseInfo({
        fileName: file.name,
        entityCount: result.entities.length,
        layers: result.layers,
      })
      setViewMode('import')
    }
    reader.readAsText(file)
    event.target.value = ''
  }

  // 選択状態を切り替え
  const toggleEntitySelection = (tempId: string) => {
    setParsedEntities((prev) =>
      prev.map((e) => (e.tempId === tempId ? { ...e, selected: !e.selected } : e))
    )
  }

  // 全選択/全解除
  const toggleAllSelection = () => {
    const allSelected = parsedEntities.every((e) => e.selected)
    setParsedEntities((prev) => prev.map((e) => ({ ...e, selected: !allSelected })))
  }

  // 選択したエンティティをインポート（実測延長に登録）
  const handleImport = () => {
    const selectedEntities = parsedEntities.filter((e) => e.selected)
    if (selectedEntities.length === 0) return

    const currentCount = pipes.length
    const newPipes: Omit<PipeRow, 'id'>[] = selectedEntities.map((entity, idx) => ({
      number: `P${String(currentCount + idx + 1).padStart(3, '0')}`,
      layerName: entity.layer,
      pipeType: null,
      diameter: null,
      designLength: null,
      measuredLength: entity.length, // 実測延長に登録
      vertices: entity.vertices,
      connectionTo: null,
      notes: null,
    }))

    addPipes(newPipes)
    setLastImportFile(parseInfo?.fileName || null)
    setParsedEntities([])
    setParseInfo(null)
    setViewMode('list') // インポート後はリスト表示に切り替え
  }

  // 管路データを更新
  const handlePipeUpdate = (
    id: string,
    field: keyof PipeRow,
    value: string | number | null
  ) => {
    updatePipe(id, { [field]: value })
  }

  // 地図上の管路クリック処理
  const handlePipeClick = (id: string) => {
    // 結合モード: 複数選択
    if (editMode === 'merge') {
      togglePipeSelection(id)
      return
    }

    // 分割モード: 単一選択
    if (editMode === 'split') {
      setSelectedPipeId(id)
      return
    }

    // 一括訂正モード
    if (isBulkEditMode) {
      const updates: Partial<PipeRow> = {}
      if (bulkEditSettings.pipeType !== null) {
        updates.pipeType = bulkEditSettings.pipeType
      }
      if (bulkEditSettings.diameter !== null) {
        updates.diameter = bulkEditSettings.diameter
      }
      if (Object.keys(updates).length > 0) {
        updatePipe(id, updates)
      }
      return
    }

    // 連番モード
    if (isSequentialMode) {
      const newNumber = `${sequentialSettings.prefix}${currentSequentialNumber}${sequentialSettings.suffix}`
      updatePipe(id, { number: newNumber })
      setCurrentSequentialNumber(prev => prev + 1)
      setSelectedPipeId(id)
      return
    }

    // 通常モード
    setSelectedPipeId(id)
  }

  // 頂点クリック処理（分割モード用）
  const handleVertexClick = (pipeId: string, vertexIndex: number) => {
    if (editMode !== 'split') return

    const result = splitPipe(pipeId, vertexIndex)
    if (result) {
      alert('管路を分割しました')
      setEditMode('normal')
    } else {
      alert('分割できませんでした')
    }
  }

  // 一括訂正モードでのクリック（テーブル用）
  const handleBulkEditClick = (id: string) => {
    if (!isBulkEditMode) {
      setSelectedPipeId(id)
      return
    }

    // 一括訂正を適用
    const updates: Partial<PipeRow> = {}
    if (bulkEditSettings.pipeType !== null) {
      updates.pipeType = bulkEditSettings.pipeType
    }
    if (bulkEditSettings.diameter !== null) {
      updates.diameter = bulkEditSettings.diameter
    }

    if (Object.keys(updates).length > 0) {
      updatePipe(id, updates)
    }
  }

  // CSVエクスポート
  const handleExportCSV = () => {
    const header = '管路番号,管種,管径(mm),設計延長(m),実測延長(m),接続先,備考\n'
    const rows = pipes
      .map((p) => {
        const pipeTypeLabel = EXTENDED_PIPE_TYPES.find(t => t.value === p.pipeType)?.label || ''
        return [
          p.number,
          pipeTypeLabel,
          p.diameter ?? '',
          p.designLength?.toFixed(3) ?? '',
          p.measuredLength?.toFixed(3) ?? '',
          p.connectionTo ?? '',
          p.notes ?? '',
        ].join(',')
      })
      .join('\n')

    const blob = new Blob([header + rows], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'pipes.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  // 一括訂正モード開始
  const startBulkEdit = () => {
    setIsBulkEditMode(true)
    setBulkEditSettings({ pipeType: null, diameter: null })
  }

  // 一括訂正モード終了
  const endBulkEdit = () => {
    setIsBulkEditMode(false)
    setBulkEditSettings({ pipeType: null, diameter: null })
  }

  // 自動接続処理
  const handleAutoConnect = () => {
    if (!selectedPipeId) {
      alert('落口となる管路を選択してください')
      return
    }

    const outletPipe = pipes.find((p) => p.id === selectedPipeId)
    if (!outletPipe) return

    // 選択中の管路を落口として設定
    updatePipe(selectedPipeId, { pipeType: 'outlet' })

    // 落口の終点（現在の下流方向）を基準に自動接続
    const results = autoConnectFromOutlet(outletPipe, 'end', pipes)

    // 結果を適用
    for (const result of results) {
      if (result.updates.shouldReverse) {
        reversePipeDirection(result.pipeId)
      }
      if (result.updates.connectionTo !== undefined) {
        updatePipe(result.pipeId, { connectionTo: result.updates.connectionTo })
      }
    }

    alert(`${results.length} 件の管路の接続関係を設定しました`)
  }

  return (
    <div className="h-full flex flex-col">
      <div className="p-4 border-b bg-white">
        <h1 className="text-xl font-bold">CAD解析</h1>
        <p className="text-sm text-muted-foreground">
          DXFファイルから管路データを抽出・登録
        </p>
      </div>

      <div className="flex-1 flex min-h-0 overflow-hidden">
        {/* 左側: データ管理 */}
        <div className="w-1/2 flex flex-col border-r min-h-0">
          {/* ツールバー */}
          <div className="p-3 border-b bg-slate-50 flex-shrink-0">
            <div className="flex items-center gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept=".dxf"
                onChange={handleFileUpload}
                className="hidden"
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                className="flex items-center gap-2 px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded hover:bg-primary/90"
              >
                <Upload className="h-4 w-4" />
                DXFインポート
              </button>
              {pipes.length > 0 && !isBulkEditMode && editMode === 'normal' && !isSequentialMode && (
                <>
                  <button
                    onClick={handleAutoConnect}
                    disabled={!selectedPipeId}
                    className={`flex items-center gap-1 px-3 py-1.5 text-sm border rounded hover:bg-white ${
                      !selectedPipeId ? 'opacity-50 cursor-not-allowed' : 'bg-green-50 border-green-400 text-green-700 hover:bg-green-100'
                    }`}
                    title="選択中の管路を落口として、接続関係を自動設定"
                  >
                    <Link2 className="h-3.5 w-3.5" />
                    自動接続
                  </button>
                  <button
                    onClick={() => {
                      setIsSequentialMode(true)
                      setCurrentSequentialNumber(sequentialSettings.startNumber)
                    }}
                    className="flex items-center gap-1 px-3 py-1.5 text-sm border rounded hover:bg-white"
                    title="クリックで連番を付与"
                  >
                    <Hash className="h-3.5 w-3.5" />
                    連番
                  </button>
                  <button
                    onClick={() => { setEditMode('merge'); clearPipeSelection() }}
                    className="flex items-center gap-1 px-3 py-1.5 text-sm border rounded hover:bg-white"
                    title="複数の管路を結合"
                  >
                    <Merge className="h-3.5 w-3.5" />
                    結合
                  </button>
                  <button
                    onClick={() => { setEditMode('split'); setSelectedPipeId(null) }}
                    className="flex items-center gap-1 px-3 py-1.5 text-sm border rounded hover:bg-white"
                    title="管路を分割"
                  >
                    <Split className="h-3.5 w-3.5" />
                    分割
                  </button>
                  <button
                    onClick={() => setShowMidpointModal(true)}
                    className="flex items-center gap-1 px-3 py-1.5 text-sm border rounded hover:bg-white"
                    title="長い区間に自動で中間点を設置"
                  >
                    <MapPin className="h-3.5 w-3.5" />
                    中間点
                  </button>
                  <button
                    onClick={startBulkEdit}
                    className="flex items-center gap-1 px-3 py-1.5 text-sm border rounded hover:bg-white"
                  >
                    <Edit3 className="h-3.5 w-3.5" />
                    一括訂正
                  </button>
                  <button
                    onClick={handleExportCSV}
                    className="flex items-center gap-1 px-3 py-1.5 text-sm border rounded hover:bg-white"
                  >
                    <Download className="h-3.5 w-3.5" />
                    CSV出力
                  </button>
                  <button
                    onClick={clearPipes}
                    className="flex items-center gap-1 px-3 py-1.5 text-sm border rounded hover:bg-white text-red-600"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    全削除
                  </button>
                </>
              )}
              {lastImportFile && !isBulkEditMode && (
                <span className="ml-auto text-xs text-muted-foreground">
                  最終インポート: {lastImportFile}
                </span>
              )}
            </div>
          </div>

          {/* 結合モードパネル */}
          {editMode === 'merge' && (
            <div className="p-3 bg-purple-50 border-b flex-shrink-0">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-purple-800">
                  結合モード: 結合する管路をクリックで選択（{selectedPipeIds.size}件選択中）
                </span>
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      if (selectedPipeIds.size < 2) {
                        alert('2本以上の管路を選択してください')
                        return
                      }
                      const result = mergePipes(Array.from(selectedPipeIds))
                      if (result) {
                        alert('管路を結合しました')
                        setEditMode('normal')
                      } else {
                        alert('選択した管路は隣接していないため結合できません')
                      }
                    }}
                    disabled={selectedPipeIds.size < 2}
                    className={`px-3 py-1 text-sm rounded ${
                      selectedPipeIds.size >= 2
                        ? 'bg-purple-600 text-white hover:bg-purple-700'
                        : 'bg-gray-300 text-gray-500 cursor-not-allowed'
                    }`}
                  >
                    <Merge className="h-3.5 w-3.5 inline mr-1" />
                    結合実行
                  </button>
                  <button
                    onClick={() => { setEditMode('normal'); clearPipeSelection() }}
                    className="p-1 text-purple-600 hover:bg-purple-100 rounded"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              </div>
              {selectedPipeIds.size > 0 && (
                <div className="text-xs text-purple-600">
                  選択中: {Array.from(selectedPipeIds).map(id => pipes.find(p => p.id === id)?.number).filter(Boolean).join(', ')}
                </div>
              )}
            </div>
          )}

          {/* 分割モードパネル */}
          {editMode === 'split' && (
            <div className="p-3 bg-orange-50 border-b flex-shrink-0">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-orange-800">
                  分割モード: {selectedPipeId
                    ? `「${pipes.find(p => p.id === selectedPipeId)?.number}」の分割点をクリック`
                    : '分割する管路を選択してください'}
                </span>
                <button
                  onClick={() => { setEditMode('normal'); setSelectedPipeId(null) }}
                  className="p-1 text-orange-600 hover:bg-orange-100 rounded"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}

          {/* 連番モードパネル */}
          {isSequentialMode && (
            <div className="p-3 bg-cyan-50 border-b flex-shrink-0">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-cyan-800">
                  連番モード: 管路をクリックして番号を付与（次: {sequentialSettings.prefix}{currentSequentialNumber}{sequentialSettings.suffix}）
                </span>
                <button
                  onClick={() => setIsSequentialMode(false)}
                  className="p-1 text-cyan-600 hover:bg-cyan-100 rounded"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="flex items-center gap-4">
                <div className="flex items-center gap-2">
                  <label className="text-xs text-cyan-700">頭文字:</label>
                  <input
                    type="text"
                    value={sequentialSettings.prefix}
                    onChange={(e) =>
                      setSequentialSettings((prev) => ({ ...prev, prefix: e.target.value }))
                    }
                    className="w-16 px-2 py-1 border rounded text-xs"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <label className="text-xs text-cyan-700">開始番号:</label>
                  <input
                    type="number"
                    value={currentSequentialNumber}
                    onChange={(e) => setCurrentSequentialNumber(parseInt(e.target.value) || 1)}
                    className="w-16 px-2 py-1 border rounded text-xs text-right"
                    min={1}
                  />
                </div>
                <div className="flex items-center gap-2">
                  <label className="text-xs text-cyan-700">末尾文字:</label>
                  <input
                    type="text"
                    value={sequentialSettings.suffix}
                    onChange={(e) =>
                      setSequentialSettings((prev) => ({ ...prev, suffix: e.target.value }))
                    }
                    className="w-16 px-2 py-1 border rounded text-xs"
                  />
                </div>
                <div className="text-xs text-cyan-600 bg-cyan-100 px-2 py-1 rounded">
                  プレビュー: {sequentialSettings.prefix}{currentSequentialNumber}{sequentialSettings.suffix}
                </div>
              </div>
            </div>
          )}

          {/* 一括訂正モードパネル */}
          {isBulkEditMode && editMode === 'normal' && (
            <div className="p-3 bg-amber-50 border-b flex-shrink-0">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-amber-800">
                  一括訂正モード: 地図上の管路をクリックして変更
                </span>
                <button
                  onClick={endBulkEdit}
                  className="p-1 text-amber-600 hover:bg-amber-100 rounded"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="flex items-center gap-4">
                <div className="flex items-center gap-2">
                  <label className="text-xs text-amber-700">管種:</label>
                  <select
                    value={bulkEditSettings.pipeType || ''}
                    onChange={(e) =>
                      setBulkEditSettings((prev) => ({
                        ...prev,
                        pipeType: e.target.value ? (e.target.value as PipeType) : null,
                      }))
                    }
                    className="px-2 py-1 border rounded text-xs"
                  >
                    <option value="">変更しない</option>
                    {EXTENDED_PIPE_TYPES.map((type) => (
                      <option key={type.value} value={type.value}>
                        {type.label}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex items-center gap-2">
                  <label className="text-xs text-amber-700">管径:</label>
                  <select
                    value={bulkEditSettings.diameter ?? ''}
                    onChange={(e) =>
                      setBulkEditSettings((prev) => ({
                        ...prev,
                        diameter: e.target.value ? parseInt(e.target.value) : null,
                      }))
                    }
                    className="px-2 py-1 border rounded text-xs"
                  >
                    <option value="">変更しない</option>
                    {PIPE_DIAMETERS.map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          )}

          {/* インポートモード: パース結果プレビュー */}
          {viewMode === 'import' && parsedEntities.length > 0 && (
            <div className="flex-1 flex flex-col min-h-0">
              <div className="p-3 bg-blue-50 border-b flex items-center justify-between flex-shrink-0">
                <span className="text-sm font-medium">
                  インポート対象の選択 ({parsedEntities.filter((e) => e.selected).length}/
                  {parsedEntities.length})
                </span>
                <div className="flex gap-2">
                  <button
                    onClick={toggleAllSelection}
                    className="px-2 py-1 text-xs border rounded hover:bg-white"
                  >
                    {parsedEntities.every((e) => e.selected) ? '全解除' : '全選択'}
                  </button>
                  <button
                    onClick={handleImport}
                    className="px-3 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700"
                  >
                    選択をインポート
                  </button>
                  <button
                    onClick={() => {
                      setParsedEntities([])
                      setParseInfo(null)
                      setViewMode('list')
                    }}
                    className="px-2 py-1 text-xs border rounded hover:bg-white"
                  >
                    キャンセル
                  </button>
                </div>
              </div>
              <div className="flex-1 overflow-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-100 sticky top-0">
                    <tr>
                      <th className="px-2 py-2 w-10"></th>
                      <th className="px-2 py-2 text-left font-medium">No.</th>
                      <th className="px-2 py-2 text-right font-medium">点数</th>
                      <th className="px-2 py-2 text-right font-medium">延長(m)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {parsedEntities.map((entity, idx) => (
                      <tr
                        key={entity.tempId}
                        className={`hover:bg-slate-50 ${entity.selected ? '' : 'opacity-50'}`}
                      >
                        <td className="px-2 py-1 text-center">
                          <input
                            type="checkbox"
                            checked={entity.selected}
                            onChange={() => toggleEntitySelection(entity.tempId)}
                            className="h-4 w-4"
                          />
                        </td>
                        <td className="px-2 py-1">{idx + 1}</td>
                        <td className="px-2 py-1 text-right">{entity.vertices.length}</td>
                        <td className="px-2 py-1 text-right font-mono">
                          {entity.length.toFixed(3)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* リストモード: 登録済み管路一覧 */}
          {(viewMode === 'list' || parsedEntities.length === 0) && pipes.length > 0 && (
            <div className="flex-1 flex flex-col min-h-0">
              <div ref={tableContainerRef} className="flex-1 overflow-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-100 sticky top-0 z-10">
                    <tr>
                      <th
                        className="px-2 py-2 text-left font-medium cursor-pointer hover:bg-slate-200 select-none"
                        onClick={() => handleSort('number')}
                      >
                        <div className="flex items-center gap-1">
                          番号
                          {sortKey === 'number' && (
                            sortDirection === 'asc' ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />
                          )}
                        </div>
                      </th>
                      <th
                        className="px-2 py-2 text-left font-medium cursor-pointer hover:bg-slate-200 select-none"
                        onClick={() => handleSort('pipeType')}
                      >
                        <div className="flex items-center gap-1">
                          管種
                          {sortKey === 'pipeType' && (
                            sortDirection === 'asc' ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />
                          )}
                        </div>
                      </th>
                      <th
                        className="px-2 py-2 text-left font-medium cursor-pointer hover:bg-slate-200 select-none"
                        onClick={() => handleSort('diameter')}
                      >
                        <div className="flex items-center gap-1">
                          管径
                          {sortKey === 'diameter' && (
                            sortDirection === 'asc' ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />
                          )}
                        </div>
                      </th>
                      <th className="px-2 py-2 text-right font-medium">設計延長</th>
                      <th className="px-2 py-2 text-right font-medium">実測延長</th>
                      <th className="px-2 py-2 text-left font-medium">接続先</th>
                      <th className="px-2 py-2 w-16"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {sortedPipes.map((pipe) => (
                      <tr
                        key={pipe.id}
                        ref={(el) => {
                          rowRefs.current[pipe.id] = el
                        }}
                        className={`hover:bg-slate-50 cursor-pointer ${
                          selectedPipeId === pipe.id ? 'bg-pink-100 ring-2 ring-pink-400 ring-inset' : ''
                        }`}
                        onClick={() => handleBulkEditClick(pipe.id)}
                      >
                        <td className="px-2 py-1">
                          <input
                            ref={(el) => {
                              cellRefs.current[`${pipe.id}-0`] = el
                            }}
                            type="text"
                            value={pipe.number}
                            onChange={(e) => handlePipeUpdate(pipe.id, 'number', e.target.value)}
                            onClick={(e) => e.stopPropagation()}
                            onKeyDown={(e) => handleCellKeyDown(e, pipe.id, 0)}
                            className="w-16 px-1 py-0.5 border rounded text-sm"
                          />
                        </td>
                        <td className="px-2 py-1">
                          <select
                            ref={(el) => {
                              cellRefs.current[`${pipe.id}-1`] = el
                            }}
                            value={pipe.pipeType || ''}
                            onChange={(e) =>
                              handlePipeUpdate(
                                pipe.id,
                                'pipeType',
                                e.target.value ? (e.target.value as PipeType) : null
                              )
                            }
                            onClick={(e) => e.stopPropagation()}
                            onKeyDown={(e) => handleCellKeyDown(e, pipe.id, 1)}
                            className="w-20 px-1 py-0.5 border rounded text-xs"
                          >
                            <option value="">-</option>
                            {EXTENDED_PIPE_TYPES.map((type) => (
                              <option key={type.value} value={type.value}>
                                {type.label}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="px-2 py-1">
                          <select
                            ref={(el) => {
                              cellRefs.current[`${pipe.id}-2`] = el
                            }}
                            value={pipe.diameter ?? ''}
                            onChange={(e) =>
                              handlePipeUpdate(
                                pipe.id,
                                'diameter',
                                e.target.value ? parseInt(e.target.value) : null
                              )
                            }
                            onClick={(e) => e.stopPropagation()}
                            onKeyDown={(e) => handleCellKeyDown(e, pipe.id, 2)}
                            className="w-16 px-1 py-0.5 border rounded text-xs"
                          >
                            <option value="">-</option>
                            {PIPE_DIAMETERS.map((d) => (
                              <option key={d} value={d}>
                                {d}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td className="px-2 py-1">
                          <input
                            ref={(el) => {
                              cellRefs.current[`${pipe.id}-3`] = el
                            }}
                            type="number"
                            value={pipe.designLength ?? ''}
                            onChange={(e) =>
                              handlePipeUpdate(
                                pipe.id,
                                'designLength',
                                e.target.value ? parseFloat(e.target.value) : null
                              )
                            }
                            onClick={(e) => e.stopPropagation()}
                            onKeyDown={(e) => handleCellKeyDown(e, pipe.id, 3)}
                            className="w-16 px-1 py-0.5 border rounded text-right text-sm"
                            step="0.001"
                            placeholder="m"
                          />
                        </td>
                        <td className="px-2 py-1 text-right font-mono text-xs">
                          {pipe.measuredLength?.toFixed(3) ?? '-'}
                        </td>
                        <td className="px-2 py-1">
                          <select
                            ref={(el) => {
                              cellRefs.current[`${pipe.id}-4`] = el
                            }}
                            value={pipe.connectionTo || ''}
                            onChange={(e) =>
                              handlePipeUpdate(pipe.id, 'connectionTo', e.target.value || null)
                            }
                            onClick={(e) => e.stopPropagation()}
                            onKeyDown={(e) => handleCellKeyDown(e, pipe.id, 4)}
                            className="w-20 px-1 py-0.5 border rounded text-xs"
                          >
                            <option value="">-</option>
                            {pipes
                              .filter((p) => p.id !== pipe.id)
                              .map((p) => (
                                <option key={p.id} value={p.id}>
                                  {p.number}
                                </option>
                              ))}
                          </select>
                        </td>
                        <td className="px-2 py-1 flex gap-1">
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              reversePipeDirection(pipe.id)
                            }}
                            className="p-1 text-blue-500 hover:bg-blue-50 rounded"
                            title="上流/下流を反転"
                          >
                            <ArrowUpDown className="h-3.5 w-3.5" />
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              deletePipe(pipe.id)
                            }}
                            className="p-1 text-red-500 hover:bg-red-50 rounded"
                            title="削除"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {/* ステータスバー */}
              <div className="px-4 py-2 bg-slate-50 border-t text-xs text-muted-foreground flex justify-between flex-shrink-0">
                <span>{pipes.length} 管路登録済み</span>
                <span>
                  総延長: {pipes.reduce((sum, p) => sum + (p.measuredLength ?? 0), 0).toFixed(3)} m
                </span>
              </div>
            </div>
          )}

          {/* 空の案内 */}
          {parsedEntities.length === 0 && pipes.length === 0 && (
            <div className="flex-1 flex items-center justify-center text-muted-foreground">
              <div className="text-center">
                <FileSearch className="h-12 w-12 mx-auto mb-2 opacity-50" />
                <p>DXFファイルを選択してください</p>
                <p className="text-xs mt-1">LINE / POLYLINE エンティティを抽出します</p>
              </div>
            </div>
          )}
        </div>

        {/* 右側: 地図表示（画面高さに固定） */}
        <div className="w-1/2 h-full overflow-hidden flex flex-col">
          {/* 地図上部のツールバー */}
          <div className="p-2 bg-white border-b flex items-center gap-2 flex-shrink-0">
            <button
              onClick={() => setShowLabels(!showLabels)}
              className={`flex items-center gap-1 px-3 py-1.5 text-sm border rounded hover:bg-slate-50 ${
                showLabels ? 'bg-blue-100 border-blue-400 text-blue-700' : ''
              }`}
            >
              <Tag className="h-3.5 w-3.5" />
              番号表示
            </button>
            <button
              onClick={() => setShowDirection(!showDirection)}
              className={`flex items-center gap-1 px-3 py-1.5 text-sm border rounded hover:bg-slate-50 ${
                showDirection ? 'bg-blue-100 border-blue-400 text-blue-700' : ''
              }`}
            >
              <Navigation className="h-3.5 w-3.5" />
              方向表示
            </button>
            <button
              onClick={() => setShowSurveyPoints(!showSurveyPoints)}
              className={`flex items-center gap-1 px-3 py-1.5 text-sm border rounded hover:bg-slate-50 ${
                showSurveyPoints ? 'bg-green-100 border-green-400 text-green-700' : ''
              }`}
            >
              <Target className="h-3.5 w-3.5" />
              測点表示
            </button>
            <div className="border-l h-6 mx-1" />
            <button
              onClick={() => setShowZones(!showZones)}
              className={`flex items-center gap-1 px-3 py-1.5 text-sm border rounded hover:bg-slate-50 ${
                showZones ? 'bg-purple-100 border-purple-400 text-purple-700' : ''
              }`}
            >
              <Square className="h-3.5 w-3.5" />
              区域
            </button>
            <button
              onClick={() => setShowCoordinates(!showCoordinates)}
              className={`flex items-center gap-1 px-3 py-1.5 text-sm border rounded hover:bg-slate-50 ${
                showCoordinates ? 'bg-orange-100 border-orange-400 text-orange-700' : ''
              }`}
            >
              <Map className="h-3.5 w-3.5" />
              座標
            </button>
          </div>
          {/* 地図 */}
          <div className="flex-1">
            <PipeMap
              selectedPipeId={selectedPipeId}
              selectedPipeIds={selectedPipeIds}
              onPipeSelect={handlePipeClick}
              onVertexClick={handleVertexClick}
              isBulkEditMode={isBulkEditMode || isSequentialMode}
              showDirection={showDirection}
              showLabels={showLabels}
              showSurveyPoints={showSurveyPoints}
              surveyPoints={surveyPointsData}
              editMode={editMode}
              previewPoints={midpointPreview}
              showZones={showZones}
              showCoordinates={showCoordinates}
            />
          </div>
        </div>
      </div>

      {/* プレビューモードパネル */}
      {isPreviewMode && midpointPreview.length > 0 && (
        <div className="fixed bottom-4 left-1/2 transform -translate-x-1/2 bg-white rounded-lg shadow-xl p-4 z-50 border-2 border-green-500">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <div className="w-4 h-4 rounded-full bg-green-500"></div>
              <span className="text-sm font-medium">
                {midpointPreview.length}個の中間点をプレビュー中
              </span>
            </div>
            <button
              onClick={() => {
                const count = autoInsertMidpoints(midpointMaxLength, midpointTargetTypes)
                setMidpointPreview([])
                setIsPreviewMode(false)
                if (count > 0) {
                  alert(`${count}個の中間点を追加しました`)
                }
              }}
              className="px-4 py-2 text-sm bg-green-600 text-white rounded hover:bg-green-700"
            >
              適用
            </button>
            <button
              onClick={() => {
                setMidpointPreview([])
                setIsPreviewMode(false)
              }}
              className="px-4 py-2 text-sm border rounded hover:bg-gray-50"
            >
              キャンセル
            </button>
          </div>
        </div>
      )}

      {/* 自動中間点設置モーダル */}
      {showMidpointModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl p-6 w-96">
            <h3 className="text-lg font-bold mb-4">自動中間点設置</h3>
            <p className="text-sm text-muted-foreground mb-4">
              指定した距離を超える区間に自動で中間点を追加します。
            </p>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">
                  分割延長（最大区間距離）
                </label>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    value={midpointMaxLength}
                    onChange={(e) => setMidpointMaxLength(parseFloat(e.target.value) || 50)}
                    className="w-24 px-2 py-1 border rounded text-right"
                    min={1}
                    step={1}
                  />
                  <span className="text-sm">m</span>
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  例: 50m設定で102mの区間 → 34m×3区間に分割（中間点2つ追加）
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium mb-2">
                  対象管種
                </label>
                <div className="space-y-1">
                  {EXTENDED_PIPE_TYPES.map((type) => (
                    <label key={type.value} className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={midpointTargetTypes.includes(type.value as PipeType)}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setMidpointTargetTypes([...midpointTargetTypes, type.value as PipeType])
                          } else {
                            setMidpointTargetTypes(midpointTargetTypes.filter(t => t !== type.value))
                          }
                        }}
                        className="rounded"
                      />
                      <span className="text-sm">{type.label}</span>
                    </label>
                  ))}
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-2 mt-6">
              <button
                onClick={() => {
                  setShowMidpointModal(false)
                  setMidpointPreview([])
                  setIsPreviewMode(false)
                }}
                className="px-4 py-2 text-sm border rounded hover:bg-gray-50"
              >
                キャンセル
              </button>
              {!isPreviewMode ? (
                <button
                  onClick={() => {
                    if (midpointTargetTypes.length === 0) {
                      alert('対象管種を1つ以上選択してください')
                      return
                    }
                    const points = previewMidpoints(midpointMaxLength, midpointTargetTypes)
                    setMidpointPreview(points)
                    setIsPreviewMode(true)
                    setShowMidpointModal(false)
                  }}
                  disabled={midpointTargetTypes.length === 0}
                  className={`px-4 py-2 text-sm rounded ${
                    midpointTargetTypes.length > 0
                      ? 'bg-blue-600 text-white hover:bg-blue-700'
                      : 'bg-gray-300 text-gray-500 cursor-not-allowed'
                  }`}
                >
                  プレビュー
                </button>
              ) : (
                <button
                  onClick={() => {
                    const count = autoInsertMidpoints(midpointMaxLength, midpointTargetTypes)
                    setShowMidpointModal(false)
                    setMidpointPreview([])
                    setIsPreviewMode(false)
                    if (count > 0) {
                      alert(`${count}個の中間点を追加しました`)
                    } else {
                      alert('追加する中間点はありませんでした')
                    }
                  }}
                  className="px-4 py-2 text-sm bg-primary text-white rounded hover:bg-primary/90"
                >
                  適用
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
