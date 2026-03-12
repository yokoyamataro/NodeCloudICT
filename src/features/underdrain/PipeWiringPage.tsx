import { useState, useMemo, useEffect } from 'react'
import {
  Cable,
  Plus,
  X,
  Hash,
  Navigation,
  Target,
  Square,
  Map,
} from 'lucide-react'
import { useUnderdrainStore } from '@/stores/underdrainStore'
import { useCoordinateStore } from '@/stores/coordinateStore'
import { useProjectStore } from '@/stores/projectStore'
import { PipeMap, type SurveyPointData } from '@/components/map/PipeMap'

// タブの種類
type TabType = 'collector' | 'direct'

// 集水暗渠タブ
interface CollectorTab {
  id: string
  name: string
  // 5列: 吸水4列 + 集水1列
  rows: WiringRow[]
}

// 配線行
interface WiringRow {
  id: string
  absorption1: string | null  // 吸水1
  absorption2: string | null  // 吸水2
  absorption3: string | null  // 吸水3
  absorption4: string | null  // 吸水4
  collector: string | null    // 集水（または落口）
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

  // 空の行を作成
  function createEmptyRow(): WiringRow {
    return {
      id: `row-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      absorption1: null,
      absorption2: null,
      absorption3: null,
      absorption4: null,
      collector: null,
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
  }

  // セル値を更新
  const updateCell = (
    tabType: TabType,
    rowId: string,
    field: keyof WiringRow,
    value: string | null,
    tabIndex?: number
  ) => {
    if (tabType === 'collector' && tabIndex !== undefined) {
      const newTabs = [...collectorTabs]
      const rowIndex = newTabs[tabIndex].rows.findIndex((r) => r.id === rowId)
      if (rowIndex >= 0) {
        newTabs[tabIndex].rows[rowIndex] = {
          ...newTabs[tabIndex].rows[rowIndex],
          [field]: value,
        }
        setCollectorTabs(newTabs)
      }
    } else if (tabType === 'direct') {
      const rowIndex = directRows.findIndex((r) => r.id === rowId)
      if (rowIndex >= 0) {
        const newRows = [...directRows]
        newRows[rowIndex] = { ...newRows[rowIndex], [field]: value }
        setDirectRows(newRows)
      }
    }
  }

  // 現在のタブのデータ
  const currentRows = useMemo(() => {
    if (activeTabType === 'collector') {
      return collectorTabs[activeCollectorIndex]?.rows || []
    }
    return directRows
  }, [activeTabType, activeCollectorIndex, collectorTabs, directRows])

  // 右列のラベル
  const rightColumnLabel = activeTabType === 'collector' ? '集水' : '落口'

  // 管路選択肢
  const pipeOptions = useMemo(() => {
    return pipes.map((p) => ({
      value: p.id,
      label: p.number,
    }))
  }, [pipes])

  // 地図用の測点データ
  const mapSurveyPoints: SurveyPointData[] = useMemo(() => {
    // TODO: 配線に応じた測点を表示
    return []
  }, [])

  return (
    <div className="h-full flex flex-col">
      {/* ヘッダー */}
      <div className="p-4 border-b bg-white flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2">
            <Cable className="h-5 w-5" />
            配線設定
          </h1>
          <p className="text-sm text-muted-foreground">
            管路の配線パターンを設定
          </p>
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
              onClick={() => setActiveTabType('direct')}
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
                  <th className="px-3 py-2 text-center font-medium text-blue-700 border-r" colSpan={4}>
                    吸水
                  </th>
                  <th className="px-3 py-2 text-center font-medium text-green-700">
                    {rightColumnLabel}
                  </th>
                  <th className="px-3 py-2 w-10"></th>
                </tr>
                <tr className="bg-slate-50">
                  <th className="px-2 py-1 text-center text-xs font-normal text-slate-500 border-r">1</th>
                  <th className="px-2 py-1 text-center text-xs font-normal text-slate-500 border-r">2</th>
                  <th className="px-2 py-1 text-center text-xs font-normal text-slate-500 border-r">3</th>
                  <th className="px-2 py-1 text-center text-xs font-normal text-slate-500 border-r">4</th>
                  <th className="px-2 py-1 text-center text-xs font-normal text-slate-500"></th>
                  <th className="px-2 py-1"></th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {currentRows.map((row) => (
                  <tr key={row.id} className="hover:bg-slate-50">
                    <td className="px-1 py-1 border-r">
                      <select
                        value={row.absorption1 || ''}
                        onChange={(e) =>
                          updateCell(
                            activeTabType,
                            row.id,
                            'absorption1',
                            e.target.value || null,
                            activeTabType === 'collector' ? activeCollectorIndex : undefined
                          )
                        }
                        className="w-full px-2 py-1.5 border rounded text-sm bg-blue-50"
                      >
                        <option value="">-</option>
                        {pipeOptions.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-1 py-1 border-r">
                      <select
                        value={row.absorption2 || ''}
                        onChange={(e) =>
                          updateCell(
                            activeTabType,
                            row.id,
                            'absorption2',
                            e.target.value || null,
                            activeTabType === 'collector' ? activeCollectorIndex : undefined
                          )
                        }
                        className="w-full px-2 py-1.5 border rounded text-sm bg-blue-50"
                      >
                        <option value="">-</option>
                        {pipeOptions.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-1 py-1 border-r">
                      <select
                        value={row.absorption3 || ''}
                        onChange={(e) =>
                          updateCell(
                            activeTabType,
                            row.id,
                            'absorption3',
                            e.target.value || null,
                            activeTabType === 'collector' ? activeCollectorIndex : undefined
                          )
                        }
                        className="w-full px-2 py-1.5 border rounded text-sm bg-blue-50"
                      >
                        <option value="">-</option>
                        {pipeOptions.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-1 py-1 border-r">
                      <select
                        value={row.absorption4 || ''}
                        onChange={(e) =>
                          updateCell(
                            activeTabType,
                            row.id,
                            'absorption4',
                            e.target.value || null,
                            activeTabType === 'collector' ? activeCollectorIndex : undefined
                          )
                        }
                        className="w-full px-2 py-1.5 border rounded text-sm bg-blue-50"
                      >
                        <option value="">-</option>
                        {pipeOptions.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-1 py-1">
                      <select
                        value={row.collector || ''}
                        onChange={(e) =>
                          updateCell(
                            activeTabType,
                            row.id,
                            'collector',
                            e.target.value || null,
                            activeTabType === 'collector' ? activeCollectorIndex : undefined
                          )
                        }
                        className={`w-full px-2 py-1.5 border rounded text-sm ${
                          activeTabType === 'collector' ? 'bg-green-50' : 'bg-orange-50'
                        }`}
                      >
                        <option value="">-</option>
                        {pipeOptions.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-1 py-1 text-center">
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
                ))}
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
            />
          </div>
        </div>
      </div>
    </div>
  )
}
