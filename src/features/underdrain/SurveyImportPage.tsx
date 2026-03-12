import { useState, useMemo, useEffect, useCallback, useRef } from 'react'
import {
  Upload,
  MapPin,
  CheckCircle2,
  AlertCircle,
  Settings,
  RefreshCw,
  Mountain,
  Link2,
  X,
  FileText,
} from 'lucide-react'
import { useUnderdrainStore } from '@/stores/underdrainStore'
import { useCoordinateStore } from '@/stores/coordinateStore'
import { useProjectStore } from '@/stores/projectStore'
import { loadSimaFile, type SimaCoordinate } from '@/lib/sima-parser'

// マッチング閾値（メートル）
const DEFAULT_MATCHING_THRESHOLD = 0.2 // 20cm

// タブの種類
type TabType = 'control' | 'boundary' | 'underdrain' | 'other'

const TAB_LABELS: Record<TabType, string> = {
  control: '基準点',
  boundary: '外周点',
  underdrain: '暗渠構成点',
  other: 'その他',
}

// 設計座標（座標計算ページから取得）
interface DesignPoint {
  id: string
  name: string
  x: number
  y: number
  z: number | null
  type: TabType
  source: 'pipe' | 'coordinate'
}

// 測量座標（SIMから取得）
interface SurveyPoint {
  id: string
  pointNumber: string
  x: number
  y: number
  z: number | null
}

// マッチング結果
interface MatchResult {
  designPoint: DesignPoint
  surveyPoint: SurveyPoint | null
  matchCandidates: SurveyPoint[]
  distance: number | null
  manualCategory?: TabType
  dzRaw: number | null    // 生の標高差（測量Z - 設計Z）
  dzCalibrated: number | null  // 補正後の標高差
}

// 補正情報
interface CalibrationInfo {
  controlPointId: string | null
  dzOffset: number  // 補正量（基準点の測量Z - 設計Z の平均）
  isEnabled: boolean
}

