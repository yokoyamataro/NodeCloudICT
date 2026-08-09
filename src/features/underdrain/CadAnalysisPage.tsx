import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { Upload, Trash2, FileSearch, Download, ArrowUpDown, Edit3, X, Navigation, Link2, Merge, Split, Tag, MapPin, ChevronUp, ChevronDown, Target, Square, Map, Maximize2, Minimize2, Printer } from 'lucide-react'
import { parseDxf, calculateLineLength } from '@/lib/dxf-parser'
import { autoConnectFromOutlet } from '@/lib/pipe-connection'
import {
  useUnderdrainStore,
  EXTENDED_PIPE_TYPES,
  PIPE_DIAMETERS,
  type PipeRow,
} from '@/stores/underdrainStore'
import { useFarmStore } from '@/stores/farmStore'
import { useProjectListStore } from '@/stores/projectListStore'
import { useCoordinateStore } from '@/stores/coordinateStore'
import { PipeMap, type SurveyPointData } from '@/components/map/PipeMap'
import { ResizableSplit } from '@/components/layout/ResizableSplit'
import { PageHeader } from '@/components/layout/PageHeader'
import { comparePipeNumbers } from '@/lib/pipeSort'
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

// 一括訂正モードの設定（連番機能を統合）
interface BulkEditSettings {
  pipeType: PipeType | null
  diameter: number | null
  // 連番設定
  enableSequential: boolean  // 連番を有効にするか
  prefix: string             // 頭文字
  currentNumber: number      // 現在の番号
  suffix: string             // 末尾文字
}

// ソートの設定
type SortKey = 'number' | 'pipeType' | 'diameter' | 'designLength' | 'connectionTo' | null
type SortDirection = 'asc' | 'desc'

// 自動接続モード
type AutoConnectMode = 'idle' | 'selecting-outlet'

