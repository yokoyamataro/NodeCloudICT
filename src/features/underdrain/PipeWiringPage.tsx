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
} from 'lucide-react'
import { useUnderdrainStore } from '@/stores/underdrainStore'
import { useCoordinateStore } from '@/stores/coordinateStore'
import { useProjectStore } from '@/stores/projectStore'
import { PipeMap, type SurveyPointData } from '@/components/map/PipeMap'

// タブの種類
type TabType = 'collector' | 'direct'

// 選択モード
type SelectionMode = 'none' | 'absorption' | 'collector'

// 集水暗渠タブ
interface CollectorTab {
  id: string
  name: string
  rows: WiringRow[]
}

// 配線行（吸水1列＋集水1列）
interface WiringRow {
  id: string
  absorptionPipes: string[]  // 吸水（複数選択可能）
  collectorPipe: string | null    // 集水（または落口）
}

export function PipeWiringPage() {
  const { pipes, fetchPipes } = useUnderdrainStore()
  const { fetchCoordinates } = useCoordinateStore()
  const { currentProject } = useProjectStore()

  // プロジェクト選択時にデータを読み込む
  useEffect(() => {
    if (currentProject) {
      fetchPipes(currentProject.id)
      fetchCoordinates(currentProject.id)
    }
  }, [currentProject, fetchPipes, fetchCoordinates])

  // タブ管理
  const [activeTabType, setActiveTabType] = useState<TabType>('collector')
  const [activeCollectorIndex, setActiveCollectorIndex] = useState(0)

  // 集水暗渠タブ（複数追加可能）
  const [collectorTabs, setCollectorTabs] = useState<CollectorTab[]>([
    {
      id: 'collector-1',
      name: '集水暗渠1',
      rows: [createEmptyRow()],
    },
  ])

  // 直落暗渠（1つのみ）
  const [directRows, setDirectRows] = useState<WiringRow[]>([createEmptyRow()])

  // 地図表示設定
  const [showLabels, setShowLabels] = useState(true)
  const [showDirection, setShowDirection] = useState(true)
  const [showSurveyPoints, setShowSurveyPoints] = useState(false)
  const [showZones, setShowZones] = useState(false)
  const [showCoordinates, setShowCoordinates] = useState(true)

  // 選択モード
  const [selectionMode, setSelectionMode] = useState<SelectionMode>('none')
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null)

  // 空の行を作成
  function createEmptyRow(): WiringRow {
    return {
      id: `row-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
      absorptionPipes: [],
      collectorPipe: null,
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
  }, [selectionMode, selectedRowId, activeTabType, activeCollectorIndex, collectorTabs, directRows])

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
        {/* 選択モード表示 */}
        {selectionMode !== 'none' && (
          <div className={`px-4 py-2 rounded-lg flex items-center gap-2 ${
            selectionMode === 'absorption'
              ? 'bg-blue-100 text-blue-700 border border-blue-300'
              : 'bg-green-100 text-green-700 border border-green-300'
          }`}>
            <MousePointer className="h-4 w-4" />
            <span className="font-medium">
              {selectionMode === 'absorption' ? '吸水を選択中（Ctrl+クリックで複数追加）' : '集水/落口を選択中'}
            </span>
            <button
              onClick={() => {
                setSelectionMode('none')
                setSelectedRowId(null)
              }}
              className="ml-2 p-1 hover:bg-white/50 rounded"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}
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
                {currentRows.map((row) => {
                  const isAbsorptionSelecting = selectionMode === 'absorption' && selectedRowId === row.id
                  const isCollectorSelecting = selectionMode === 'collector' && selectedRowId === row.id

                  return (
                    <tr key={row.id} className={`hover:bg-slate-50 ${
                      selectedRowId === row.id ? 'bg-yellow-50' : ''
                    }`}>
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
          <div className="p-2 border-t bg-white">
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
              isBulkEditMode={selectionMode !== 'none'}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