export function SurveyImportPage() {
  const { pipes, fetchPipes } = useUnderdrainStore()
  const { coordinates, fetchCoordinates } = useCoordinateStore()
  const { currentProject } = useProjectStore()

  // プロジェクト選択時にデータを読み込む
  useEffect(() => {
    if (currentProject) {
      fetchPipes(currentProject.id)
      fetchCoordinates(currentProject.id)
    }
  }, [currentProject, fetchPipes, fetchCoordinates])

  // 状態
  const [activeTab, setActiveTab] = useState<TabType>('control')
  const [matchingThreshold, setMatchingThreshold] = useState(DEFAULT_MATCHING_THRESHOLD)
  const [showSettings, setShowSettings] = useState(false)
  const [surveyPoints, setSurveyPoints] = useState<SurveyPoint[]>([])
  const [isImportModalOpen, setIsImportModalOpen] = useState(false)
  const [importedData, setImportedData] = useState<SimaCoordinate[]>([])
  const [isSelectionModalOpen, setIsSelectionModalOpen] = useState(false)
  const [selectionTarget, setSelectionTarget] = useState<{
    designPointId: string
    candidates: SurveyPoint[]
  } | null>(null)
  const [selectedSurveyPoints, setSelectedSurveyPoints] = useState<Map<string, string>>(new Map())
  const [manualCategories, setManualCategories] = useState<Map<string, TabType>>(new Map())
  const [calibration, setCalibration] = useState<CalibrationInfo>({
    controlPointId: null,
    dzOffset: 0,
    isEnabled: false,
  })
  const fileInputRef = useRef<HTMLInputElement>(null)

  // 設計点を生成（座標計算と同じロジック）
  const designPoints = useMemo(() => {
    const points: DesignPoint[] = []

    // 管路から測点を生成
    for (const pipe of pipes) {
      if (pipe.vertices.length < 2) continue
      const vertices = pipe.vertices

      // 最上流（始点）
      points.push({
        id: `${pipe.id}-upstream`,
        name: `${pipe.number}C`,
        x: vertices[0].x,
        y: vertices[0].y,
        z: vertices[0].z,
        type: 'underdrain',
        source: 'pipe',
      })

      // 中間点
      if (vertices.length > 2) {
        const middleCount = vertices.length - 2
        for (let i = 0; i < middleCount; i++) {
          const vertexIndex = vertices.length - 2 - i
          const middleIndex = i + 1
          points.push({
            id: `${pipe.id}-middle-${middleIndex}`,
            name: `${pipe.number}B${middleIndex}`,
            x: vertices[vertexIndex].x,
            y: vertices[vertexIndex].y,
            z: vertices[vertexIndex].z,
            type: 'underdrain',
            source: 'pipe',
          })
        }
      }

      // 最下流（終点）
      const lastVertex = vertices[vertices.length - 1]
      points.push({
        id: `${pipe.id}-downstream`,
        name: `${pipe.number}A`,
        x: lastVertex.x,
        y: lastVertex.y,
        z: lastVertex.z,
        type: 'underdrain',
        source: 'pipe',
      })
    }

    // 座標管理から点を追加
    for (const coord of coordinates) {
      let type: TabType = 'other'
      if (coord.type === 'control') type = 'control'
      else if (coord.type === 'boundary') type = 'boundary'
      else if (coord.type === 'underdrain') type = 'underdrain'

      points.push({
        id: coord.id,
        name: coord.pointNumber,
        x: coord.x,
        y: coord.y,
        z: coord.z,
        type,
        source: 'coordinate',
      })
    }

    return points
  }, [pipes, coordinates])

  // 2点間の距離を計算
  const calcDistance = useCallback((p1: { x: number; y: number }, p2: { x: number; y: number }) => {
    const dx = p2.x - p1.x
    const dy = p2.y - p1.y
    return Math.sqrt(dx * dx + dy * dy)
  }, [])

  // マッチング結果を計算
  const matchResults = useMemo(() => {
    const results: MatchResult[] = []

    for (const dp of designPoints) {
      // 手動選択があればそれを使用
      const manualSurveyId = selectedSurveyPoints.get(dp.id)
      const manualCategory = manualCategories.get(dp.id)

      if (manualSurveyId) {
        const sp = surveyPoints.find((s) => s.id === manualSurveyId)
        if (sp) {
          const distance = calcDistance(dp, sp)
          const dzRaw = sp.z !== null && dp.z !== null ? sp.z - dp.z : null
          const dzCalibrated = dzRaw !== null && calibration.isEnabled ? dzRaw - calibration.dzOffset : dzRaw
          results.push({
            designPoint: { ...dp, type: manualCategory || dp.type },
            surveyPoint: sp,
            matchCandidates: [],
            distance,
            manualCategory,
            dzRaw,
            dzCalibrated,
          })
          continue
        }
      }

      // 自動マッチング
      const candidates: { sp: SurveyPoint; distance: number }[] = []
      for (const sp of surveyPoints) {
        const distance = calcDistance(dp, sp)
        if (distance <= matchingThreshold) {
          candidates.push({ sp, distance })
        }
      }
      candidates.sort((a, b) => a.distance - b.distance)

      const bestMatch = candidates.length > 0 ? candidates[0] : null
      const dzRaw = bestMatch?.sp.z !== null && dp.z !== null && bestMatch
        ? bestMatch.sp.z! - dp.z
        : null
      const dzCalibrated = dzRaw !== null && calibration.isEnabled ? dzRaw - calibration.dzOffset : dzRaw

      results.push({
        designPoint: { ...dp, type: manualCategory || dp.type },
        surveyPoint: bestMatch?.sp || null,
        matchCandidates: candidates.map((c) => c.sp),
        distance: bestMatch?.distance || null,
        manualCategory,
        dzRaw,
        dzCalibrated,
      })
    }

    return results
  }, [designPoints, surveyPoints, matchingThreshold, selectedSurveyPoints, manualCategories, calibration, calcDistance])

  // タブ別にフィルタリング
  const filteredResults = useMemo(() => {
    return matchResults.filter((r) => r.designPoint.type === activeTab)
  }, [matchResults, activeTab])

  // 各タブの統計
  const tabStats = useMemo(() => {
    const stats: Record<TabType, { total: number; matched: number }> = {
      control: { total: 0, matched: 0 },
      boundary: { total: 0, matched: 0 },
      underdrain: { total: 0, matched: 0 },
      other: { total: 0, matched: 0 },
    }

    for (const r of matchResults) {
      stats[r.designPoint.type].total++
      if (r.surveyPoint) stats[r.designPoint.type].matched++
    }

    return stats
  }, [matchResults])

  // 基準点の標高差から補正量を計算
  const recalculateCalibration = useCallback(() => {
    const controlResults = matchResults.filter(
      (r) => r.designPoint.type === 'control' && r.surveyPoint && r.dzRaw !== null
    )

    if (controlResults.length === 0) {
      setCalibration((prev) => ({ ...prev, dzOffset: 0 }))
      return
    }

    // 基準点の標高差の平均を補正量とする
    const sum = controlResults.reduce((acc, r) => acc + (r.dzRaw || 0), 0)
    const avg = sum / controlResults.length

    setCalibration((prev) => ({ ...prev, dzOffset: avg }))
  }, [matchResults])

  // SIMファイルをインポート
  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    try {
      const result = await loadSimaFile(file)
      setImportedData(result.coordinates)
      setIsImportModalOpen(true)
    } catch (err) {
      console.error('SIMファイルの読み込みに失敗:', err)
    }
  }

  // インポートを確定
  const confirmImport = () => {
    const newPoints: SurveyPoint[] = importedData.map((c, i) => ({
      id: `survey-${Date.now()}-${i}`,
      pointNumber: c.pointNumber,
      x: c.x,
      y: c.y,
      z: c.z,
    }))
    setSurveyPoints(newPoints)
    setIsImportModalOpen(false)
    setImportedData([])
    // マッチング状態をリセット
    setSelectedSurveyPoints(new Map())
    setManualCategories(new Map())
  }

  // 選択モーダルを開く
  const openSelectionModal = (designPointId: string, candidates: SurveyPoint[]) => {
    setSelectionTarget({ designPointId, candidates })
    setIsSelectionModalOpen(true)
  }

  // 測量点を手動選択
  const selectSurveyPoint = (surveyPointId: string) => {
    if (!selectionTarget) return
    setSelectedSurveyPoints((prev) => {
      const next = new Map(prev)
      next.set(selectionTarget.designPointId, surveyPointId)
      return next
    })
    setIsSelectionModalOpen(false)
    setSelectionTarget(null)
  }

  // マッチング解除
  const clearMatch = (designPointId: string) => {
    setSelectedSurveyPoints((prev) => {
      const next = new Map(prev)
      next.delete(designPointId)
      return next
    })
  }

  // カテゴリ変更（その他からの振り分け）
  const changeCategory = (designPointId: string, newType: TabType) => {
    setManualCategories((prev) => {
      const next = new Map(prev)
      next.set(designPointId, newType)
      return next
    })
  }

  return (
    <div className="h-full flex flex-col">
      {/* ヘッダー */}
      <div className="p-4 border-b bg-white flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2">
            <Upload className="h-5 w-5" />
            測量データ
          </h1>
          <p className="text-sm text-muted-foreground">
            SIMファイルをインポートして設計座標と照合
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            accept=".sim,.SIM"
            onChange={handleFileSelect}
            className="hidden"
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-500"
          >
            <Upload className="h-4 w-4" />
            SIMインポート
          </button>
          <button
            disabled
            className="flex items-center gap-2 px-4 py-2 border rounded text-slate-400 cursor-not-allowed"
            title="後日実装予定"
          >
            <FileText className="h-4 w-4" />
            LANDXML
          </button>
          <button
            onClick={() => setShowSettings(!showSettings)}
            className={`flex items-center gap-1 px-3 py-2 border rounded hover:bg-slate-50 ${
              showSettings ? 'bg-blue-50 border-blue-300' : ''
            }`}
          >
            <Settings className="h-4 w-4" />
            設定
          </button>
        </div>
      </div>

      {/* 設定パネル */}
      {showSettings && (
        <div className="p-4 bg-blue-50 border-b">
          <div className="flex items-center gap-8">
            <div>
              <label className="block text-xs text-muted-foreground mb-1">
                マッチング閾値 (m)
              </label>
              <input
                type="number"
                value={matchingThreshold}
                onChange={(e) => setMatchingThreshold(parseFloat(e.target.value) || 0.2)}
                step="0.01"
                min="0.01"
                max="1.0"
                className="w-24 px-2 py-1.5 border rounded text-sm"
              />
              <p className="text-xs text-muted-foreground mt-1">
                この距離以内の点を候補とします
              </p>
            </div>
            <div className="border-l h-12 mx-4" />
            <div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={calibration.isEnabled}
                  onChange={(e) =>
                    setCalibration((prev) => ({ ...prev, isEnabled: e.target.checked }))
                  }
                  className="h-4 w-4"
                />
                <Mountain className="h-4 w-4" />
                標高補正を有効化
              </label>
              <p className="text-xs text-muted-foreground mt-1">
                基準点の標高差を元に他の点を補正
              </p>
            </div>
            {calibration.isEnabled && (
              <div className="flex items-center gap-2">
                <span className="text-sm">
                  補正量: {calibration.dzOffset >= 0 ? '+' : ''}
                  {calibration.dzOffset.toFixed(3)}m
                </span>
                <button
                  onClick={recalculateCalibration}
                  className="flex items-center gap-1 px-2 py-1 text-xs border rounded hover:bg-white"
                >
                  <RefreshCw className="h-3 w-3" />
                  再計算
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* タブ */}
      <div className="border-b bg-white">
        <div className="flex">
          {(Object.keys(TAB_LABELS) as TabType[]).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-6 py-3 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-slate-600 hover:text-slate-900'
              }`}
            >
              {TAB_LABELS[tab]}
              <span className="ml-2 text-xs">
                ({tabStats[tab].matched}/{tabStats[tab].total})
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* メインコンテンツ */}
      <div className="flex-1 overflow-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-100 sticky top-0 z-10">
            <tr>
              <th className="px-3 py-2 text-left font-medium w-8"></th>
              <th className="px-3 py-2 text-left font-medium">点名</th>
              <th className="px-3 py-2 text-right font-medium">設計X</th>
              <th className="px-3 py-2 text-right font-medium">設計Y</th>
              <th className="px-3 py-2 text-right font-medium">設計Z</th>
              <th className="px-3 py-2 text-center font-medium w-8">
                <Link2 className="h-4 w-4 mx-auto" />
              </th>
              <th className="px-3 py-2 text-left font-medium">測量点名</th>
              <th className="px-3 py-2 text-right font-medium">測量X</th>
              <th className="px-3 py-2 text-right font-medium">測量Y</th>
              <th className="px-3 py-2 text-right font-medium">測量Z</th>
              <th className="px-3 py-2 text-right font-medium">距離</th>
              <th className="px-3 py-2 text-right font-medium">dZ</th>
              {activeTab === 'other' && (
                <th className="px-3 py-2 text-center font-medium">振り分け</th>
              )}
              <th className="px-3 py-2 text-center font-medium w-16">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {filteredResults.map((result) => {
              const hasMatch = result.surveyPoint !== null
              const hasMultipleCandidates = result.matchCandidates.length > 1
              return (
                <tr
                  key={result.designPoint.id}
                  className={`hover:bg-slate-50 ${
                    hasMatch ? 'bg-green-50' : surveyPoints.length > 0 ? 'bg-red-50' : ''
                  }`}
                >
                  <td className="px-3 py-2 text-center">
                    {hasMatch ? (
                      <CheckCircle2 className="h-4 w-4 text-green-600" />
                    ) : surveyPoints.length > 0 ? (
                      <AlertCircle className="h-4 w-4 text-red-500" />
                    ) : (
                      <span className="h-4 w-4 block" />
                    )}
                  </td>
                  <td className="px-3 py-2 font-mono font-medium">
                    {result.designPoint.name}
                    {result.designPoint.source === 'coordinate' && (
                      <span className="ml-1 text-xs text-orange-600">(座標)</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">
                    {result.designPoint.x.toFixed(3)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">
                    {result.designPoint.y.toFixed(3)}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">
                    {result.designPoint.z?.toFixed(3) ?? '-'}
                  </td>
                  <td className="px-3 py-2 text-center">
                    {hasMatch && <Link2 className="h-4 w-4 mx-auto text-green-600" />}
                  </td>
                  <td className="px-3 py-2 font-mono">
                    {result.surveyPoint?.pointNumber ?? '-'}
                    {hasMultipleCandidates && (
                      <span className="ml-1 text-xs text-orange-600">
                        (+{result.matchCandidates.length - 1})
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">
                    {result.surveyPoint?.x.toFixed(3) ?? '-'}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">
                    {result.surveyPoint?.y.toFixed(3) ?? '-'}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">
                    {result.surveyPoint?.z?.toFixed(3) ?? '-'}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">
                    {result.distance !== null ? (
                      <span
                        className={`${
                          result.distance <= 0.1
                            ? 'text-green-600'
                            : result.distance <= 0.2
                            ? 'text-yellow-600'
                            : 'text-red-600'
                        }`}
                      >
                        {(result.distance * 100).toFixed(1)}cm
                      </span>
                    ) : (
                      '-'
                    )}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">
                    {result.dzCalibrated !== null ? (
                      <span
                        className={`${
                          Math.abs(result.dzCalibrated) <= 0.05
                            ? 'text-green-600'
                            : Math.abs(result.dzCalibrated) <= 0.1
                            ? 'text-yellow-600'
                            : 'text-red-600'
                        }`}
                      >
                        {result.dzCalibrated >= 0 ? '+' : ''}
                        {result.dzCalibrated.toFixed(3)}
                      </span>
                    ) : (
                      '-'
                    )}
                    {calibration.isEnabled && result.dzRaw !== null && result.dzRaw !== result.dzCalibrated && (
                      <span className="text-xs text-slate-400 ml-1">
                        (生:{result.dzRaw >= 0 ? '+' : ''}{result.dzRaw.toFixed(3)})
                      </span>
                    )}
                  </td>
                  {activeTab === 'other' && (
                    <td className="px-3 py-2 text-center">
                      <select
                        value={result.manualCategory || 'other'}
                        onChange={(e) =>
                          changeCategory(result.designPoint.id, e.target.value as TabType)
                        }
                        className="text-xs border rounded px-1 py-0.5"
                      >
                        <option value="other">その他</option>
                        <option value="control">基準点</option>
                        <option value="boundary">外周点</option>
                        <option value="underdrain">暗渠構成点</option>
                      </select>
                    </td>
                  )}
                  <td className="px-3 py-2 text-center">
                    <div className="flex items-center justify-center gap-1">
                      {hasMultipleCandidates && (
                        <button
                          onClick={() =>
                            openSelectionModal(result.designPoint.id, result.matchCandidates)
                          }
                          className="px-2 py-1 text-xs bg-blue-100 text-blue-700 rounded hover:bg-blue-200"
                        >
                          選択
                        </button>
                      )}
                      {hasMatch && (
                        <button
                          onClick={() => clearMatch(result.designPoint.id)}
                          className="p-1 text-red-500 hover:bg-red-100 rounded"
                          title="マッチング解除"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              )
            })}
            {filteredResults.length === 0 && (
              <tr>
                <td colSpan={activeTab === 'other' ? 14 : 13} className="px-4 py-8 text-center text-muted-foreground">
                  {surveyPoints.length === 0
                    ? 'SIMファイルをインポートしてください'
                    : 'このカテゴリには該当する点がありません'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* SIMインポートモーダル */}
      {isImportModalOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl w-[800px] max-h-[80vh] flex flex-col">
            <div className="p-4 border-b flex items-center justify-between">
              <h2 className="text-lg font-bold flex items-center gap-2">
                <Upload className="h-5 w-5" />
                SIMファイルインポート
              </h2>
              <button
                onClick={() => {
                  setIsImportModalOpen(false)
                  setImportedData([])
                }}
                className="p-1 hover:bg-slate-100 rounded"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="p-4 flex-1 overflow-auto">
              <p className="text-sm text-muted-foreground mb-4">
                {importedData.length}件の座標データが見つかりました。インポートしますか？
              </p>
              <table className="w-full text-sm border">
                <thead className="bg-slate-100 sticky top-0">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">No</th>
                    <th className="px-3 py-2 text-left font-medium">点名</th>
                    <th className="px-3 py-2 text-right font-medium">X</th>
                    <th className="px-3 py-2 text-right font-medium">Y</th>
                    <th className="px-3 py-2 text-right font-medium">Z</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {importedData.map((coord, i) => (
                    <tr key={i} className="hover:bg-slate-50">
                      <td className="px-3 py-1.5 font-mono text-xs">{coord.index}</td>
                      <td className="px-3 py-1.5 font-mono">{coord.pointNumber}</td>
                      <td className="px-3 py-1.5 text-right font-mono">{coord.x.toFixed(3)}</td>
                      <td className="px-3 py-1.5 text-right font-mono">{coord.y.toFixed(3)}</td>
                      <td className="px-3 py-1.5 text-right font-mono">
                        {coord.z?.toFixed(3) ?? '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="p-4 border-t flex justify-end gap-2">
              <button
                onClick={() => {
                  setIsImportModalOpen(false)
                  setImportedData([])
                }}
                className="px-4 py-2 border rounded hover:bg-slate-50"
              >
                キャンセル
              </button>
              <button
                onClick={confirmImport}
                className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-500"
              >
                インポート
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 選択モーダル */}
      {isSelectionModalOpen && selectionTarget && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl w-[600px] max-h-[60vh] flex flex-col">
            <div className="p-4 border-b flex items-center justify-between">
              <h2 className="text-lg font-bold flex items-center gap-2">
                <MapPin className="h-5 w-5" />
                測量点を選択
              </h2>
              <button
                onClick={() => {
                  setIsSelectionModalOpen(false)
                  setSelectionTarget(null)
                }}
                className="p-1 hover:bg-slate-100 rounded"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="p-4 flex-1 overflow-auto">
              <p className="text-sm text-muted-foreground mb-4">
                複数の候補点があります。使用する測量点を選択してください。
              </p>
              <table className="w-full text-sm border">
                <thead className="bg-slate-100 sticky top-0">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">点名</th>
                    <th className="px-3 py-2 text-right font-medium">X</th>
                    <th className="px-3 py-2 text-right font-medium">Y</th>
                    <th className="px-3 py-2 text-right font-medium">Z</th>
                    <th className="px-3 py-2 text-right font-medium">距離</th>
                    <th className="px-3 py-2 w-20"></th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {selectionTarget.candidates.map((sp) => {
                    const dp = designPoints.find((d) => d.id === selectionTarget.designPointId)
                    const dist = dp ? calcDistance(dp, sp) : 0
                    return (
                      <tr key={sp.id} className="hover:bg-slate-50">
                        <td className="px-3 py-2 font-mono">{sp.pointNumber}</td>
                        <td className="px-3 py-2 text-right font-mono">{sp.x.toFixed(3)}</td>
                        <td className="px-3 py-2 text-right font-mono">{sp.y.toFixed(3)}</td>
                        <td className="px-3 py-2 text-right font-mono">
                          {sp.z?.toFixed(3) ?? '-'}
                        </td>
                        <td className="px-3 py-2 text-right font-mono">
                          {(dist * 100).toFixed(1)}cm
                        </td>
                        <td className="px-3 py-2 text-center">
                          <button
                            onClick={() => selectSurveyPoint(sp.id)}
                            className="px-3 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-500"
                          >
                            選択
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
