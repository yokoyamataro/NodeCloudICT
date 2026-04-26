import { useState, useMemo, useEffect, useCallback, useRef } from 'react'
import {
  Cable,
  Plus,
  X,
  Hash,
  Navigation,
  Target,
  Square,
  Map as MapIcon,
  MousePointer,
  Zap,
  GitMerge,
  Loader2,
  RefreshCw,
  PlusCircle,
  Trash2,
} from 'lucide-react'
import { useUnderdrainStore, type PipeRow } from '@/stores/underdrainStore'
import { useCoordinateStore } from '@/stores/coordinateStore'
import { useFarmStore } from '@/stores/farmStore'
import { useProjectListStore } from '@/stores/projectListStore'
import { usePipeWiringStore, type CollectorTab, type WiringRow, type RowType } from '@/stores/pipeWiringStore'
import { useConstructionPlanStore } from '@/stores/constructionPlanStore'
import { PipeMap, type SurveyPointData, type PipeChangePoint } from '@/components/map/PipeMap'
import type { PipeVertex } from '@/types/database'

// タブの種類
type TabType = 'collector' | 'direct'

// 選択モード
type SelectionMode = 'none' | 'absorption' | 'collector' | 'bulk-start'

export function PipeWiringPage() {
  const { pipes, fetchPipes } = useUnderdrainStore()
  const { fetchCoordinates, setZone } = useCoordinateStore()
  const { currentFarm } = useFarmStore()
  const { projects } = useProjectListStore()
  const {
    collectorTabs,
    directRows,
    setCollectorTabs,
    setDirectRows,
    fetchWiring,
    loading: wiringLoading,
    saving: wiringSaving,
  } = usePipeWiringStore()
  const { fetchPlan } = useConstructionPlanStore()

  // 前の圃場IDを保持するref
  const prevFarmIdRef = useRef<string | null>(null)

  // プロジェクト選択時にデータを読み込む
  useEffect(() => {
    if (currentFarm) {
      prevFarmIdRef.current = currentFarm.id

      // プロジェクトの座標系を設定
      const project = projects.find((p) => p.id === currentFarm.project_id)
      if (project) {
        setZone(project.coordinate_zone)
      }

      fetchPipes(currentFarm.id)
      fetchCoordinates(currentFarm.id)
      fetchWiring(currentFarm.id)
      fetchPlan(currentFarm.id)
    }
  }, [currentFarm, projects, setZone, fetchPipes, fetchCoordinates, fetchWiring, fetchPlan])

  // タブ管理
  const [activeTabType, setActiveTabType] = useState<TabType>('collector')
  const [activeCollectorIndex, setActiveCollectorIndex] = useState(0)

  // 地図表示設定
  const [showLabels, setShowLabels] = useState(true)
  const [showDirection, setShowDirection] = useState(true)
  const [showSurveyPoints, setShowSurveyPoints] = useState(false)
  const [showZones, setShowZones] = useState(false)
  const [showCoordinates, setShowCoordinates] = useState(true)

  // 選択モード
  const [selectionMode, setSelectionMode] = useState<SelectionMode>('none')
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null)

  // 一括設定モード用の状態
  const [pendingCollectorPipeId, setPendingCollectorPipeId] = useState<string | null>(null) // 次に処理する集水管
  const [previousCollectorPipeId, setPreviousCollectorPipeId] = useState<string | null>(null) // 前の集水管ID（除外用）
  const [showContinueDialog, setShowContinueDialog] = useState(false) // 続けるか確認ダイアログ
  const [isOutletDialog, setIsOutletDialog] = useState(false) // 落口確認ダイアログかどうか

  // 2点間の距離を計算
  const calcDistance = useCallback((p1: PipeVertex, p2: PipeVertex): number => {
    const dx = p2.x - p1.x
    const dy = p2.y - p1.y
    return Math.sqrt(dx * dx + dy * dy)
  }, [])

  // 管路の下流端点から指定した点までの累積距離を計算
  const calcDistanceAlongPipe = useCallback((pipe: PipeRow, point: PipeVertex): number => {
    const vertices = pipe.vertices
    if (vertices.length < 2) return 0

    let totalDistance = 0

    for (let i = vertices.length - 1; i > 0; i--) {
      const segStart = vertices[i]
      const segEnd = vertices[i - 1]
      const segLength = calcDistance(segStart, segEnd)

      const dx = segEnd.x - segStart.x
      const dy = segEnd.y - segStart.y
      const lengthSq = dx * dx + dy * dy

      if (lengthSq === 0) {
        totalDistance += segLength
        continue
      }

      let t = ((point.x - segStart.x) * dx + (point.y - segStart.y) * dy) / lengthSq
      t = Math.max(0, Math.min(1, t))

      const nearestX = segStart.x + t * dx
      const nearestY = segStart.y + t * dy

      const distX = point.x - nearestX
      const distY = point.y - nearestY
      const dist = Math.sqrt(distX * distX + distY * distY)

      if (dist <= 0.1) {
        totalDistance += t * segLength
        return totalDistance
      }

      totalDistance += segLength
    }

    return totalDistance
  }, [calcDistance])

  // 接続距離を計算（mm単位）
  const getConnectionDistance = useCallback((absorptionPipe: PipeRow, collectorPipe: PipeRow): number => {
    const downstreamVertex = absorptionPipe.vertices[absorptionPipe.vertices.length - 1]
    return Math.round(calcDistanceAlongPipe(collectorPipe, downstreamVertex) * 1000)
  }, [calcDistanceAlongPipe])

  // 一括設定を開始（末端吸水を選択するモードに入る）
  const startBulkSetting = () => {
    setSelectionMode('bulk-start')
    setSelectedRowId(null)
  }

  // 一括設定をキャンセル
  const cancelBulkSetting = () => {
    setSelectionMode('none')
    setSelectedRowId(null)
    setPendingCollectorPipeId(null)
    setPreviousCollectorPipeId(null)
    setShowContinueDialog(false)
    setIsOutletDialog(false)
  }

  // 集水管の内部頂点（端部以外）を集水変化点候補として返すヘルパ
  // absorptionVertexSet が渡されたらその頂点はスキップ
  // ※ 角度閾値による折点判定はせず、内部頂点はすべて変化点候補とする
  //   （CAD 解析で測点分割された頂点はすべて意味のある節点とみなす）
  const findCollectorBendVertices = useCallback(
    (collectorPipe: PipeRow, absorptionVertexSet?: Set<number>): number[] => {
      const result: number[] = []
      const cv = collectorPipe.vertices
      if (cv.length < 3) return result
      for (let i = 1; i < cv.length - 1; i++) {
        if (absorptionVertexSet?.has(i)) continue
        result.push(i)
      }
      return result
    },
    [],
  )

  // 一括設定を実行（集水管に対して吸水を追加）
  // excludePipeId: 既に追加済みの管路ID（二重登録防止用）
  const executeBulkSetting = useCallback((collectorPipeId: string, excludePipeId?: string) => {
    const collectorPipe = pipes.find(p => p.id === collectorPipeId)
    if (!collectorPipe) return

    // この集水管を接続先としている管を検索（既に追加済みの管路は除外）
    const connectedAllPipes = pipes.filter(p =>
      p.connectionTo === collectorPipeId && p.id !== excludePipeId
    )
    // 「吸水管」として扱うのは pipe_type === 'branch' のみ。
    // それ以外（main / outlet / connection 等）は集水間の連結なので
    // 「集水変化点」として扱う。
    const connectedAbsorptionPipes = connectedAllPipes.filter(p => p.pipeType === 'branch')
    const connectedCollectorLinks = connectedAllPipes.filter(p => p.pipeType !== 'branch')

    // 非吸水の連結管（前段の集水管が下流端でこの集水管に合流）について、
    // この集水管側の合流頂点を抽出
    const linkJunctionVertexIdxs = connectedCollectorLinks
      .map((linkPipe) => {
        const downstream = linkPipe.vertices[linkPipe.vertices.length - 1]
        let bestIdx = -1
        let bestDist = Infinity
        for (let i = 0; i < collectorPipe.vertices.length; i++) {
          const d = Math.hypot(
            collectorPipe.vertices[i].x - downstream.x,
            collectorPipe.vertices[i].y - downstream.y,
          )
          if (d < bestDist) { bestDist = d; bestIdx = i }
        }
        return bestIdx >= 0 && bestDist <= 0.5 ? bestIdx : -1
      })
      .filter(idx => idx >= 0)

    // 接続している吸水管が無い場合でも、この集水管自体に折点や
    // 連結管との合流点があれば collector_change 行として登録する。
    if (connectedAbsorptionPipes.length === 0) {
      const bendIdxs = findCollectorBendVertices(collectorPipe)
      // 集水変化点として登録すべき頂点 = 「連結管との合流頂点」 + 「内部折点」
      // 上流端（idx=0）も含める。これは前段の集水管との接続点であり、
      // 表示時に「PrevA CurrC」の形で命名される。
      // 重複排除して上流→下流順に並べる。
      const changeVertexIdxs = Array.from(
        new Set([...linkJunctionVertexIdxs, ...bendIdxs]),
      ).sort((a, b) => a - b)
      if (changeVertexIdxs.length > 0) {
        const newRows: WiringRow[] = changeVertexIdxs.map(() => ({
          id: `row-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
          rowType: 'collector_change' as RowType,
          absorptionPipes: [],
          collectorPipe: collectorPipeId,
          isMergePipe: false,
          mergeSystemIndex: null,
        }))
        if (activeTabType === 'collector') {
          setCollectorTabs(prev => prev.map((tab, i) => {
            if (i !== activeCollectorIndex) return tab
            const filtered = tab.rows.filter(r =>
              r.rowType || r.absorptionPipes.length > 0 || r.collectorPipe
            )
            return { ...tab, rows: [...filtered, ...newRows] }
          }))
        } else {
          setDirectRows(prev => {
            const filtered = prev.filter(r =>
              r.rowType || r.absorptionPipes.length > 0 || r.collectorPipe
            )
            return [...filtered, ...newRows]
          })
        }
      }
      // 集水管の接続先を調べる
      const nextCollectorId = collectorPipe.connectionTo
      if (nextCollectorId) {
        const nextCollector = pipes.find(p => p.id === nextCollectorId)
        if (nextCollector) {
          // 次の集水管がある場合は確認ダイアログを表示
          setPendingCollectorPipeId(nextCollectorId)
          setIsOutletDialog(false)
          setShowContinueDialog(true)
          return
        }
      }
      // 次の集水管がない場合は落口確認ダイアログを表示
      setPendingCollectorPipeId(collectorPipeId)
      setIsOutletDialog(true)
      setShowContinueDialog(true)
      return
    }

    // 接続距離を計算して降順（遠い方から）にソート
    const sortedAbsorptionPipes = connectedAbsorptionPipes
      .map(pipe => ({
        pipe,
        distance: getConnectionDistance(pipe, collectorPipe)
      }))
      .sort((a, b) => b.distance - a.distance)

    // 集水管の各頂点ごとに、最も近い吸水管下流端点との距離を計算し、
    // 「合流が無い折点」を集水変化点として抽出する。
    const absorptionVertexSet = new Set<number>()
    {
      const cv = collectorPipe.vertices
      for (const { pipe } of sortedAbsorptionPipes) {
        const downstream = pipe.vertices[pipe.vertices.length - 1]
        let bestIdx = -1
        let bestDist = Infinity
        for (let i = 0; i < cv.length; i++) {
          const d = Math.hypot(cv[i].x - downstream.x, cv[i].y - downstream.y)
          if (d < bestDist) { bestDist = d; bestIdx = i }
        }
        if (bestIdx >= 0 && bestDist <= 0.5) absorptionVertexSet.add(bestIdx)
      }
    }
    const bendOnly = findCollectorBendVertices(collectorPipe, absorptionVertexSet)
    // 内部折点 + 連結管との合流頂点（重複排除）
    const collectorChangeVertexIdx = Array.from(
      new Set([...bendOnly, ...linkJunctionVertexIdxs]),
    )

    // 「上流→下流」順に吸水合流イベントと集水変化点イベントを統合する。
    // - 吸水合流イベントは distance（下流からの累積距離）が大きいほど上流。
    // - 集水変化点は collectorChangeVertexIdx（vertex 番号 = 上流から振った index）。
    //   下流からの累積距離に変換して比較する。
    type Event =
      | { kind: 'absorption'; pipe: PipeRow; distFromDownstream: number }
      | { kind: 'change'; vertexIdx: number; distFromDownstream: number }

    const cv2 = collectorPipe.vertices
    // 頂点 i から下流端までの累積距離（m）を事前計算
    const cumDistFromDownstream: number[] = new Array(cv2.length).fill(0)
    for (let i = cv2.length - 2; i >= 0; i--) {
      cumDistFromDownstream[i] = cumDistFromDownstream[i + 1] + calcDistance(cv2[i], cv2[i + 1])
    }

    const events: Event[] = []
    for (const { pipe, distance } of sortedAbsorptionPipes) {
      // distance は mm 単位なので m に戻す
      events.push({ kind: 'absorption', pipe, distFromDownstream: distance / 1000 })
    }
    for (const idx of collectorChangeVertexIdx) {
      events.push({ kind: 'change', vertexIdx: idx, distFromDownstream: cumDistFromDownstream[idx] })
    }
    // 上流側 = distFromDownstream が大きい → 降順で並べると上流から下流に並ぶ
    events.sort((a, b) => b.distFromDownstream - a.distFromDownstream)

    // events を行に変換するヘルパ。最初の吸水合流のみ absorption_end とする。
    const buildRowsFromEvents = (): WiringRow[] => {
      const rows: WiringRow[] = []
      let absorptionCount = 0
      for (const evt of events) {
        if (evt.kind === 'absorption') {
          const rowType: RowType = absorptionCount === 0 ? 'absorption_end' : 'absorption_merge'
          absorptionCount++
          rows.push({
            id: `row-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
            rowType,
            absorptionPipes: [evt.pipe.id],
            collectorPipe: collectorPipeId,
            isMergePipe: false,
            mergeSystemIndex: null,
          })
        } else {
          rows.push({
            id: `row-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
            rowType: 'collector_change',
            absorptionPipes: [],
            collectorPipe: collectorPipeId,
            isMergePipe: false,
            mergeSystemIndex: null,
          })
        }
      }
      return rows
    }

    // 現在のタブに行を追加（タイプを自動判別）
    if (activeTabType === 'collector') {
      setCollectorTabs(prev => {
        // 深いコピーを作成
        return prev.map((tab, i) => {
          if (i !== activeCollectorIndex) return tab

          // 現在のタブの行を処理
          let newRows = [...tab.rows]

          // 先頭の空行を削除（rowType, absorptionPipes, collectorPipeが全て空の行）
          while (newRows.length > 0) {
            const firstRow = newRows[0]
            if (!firstRow.rowType && firstRow.absorptionPipes.length === 0 && !firstRow.collectorPipe) {
              newRows.shift()
            } else {
              break
            }
          }

          newRows.push(...buildRowsFromEvents())

          return { ...tab, rows: newRows }
        })
      })
    } else {
      setDirectRows(prev => {
        let newRows = [...prev]

        // 先頭の空行を削除
        while (newRows.length > 0) {
          const firstRow = newRows[0]
          if (!firstRow.rowType && firstRow.absorptionPipes.length === 0 && !firstRow.collectorPipe) {
            newRows.shift()
          } else {
            break
          }
        }

        newRows.push(...buildRowsFromEvents())
        return newRows
      })
    }

    // 集水管の接続先を調べる
    const nextCollectorId = collectorPipe.connectionTo
    if (nextCollectorId) {
      const nextCollector = pipes.find(p => p.id === nextCollectorId)
      if (nextCollector) {
        // 次の集水管がある場合は確認ダイアログを表示
        // 現在の集水管IDを保存（次の吸水検索時に除外するため）
        setPreviousCollectorPipeId(collectorPipeId)
        setPendingCollectorPipeId(nextCollectorId)
        setIsOutletDialog(false)
        setShowContinueDialog(true)
        return
      }
    }

    // 次の集水管がない場合は落口確認ダイアログを表示
    setPreviousCollectorPipeId(collectorPipeId)
    setPendingCollectorPipeId(collectorPipeId)
    setIsOutletDialog(true)
    setShowContinueDialog(true)
  }, [pipes, activeTabType, activeCollectorIndex, getConnectionDistance, calcDistance, findCollectorBendVertices])

  // 一括設定を続行
  const continueBulkSetting = () => {
    setShowContinueDialog(false)
    if (pendingCollectorPipeId) {
      // 前の集水管IDを除外して実行（前の集水管が吸水として選択されないように）
      executeBulkSetting(pendingCollectorPipeId, previousCollectorPipeId ?? undefined)
    }
  }

  // 一括設定を終了（続けない）
  const finishBulkSetting = () => {
    setShowContinueDialog(false)
    setPendingCollectorPipeId(null)
    setPreviousCollectorPipeId(null)
    setIsOutletDialog(false)
    setSelectionMode('none')
  }

  // 落口として設定
  const setAsOutlet = () => {
    if (!pendingCollectorPipeId) return

    const collectorPipe = pipes.find(p => p.id === pendingCollectorPipeId)
    if (!collectorPipe) return

    const outletRow: WiringRow = {
      id: `row-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
      rowType: 'outlet',
      absorptionPipes: [],
      collectorPipe: pendingCollectorPipeId,
      isMergePipe: false,
      mergeSystemIndex: null,
    }

    // 落口行を追加（吸水は空、集水に最後の管路番号と下流測点を表示）
    if (activeTabType === 'collector') {
      // 深いコピーを作成
      const newTabs = collectorTabs.map((tab, i) => {
        if (i === activeCollectorIndex) {
          return { ...tab, rows: [...tab.rows, outletRow] }
        }
        return tab
      })
      setCollectorTabs(newTabs)
    } else {
      setDirectRows([...directRows, outletRow])
    }

    setShowContinueDialog(false)
    setPendingCollectorPipeId(null)
    setIsOutletDialog(false)
    setSelectionMode('none')
  }

  // 集水合流管として指定して終了
  const setAsMergePipe = () => {
    // 現在の系統の最後の集水管IDを使用（previousCollectorPipeIdが設定されていればそれを、なければpendingを使用）
    const lastCollectorPipeId = previousCollectorPipeId || pendingCollectorPipeId
    if (!lastCollectorPipeId) return

    const mergeRow: WiringRow = {
      id: `row-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
      rowType: 'collector_junction',
      absorptionPipes: [],
      collectorPipe: lastCollectorPipeId,
      isMergePipe: true,
      mergeSystemIndex: null,
    }

    // 現在のタブに区切り行（合流管）を追加
    if (activeTabType === 'collector') {
      // 深いコピーを作成
      const newTabs = collectorTabs.map((tab, i) => {
        if (i === activeCollectorIndex) {
          return { ...tab, rows: [...tab.rows, mergeRow, createEmptyRow()] }
        }
        return tab
      })
      setCollectorTabs(newTabs)
    } else {
      setDirectRows([...directRows, mergeRow, createEmptyRow()])
    }

    setShowContinueDialog(false)
    setPendingCollectorPipeId(null)
    setPreviousCollectorPipeId(null)
    setSelectionMode('none')
  }

  // 空の行を作成
  function createEmptyRow(): WiringRow {
    return {
      id: `row-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
      rowType: null,
      absorptionPipes: [],
      collectorPipe: null,
      isMergePipe: false,
      mergeSystemIndex: null,
    }
  }

  // 集水暗渠タブを追加
  const addCollectorTab = () => {
    // 既存のタブ名から使用中の番号を抽出
    const usedNumbers = new Set<number>()
    collectorTabs.forEach(tab => {
      const match = tab.name.match(/^集水暗渠(\d+)$/)
      if (match) {
        usedNumbers.add(parseInt(match[1], 10))
      }
    })

    // 使われていない最小の番号を見つける
    let newNumber = 1
    while (usedNumbers.has(newNumber)) {
      newNumber++
    }

    const currentLength = collectorTabs.length
    const newTab: CollectorTab = {
      id: `collector-${Date.now()}`,
      name: `集水暗渠${newNumber}`,
      rows: [createEmptyRow()],
    }
    // 新しいタブを追加
    setCollectorTabs([...collectorTabs, newTab])
    // 新しいタブのインデックスを設定（状態更新後に実行されるようにsetTimeoutで遅延）
    setTimeout(() => {
      setActiveCollectorIndex(currentLength)
    }, 0)
  }

  // 集水暗渠タブを削除
  const removeCollectorTab = (index: number) => {
    if (collectorTabs.length <= 1) return
    const newTabs = collectorTabs.filter((_, i) => i !== index)
    setCollectorTabs(newTabs)
    // インデックス調整（状態更新後に実行されるようにsetTimeoutで遅延）
    if (activeCollectorIndex >= newTabs.length) {
      setTimeout(() => {
        setActiveCollectorIndex(newTabs.length - 1)
      }, 0)
    }
  }

  // 行を挿入（指定した行の前に挿入）
  const insertRowBefore = (tabType: TabType, rowId: string, tabIndex?: number) => {
    if (tabType === 'collector' && tabIndex !== undefined) {
      const rowIndex = collectorTabs[tabIndex].rows.findIndex(r => r.id === rowId)
      if (rowIndex >= 0) {
        // 深いコピーを作成
        const newTabs = collectorTabs.map((tab, i) => {
          if (i === tabIndex) {
            const newRows = [...tab.rows]
            newRows.splice(rowIndex, 0, createEmptyRow())
            return { ...tab, rows: newRows }
          }
          return tab
        })
        setCollectorTabs(newTabs)
      }
    } else if (tabType === 'direct') {
      const rowIndex = directRows.findIndex(r => r.id === rowId)
      if (rowIndex >= 0) {
        const newRows = [...directRows]
        newRows.splice(rowIndex, 0, createEmptyRow())
        setDirectRows(newRows)
      }
    }
  }

  // 行を削除
  const removeRow = (tabType: TabType, rowId: string, tabIndex?: number) => {
    if (tabType === 'collector' && tabIndex !== undefined) {
      if (collectorTabs[tabIndex].rows.length <= 1) return
      // 深いコピーを作成
      const newTabs = collectorTabs.map((tab, i) => {
        if (i === tabIndex) {
          return { ...tab, rows: tab.rows.filter((r) => r.id !== rowId) }
        }
        return tab
      })
      setCollectorTabs(newTabs)
    } else if (tabType === 'direct') {
      if (directRows.length <= 1) return
      setDirectRows(directRows.filter((r) => r.id !== rowId))
    }
    // 削除した行が選択中だった場合は選択解除
    if (selectedRowId === rowId) {
      setSelectionMode('none')
      setSelectedRowId(null)
    }
  }

  // 系統を追加（現在の系統リストの最後に新しい空の系統を追加）
  const addSystem = () => {
    if (activeTabType === 'collector') {
      // 深いコピーを作成
      const newTabs = collectorTabs.map((tab, i) => {
        if (i === activeCollectorIndex) {
          return { ...tab, rows: [...tab.rows, createEmptyRow()] }
        }
        return tab
      })
      setCollectorTabs(newTabs)
    } else {
      setDirectRows([...directRows, createEmptyRow()])
    }
  }

  // 系統を削除（指定した系統の全行を削除）
  const removeSystem = (systemRowIds: string[]) => {
    if (systemRowIds.length === 0) return

    if (activeTabType === 'collector') {
      // 深いコピーを作成
      const newTabs = collectorTabs.map((tab, i) => {
        if (i === activeCollectorIndex) {
          let newRows = tab.rows.filter(r => !systemRowIds.includes(r.id))
          // 全て削除された場合は空の行を追加
          if (newRows.length === 0) {
            newRows = [createEmptyRow()]
          }
          return { ...tab, rows: newRows }
        }
        return tab
      })
      setCollectorTabs(newTabs)
    } else {
      let newRows = directRows.filter(r => !systemRowIds.includes(r.id))
      // 全て削除された場合は空の行を追加
      if (newRows.length === 0) {
        newRows = [createEmptyRow()]
      }
      setDirectRows(newRows)
    }
    // 削除した行に選択中のものがあれば選択解除
    if (selectedRowId && systemRowIds.includes(selectedRowId)) {
      setSelectionMode('none')
      setSelectedRowId(null)
    }
  }

  // 吸水の選択を開始
  const startAbsorptionSelection = (rowId: string) => {
    if (selectionMode === 'absorption' && selectedRowId === rowId) {
      // すでに選択中なら解除
      setSelectionMode('none')
      setSelectedRowId(null)
    } else {
      setSelectionMode('absorption')
      setSelectedRowId(rowId)
    }
  }

  // 集水の選択を開始
  const startCollectorSelection = (rowId: string) => {
    if (selectionMode === 'collector' && selectedRowId === rowId) {
      // すでに選択中なら解除
      setSelectionMode('none')
      setSelectedRowId(null)
    } else {
      setSelectionMode('collector')
      setSelectedRowId(rowId)
    }
  }

  // 地図上の管路がクリックされた時
  const handlePipeSelect = useCallback((pipeId: string, ctrlKey?: boolean) => {
    // 一括設定モード: 末端吸水を選択
    if (selectionMode === 'bulk-start') {
      const selectedPipe = pipes.find(p => p.id === pipeId)
      if (!selectedPipe) return

      // 選択した管の接続先を取得
      const collectorPipeId = selectedPipe.connectionTo
      if (!collectorPipeId) {
        alert('選択した管路に接続先が設定されていません')
        return
      }

      const collectorPipe = pipes.find(p => p.id === collectorPipeId)
      if (!collectorPipe) {
        alert('接続先の管路が見つかりません')
        return
      }

      // 最初の行を追加（選択した末端吸水 + その接続先）
      const firstRow: WiringRow = {
        id: `row-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
        rowType: 'absorption_end',
        absorptionPipes: [pipeId],
        collectorPipe: collectorPipeId,
        isMergePipe: false,
        mergeSystemIndex: null,
      }

      if (activeTabType === 'collector') {
        // 深いコピーを作成
        const newTabs = collectorTabs.map((tab, i) => {
          if (i === activeCollectorIndex) {
            return { ...tab, rows: [...tab.rows, firstRow] }
          }
          return tab
        })
        setCollectorTabs(newTabs)
      } else {
        setDirectRows([...directRows, firstRow])
      }

      // 同じ接続先を持つ他の管路を追加（最初に追加した管路は除外）
      setSelectionMode('none')
      executeBulkSetting(collectorPipeId, pipeId)
      return
    }

    if (selectionMode === 'none' || !selectedRowId) return

    if (selectionMode === 'absorption') {
      // 現在の行のインデックスと次の行IDを先に計算
      const rows = activeTabType === 'collector'
        ? collectorTabs[activeCollectorIndex]?.rows || []
        : directRows
      const currentIndex = rows.findIndex(r => r.id === selectedRowId)
      const nextRowId = currentIndex >= 0 && currentIndex < rows.length - 1
        ? rows[currentIndex + 1].id
        : null

      // 吸水に追加
      if (activeTabType === 'collector') {
        // 深いコピーを作成
        const newTabs = collectorTabs.map((tab, i) => {
          if (i === activeCollectorIndex) {
            return {
              ...tab,
              rows: tab.rows.map(row => {
                if (row.id === selectedRowId && !row.absorptionPipes.includes(pipeId)) {
                  return { ...row, absorptionPipes: [...row.absorptionPipes, pipeId] }
                }
                return row
              })
            }
          }
          return tab
        })
        setCollectorTabs(newTabs)
      } else {
        const newRows = directRows.map(row => {
          if (row.id === selectedRowId && !row.absorptionPipes.includes(pipeId)) {
            return { ...row, absorptionPipes: [...row.absorptionPipes, pipeId] }
          }
          return row
        })
        setDirectRows(newRows)
      }

      // Ctrlキーが押されていなければ次の行に移動
      if (!ctrlKey) {
        if (nextRowId) {
          setSelectedRowId(nextRowId)
        } else {
          // 最後の行の場合は新しい行を作成してそこに移動
          const newRow = createEmptyRow()
          if (activeTabType === 'collector') {
            // 深いコピーを作成
            const newTabs = collectorTabs.map((tab, i) => {
              if (i === activeCollectorIndex) {
                return { ...tab, rows: [...tab.rows, newRow] }
              }
              return tab
            })
            setCollectorTabs(newTabs)
          } else {
            setDirectRows([...directRows, newRow])
          }
          setSelectedRowId(newRow.id)
        }
      }
    } else if (selectionMode === 'collector') {
      // 集水に設定（1つのみ）
      if (activeTabType === 'collector') {
        // 深いコピーを作成
        const newTabs = collectorTabs.map((tab, i) => {
          if (i === activeCollectorIndex) {
            return {
              ...tab,
              rows: tab.rows.map(row => {
                if (row.id === selectedRowId) {
                  return { ...row, collectorPipe: row.collectorPipe === pipeId ? null : pipeId }
                }
                return row
              })
            }
          }
          return tab
        })
        setCollectorTabs(newTabs)
      } else {
        const newRows = directRows.map(row => {
          if (row.id === selectedRowId) {
            return { ...row, collectorPipe: row.collectorPipe === pipeId ? null : pipeId }
          }
          return row
        })
        setDirectRows(newRows)
      }
      // 集水選択後は選択モード解除
      setSelectionMode('none')
      setSelectedRowId(null)
    }
  }, [selectionMode, selectedRowId, activeTabType, activeCollectorIndex, collectorTabs, directRows, pipes, executeBulkSetting])

  // 吸水から管を削除
  const removeAbsorptionPipe = (rowId: string, pipeId: string, tabIndex?: number) => {
    if (activeTabType === 'collector' && tabIndex !== undefined) {
      // 深いコピーを作成
      const newTabs = collectorTabs.map((tab, i) => {
        if (i === tabIndex) {
          return {
            ...tab,
            rows: tab.rows.map(row => {
              if (row.id === rowId) {
                return { ...row, absorptionPipes: row.absorptionPipes.filter(id => id !== pipeId) }
              }
              return row
            })
          }
        }
        return tab
      })
      setCollectorTabs(newTabs)
    } else {
      const newRows = directRows.map(row => {
        if (row.id === rowId) {
          return { ...row, absorptionPipes: row.absorptionPipes.filter(id => id !== pipeId) }
        }
        return row
      })
      setDirectRows(newRows)
    }
  }

  // 集水を削除
  const clearCollectorPipe = (rowId: string, tabIndex?: number) => {
    if (activeTabType === 'collector' && tabIndex !== undefined) {
      // 深いコピーを作成
      const newTabs = collectorTabs.map((tab, i) => {
        if (i === tabIndex) {
          return {
            ...tab,
            rows: tab.rows.map(row => {
              if (row.id === rowId) {
                return { ...row, collectorPipe: null }
              }
              return row
            })
          }
        }
        return tab
      })
      setCollectorTabs(newTabs)
    } else {
      const newRows = directRows.map(row => {
        if (row.id === rowId) {
          return { ...row, collectorPipe: null }
        }
        return row
      })
      setDirectRows(newRows)
    }
  }

  // 管路番号を取得
  const getPipeNumber = useCallback((pipeId: string) => {
    const pipe = pipes.find(p => p.id === pipeId)
    return pipe?.number || pipeId
  }, [pipes])

  // 管路の頂点から測点名を生成するヘルパー
  // vertexIndex=0 → C（最上流）
  // vertexIndex=totalVertices-1 → A（最下流）
  // それ以外 → B{i}（中間点、下流から順。vertexIndex が下流側ほど小さい番号）
  const generatePointName = useCallback((pipeNumber: string, vertexIndex: number, totalVertices: number): string => {
    if (vertexIndex === 0) {
      return `${pipeNumber}C` // 最上流
    } else if (vertexIndex === totalVertices - 1) {
      return `${pipeNumber}A` // 最下流
    } else {
      // 中間点: 下流から順に B1, B2, ...（PipeCoordinateCalcPage と同じ規則）
      const middleIndex = totalVertices - 1 - vertexIndex
      return `${pipeNumber}B${middleIndex}`
    }
  }, [])

  // 前の管の下流端と一致する、次の管の頂点インデックスを検出
  // 一致が見つからなければ 0（従来通りの C）を返す
  const findMatchingVertexIndex = useCallback(
    (nextPipe: PipeRow, endVertex: PipeVertex): number => {
      if (nextPipe.vertices.length === 0) return 0
      const EPS = 1e-4
      for (let i = 0; i < nextPipe.vertices.length; i++) {
        const v = nextPipe.vertices[i]
        if (Math.abs(v.x - endVertex.x) < EPS && Math.abs(v.y - endVertex.y) < EPS) {
          return i
        }
      }
      return 0
    },
    [],
  )

  // 吸水管と集水管の接続測点名を取得（常に接続元の下流端末番号）
  const getConnectionPointName = useCallback((absorptionPipeIds: string[], collectorPipeId: string | null): string | null => {
    if (!collectorPipeId || absorptionPipeIds.length === 0) return null

    // 最初の吸水管の下流点を使用（接続元の下流端末番号）
    const absorptionPipe = pipes.find(p => p.id === absorptionPipeIds[0])
    if (!absorptionPipe || absorptionPipe.vertices.length === 0) return null

    // 常に吸水管の下流測点名を返す
    return generatePointName(
      absorptionPipe.number,
      absorptionPipe.vertices.length - 1,
      absorptionPipe.vertices.length
    )
  }, [pipes, generatePointName])

  // 集水合流管の接続測点名を取得（集水管の下流点）
  const getMergePointName = useCallback((collectorPipeId: string | null): string | null => {
    if (!collectorPipeId) return null

    const collectorPipe = pipes.find(p => p.id === collectorPipeId)
    if (!collectorPipe || collectorPipe.vertices.length === 0) return null

    // 集水管の下流点（最後の構成点）の測点名を返す
    return generatePointName(
      collectorPipe.number,
      collectorPipe.vertices.length - 1,
      collectorPipe.vertices.length
    )
  }, [pipes, generatePointName])

  // 集水管上の測点名を取得（行タイプと前後の管路関係に基づく）
  // rowType: 行タイプ
  // collectorPipeId: 現在の行の集水管ID
  // prevCollectorPipeId: 前の行の集水管ID（管の切り替わり判定用）
  // collectorChangeIndex: 同一集水管内で N 番目（0 始まり）の collector_change 行であるか
  const getCollectorPointName = useCallback((
    rowType: RowType | null,
    collectorPipeId: string | null,
    prevCollectorPipeId: string | null,
    collectorChangeIndex?: number,
  ): string | null => {
    if (!collectorPipeId) return null

    const collectorPipe = pipes.find(p => p.id === collectorPipeId)
    if (!collectorPipe || collectorPipe.vertices.length === 0) return null

    // 吸水端部: 集水管の最上流点（C）
    if (rowType === 'absorption_end') {
      return generatePointName(collectorPipe.number, 0, collectorPipe.vertices.length)
    }

    // 落口: 落口管の下流端（A）
    if (rowType === 'outlet') {
      return generatePointName(collectorPipe.number, collectorPipe.vertices.length - 1, collectorPipe.vertices.length)
    }

    // 集水合流点: 集水管の下流端（A）
    if (rowType === 'collector_junction') {
      return generatePointName(collectorPipe.number, collectorPipe.vertices.length - 1, collectorPipe.vertices.length)
    }

    // 集水変化点: 同一集水管における出現順 = vertex index に対応
    //   index=0 → vertex 0（C）= 前管との合流点。「PrevA CurrC」形式
    //   index>0 → 内部頂点（B{n}）あるいは下流端
    if (rowType === 'collector_change' && collectorChangeIndex !== undefined) {
      const vIdx = collectorChangeIndex
      if (vIdx === 0 && prevCollectorPipeId && prevCollectorPipeId !== collectorPipeId) {
        // 前管との合流点：結合名で返す
        const prevPipe = pipes.find(p => p.id === prevCollectorPipeId)
        const prevEndPointName = prevPipe && prevPipe.vertices.length > 0
          ? generatePointName(prevPipe.number, prevPipe.vertices.length - 1, prevPipe.vertices.length)
          : null
        const prevEndVertex = prevPipe && prevPipe.vertices.length > 0
          ? prevPipe.vertices[prevPipe.vertices.length - 1]
          : null
        const newStartIndex = prevEndVertex
          ? findMatchingVertexIndex(collectorPipe, prevEndVertex)
          : 0
        const newStartPointName = generatePointName(
          collectorPipe.number,
          newStartIndex,
          collectorPipe.vertices.length,
        )
        if (prevEndPointName) return `${prevEndPointName} ${newStartPointName}`
        return newStartPointName
      }
      // それ以外（同管内の頂点）→ 該当する vertex の名前
      if (vIdx >= 0 && vIdx < collectorPipe.vertices.length) {
        return generatePointName(collectorPipe.number, vIdx, collectorPipe.vertices.length)
      }
      return null
    }

    // 吸水合流・集水合流: 管が変わる場合のみ「PrevA CurrC」形式、それ以外は無名
    if (rowType === 'absorption_merge' || rowType === 'collector_merge') {
      if (prevCollectorPipeId && prevCollectorPipeId !== collectorPipeId) {
        const prevPipe = pipes.find(p => p.id === prevCollectorPipeId)
        const prevEndPointName = prevPipe && prevPipe.vertices.length > 0
          ? generatePointName(prevPipe.number, prevPipe.vertices.length - 1, prevPipe.vertices.length)
          : null
        const prevEndVertex = prevPipe && prevPipe.vertices.length > 0
          ? prevPipe.vertices[prevPipe.vertices.length - 1]
          : null
        const newStartIndex = prevEndVertex
          ? findMatchingVertexIndex(collectorPipe, prevEndVertex)
          : 0
        const newStartPointName = generatePointName(collectorPipe.number, newStartIndex, collectorPipe.vertices.length)
        if (prevEndPointName) return `${prevEndPointName} ${newStartPointName}`
        return newStartPointName
      } else {
        return null
      }
    }

    // その他
    return null
  }, [pipes, generatePointName, findMatchingVertexIndex])

  // 前の行の集水管下流端の測点名を取得（管が変わる場合のセパレータ行用）
  const getPrevCollectorEndPointName = useCallback((prevCollectorPipeId: string | null): string | null => {
    if (!prevCollectorPipeId) return null

    const prevCollectorPipe = pipes.find(p => p.id === prevCollectorPipeId)
    if (!prevCollectorPipe || prevCollectorPipe.vertices.length === 0) return null

    // 前の集水管の下流端（A）
    return generatePointName(prevCollectorPipe.number, prevCollectorPipe.vertices.length - 1, prevCollectorPipe.vertices.length)
  }, [pipes, generatePointName])

  // 行タイプの選択肢
  const rowTypeOptions: { value: RowType; label: string }[] = [
    { value: 'absorption_end', label: '吸水端部' },
    { value: 'absorption_merge', label: '吸水合流' },
    { value: 'collector_merge', label: '集水合流' },
    { value: 'collector_change', label: '集水変化点' },
    { value: 'collector_junction', label: '集水合流点' },
    { value: 'outlet', label: '落口' },
  ]

  // 吸水列を非表示・選択不可にするタイプ
  const hideAbsorptionTypes: RowType[] = ['collector_junction', 'collector_change', 'outlet']

  // 行タイプを変更
  const updateRowType = useCallback((rowId: string, newType: RowType | null, tabIndex?: number) => {
    // 集水合流に変更する場合はabsorptionPipesをクリアして系統選択を促す
    const shouldClearAbsorption = newType === 'collector_merge'

    if (activeTabType === 'collector' && tabIndex !== undefined) {
      // 深いコピーを作成
      const newTabs = collectorTabs.map((tab, i) => {
        if (i === tabIndex) {
          return {
            ...tab,
            rows: tab.rows.map(row =>
              row.id === rowId
                ? { ...row, rowType: newType, ...(shouldClearAbsorption ? { absorptionPipes: [] } : {}) }
                : row
            )
          }
        }
        return tab
      })
      setCollectorTabs(newTabs)
    } else {
      const newRows = directRows.map(row =>
        row.id === rowId
          ? { ...row, rowType: newType, ...(shouldClearAbsorption ? { absorptionPipes: [] } : {}) }
          : row
      )
      setDirectRows(newRows)
    }
  }, [activeTabType, collectorTabs, directRows, setCollectorTabs, setDirectRows])

  // 現在のタブのデータ
  const currentRows = useMemo(() => {
    if (activeTabType === 'collector') {
      return collectorTabs[activeCollectorIndex]?.rows || []
    }
    return directRows
  }, [activeTabType, activeCollectorIndex, collectorTabs, directRows])

  // 系統ごとにグループ化（吸水から始まり、落口or合流管で終わる）
  interface SystemGroup {
    id: string
    systemIndex: number
    rows: WiringRow[]
    endType: 'outlet' | 'merge' | 'open' // 落口、合流管、未完（設定中）
  }

  const systemGroups = useMemo((): SystemGroup[] => {
    const groups: SystemGroup[] = []
    let currentGroup: WiringRow[] = []
    let systemIndex = 1

    for (const row of currentRows) {
      currentGroup.push(row)

      // 落口行の場合（rowTypeで判定）
      if (row.rowType === 'outlet') {
        groups.push({
          id: `system-${systemIndex}`,
          systemIndex,
          rows: [...currentGroup],
          endType: 'outlet'
        })
        currentGroup = []
        systemIndex++
        continue
      }

      // 集水合流点行の場合（rowTypeで判定）
      if (row.rowType === 'collector_junction') {
        groups.push({
          id: `system-${systemIndex}`,
          systemIndex,
          rows: [...currentGroup],
          endType: 'merge'
        })
        currentGroup = []
        systemIndex++
        continue
      }
    }

    // 残りの行があれば未完系統として追加
    if (currentGroup.length > 0) {
      groups.push({
        id: `system-${systemIndex}`,
        systemIndex,
        rows: currentGroup,
        endType: 'open'
      })
    }

    return groups
  }, [currentRows])

  // 表示用の行タイプ
  type DisplayRowType = 'data' | 'pipe-separator'

  interface DisplayRow {
    type: DisplayRowType
    row?: WiringRow  // データ行の場合
    rowIndex?: number  // データ行の系統内インデックス
    prevCollectorPipeId?: string | null  // 前の行の集水管ID
    /**
     * collector_change 行で、同一集水管の N 番目（0 始まり）であることを示す。
     * 0 番目は前段集水管との合流点（PrevA CurrC 形式の表示）、
     * 1 番目以降は集水管の内部頂点（順番に C, B{n}, A...）に対応。
     */
    collectorChangeIndex?: number
    pipeNumber?: string  // セパレータ行の場合の管番号
    pipeId?: string  // セパレータ行の場合の管ID
    currentPipeEndPointName?: string | null  // セパレータ行: 現在の管の下流端名（S4A）
    nextPipeStartPointName?: string | null  // セパレータ行: 次の管の上流端名（S3C）
  }

  // 次の管の接続点測点名を取得
  // 前の管の下流端と一致する頂点を検出して命名（CAD解析で測点分割した場合 C 以外と接続し得る）
  const getNextCollectorStartPointName = useCallback((
    nextCollectorPipeId: string | null,
    prevCollectorPipeId?: string | null,
  ): string | null => {
    if (!nextCollectorPipeId) return null

    const nextCollectorPipe = pipes.find(p => p.id === nextCollectorPipeId)
    if (!nextCollectorPipe || nextCollectorPipe.vertices.length === 0) return null

    // 前管の下流端が分かる場合は、その座標に一致する頂点を検出
    if (prevCollectorPipeId) {
      const prevPipe = pipes.find(p => p.id === prevCollectorPipeId)
      if (prevPipe && prevPipe.vertices.length > 0) {
        const endVertex = prevPipe.vertices[prevPipe.vertices.length - 1]
        const idx = findMatchingVertexIndex(nextCollectorPipe, endVertex)
        return generatePointName(nextCollectorPipe.number, idx, nextCollectorPipe.vertices.length)
      }
    }

    // 前管が未指定の場合は C を返す（従来動作）
    return generatePointName(nextCollectorPipe.number, 0, nextCollectorPipe.vertices.length)
  }, [pipes, generatePointName, findMatchingVertexIndex])

  // 系統ごとに表示用の行データを生成（各吸水行の後にセパレータ行を挿入、ただし最終行は除く）
  const buildDisplayRows = useCallback((rows: WiringRow[]): DisplayRow[] => {
    const displayRows: DisplayRow[] = []

    // 同一集水管における collector_change 行の出現回数カウンタ
    const collectorChangeCounters = new Map<string, number>()

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      const isLastRow = i === rows.length - 1
      const prevRow = i > 0 ? rows[i - 1] : null
      const prevCollectorPipeId = prevRow?.collectorPipe || null

      let collectorChangeIndex: number | undefined = undefined
      if (row.rowType === 'collector_change' && row.collectorPipe) {
        collectorChangeIndex = collectorChangeCounters.get(row.collectorPipe) ?? 0
        collectorChangeCounters.set(row.collectorPipe, collectorChangeIndex + 1)
      }

      // データ行を追加
      displayRows.push({
        type: 'data',
        row,
        rowIndex: i,
        prevCollectorPipeId,
        collectorChangeIndex,
      })

      // 各データ行の後にセパレータ行を挿入（集水管がある場合、ただし最終行は除く）
      if (row.collectorPipe && !isLastRow) {
        const nextRow = rows[i + 1]
        const nextCollectorPipeId = nextRow?.collectorPipe || null
        const isPipeChanging = nextCollectorPipeId && nextCollectorPipeId !== row.collectorPipe

        const pipe = pipes.find(p => p.id === row.collectorPipe)

        // 管が変わる場合: 現在の管の下流端名と次の管の上流端名を取得
        const currentPipeEndPointName = isPipeChanging
          ? getPrevCollectorEndPointName(row.collectorPipe)
          : null
        const nextPipeStartPointName = isPipeChanging
          ? getNextCollectorStartPointName(nextCollectorPipeId, row.collectorPipe)
          : null

        displayRows.push({
          type: 'pipe-separator',
          pipeNumber: pipe?.number || row.collectorPipe,
          pipeId: row.collectorPipe,
          currentPipeEndPointName,
          nextPipeStartPointName
        })
      }
    }

    return displayRows
  }, [pipes, getPrevCollectorEndPointName, getNextCollectorStartPointName])

  // 指定した系統の末尾の集水管の下流端点名を返す（例: S6A）
  const getSystemEndPointName = useCallback((systemIndex: number): string | null => {
    const group = systemGroups.find(g => g.systemIndex === systemIndex)
    if (!group || group.rows.length === 0) return null
    const lastRow = group.rows[group.rows.length - 1]
    if (!lastRow.collectorPipe) return null
    const pipe = pipes.find(p => p.id === lastRow.collectorPipe)
    if (!pipe || pipe.vertices.length === 0) return null
    return generatePointName(pipe.number, pipe.vertices.length - 1, pipe.vertices.length)
  }, [systemGroups, pipes, generatePointName])

  // 吸水に登録済みの系統（自系統を除く）を取得
  // 集水合流タイプで選択可能な系統を返す
  const getAvailableSystemsForMerge = useCallback((currentSystemIndex: number): { systemIndex: number; label: string }[] => {
    const systems: { systemIndex: number; label: string }[] = []

    for (const group of systemGroups) {
      // 自系統を除外
      if (group.systemIndex === currentSystemIndex) continue
      // 完了済み系統（落口または合流）のみ選択可能
      if (group.endType === 'outlet' || group.endType === 'merge') {
        const endName = getSystemEndPointName(group.systemIndex)
        const endSuffix = group.endType === 'outlet' ? '（落口）' : '（合流）'
        const nameSuffix = endName ? ` → ${endName}` : ''
        systems.push({
          systemIndex: group.systemIndex,
          label: `系統${group.systemIndex}${endSuffix}${nameSuffix}`
        })
      }
    }

    return systems
  }, [systemGroups, getSystemEndPointName])

  // 右列のラベル
  const rightColumnLabel = activeTabType === 'collector' ? '集水' : '落口'

  // 地図用の測点データ（管路の頂点から生成）
  const mapSurveyPoints: SurveyPointData[] = useMemo(() => {
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

  // 管切り替え点のデータ（地図上で〇マーカー表示用）
  const pipeChangePoints: PipeChangePoint[] = useMemo(() => {
    const points: PipeChangePoint[] = []

    // 全タブ・全系統から管切り替え点を収集
    const allRows: WiringRow[] = []
    for (const tab of collectorTabs) {
      allRows.push(...tab.rows)
    }
    allRows.push(...directRows)

    // 各行を順に見て、管が切り替わる箇所を検出
    for (let i = 1; i < allRows.length; i++) {
      const currentRow = allRows[i]
      const prevRow = allRows[i - 1]

      // 前の行と現在の行の両方に集水管が設定されていて、異なる管の場合
      if (prevRow.collectorPipe && currentRow.collectorPipe && prevRow.collectorPipe !== currentRow.collectorPipe) {
        // 前の管の下流端点の座標を取得
        const prevPipe = pipes.find(p => p.id === prevRow.collectorPipe)
        if (prevPipe && prevPipe.vertices.length > 0) {
          const endVertex = prevPipe.vertices[prevPipe.vertices.length - 1]

          // ラベルを生成（S4A S3C形式）
          const prevEndPointName = generatePointName(prevPipe.number, prevPipe.vertices.length - 1, prevPipe.vertices.length)
          const nextPipe = pipes.find(p => p.id === currentRow.collectorPipe)
          // 次管のどの頂点が前管の下流端と一致するかを検出（CAD解析で測点を分割した場合に C 以外と接続し得る）
          const nextStartPointName = nextPipe && nextPipe.vertices.length > 0
            ? generatePointName(
                nextPipe.number,
                findMatchingVertexIndex(nextPipe, endVertex),
                nextPipe.vertices.length,
              )
            : ''

          points.push({
            x: endVertex.x,
            y: endVertex.y,
            label: `${prevEndPointName} ${nextStartPointName}`.trim()
          })
        }
      }
    }

    return points
  }, [collectorTabs, directRows, pipes, generatePointName, findMatchingVertexIndex])

  // 現在選択中の行の吸水管路IDs（地図上でハイライト用）
  const selectedAbsorptionPipes = useMemo(() => {
    if (!selectedRowId) return new Set<string>()
    const row = currentRows.find(r => r.id === selectedRowId)
    if (!row) return new Set<string>()
    return new Set(row.absorptionPipes)
  }, [selectedRowId, currentRows])

  // 現在選択中の行の集水管路ID
  const selectedCollectorPipe = useMemo(() => {
    if (!selectedRowId) return null
    const row = currentRows.find(r => r.id === selectedRowId)
    return row?.collectorPipe || null
  }, [selectedRowId, currentRows])

  // 全タブの全行から選択済みの管路IDを収集（地図上で黄色表示用）
  const allAssignedPipeIds = useMemo(() => {
    const ids = new Set<string>()
    // 全ての集水暗渠タブ
    for (const tab of collectorTabs) {
      for (const row of tab.rows) {
        row.absorptionPipes.forEach(id => ids.add(id))
        if (row.collectorPipe) ids.add(row.collectorPipe)
      }
    }
    // 直落暗渠
    for (const row of directRows) {
      row.absorptionPipes.forEach(id => ids.add(id))
      if (row.collectorPipe) ids.add(row.collectorPipe)
    }
    return ids
  }, [collectorTabs, directRows])

  return (
    <div className="h-full flex flex-col">
      {/* ヘッダー */}
      <div className="p-4 border-b bg-white flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2">
            <Cable className="h-5 w-5" />
            配管系統
          </h1>
          <p className="text-sm text-muted-foreground">
            吸水から集水管接続・落口までの系統を設定（地図上の管路をクリックして選択）
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* 再読み込みボタン */}
          {selectionMode === 'none' && (
            <>
              {wiringLoading ? (
                <div className="flex items-center gap-2 px-4 py-2 text-slate-400">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  読み込み中...
                </div>
              ) : (
                <button
                  onClick={() => currentFarm && fetchWiring(currentFarm.id, true)}
                  disabled={wiringSaving}
                  className="flex items-center gap-2 px-3 py-2 text-slate-600 border rounded-lg hover:bg-slate-50 transition-colors disabled:opacity-50"
                  title="データを再読み込み"
                >
                  <RefreshCw className="h-4 w-4" />
                </button>
              )}
            </>
          )}

          {/* 選択モード表示 */}
          {selectionMode !== 'none' && (
            <div className={`px-4 py-2 rounded-lg flex items-center gap-2 ${
              selectionMode === 'absorption'
                ? 'bg-blue-100 text-blue-700 border border-blue-300'
                : selectionMode === 'bulk-start'
                  ? 'bg-purple-100 text-purple-700 border border-purple-300'
                  : 'bg-green-100 text-green-700 border border-green-300'
            }`}>
              <MousePointer className="h-4 w-4" />
              <span className="font-medium">
                {selectionMode === 'absorption'
                  ? '吸水を選択中（Ctrl+クリックで複数追加）'
                  : selectionMode === 'bulk-start'
                    ? '末端の吸水管を選択してください'
                    : '集水/落口を選択中'}
              </span>
              <button
                onClick={() => {
                  if (selectionMode === 'bulk-start') {
                    cancelBulkSetting()
                  } else {
                    setSelectionMode('none')
                    setSelectedRowId(null)
                  }
                }}
                className="ml-2 p-1 hover:bg-white/50 rounded"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          )}
        </div>
      </div>

      {/* メインコンテンツ */}
      <div className="flex-1 flex overflow-hidden">
        {/* 左側: 配線テーブル */}
        <div className="w-1/2 flex flex-col overflow-hidden border-r">
          {/* タブヘッダー */}
          <div className="border-b bg-white flex items-center">
            {/* 集水暗渠タブ */}
            {collectorTabs.map((tab, index) => (
              <div
                key={tab.id}
                className={`relative group flex items-center ${
                  activeTabType === 'collector' && activeCollectorIndex === index
                    ? 'bg-blue-50'
                    : ''
                }`}
              >
                <button
                  onClick={() => {
                    setActiveTabType('collector')
                    setActiveCollectorIndex(index)
                    setSelectionMode('none')
                    setSelectedRowId(null)
                  }}
                  className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                    activeTabType === 'collector' && activeCollectorIndex === index
                      ? 'border-blue-600 text-blue-600'
                      : 'border-transparent text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {tab.name}
                </button>
                {collectorTabs.length > 1 && (
                  <button
                    onClick={() => removeCollectorTab(index)}
                    className="absolute -top-1 -right-1 p-0.5 bg-red-500 text-white rounded-full opacity-0 group-hover:opacity-100 transition-opacity"
                    title="タブを削除"
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </div>
            ))}
            {/* タブ追加ボタン */}
            <button
              onClick={addCollectorTab}
              className="px-3 py-3 text-slate-400 hover:text-blue-600 hover:bg-blue-50 transition-colors"
              title="集水暗渠タブを追加"
            >
              <Plus className="h-4 w-4" />
            </button>
            {/* 区切り */}
            <div className="border-l h-8 mx-2" />
            {/* 直落暗渠タブ */}
            <button
              onClick={() => {
                setActiveTabType('direct')
                setSelectionMode('none')
                setSelectedRowId(null)
              }}
              className={`px-4 py-3 text-sm font-medium border-b-2 transition-colors ${
                activeTabType === 'direct'
                  ? 'border-orange-600 text-orange-600'
                  : 'border-transparent text-slate-600 hover:text-slate-900'
              }`}
            >
              直落暗渠
            </button>
          </div>

          {/* テーブル（系統ごとにブロック分け） */}
          <div className="flex-1 overflow-auto p-2 space-y-4">
            {systemGroups.map((group) => (
              <div key={group.id} className="border rounded-lg overflow-hidden bg-white shadow-sm">
                {/* 系統ヘッダー */}
                <div className={`px-3 py-2 font-medium text-sm flex items-center gap-2 ${
                  group.endType === 'outlet'
                    ? 'bg-orange-100 text-orange-800 border-b border-orange-200'
                    : group.endType === 'merge'
                      ? 'bg-purple-100 text-purple-800 border-b border-purple-200'
                      : 'bg-slate-100 text-slate-700 border-b border-slate-200'
                }`}>
                  <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-white text-xs font-bold">
                    {group.systemIndex}
                  </span>
                  <span className="flex-1">
                    系統 {group.systemIndex}
                    {group.endType === 'outlet' && ' （落口）'}
                    {group.endType === 'merge' && ' （合流）'}
                    {group.endType === 'open' && ' （設定中）'}
                  </span>
                  {/* 一括設定ボタン */}
                  {selectionMode === 'none' && (
                    <button
                      onClick={startBulkSetting}
                      className="flex items-center gap-1 px-2 py-1 bg-purple-600 text-white rounded hover:bg-purple-700 transition-colors text-xs"
                      title="一括設定"
                    >
                      <Zap className="h-3 w-3" />
                      一括設定
                    </button>
                  )}
                  {/* 系統削除ボタン */}
                  <button
                    onClick={() => removeSystem(group.rows.map(r => r.id))}
                    className="p-1 rounded hover:bg-white/50 text-red-600 hover:text-red-700"
                    title="この系統を削除"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>

                {/* 系統内テーブル */}
                <table className="w-full text-sm">
                  <thead className="bg-slate-50">
                    <tr>
                      <th className="px-2 py-1 text-center font-medium text-slate-600 border-r w-24 text-xs">
                        タイプ
                      </th>
                      <th className="px-2 py-1 text-center font-medium text-blue-700 border-r text-xs">
                        吸水
                      </th>
                      <th className={`px-2 py-1 text-center font-medium text-xs ${
                        activeTabType === 'collector' ? 'text-green-700' : 'text-orange-700'
                      }`}>
                        {rightColumnLabel}
                      </th>
                      <th className="px-1 py-1 w-8"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {buildDisplayRows(group.rows).map((displayRow, displayIndex) => {
                      // セパレータ行（配管番号のみ表示）
                      if (displayRow.type === 'pipe-separator') {
                        return (
                          <tr key={`sep-${displayRow.pipeId}-${displayIndex}`} className="bg-green-50 h-6">
                            <td className="px-1 py-0.5 border-r"></td>
                            <td className="px-1 py-0.5 border-r"></td>
                            <td className="px-1 py-0.5">
                              <span className={`text-xs font-medium ${
                                activeTabType === 'collector' ? 'text-green-700' : 'text-orange-700'
                              }`}>
                                {displayRow.pipeNumber}
                              </span>
                            </td>
                            <td className="px-1 py-0.5"></td>
                          </tr>
                        )
                      }

                      // データ行
                      const row = displayRow.row!
                      const isAbsorptionSelecting = selectionMode === 'absorption' && selectedRowId === row.id
                      const isCollectorSelecting = selectionMode === 'collector' && selectedRowId === row.id
                      // 吸水を非表示・選択不可にするタイプかどうか
                      const shouldHideAbsorption = row.rowType && hideAbsorptionTypes.includes(row.rowType)
                      // 集水合流タイプかどうか
                      const isCollectorMerge = row.rowType === 'collector_merge'
                      // 選択可能な系統リスト（集水合流タイプ用）
                      const availableSystems = isCollectorMerge ? getAvailableSystemsForMerge(group.systemIndex) : []

                      // 集水管の測点名を取得（行タイプと前後の管路関係に基づく）
                      const collectorPointName = row.collectorPipe
                        ? getCollectorPointName(
                            row.rowType,
                            row.collectorPipe,
                            displayRow.prevCollectorPipeId || null,
                            displayRow.collectorChangeIndex,
                          )
                        : null

                      return (
                        <tr key={row.id} className={`hover:bg-slate-50 h-9 ${
                          selectedRowId === row.id ? 'bg-yellow-50' : ''
                        }`}>
                          {/* タイプ列 */}
                          <td className="px-1 py-1 border-r">
                            <select
                              value={row.rowType || ''}
                              onChange={(e) => updateRowType(
                                row.id,
                                e.target.value as RowType || null,
                                activeTabType === 'collector' ? activeCollectorIndex : undefined
                              )}
                              className="w-full text-xs py-0.5 px-1 border rounded bg-white"
                            >
                              <option value="">-</option>
                              {rowTypeOptions.map(opt => (
                                <option key={opt.value} value={opt.value}>{opt.label}</option>
                              ))}
                            </select>
                          </td>
                          {/* 吸水列 */}
                          <td className="px-1 py-1 border-r">
                            {shouldHideAbsorption ? (
                              // 集水合流点・集水変化点・落口は吸水非表示
                              <span className="text-xs text-slate-400">-</span>
                            ) : isCollectorMerge ? (
                              // 集水合流タイプ: 登録済みの他系統を選択
                              <div className="flex flex-wrap gap-0.5 items-center">
                                {row.absorptionPipes.length > 0 && (
                                  <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-purple-100 text-purple-800 rounded text-xs">
                                    系統{row.absorptionPipes[0]}
                                    {(() => {
                                      const sysIdx = parseInt(row.absorptionPipes[0])
                                      if (isNaN(sysIdx)) return null
                                      const endName = getSystemEndPointName(sysIdx)
                                      return endName ? (
                                        <span className="ml-1 text-purple-600">→ {endName}</span>
                                      ) : null
                                    })()}
                                    <button
                                      onClick={() => {
                                        // 系統IDを削除（深いコピーを作成）
                                        if (activeTabType === 'collector') {
                                          const newTabs = collectorTabs.map((tab, i) => {
                                            if (i === activeCollectorIndex) {
                                              return {
                                                ...tab,
                                                rows: tab.rows.map(r => r.id === row.id ? { ...r, absorptionPipes: [] } : r)
                                              }
                                            }
                                            return tab
                                          })
                                          setCollectorTabs(newTabs)
                                        } else {
                                          const newRows = directRows.map(r => r.id === row.id ? { ...r, absorptionPipes: [] } : r)
                                          setDirectRows(newRows)
                                        }
                                      }}
                                      className="hover:text-red-600"
                                    >
                                      <X className="h-3 w-3" />
                                    </button>
                                  </span>
                                )}
                                {row.absorptionPipes.length === 0 && (
                                  <select
                                    value=""
                                    onChange={(e) => {
                                      const selectedSystemIndex = e.target.value
                                      if (!selectedSystemIndex) return
                                      // 系統インデックスをabsorptionPipesに格納（深いコピーを作成）
                                      if (activeTabType === 'collector') {
                                        const newTabs = collectorTabs.map((tab, i) => {
                                          if (i === activeCollectorIndex) {
                                            return {
                                              ...tab,
                                              rows: tab.rows.map(r => r.id === row.id ? { ...r, absorptionPipes: [selectedSystemIndex] } : r)
                                            }
                                          }
                                          return tab
                                        })
                                        setCollectorTabs(newTabs)
                                      } else {
                                        const newRows = directRows.map(r => r.id === row.id ? { ...r, absorptionPipes: [selectedSystemIndex] } : r)
                                        setDirectRows(newRows)
                                      }
                                    }}
                                    className="text-xs py-0.5 px-1 border rounded bg-white"
                                  >
                                    <option value="">系統を選択...</option>
                                    {availableSystems.map(sys => (
                                      <option key={sys.systemIndex} value={sys.systemIndex.toString()}>
                                        {sys.label}
                                      </option>
                                    ))}
                                  </select>
                                )}
                              </div>
                            ) : (
                              // 通常の吸水選択
                              <div className="flex flex-wrap gap-0.5 items-center">
                                {row.absorptionPipes.map(pipeId => (
                                  <span
                                    key={pipeId}
                                    className="inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-blue-100 text-blue-800 rounded text-xs"
                                  >
                                    {getPipeNumber(pipeId)}
                                    <button
                                      onClick={() => removeAbsorptionPipe(
                                        row.id,
                                        pipeId,
                                        activeTabType === 'collector' ? activeCollectorIndex : undefined
                                      )}
                                      className="hover:text-red-600"
                                    >
                                      <X className="h-3 w-3" />
                                    </button>
                                  </span>
                                ))}
                                <button
                                  onClick={() => startAbsorptionSelection(row.id)}
                                  className={`px-1.5 py-0.5 text-xs rounded border transition-colors ${
                                    isAbsorptionSelecting
                                      ? 'bg-blue-600 text-white border-blue-600'
                                      : 'border-blue-300 text-blue-600 hover:bg-blue-50'
                                  }`}
                                >
                                  {isAbsorptionSelecting ? '選択中' : '+'}
                                </button>
                                {/* 接続点名を吸水列の右端に表示 */}
                                {row.collectorPipe && row.absorptionPipes.length > 0 && (
                                  <span className="text-xs text-slate-500 ml-1">
                                    {getConnectionPointName(row.absorptionPipes, row.collectorPipe) || '-'}
                                  </span>
                                )}
                              </div>
                            )}
                          </td>
                          {/* 集水列 - 測点名を表示 */}
                          <td className="px-1 py-1">
                            <div className="flex items-center gap-1">
                              {row.collectorPipe ? (
                                <>
                                  {/* 集水合流点の場合は下流測点を表示 */}
                                  {row.rowType === 'collector_junction' ? (
                                    <span className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-xs bg-purple-100 text-purple-800`}>
                                      {getMergePointName(row.collectorPipe)}
                                      <button
                                        onClick={() => clearCollectorPipe(
                                          row.id,
                                          activeTabType === 'collector' ? activeCollectorIndex : undefined
                                        )}
                                        className="hover:text-red-600"
                                      >
                                        <X className="h-3 w-3" />
                                      </button>
                                    </span>
                                  ) : (
                                    // 通常の行: 測点名を表示（ある場合）
                                    <span className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-xs ${
                                      activeTabType === 'collector'
                                        ? 'bg-green-100 text-green-800'
                                        : 'bg-orange-100 text-orange-800'
                                    }`}>
                                      {collectorPointName || '-'}
                                      <button
                                        onClick={() => clearCollectorPipe(
                                          row.id,
                                          activeTabType === 'collector' ? activeCollectorIndex : undefined
                                        )}
                                        className="hover:text-red-600"
                                      >
                                        <X className="h-3 w-3" />
                                      </button>
                                    </span>
                                  )}
                                  {/* 落口タイプの場合のみ落口情報を表示 */}
                                  {row.rowType === 'outlet' && (
                                    <span className="text-xs text-orange-500">
                                      → {getMergePointName(row.collectorPipe)} (落口)
                                    </span>
                                  )}
                                </>
                              ) : (
                                <button
                                  onClick={() => startCollectorSelection(row.id)}
                                  className={`px-1.5 py-0.5 text-xs rounded border transition-colors ${
                                    isCollectorSelecting
                                      ? (activeTabType === 'collector'
                                          ? 'bg-green-600 text-white border-green-600'
                                          : 'bg-orange-600 text-white border-orange-600')
                                      : (activeTabType === 'collector'
                                          ? 'border-green-300 text-green-600 hover:bg-green-50'
                                          : 'border-orange-300 text-orange-600 hover:bg-orange-50')
                                  }`}
                                >
                                  {isCollectorSelecting ? '選択中' : '選択'}
                                </button>
                              )}
                            </div>
                          </td>
                          {/* 行操作ボタン */}
                          <td className="px-1 py-1 text-center">
                            <div className="flex items-center gap-0.5">
                              <button
                                onClick={() =>
                                  insertRowBefore(
                                    activeTabType,
                                    row.id,
                                    activeTabType === 'collector' ? activeCollectorIndex : undefined
                                  )
                                }
                                className="p-0.5 text-blue-400 hover:text-blue-600 hover:bg-blue-50 rounded"
                                title="この行の前に挿入"
                              >
                                <PlusCircle className="h-3.5 w-3.5" />
                              </button>
                              <button
                                onClick={() =>
                                  removeRow(
                                    activeTabType,
                                    row.id,
                                    activeTabType === 'collector' ? activeCollectorIndex : undefined
                                  )
                                }
                                className="p-0.5 text-red-400 hover:text-red-600 hover:bg-red-50 rounded"
                                title="行を削除"
                                disabled={currentRows.length <= 1}
                              >
                                <X className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
                {/* 行追加ボタン（各系統内） */}
                <div className="px-2 py-1.5 bg-slate-50 border-t">
                  <button
                    onClick={() => {
                      // 系統の最後の行の後に新しい行を挿入
                      const lastRow = group.rows[group.rows.length - 1]
                      if (!lastRow) return

                      const newRow = createEmptyRow()

                      if (activeTabType === 'collector') {
                        // 深いコピーを作成
                        const newTabs = collectorTabs.map((tab, i) => {
                          if (i === activeCollectorIndex) {
                            const lastRowIndex = tab.rows.findIndex(r => r.id === lastRow.id)
                            let newRows: WiringRow[]
                            if (lastRowIndex >= 0) {
                              newRows = [
                                ...tab.rows.slice(0, lastRowIndex + 1),
                                newRow,
                                ...tab.rows.slice(lastRowIndex + 1)
                              ]
                            } else {
                              newRows = [...tab.rows, newRow]
                            }
                            return { ...tab, rows: newRows }
                          }
                          return tab
                        })
                        setCollectorTabs(newTabs)
                      } else {
                        const lastRowIndex = directRows.findIndex(r => r.id === lastRow.id)
                        let newRows: WiringRow[]
                        if (lastRowIndex >= 0) {
                          newRows = [
                            ...directRows.slice(0, lastRowIndex + 1),
                            newRow,
                            ...directRows.slice(lastRowIndex + 1)
                          ]
                        } else {
                          newRows = [...directRows, newRow]
                        }
                        setDirectRows(newRows)
                      }
                    }}
                    className="flex items-center gap-1 px-2 py-1 text-xs text-blue-600 hover:bg-blue-50 rounded"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    行を追加
                  </button>
                </div>
              </div>
            ))}
          </div>

          {/* 系統追加ボタン */}
          <div className="p-2 border-t bg-white flex items-center gap-2">
            <button
              onClick={addSystem}
              className="flex items-center gap-1 px-3 py-1.5 text-sm text-green-600 hover:bg-green-50 rounded border border-green-200"
            >
              <PlusCircle className="h-4 w-4" />
              系統を追加
            </button>
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
              <MapIcon className="h-4 w-4" />
              座標
            </button>
          </div>
          {/* 地図 */}
          <div className="flex-1">
            <PipeMap
              showLabels={showLabels}
              showDirection={showDirection}
              showSurveyPoints={showSurveyPoints}
              surveyPoints={mapSurveyPoints}
              showZones={showZones}
              showCoordinates={showCoordinates}
              onPipeSelect={handlePipeSelect}
              selectedPipeId={selectedCollectorPipe}
              selectedPipeIds={selectedAbsorptionPipes}
              assignedPipeIds={allAssignedPipeIds}
              isBulkEditMode={selectionMode !== 'none'}
              pipeChangePoints={pipeChangePoints}
              focusedPipeId={showContinueDialog ? pendingCollectorPipeId : null}
            />
          </div>
        </div>
      </div>

      {/* 続けるか確認ダイアログ / 落口確認ダイアログ */}
      {showContinueDialog && pendingCollectorPipeId && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl p-6 w-[420px]">
            {isOutletDialog ? (
              <>
                <h3 className="text-lg font-bold mb-4">落口を設定しますか？</h3>
                <p className="text-sm text-muted-foreground mb-4">
                  管路「<span className="font-medium text-orange-700">{getPipeNumber(pendingCollectorPipeId)}</span>」の
                  下流端（<span className="font-medium">{getMergePointName(pendingCollectorPipeId)}</span>）を
                  落口として設定しますか？
                </p>
                <div className="flex flex-col gap-2">
                  <button
                    onClick={setAsOutlet}
                    className="w-full px-4 py-2.5 text-sm bg-orange-600 text-white rounded hover:bg-orange-700 flex items-center justify-center gap-2"
                  >
                    <Target className="h-4 w-4" />
                    落口として設定
                  </button>
                  <button
                    onClick={finishBulkSetting}
                    className="w-full px-4 py-2 text-sm border rounded hover:bg-gray-50"
                  >
                    設定せずに終了
                  </button>
                </div>
              </>
            ) : (
              <>
                <h3 className="text-lg font-bold mb-4">接続先の処理を続けますか？</h3>
                <p className="text-sm text-muted-foreground mb-4">
                  次の接続先「<span className="font-medium text-purple-700">{getPipeNumber(pendingCollectorPipeId)}</span>」について、
                  どのように処理しますか？
                </p>
                <div className="flex flex-col gap-2">
                  <button
                    onClick={continueBulkSetting}
                    className="w-full px-4 py-2.5 text-sm bg-purple-600 text-white rounded hover:bg-purple-700 flex items-center justify-center gap-2"
                  >
                    <Zap className="h-4 w-4" />
                    続ける（同様の処理を実行）
                  </button>
                  <button
                    onClick={setAsMergePipe}
                    className="w-full px-4 py-2.5 text-sm bg-purple-100 text-purple-700 border border-purple-300 rounded hover:bg-purple-200 flex items-center justify-center gap-2"
                  >
                    <GitMerge className="h-4 w-4" />
                    集水合流管として指定
                  </button>
                  <button
                    onClick={finishBulkSetting}
                    className="w-full px-4 py-2 text-sm border rounded hover:bg-gray-50"
                  >
                    終了する
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

    </div>
  )
}
