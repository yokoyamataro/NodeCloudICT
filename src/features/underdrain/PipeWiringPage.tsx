import { useState, useMemo, useEffect, useCallback } from 'react'
import {
  Cable,
  Plus,
  X,
  Hash,
  Navigation,
  Target,
  Square,
  Map,
  MousePointer,
  Zap,
  GitMerge,
  Save,
  Loader2,
  RefreshCw,
} from 'lucide-react'
import { useUnderdrainStore, type PipeRow } from '@/stores/underdrainStore'
import { useCoordinateStore } from '@/stores/coordinateStore'
import { useProjectStore } from '@/stores/projectStore'
import { usePipeWiringStore, type CollectorTab, type WiringRow } from '@/stores/pipeWiringStore'
import { PipeMap, type SurveyPointData } from '@/components/map/PipeMap'
import type { PipeVertex } from '@/types/database'

// タブの種類
type TabType = 'collector' | 'direct'

// 選択モード
type SelectionMode = 'none' | 'absorption' | 'collector' | 'bulk-start'

export function PipeWiringPage() {
  const { pipes, fetchPipes } = useUnderdrainStore()
  const { fetchCoordinates } = useCoordinateStore()
  const { currentProject } = useProjectStore()
  const {
    collectorTabs,
    directRows,
    setCollectorTabs,
    setDirectRows,
    fetchWiring,
    saveWiring,
    loading: wiringLoading,
    saving: wiringSaving,
    hasChanges,
  } = usePipeWiringStore()

  // プロジェクト選択時にデータを読み込む
  useEffect(() => {
    if (currentProject) {
      fetchPipes(currentProject.id)
      fetchCoordinates(currentProject.id)
      fetchWiring(currentProject.id)
    }
  }, [currentProject, fetchPipes, fetchCoordinates, fetchWiring])

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
  const [showContinueDialog, setShowContinueDialog] = useState(false) // 続けるか確認ダイアログ

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
    setShowContinueDialog(false)
  }

  // 一括設定を実行（集水管に対して吸水を追加）
  const executeBulkSetting = useCallback((collectorPipeId: string) => {
    const collectorPipe = pipes.find(p => p.id === collectorPipeId)
    if (!collectorPipe) return

    // この集水管を接続先としている吸水管を検索
    const connectedAbsorptionPipes = pipes.filter(p => p.connectionTo === collectorPipeId)

    if (connectedAbsorptionPipes.length === 0) {
      // 接続している管がない場合は終了
      cancelBulkSetting()
      return
    }

    // 接続距離を計算して降順（遠い方から）にソート
    const sortedAbsorptionPipes = connectedAbsorptionPipes
      .map(pipe => ({
        pipe,
        distance: getConnectionDistance(pipe, collectorPipe)
      }))
      .sort((a, b) => b.distance - a.distance)

    // 現在のタブに行を追加
    if (activeTabType === 'collector') {
      setCollectorTabs(prev => {
        const newTabs = [...prev]
        const currentTab = newTabs[activeCollectorIndex]

        // 各吸水管を距離の大きい順に新しい行として追加
        for (const { pipe } of sortedAbsorptionPipes) {
          const newRow: WiringRow = {
            id: `row-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
            absorptionPipes: [pipe.id],
            collectorPipe: collectorPipeId,
            isMergePipe: false,
          }
          currentTab.rows.push(newRow)
        }

        return newTabs
      })
    } else {
      setDirectRows(prev => {
        const newRows = [...prev]
        for (const { pipe } of sortedAbsorptionPipes) {
          const newRow: WiringRow = {
            id: `row-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
            absorptionPipes: [pipe.id],
            collectorPipe: collectorPipeId,
            isMergePipe: false,
          }
          newRows.push(newRow)
        }
        return newRows
      })
    }

    // 集水管の接続先を調べる
    const nextCollectorId = collectorPipe.connectionTo
    if (nextCollectorId) {
      const nextCollector = pipes.find(p => p.id === nextCollectorId)
      if (nextCollector) {
        // 次の集水管がある場合は確認ダイアログを表示
        setPendingCollectorPipeId(nextCollectorId)
        setShowContinueDialog(true)
        return
      }
    }

    // 次の集水管がない場合は終了
    cancelBulkSetting()
  }, [pipes, activeTabType, activeCollectorIndex, getConnectionDistance])

  // 一括設定を続行
  const continueBulkSetting = () => {
    setShowContinueDialog(false)
    if (pendingCollectorPipeId) {
      executeBulkSetting(pendingCollectorPipeId)
    }
  }

  // 一括設定を終了（続けない）
  const finishBulkSetting = () => {
    setShowContinueDialog(false)
    setPendingCollectorPipeId(null)
    setSelectionMode('none')
  }

  // 集水合流管として指定して終了
  const setAsMergePipe = () => {
    if (!pendingCollectorPipeId) return

    // 現在のタブに区切り行（合流管）を追加
    if (activeTabType === 'collector') {
      setCollectorTabs(prev => {
        const newTabs = [...prev]
        const currentTab = newTabs[activeCollectorIndex]

        // 合流管行を追加
        const mergeRow: WiringRow = {
          id: `row-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
          absorptionPipes: [],
          collectorPipe: pendingCollectorPipeId,
          isMergePipe: true,
        }
        currentTab.rows.push(mergeRow)

        // 新しい空行を追加（次のセクションの開始）
        currentTab.rows.push(createEmptyRow())

        return newTabs
      })
    } else {
      setDirectRows(prev => {
        const newRows = [...prev]
        const mergeRow: WiringRow = {
          id: `row-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
          absorptionPipes: [],
          collectorPipe: pendingCollectorPipeId,
          isMergePipe: true,
        }
        newRows.push(mergeRow)
        newRows.push(createEmptyRow())
        return newRows
      })
    }

    setShowContinueDialog(false)
    setPendingCollectorPipeId(null)
    setSelectionMode('none')
  }

  // 手動で集水合流管を追加
  const addMergePipeRow = () => {
    if (activeTabType === 'collector') {
      const mergeRowId = `row-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`

      setCollectorTabs(prev => {
        const newTabs = [...prev]
        const currentTab = newTabs[activeCollectorIndex]

        // 合流管行を追加（集水管は後で選択）
        const mergeRow: WiringRow = {
          id: mergeRowId,
          absorptionPipes: [],
          collectorPipe: null,
          isMergePipe: true,
        }
        currentTab.rows.push(mergeRow)

        // 新しい空行を追加
        currentTab.rows.push(createEmptyRow())

        return newTabs
      })

      // 合流管の選択モードに入る
      setSelectionMode('collector')
      setSelectedRowId(mergeRowId)
    }
  }

  // 空の行を作成
  function createEmptyRow(): WiringRow {
    return {
      id: `row-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
      absorptionPipes: [],
      collectorPipe: null,
      isMergePipe: false,
    }
  }

  // 集水暗渠タブを追加
  const addCollectorTab = () => {
    const newIndex = collectorTabs.length + 1
    const newTab: CollectorTab = {
      id: `collector-${Date.now()}`,
      name: `集水暗渠${newIndex}`,
      rows: [createEmptyRow()],
    }
    setCollectorTabs([...collectorTabs, newTab])
    setActiveCollectorIndex(collectorTabs.length)
  }

  // 集水暗渠タブを削除
  const removeCollectorTab = (index: number) => {
    if (collectorTabs.length <= 1) return
    const newTabs = collectorTabs.filter((_, i) => i !== index)
    setCollectorTabs(newTabs)
    if (activeCollectorIndex >= newTabs.length) {
      setActiveCollectorIndex(newTabs.length - 1)
    }
  }

  // 行を追加
  const addRow = (tabType: TabType, tabIndex?: number) => {
    if (tabType === 'collector' && tabIndex !== undefined) {
      const newTabs = [...collectorTabs]
      newTabs[tabIndex].rows.push(createEmptyRow())
      setCollectorTabs(newTabs)
    } else if (tabType === 'direct') {
      setDirectRows([...directRows, createEmptyRow()])
    }
  }

  // 行を削除
  const removeRow = (tabType: TabType, rowId: string, tabIndex?: number) => {
    if (tabType === 'collector' && tabIndex !== undefined) {
      const newTabs = [...collectorTabs]
      if (newTabs[tabIndex].rows.length <= 1) return
      newTabs[tabIndex].rows = newTabs[tabIndex].rows.filter((r) => r.id !== rowId)
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
      if (activeTabType === 'collector') {
        setCollectorTabs(prev => {
          const newTabs = [...prev]
          const currentTab = newTabs[activeCollectorIndex]

          // 最初の行：選択した末端吸水とその接続先
          const firstRow: WiringRow = {
            id: `row-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
            absorptionPipes: [pipeId],
            collectorPipe: collectorPipeId,
            isMergePipe: false,
          }
          currentTab.rows.push(firstRow)

          return newTabs
        })
      } else {
        setDirectRows(prev => {
          const newRows = [...prev]
          const firstRow: WiringRow = {
            id: `row-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
            absorptionPipes: [pipeId],
            collectorPipe: collectorPipeId,
            isMergePipe: false,
          }
          newRows.push(firstRow)
          return newRows
        })
      }

      // 同じ接続先を持つ他の管路を追加
      setSelectionMode('none')
      executeBulkSetting(collectorPipeId)
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
        setCollectorTabs(prev => {
          const newTabs = [...prev]
          const row = newTabs[activeCollectorIndex].rows.find(r => r.id === selectedRowId)
          if (row && !row.absorptionPipes.includes(pipeId)) {
            row.absorptionPipes = [...row.absorptionPipes, pipeId]
          }
          return newTabs
        })
      } else {
        setDirectRows(prev => {
          const newRows = [...prev]
          const row = newRows.find(r => r.id === selectedRowId)
          if (row && !row.absorptionPipes.includes(pipeId)) {
            row.absorptionPipes = [...row.absorptionPipes, pipeId]
          }
          return newRows
        })
      }

      // Ctrlキーが押されていなければ次の行に移動
      if (!ctrlKey) {
        if (nextRowId) {
          setSelectedRowId(nextRowId)
        } else {
          // 最後の行の場合は新しい行を作成してそこに移動
          const newRow = createEmptyRow()
          if (activeTabType === 'collector') {
            setCollectorTabs(prev => {
              const newTabs = [...prev]
              newTabs[activeCollectorIndex].rows.push(newRow)
              return newTabs
            })
          } else {
            setDirectRows(prev => [...prev, newRow])
          }
          setSelectedRowId(newRow.id)
        }
      }
    } else if (selectionMode === 'collector') {
      // 集水に設定（1つのみ）
      if (activeTabType === 'collector') {
        setCollectorTabs(prev => {
          const newTabs = [...prev]
          const row = newTabs[activeCollectorIndex].rows.find(r => r.id === selectedRowId)
          if (row) {
            row.collectorPipe = row.collectorPipe === pipeId ? null : pipeId
          }
          return newTabs
        })
      } else {
        setDirectRows(prev => {
          const newRows = [...prev]
          const row = newRows.find(r => r.id === selectedRowId)
          if (row) {
            row.collectorPipe = row.collectorPipe === pipeId ? null : pipeId
          }
          return newRows
        })
      }
      // 集水選択後は選択モード解除
      setSelectionMode('none')
      setSelectedRowId(null)
    }
  }, [selectionMode, selectedRowId, activeTabType, activeCollectorIndex, collectorTabs, directRows, pipes, executeBulkSetting])

  // 吸水から管を削除
  const removeAbsorptionPipe = (rowId: string, pipeId: string, tabIndex?: number) => {
    if (activeTabType === 'collector' && tabIndex !== undefined) {
      setCollectorTabs(prev => {
        const newTabs = [...prev]
        const row = newTabs[tabIndex].rows.find(r => r.id === rowId)
        if (row) {
          row.absorptionPipes = row.absorptionPipes.filter(id => id !== pipeId)
        }
        return newTabs
      })
    } else {
      setDirectRows(prev => {
        const newRows = [...prev]
        const row = newRows.find(r => r.id === rowId)
        if (row) {
          row.absorptionPipes = row.absorptionPipes.filter(id => id !== pipeId)
        }
        return newRows
      })
    }
  }

  // 集水を削除
  const clearCollectorPipe = (rowId: string, tabIndex?: number) => {
    if (activeTabType === 'collector' && tabIndex !== undefined) {
      setCollectorTabs(prev => {
        const newTabs = [...prev]
        const row = newTabs[tabIndex].rows.find(r => r.id === rowId)
        if (row) {
          row.collectorPipe = null
        }
        return newTabs
      })
    } else {
      setDirectRows(prev => {
        const newRows = [...prev]
        const row = newRows.find(r => r.id === rowId)
        if (row) {
          row.collectorPipe = null
        }
        return newRows
      })
    }
  }

  // 管路番号を取得
  const getPipeNumber = useCallback((pipeId: string) => {
    const pipe = pipes.find(p => p.id === pipeId)
    return pipe?.number || pipeId
  }, [pipes])

  // 現在のタブのデータ
  const currentRows = useMemo(() => {
    if (activeTabType === 'collector') {
      return collectorTabs[activeCollectorIndex]?.rows || []
    }
    return directRows
  }, [activeTabType, activeCollectorIndex, collectorTabs, directRows])

  // 右列のラベル
  const rightColumnLabel = activeTabType === 'collector' ? '集水' : '落口'

  // 地図用の測点データ
  const mapSurveyPoints: SurveyPointData[] = useMemo(() => {
    return []
  }, [])

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
            管路設定
          </h1>
          <p className="text-sm text-muted-foreground">
            管路の配線パターンを設定（地図上の管路をクリックして選択）
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* 保存ボタン */}
          {selectionMode === 'none' && (
            <>
              {wiringLoading ? (
                <div className="flex items-center gap-2 px-4 py-2 text-slate-400">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  読み込み中...
                </div>
              ) : (
                <>
                  <button
                    onClick={() => currentProject && fetchWiring(currentProject.id)}
                    disabled={wiringSaving}
                    className="flex items-center gap-2 px-3 py-2 text-slate-600 border rounded-lg hover:bg-slate-50 transition-colors disabled:opacity-50"
                    title="データを再読み込み"
                  >
                    <RefreshCw className="h-4 w-4" />
                  </button>
                  <button
                    onClick={saveWiring}
                    disabled={wiringSaving || !hasChanges}
                    className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${
                      hasChanges
                        ? 'bg-blue-600 text-white hover:bg-blue-700'
                        : 'bg-slate-200 text-slate-400 cursor-not-allowed'
                    }`}
                  >
                    {wiringSaving ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Save className="h-4 w-4" />
                    )}
                    {wiringSaving ? '保存中...' : '保存'}
                  </button>
                </>
              )}
            </>
          )}

          {/* 一括設定ボタン */}
          {selectionMode === 'none' && !wiringLoading && (
            <button
              onClick={startBulkSetting}
              className="flex items-center gap-2 px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors"
            >
              <Zap className="h-4 w-4" />
              一括設定
            </button>
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

          {/* テーブル */}
          <div className="flex-1 overflow-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-100 sticky top-0 z-10">
                <tr>
                  <th className="px-3 py-2 text-center font-medium text-blue-700 border-r w-1/2">
                    吸水
                  </th>
                  <th className={`px-3 py-2 text-center font-medium w-1/2 ${
                    activeTabType === 'collector' ? 'text-green-700' : 'text-orange-700'
                  }`}>
                    {rightColumnLabel}
                  </th>
                  <th className="px-3 py-2 w-10"></th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {currentRows.map((row, rowIndex) => {
                  const isAbsorptionSelecting = selectionMode === 'absorption' && selectedRowId === row.id
                  const isCollectorSelecting = selectionMode === 'collector' && selectedRowId === row.id
                  const prevRow = rowIndex > 0 ? currentRows[rowIndex - 1] : null
                  const showDivider = prevRow?.isMergePipe

                  // 合流管行の場合は特別な表示
                  if (row.isMergePipe) {
                    return (
                      <tr key={row.id} className="bg-purple-50 border-b-4 border-purple-400">
                        <td colSpan={2} className="px-2 py-3 text-center">
                          <div className="flex items-center justify-center gap-2">
                            <GitMerge className="h-4 w-4 text-purple-600" />
                            <span className="font-medium text-purple-700">集水合流管：</span>
                            {row.collectorPipe ? (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 bg-purple-200 text-purple-800 rounded text-xs">
                                {getPipeNumber(row.collectorPipe)}
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
                              <button
                                onClick={() => startCollectorSelection(row.id)}
                                className={`px-2 py-1 text-xs rounded border transition-colors ${
                                  isCollectorSelecting
                                    ? 'bg-purple-600 text-white border-purple-600'
                                    : 'border-purple-300 text-purple-600 hover:bg-purple-100'
                                }`}
                              >
                                {isCollectorSelecting ? '選択中...' : '選択'}
                              </button>
                            )}
                          </div>
                        </td>
                        <td className="px-1 py-2 text-center">
                          <button
                            onClick={() =>
                              removeRow(
                                activeTabType,
                                row.id,
                                activeTabType === 'collector' ? activeCollectorIndex : undefined
                              )
                            }
                            className="p-1 text-red-400 hover:text-red-600 hover:bg-red-50 rounded"
                            title="行を削除"
                          >
                            <X className="h-4 w-4" />
                          </button>
                        </td>
                      </tr>
                    )
                  }

                  return (
                    <tr key={row.id} className={`hover:bg-slate-50 ${
                      selectedRowId === row.id ? 'bg-yellow-50' : ''
                    } ${showDivider ? 'border-t-4 border-purple-200' : ''}`}>
                      {/* 吸水列 */}
                      <td className="px-2 py-2 border-r">
                        <div className="flex flex-wrap gap-1 min-h-[32px] items-center">
                          {row.absorptionPipes.map(pipeId => (
                            <span
                              key={pipeId}
                              className="inline-flex items-center gap-1 px-2 py-0.5 bg-blue-100 text-blue-800 rounded text-xs"
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
                            className={`px-2 py-1 text-xs rounded border transition-colors ${
                              isAbsorptionSelecting
                                ? 'bg-blue-600 text-white border-blue-600'
                                : 'border-blue-300 text-blue-600 hover:bg-blue-50'
                            }`}
                          >
                            {isAbsorptionSelecting ? '選択中...' : '+ 追加'}
                          </button>
                        </div>
                      </td>
                      {/* 集水列 */}
                      <td className="px-2 py-2">
                        <div className="flex items-center gap-1 min-h-[32px]">
                          {row.collectorPipe ? (
                            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs ${
                              activeTabType === 'collector'
                                ? 'bg-green-100 text-green-800'
                                : 'bg-orange-100 text-orange-800'
                            }`}>
                              {getPipeNumber(row.collectorPipe)}
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
                            <button
                              onClick={() => startCollectorSelection(row.id)}
                              className={`px-2 py-1 text-xs rounded border transition-colors ${
                                isCollectorSelecting
                                  ? (activeTabType === 'collector'
                                      ? 'bg-green-600 text-white border-green-600'
                                      : 'bg-orange-600 text-white border-orange-600')
                                  : (activeTabType === 'collector'
                                      ? 'border-green-300 text-green-600 hover:bg-green-50'
                                      : 'border-orange-300 text-orange-600 hover:bg-orange-50')
                              }`}
                            >
                              {isCollectorSelecting ? '選択中...' : '選択'}
                            </button>
                          )}
                        </div>
                      </td>
                      {/* 削除ボタン */}
                      <td className="px-1 py-2 text-center">
                        <button
                          onClick={() =>
                            removeRow(
                              activeTabType,
                              row.id,
                              activeTabType === 'collector' ? activeCollectorIndex : undefined
                            )
                          }
                          className="p-1 text-red-400 hover:text-red-600 hover:bg-red-50 rounded"
                          title="行を削除"
                          disabled={currentRows.length <= 1}
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {/* 行追加ボタン */}
          <div className="p-2 border-t bg-white flex items-center gap-2">
            <button
              onClick={() =>
                addRow(
                  activeTabType,
                  activeTabType === 'collector' ? activeCollectorIndex : undefined
                )
              }
              className="flex items-center gap-1 px-3 py-1.5 text-sm text-blue-600 hover:bg-blue-50 rounded"
            >
              <Plus className="h-4 w-4" />
              行を追加
            </button>
            {activeTabType === 'collector' && (
              <button
                onClick={addMergePipeRow}
                className="flex items-center gap-1 px-3 py-1.5 text-sm text-purple-600 hover:bg-purple-50 rounded border border-purple-200"
              >
                <GitMerge className="h-4 w-4" />
                集水合流管に接続
              </button>
            )}
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
              <Map className="h-4 w-4" />
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
            />
          </div>
        </div>
      </div>

      {/* 続けるか確認ダイアログ */}
      {showContinueDialog && pendingCollectorPipeId && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl p-6 w-[420px]">
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
          </div>
        </div>
      )}
    </div>
  )
}