export function CadAnalysisPage() {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [parsedEntities, setParsedEntities] = useState<ParsedEntity[]>([])
  const [parseInfo, setParseInfo] = useState<{
    fileName: string
    entityCount: number
    layers: string[]
  } | null>(null)
  const [viewMode, setViewMode] = useState<ViewMode>('import')

  // 一括訂正モード（連番機能を統合）
  const [isBulkEditMode, setIsBulkEditMode] = useState(false)
  const [bulkEditSettings, setBulkEditSettings] = useState<BulkEditSettings>({
    pipeType: null,
    diameter: null,
    enableSequential: false,
    prefix: '',
    currentNumber: 1,
    suffix: '',
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

  // 全画面表示モード
  const [isFullscreen, setIsFullscreen] = useState(false)

  // 結合・分割モード
  const [editMode, setEditMode] = useState<'normal' | 'merge' | 'split'>('normal')

  // 結合実行時の属性引き継ぎ選択モーダル
  // key = 属性名, value = 引き継ぎ元 pipe id（または 'sum' = 設計延長の合算）
  const [showMergeAttrModal, setShowMergeAttrModal] = useState(false)
  const [mergeAttrSource, setMergeAttrSource] = useState<{
    number: string
    layerName: string
    pipeType: string
    diameter: string
    designLength: string  // pipe id または 'sum'
    connectionTo: string
    notes: string
  } | null>(null)

  // ソート設定
  // デフォルトは配管番号昇順（頭文字を除いた数字で比較）
  const [sortKey, setSortKey] = useState<SortKey>('number')
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc')

  // 自動接続モード
  const [autoConnectMode, setAutoConnectMode] = useState<AutoConnectMode>('idle')

  const { currentFarm } = useFarmStore()
  const { projects } = useProjectListStore()
  const {
    pipes,
    fetchPipes,
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
    splitPipeAtPoint,
    autoInsertMidpoints,
    previewMidpoints,
  } = useUnderdrainStore()

  // プロジェクト選択時にデータを読み込む
  useEffect(() => {
    if (currentFarm) {
      const project = projects.find((p) => p.id === currentFarm.project_id)
      if (project) {
        const { setZone } = useCoordinateStore.getState()
        setZone(project.coordinate_zone)
      }
      fetchPipes(currentFarm.id)
    }
  }, [currentFarm, projects, fetchPipes])

  // 2点間の距離を計算
  const calcDistance = (p1: PipeVertex, p2: PipeVertex): number => {
    const dx = p2.x - p1.x
    const dy = p2.y - p1.y
    return Math.sqrt(dx * dx + dy * dy)
  }

  // 管路の下流端点から指定した点までの累積距離を計算
  const calcDistanceAlongPipe = (pipe: PipeRow, point: PipeVertex): number => {
    const vertices = pipe.vertices
    if (vertices.length < 2) return 0

    // 下流端点は配列の最後
    let totalDistance = 0

    // 最後の頂点から順に遡って、点が属するセグメントを見つける
    for (let i = vertices.length - 1; i > 0; i--) {
      const segStart = vertices[i]
      const segEnd = vertices[i - 1]
      const segLength = calcDistance(segStart, segEnd)

      // 点とセグメントの最短距離を計算
      const dx = segEnd.x - segStart.x
      const dy = segEnd.y - segStart.y
      const lengthSq = dx * dx + dy * dy

      if (lengthSq === 0) {
        totalDistance += segLength
        continue
      }

      // 線分上の最近点のパラメータ t を計算
      let t = ((point.x - segStart.x) * dx + (point.y - segStart.y) * dy) / lengthSq
      t = Math.max(0, Math.min(1, t))

      // 最近点の座標
      const nearestX = segStart.x + t * dx
      const nearestY = segStart.y + t * dy

      // 距離を計算
      const distX = point.x - nearestX
      const distY = point.y - nearestY
      const dist = Math.sqrt(distX * distX + distY * distY)

      // 閾値内なら、この点がこのセグメントに接続している
      if (dist <= 0.1) { // 10cm閾値
        // 下流端点（segStart）からの距離を追加
        totalDistance += t * segLength
        return totalDistance
      }

      totalDistance += segLength
    }

    return totalDistance
  }

  // 接続距離を計算（mm単位）
  const getConnectionDistance = useCallback((pipe: PipeRow): number | null => {
    if (!pipe.connectionTo) return null

    const targetPipe = pipes.find(p => p.id === pipe.connectionTo)
    if (!targetPipe || targetPipe.vertices.length < 2) return null

    // 現在の管路の下流端点（配列の最後）
    const downstreamVertex = pipe.vertices[pipe.vertices.length - 1]

    // 接続先管路の下流端点からの距離を計算
    const distanceM = calcDistanceAlongPipe(targetPipe, downstreamVertex)

    // mmに変換
    return Math.round(distanceM * 1000)
  }, [pipes])

  // 自動中間点設置モーダル
  const [showMidpointModal, setShowMidpointModal] = useState(false)
  const [midpointMaxLength, setMidpointMaxLength] = useState(50) // デフォルト50m
  const [midpointTargetTypes, setMidpointTargetTypes] = useState<PipeType[]>(['branch']) // デフォルトは吸水のみ
  const [midpointPreview, setMidpointPreview] = useState<import('@/types/database').PipeVertex[]>([]) // プレビュー用の中間点
  const [isPreviewMode, setIsPreviewMode] = useState(false) // プレビューモード

  // 距離指定での分割（始点側からの距離）
  const [splitDistanceInput, setSplitDistanceInput] = useState<string>('')

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
          // 頭文字・末尾文字を除いた数字部分のみで比較（K3 < O1 にしない）
          return multiplier * comparePipeNumbers(a.number, b.number)
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
        case 'designLength': {
          const aLen = a.designLength ?? -1
          const bLen = b.designLength ?? -1
          return multiplier * (aLen - bLen)
        }
        case 'connectionTo': {
          const aConn = a.connectionTo ? pipes.find(p => p.id === a.connectionTo)?.number ?? '' : ''
          const bConn = b.connectionTo ? pipes.find(p => p.id === b.connectionTo)?.number ?? '' : ''
          return multiplier * aConn.localeCompare(bConn, 'ja', { numeric: true })
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

  // 取込前の候補プレビュー（地図の仮表示に使う）。
  // label は「選択中の並び順」に基づくインポート予定番号 (P{n}) を採用。
  // 未選択の線は "-" だけ表示して区別。
  const importPreviewLines = useMemo(() => {
    let seqSelected = 0
    return parsedEntities.map((e, idx) => {
      let label: string | null = null
      if (e.selected) {
        seqSelected++
        const numberIdx = pipes.length + seqSelected
        label = `P${String(numberIdx).padStart(3, '0')}`
      } else {
        label = `-${idx + 1}` // 未選択も一応識別できるように
      }
      return {
        tempId: e.tempId,
        vertices: e.vertices,
        selected: e.selected,
        label,
      }
    })
  }, [parsedEntities, pipes.length])

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

  // 2.000m の線を除外（記号など配線でないもの）
  // Why: 2m ぴったりの LINE は方位記号・凡例・シンボル図形として使われることが多く、配管ではない
  const excludeTwoMeterLines = () => {
    const TOLERANCE = 0.005 // 5mm 以内なら 2.000m とみなす
    setParsedEntities((prev) =>
      prev.map((e) =>
        Math.abs(e.length - 2.0) < TOLERANCE ? { ...e, selected: false } : e
      )
    )
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
      // 設計延長は実測延長を整数に四捨五入した値で初期化
      designLength: entity.length != null ? Math.round(entity.length) : null,
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
    // 自動接続モード: 落口選択
    if (autoConnectMode === 'selecting-outlet') {
      executeAutoConnect(id)
      return
    }

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

    // 一括訂正モード（連番機能を含む）
    if (isBulkEditMode) {
      const updates: Partial<PipeRow> = {}
      if (bulkEditSettings.pipeType !== null) {
        updates.pipeType = bulkEditSettings.pipeType
      }
      if (bulkEditSettings.diameter !== null) {
        updates.diameter = bulkEditSettings.diameter
      }
      // 連番が有効な場合
      if (bulkEditSettings.enableSequential) {
        const newNumber = `${bulkEditSettings.prefix}${bulkEditSettings.currentNumber}${bulkEditSettings.suffix}`
        updates.number = newNumber
        setBulkEditSettings(prev => ({ ...prev, currentNumber: prev.currentNumber + 1 }))
      }
      if (Object.keys(updates).length > 0) {
        updatePipe(id, updates)
      }
      setSelectedPipeId(id)
      return
    }

    // 通常モード
    setSelectedPipeId(id)
  }

  // 始点（vertices[0]）からの距離 d 上にある点を返す（範囲外は null）
  const pointAtDistanceFromStart = (
    vertices: import('@/types/database').PipeVertex[],
    distance: number,
  ): import('@/types/database').PipeVertex | null => {
    if (vertices.length < 2 || !Number.isFinite(distance) || distance <= 0) return null
    let acc = 0
    for (let i = 0; i < vertices.length - 1; i++) {
      const v1 = vertices[i]
      const v2 = vertices[i + 1]
      const segLen = Math.hypot(v2.x - v1.x, v2.y - v1.y)
      if (segLen <= 0) continue
      if (acc + segLen >= distance - 1e-9) {
        const local = distance - acc
        const t = Math.max(0, Math.min(1, local / segLen))
        return {
          x: v1.x + t * (v2.x - v1.x),
          y: v1.y + t * (v2.y - v1.y),
          z: v1.z != null && v2.z != null ? v1.z + t * (v2.z - v1.z) : v1.z ?? v2.z,
        }
      }
      acc += segLen
    }
    return null
  }

  // 分割モード時、距離指定が有効なら仮の分割点を計算
  const splitPipeForDistance = pipes.find((p) => p.id === selectedPipeId) || null
  const splitPipeTotalLength = useMemo(() => {
    if (!splitPipeForDistance) return 0
    let total = 0
    const vs = splitPipeForDistance.vertices
    for (let i = 0; i < vs.length - 1; i++) {
      total += Math.hypot(vs[i + 1].x - vs[i].x, vs[i + 1].y - vs[i].y)
    }
    return total
  }, [splitPipeForDistance])
  const splitDistanceValue = parseFloat(splitDistanceInput)
  const splitPreviewPoint = useMemo<import('@/types/database').PipeVertex | null>(() => {
    if (editMode !== 'split' || !splitPipeForDistance) return null
    if (!Number.isFinite(splitDistanceValue) || splitDistanceValue <= 0) return null
    if (splitDistanceValue >= splitPipeTotalLength) return null
    return pointAtDistanceFromStart(splitPipeForDistance.vertices, splitDistanceValue)
  }, [editMode, splitPipeForDistance, splitDistanceValue, splitPipeTotalLength])

  // 距離指定の分割確定
  const handleConfirmSplitByDistance = () => {
    if (!selectedPipeId || !splitPreviewPoint) return
    const result = splitPipeAtPoint(selectedPipeId, splitPreviewPoint)
    if (result) {
      setSplitDistanceInput('')
      setEditMode('normal')
      setSelectedPipeId(null)
    } else {
      alert('分割できませんでした（位置が管路上にありません）')
    }
  }

  // 編集モード変更時に距離入力を初期化
  useEffect(() => {
    if (editMode !== 'split') setSplitDistanceInput('')
  }, [editMode])

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

  // 合流点クリック処理（分割モード用）
  const handleJunctionSplitClick = (pipeId: string, point: { x: number; y: number }) => {
    if (editMode !== 'split') return

    const result = splitPipeAtPoint(pipeId, point)
    if (result) {
      alert('合流点で管路を分割しました')
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
    setBulkEditSettings({
      pipeType: null,
      diameter: null,
      enableSequential: false,
      prefix: '',
      currentNumber: 1,
      suffix: '',
    })
  }

  // 一括訂正モード終了
  const endBulkEdit = () => {
    setIsBulkEditMode(false)
    setBulkEditSettings({
      pipeType: null,
      diameter: null,
      enableSequential: false,
      prefix: '',
      currentNumber: 1,
      suffix: '',
    })
  }

  // 自動接続モード開始
  const startAutoConnect = () => {
    setAutoConnectMode('selecting-outlet')
    setSelectedPipeId(null)
  }

  // 自動接続モード終了
  const cancelAutoConnect = () => {
    setAutoConnectMode('idle')
  }

  // 自動接続実行（落口を選択した後に呼ばれる）
  const executeAutoConnect = (outletPipeId: string) => {
    // 最新のpipes状態を取得（分割・結合後の管路も含む）
    // ストアから直接取得することで、最新の状態を反映
    const currentPipes = useUnderdrainStore.getState().pipes

    // 落口管路も最新の状態から取得
    const outletPipe = currentPipes.find((p) => p.id === outletPipeId)
    if (!outletPipe) {
      setAutoConnectMode('idle')
      alert('選択した管路が見つかりません')
      return
    }

    // 選択中の管路を落口として設定
    updatePipe(outletPipeId, { pipeType: 'outlet' })
    setSelectedPipeId(outletPipeId)

    // 落口の終点（現在の下流方向）を基準に自動接続
    const results = autoConnectFromOutlet(outletPipe, 'end', currentPipes)

    // 結果を適用
    for (const result of results) {
      if (result.updates.shouldReverse) {
        reversePipeDirection(result.pipeId)
      }
      if (result.updates.connectionTo !== undefined) {
        updatePipe(result.pipeId, { connectionTo: result.updates.connectionTo })
      }
    }

    setAutoConnectMode('idle')
    alert(`${results.length} 件の管路の接続関係を設定しました`)
  }

  // 工区が選択されていない場合のエラー表示
  if (!currentFarm) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center text-muted-foreground">
          <p>工区を選択してください</p>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col">
      <PageHeader title="CAD解析" subtitle="DXFファイルから管路データを抽出・登録" />

      <ResizableSplit
        storageKey="cad-analysis"
        defaultLeft={620}
        minLeft={320}
        maxLeft={1400}
        className="flex-1 min-h-0"
        left={
        <div className="flex-1 flex flex-col border-r min-h-0">
          {/* ツールバー */}
          <div className="p-2 border-b bg-slate-50 flex-shrink-0">
            <div className="flex items-center gap-1 flex-wrap">
              <input
                ref={fileInputRef}
                type="file"
                accept=".dxf"
                onChange={handleFileUpload}
                className="hidden"
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                className="flex items-center gap-1.5 px-2.5 py-1.5 text-sm bg-primary text-primary-foreground rounded hover:bg-primary/90 whitespace-nowrap"
                title="DXF ファイルをインポート"
              >
                <Upload className="h-4 w-4" />
                DXF
              </button>
              {pipes.length > 0 && !isBulkEditMode && editMode === 'normal' && autoConnectMode === 'idle' && (
                <>
                  <div className="w-px h-6 bg-slate-300 mx-0.5" />
                  {/* 編集モード */}
                  <button
                    onClick={startBulkEdit}
                    className="p-2 text-slate-600 border border-transparent rounded hover:bg-white hover:border-slate-300"
                    title="一括訂正（管種・管径・連番をまとめて設定）"
                  >
                    <Edit3 className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => { setEditMode('merge'); clearPipeSelection() }}
                    className="p-2 text-slate-600 border border-transparent rounded hover:bg-white hover:border-slate-300"
                    title="結合（隣接管路を 1 本にまとめる）"
                  >
                    <Merge className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => { setEditMode('split'); setSelectedPipeId(null) }}
                    className="p-2 text-slate-600 border border-transparent rounded hover:bg-white hover:border-slate-300"
                    title="分割（管路を頂点・距離・合流点で分ける）"
                  >
                    <Split className="h-4 w-4" />
                  </button>

                  <div className="w-px h-6 bg-slate-300 mx-0.5" />
                  {/* 自動処理 */}
                  <button
                    onClick={startAutoConnect}
                    className="flex items-center gap-1 px-2 py-1.5 text-sm border border-green-400 bg-green-50 text-green-700 rounded hover:bg-green-100 whitespace-nowrap"
                    title="自動接続（落口を選択して接続関係と上下流方向を自動設定）"
                  >
                    <Link2 className="h-4 w-4" />
                    自動接続
                  </button>
                  <button
                    onClick={() => setShowMidpointModal(true)}
                    className="p-2 text-slate-600 border border-transparent rounded hover:bg-white hover:border-slate-300"
                    title="中間点（長い区間に自動で中間点を設置）"
                  >
                    <MapPin className="h-4 w-4" />
                  </button>

                  <div className="w-px h-6 bg-slate-300 mx-0.5" />
                  {/* 出力 / 危険 */}
                  <button
                    onClick={handleExportCSV}
                    className="p-2 text-slate-600 border border-transparent rounded hover:bg-white hover:border-slate-300"
                    title="CSV 出力"
                  >
                    <Download className="h-4 w-4" />
                  </button>
                  <button
                    onClick={clearPipes}
                    className="p-2 text-red-600 border border-transparent rounded hover:bg-red-50 hover:border-red-300"
                    title="全削除（取込済みの管路をすべて削除）"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </>
              )}
              {lastImportFile && !isBulkEditMode && (
                <span className="ml-auto text-xs text-muted-foreground truncate max-w-[200px]" title={lastImportFile}>
                  最終: {lastImportFile}
                </span>
              )}
            </div>
          </div>

          {/* 自動接続モードパネル */}
          {autoConnectMode === 'selecting-outlet' && (
            <div className="p-3 bg-green-50 border-b flex-shrink-0">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-green-800">
                  自動接続モード: 落口となる管路をクリックして選択してください
                </span>
                <button
                  onClick={cancelAutoConnect}
                  className="p-1 text-green-600 hover:bg-green-100 rounded"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <p className="text-xs text-green-600 mt-1">
                選択した管路を落口として、接続関係と上下流方向を自動設定します
              </p>
            </div>
          )}

          {/* 結合モードパネル */}
          {editMode === 'merge' && (
            <div className="p-3 bg-purple-50 border-b flex-shrink-0">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-purple-800">
                  結合モード: 結合する管路をクリックで選択（{selectedPipeIds.size}件選択中）
                  {isBulkEditMode && (
                    <span className="ml-2 text-amber-700 text-xs">
                      （完了後、一括訂正モードに戻ります）
                    </span>
                  )}
                </span>
                <div className="flex gap-2">
                  <button
                    onClick={() => {
                      if (selectedPipeIds.size < 2) {
                        alert('2本以上の管路を選択してください')
                        return
                      }
                      const firstId = Array.from(selectedPipeIds)[0]
                      setMergeAttrSource({
                        number: firstId,
                        layerName: firstId,
                        pipeType: firstId,
                        diameter: firstId,
                        designLength: firstId,
                        connectionTo: firstId,
                        notes: firstId,
                      })
                      setShowMergeAttrModal(true)
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
            <div className="p-3 bg-orange-50 border-b flex-shrink-0 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-orange-800">
                  分割モード: {selectedPipeId
                    ? `「${pipes.find(p => p.id === selectedPipeId)?.number}」の分割点をクリック、または下で距離指定`
                    : '分割する管路を選択してください'}
                  {isBulkEditMode && (
                    <span className="ml-2 text-amber-700 text-xs">
                      （完了後、一括訂正モードに戻ります）
                    </span>
                  )}
                </span>
                <button
                  onClick={() => { setEditMode('normal'); setSelectedPipeId(null) }}
                  className="p-1 text-orange-600 hover:bg-orange-100 rounded"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              {selectedPipeId && splitPipeForDistance && (
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs text-orange-700">始点側からの距離 (m):</span>
                  <input
                    type="number"
                    step={0.1}
                    min={0}
                    max={splitPipeTotalLength}
                    value={splitDistanceInput}
                    onChange={(e) => setSplitDistanceInput(e.target.value)}
                    placeholder={`0 〜 ${splitPipeTotalLength.toFixed(2)}`}
                    className="px-2 py-1 border rounded text-xs w-32 text-right"
                  />
                  <span className="text-[11px] text-orange-600">
                    総延長 {splitPipeTotalLength.toFixed(2)} m
                  </span>
                  {splitPreviewPoint && (
                    <span className="text-[11px] text-emerald-700 font-mono">
                      仮の点: ({splitPreviewPoint.x.toFixed(3)}, {splitPreviewPoint.y.toFixed(3)})
                    </span>
                  )}
                  <button
                    onClick={handleConfirmSplitByDistance}
                    disabled={!splitPreviewPoint}
                    className="px-3 py-1 text-xs bg-orange-600 text-white rounded hover:bg-orange-700 disabled:opacity-50"
                  >
                    確定して分割
                  </button>
                </div>
              )}
            </div>
          )}

          {/* 一括訂正モードパネル（連番機能を含む） */}
          {isBulkEditMode && editMode === 'normal' && (
            <div className="p-3 bg-amber-50 border-b flex-shrink-0">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-amber-800">
                  一括訂正モード: 地図上の管路をクリックして変更
                  {bulkEditSettings.enableSequential && (
                    <span className="ml-2 text-cyan-700">
                      （次の番号: {bulkEditSettings.prefix}{bulkEditSettings.currentNumber}{bulkEditSettings.suffix}）
                    </span>
                  )}
                </span>
                <div className="flex items-center gap-1">
                  {/* 一括訂正の途中でも管の結合・分割を割り込みで実行できる */}
                  <button
                    onClick={() => { setEditMode('merge'); clearPipeSelection() }}
                    className="flex items-center gap-1 px-2 py-1 text-xs border border-purple-300 bg-white text-purple-700 rounded hover:bg-purple-50"
                    title="結合を割り込みで実行（完了後、一括訂正に戻る）"
                  >
                    <Merge className="h-3.5 w-3.5" />
                    結合
                  </button>
                  <button
                    onClick={() => { setEditMode('split'); setSelectedPipeId(null) }}
                    className="flex items-center gap-1 px-2 py-1 text-xs border border-orange-300 bg-white text-orange-700 rounded hover:bg-orange-50"
                    title="分割を割り込みで実行（完了後、一括訂正に戻る）"
                  >
                    <Split className="h-3.5 w-3.5" />
                    分割
                  </button>
                  <button
                    onClick={endBulkEdit}
                    className="p-1 text-amber-600 hover:bg-amber-100 rounded"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              </div>
              <div className="flex items-center gap-4 flex-wrap">
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
                <div className="border-l pl-4 flex items-center gap-2">
                  <label className="flex items-center gap-1 text-xs text-amber-700 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={bulkEditSettings.enableSequential}
                      onChange={(e) =>
                        setBulkEditSettings((prev) => ({
                          ...prev,
                          enableSequential: e.target.checked,
                        }))
                      }
                      className="h-3 w-3"
                    />
                    連番
                  </label>
                </div>
                {bulkEditSettings.enableSequential && (
                  <>
                    <div className="flex items-center gap-2">
                      <label className="text-xs text-cyan-700">頭文字:</label>
                      <input
                        type="text"
                        value={bulkEditSettings.prefix}
                        onChange={(e) =>
                          setBulkEditSettings((prev) => ({ ...prev, prefix: e.target.value }))
                        }
                        className="w-16 px-2 py-1 border rounded text-xs"
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <label className="text-xs text-cyan-700">番号:</label>
                      <input
                        type="number"
                        value={bulkEditSettings.currentNumber}
                        onChange={(e) =>
                          setBulkEditSettings((prev) => ({
                            ...prev,
                            currentNumber: parseInt(e.target.value) || 1,
                          }))
                        }
                        className="w-16 px-2 py-1 border rounded text-xs text-right"
                        min={1}
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <label className="text-xs text-cyan-700">末尾:</label>
                      <input
                        type="text"
                        value={bulkEditSettings.suffix}
                        onChange={(e) =>
                          setBulkEditSettings((prev) => ({ ...prev, suffix: e.target.value }))
                        }
                        className="w-16 px-2 py-1 border rounded text-xs"
                      />
                    </div>
                  </>
                )}
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
                    onClick={excludeTwoMeterLines}
                    className="px-2 py-1 text-xs border rounded hover:bg-white"
                    title="2.000m の線（方位記号・凡例など、配線でない図形）を選択から外す"
                  >
                    2m線を除外
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
                      <th
                        className="px-2 py-2 text-right font-medium cursor-pointer hover:bg-slate-200 select-none"
                        onClick={() => handleSort('designLength')}
                      >
                        <div className="flex items-center justify-end gap-1">
                          設計延長
                          {sortKey === 'designLength' && (
                            sortDirection === 'asc' ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />
                          )}
                        </div>
                      </th>
                      <th className="px-2 py-2 text-right font-medium">実測延長</th>
                      <th
                        className="px-2 py-2 text-left font-medium cursor-pointer hover:bg-slate-200 select-none"
                        onClick={() => handleSort('connectionTo')}
                      >
                        <div className="flex items-center gap-1">
                          接続先
                          {sortKey === 'connectionTo' && (
                            sortDirection === 'asc' ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />
                          )}
                        </div>
                      </th>
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
                            // フォーカス中のマウスホイールで数値が変わるのを防止
                            onWheel={(e) => e.currentTarget.blur()}
                            className="w-16 px-1 py-0.5 border rounded text-right text-sm"
                            step="0.001"
                            placeholder="m"
                          />
                        </td>
                        <td className="px-2 py-1 text-right font-mono text-xs">
                          {pipe.measuredLength?.toFixed(3) ?? '-'}
                        </td>
                        <td className="px-2 py-1">
                          <div className="flex items-center gap-1">
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
                            {pipe.connectionTo && (() => {
                              const dist = getConnectionDistance(pipe)
                              return dist !== null ? (
                                <span className="text-xs text-muted-foreground font-mono whitespace-nowrap">
                                  @{dist.toLocaleString()}mm
                                </span>
                              ) : null
                            })()}
                          </div>
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

        }
        right={
        <div className="flex-1 h-full overflow-hidden flex flex-col">
          {/* 地図上部のツールバー（アイコン中心の表示トグル） */}
          <div className="p-2 bg-white border-b flex items-center gap-1 flex-shrink-0">
            <button
              onClick={() => setShowLabels(!showLabels)}
              className={`p-2 border rounded hover:bg-slate-50 ${
                showLabels ? 'bg-blue-100 border-blue-400 text-blue-700' : 'border-transparent text-slate-600'
              }`}
              title="番号表示"
            >
              <Tag className="h-4 w-4" />
            </button>
            <button
              onClick={() => setShowDirection(!showDirection)}
              className={`p-2 border rounded hover:bg-slate-50 ${
                showDirection ? 'bg-blue-100 border-blue-400 text-blue-700' : 'border-transparent text-slate-600'
              }`}
              title="方向表示"
            >
              <Navigation className="h-4 w-4" />
            </button>
            <button
              onClick={() => setShowSurveyPoints(!showSurveyPoints)}
              className={`p-2 border rounded hover:bg-slate-50 ${
                showSurveyPoints ? 'bg-green-100 border-green-400 text-green-700' : 'border-transparent text-slate-600'
              }`}
              title="測点表示"
            >
              <Target className="h-4 w-4" />
            </button>
            <div className="w-px h-6 bg-slate-300 mx-0.5" />
            <button
              onClick={() => setShowZones(!showZones)}
              className={`p-2 border rounded hover:bg-slate-50 ${
                showZones ? 'bg-purple-100 border-purple-400 text-purple-700' : 'border-transparent text-slate-600'
              }`}
              title="区域表示"
            >
              <Square className="h-4 w-4" />
            </button>
            <button
              onClick={() => setShowCoordinates(!showCoordinates)}
              className={`p-2 border rounded hover:bg-slate-50 ${
                showCoordinates ? 'bg-orange-100 border-orange-400 text-orange-700' : 'border-transparent text-slate-600'
              }`}
              title="座標管理点表示"
            >
              <Map className="h-4 w-4" />
            </button>
            <div className="w-px h-6 bg-slate-300 mx-0.5" />
            <button
              onClick={() => setIsFullscreen(true)}
              className="p-2 border border-transparent text-slate-600 rounded hover:bg-slate-50 hover:border-slate-300"
              title="全画面表示"
            >
              <Maximize2 className="h-4 w-4" />
            </button>
            <button
              onClick={() => window.print()}
              className="p-2 border border-transparent text-slate-600 rounded hover:bg-slate-50 hover:border-slate-300"
              title="印刷"
            >
              <Printer className="h-4 w-4" />
            </button>
          </div>
          {/* 地図 */}
          <div className="flex-1">
            <PipeMap
              selectedPipeId={selectedPipeId}
              selectedPipeIds={selectedPipeIds}
              onPipeSelect={handlePipeClick}
              onVertexClick={handleVertexClick}
              onJunctionSplitClick={handleJunctionSplitClick}
              isBulkEditMode={isBulkEditMode || autoConnectMode === 'selecting-outlet'}
              showDirection={showDirection}
              showLabels={showLabels}
              showSurveyPoints={showSurveyPoints}
              surveyPoints={surveyPointsData}
              editMode={editMode}
              previewPoints={
                splitPreviewPoint
                  ? [...midpointPreview, splitPreviewPoint]
                  : midpointPreview
              }
              showZones={showZones}
              showCoordinates={showCoordinates}
              importPreviewLines={importPreviewLines}
              onPreviewClick={toggleEntitySelection}
            />
          </div>
        </div>
        }
      />

      {/* プレビューモードパネル */}
      {isPreviewMode && midpointPreview.length > 0 && (
        <div className="fixed bottom-4 left-1/2 transform -translate-x-1/2 bg-white rounded-lg shadow-xl p-4 z-[3000] border-2 border-green-500">
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
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[3000]">
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

      {/* 結合時の属性引き継ぎ選択モーダル */}
      {showMergeAttrModal && mergeAttrSource && (() => {
        const selectedPipes = Array.from(selectedPipeIds)
          .map(id => pipes.find(p => p.id === id))
          .filter((p): p is PipeRow => p !== undefined)
        if (selectedPipes.length < 2) return null

        const attrRows: Array<{
          key: keyof typeof mergeAttrSource
          label: string
          format: (p: PipeRow) => string
          extraOption?: { value: string; label: string; compute: () => string }
        }> = [
          { key: 'number', label: '番号', format: (p) => p.number || '（空）' },
          {
            key: 'pipeType',
            label: '管種',
            format: (p) => EXTENDED_PIPE_TYPES.find(t => t.value === p.pipeType)?.label ?? '未設定',
          },
          { key: 'diameter', label: '管径 (mm)', format: (p) => p.diameter != null ? String(p.diameter) : '未設定' },
          {
            key: 'designLength',
            label: '設計延長 (m)',
            format: (p) => p.designLength != null ? p.designLength.toFixed(3) : '未設定',
            extraOption: {
              value: 'sum',
              label: '合算',
              compute: () => selectedPipes
                .reduce((acc, p) => acc + (p.designLength ?? 0), 0)
                .toFixed(3),
            },
          },
          { key: 'layerName', label: 'レイヤ名', format: (p) => p.layerName || '（空）' },
          {
            key: 'connectionTo',
            label: '接続先',
            format: (p) => {
              if (!p.connectionTo) return 'なし'
              const target = pipes.find(x => x.id === p.connectionTo)
              return target?.number ?? 'なし'
            },
          },
          { key: 'notes', label: '備考', format: (p) => p.notes || '（空）' },
        ]

        const executeMerge = () => {
          if (!mergeAttrSource) return
          const findPipe = (id: string) => selectedPipes.find(p => p.id === id)
          const overrides: Partial<Pick<PipeRow, 'number' | 'layerName' | 'pipeType' | 'diameter' | 'designLength' | 'connectionTo' | 'notes'>> = {}
          const numberSrc = findPipe(mergeAttrSource.number)
          if (numberSrc) overrides.number = numberSrc.number
          const layerSrc = findPipe(mergeAttrSource.layerName)
          if (layerSrc) overrides.layerName = layerSrc.layerName
          const pipeTypeSrc = findPipe(mergeAttrSource.pipeType)
          if (pipeTypeSrc) overrides.pipeType = pipeTypeSrc.pipeType
          const diameterSrc = findPipe(mergeAttrSource.diameter)
          if (diameterSrc) overrides.diameter = diameterSrc.diameter
          if (mergeAttrSource.designLength === 'sum') {
            overrides.designLength = selectedPipes.reduce((acc, p) => acc + (p.designLength ?? 0), 0)
          } else {
            const lengthSrc = findPipe(mergeAttrSource.designLength)
            if (lengthSrc) overrides.designLength = lengthSrc.designLength
          }
          const connSrc = findPipe(mergeAttrSource.connectionTo)
          if (connSrc) overrides.connectionTo = connSrc.connectionTo
          const notesSrc = findPipe(mergeAttrSource.notes)
          if (notesSrc) overrides.notes = notesSrc.notes

          const result = mergePipes(Array.from(selectedPipeIds), overrides)
          setShowMergeAttrModal(false)
          setMergeAttrSource(null)
          if (result) {
            setEditMode('normal')
          } else {
            alert('選択した管路は隣接していないため結合できません')
          }
        }

        return (
          <div className="fixed inset-0 z-[3000] bg-black/40 flex items-center justify-center p-4">
            <div className="bg-white rounded-lg shadow-xl w-full max-w-4xl max-h-[92vh] flex flex-col">
              <div className="px-4 py-3 border-b flex items-center justify-between">
                <span className="text-sm font-semibold">
                  管路結合: 引き継ぐ属性の選択
                </span>
                <button
                  onClick={() => { setShowMergeAttrModal(false); setMergeAttrSource(null) }}
                  className="p-1 rounded hover:bg-slate-100"
                >
                  <X className="h-4 w-4 text-slate-500" />
                </button>
              </div>
              <div className="flex-1 overflow-auto p-4">
                <p className="text-xs text-slate-500 mb-3">
                  各属性ごとに、どの管路の値を引き継ぐかを選択してください。実測延長は結合後の頂点座標から自動計算されます。
                </p>
                <div className="overflow-auto border rounded">
                  <table className="w-full text-xs">
                    <thead className="bg-slate-50 sticky top-0">
                      <tr>
                        <th className="text-left py-2 px-2 border-b font-medium text-slate-600">属性</th>
                        {selectedPipes.map(p => (
                          <th key={p.id} className="text-left py-2 px-2 border-b font-mono text-slate-700">
                            {p.number}
                          </th>
                        ))}
                        {/* extraOption 列: 設計延長のみ「合算」を表示 */}
                        <th className="text-left py-2 px-2 border-b font-medium text-slate-500 w-24">
                          その他
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {attrRows.map(row => (
                        <tr key={row.key} className="border-b">
                          <td className="py-2 px-2 font-medium text-slate-600">{row.label}</td>
                          {selectedPipes.map(p => (
                            <td key={p.id} className="py-2 px-2">
                              <label className="flex items-center gap-1.5 cursor-pointer">
                                <input
                                  type="radio"
                                  name={`merge-attr-${row.key}`}
                                  checked={mergeAttrSource[row.key] === p.id}
                                  onChange={() =>
                                    setMergeAttrSource(prev =>
                                      prev ? { ...prev, [row.key]: p.id } : prev
                                    )
                                  }
                                />
                                <span className="font-mono">{row.format(p)}</span>
                              </label>
                            </td>
                          ))}
                          <td className="py-2 px-2">
                            {row.extraOption && (
                              <label className="flex items-center gap-1.5 cursor-pointer">
                                <input
                                  type="radio"
                                  name={`merge-attr-${row.key}`}
                                  checked={mergeAttrSource[row.key] === row.extraOption.value}
                                  onChange={() =>
                                    setMergeAttrSource(prev =>
                                      prev ? { ...prev, [row.key]: row.extraOption!.value } : prev
                                    )
                                  }
                                />
                                <span className="font-mono">
                                  {row.extraOption.label} = {row.extraOption.compute()}
                                </span>
                              </label>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              <div className="px-4 py-2 border-t flex items-center justify-end gap-2">
                <button
                  onClick={() => { setShowMergeAttrModal(false); setMergeAttrSource(null) }}
                  className="px-3 py-1 text-xs border rounded hover:bg-slate-50"
                >
                  キャンセル
                </button>
                <button
                  onClick={executeMerge}
                  className="flex items-center gap-1 px-3 py-1 text-xs bg-purple-600 text-white rounded hover:bg-purple-700"
                >
                  <Merge className="h-3 w-3" />
                  結合実行
                </button>
              </div>
            </div>
          </div>
        )
      })()}

      {/* 全画面表示モード */}
      {isFullscreen && (
        <div className="fixed inset-0 z-[9999] bg-white flex flex-col print:static print:h-auto">
          {/* 全画面時のツールバー */}
          <div className="p-2 bg-white border-b flex items-center gap-2 flex-shrink-0 print:hidden">
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
            <div className="flex-1" />
            <button
              onClick={() => window.print()}
              className="flex items-center gap-1 px-3 py-1.5 text-sm border rounded hover:bg-slate-50"
              title="印刷"
            >
              <Printer className="h-3.5 w-3.5" />
              印刷
            </button>
            <button
              onClick={() => setIsFullscreen(false)}
              className="flex items-center gap-1 px-3 py-1.5 text-sm border rounded hover:bg-slate-50"
              title="全画面終了"
            >
              <Minimize2 className="h-3.5 w-3.5" />
              閉じる
            </button>
          </div>
          {/* 全画面地図 */}
          <div className="flex-1 print:h-[100vh]">
            <PipeMap
              selectedPipeId={selectedPipeId}
              selectedPipeIds={selectedPipeIds}
              onPipeSelect={handlePipeClick}
              onVertexClick={handleVertexClick}
              onJunctionSplitClick={handleJunctionSplitClick}
              isBulkEditMode={false}
              showDirection={showDirection}
              showLabels={showLabels}
              showSurveyPoints={showSurveyPoints}
              surveyPoints={surveyPointsData}
              editMode="normal"
              previewPoints={[]}
              showZones={showZones}
              showCoordinates={showCoordinates}
              importPreviewLines={importPreviewLines}
              onPreviewClick={toggleEntitySelection}
            />
          </div>
        </div>
      )}
    </div>
  )
}
