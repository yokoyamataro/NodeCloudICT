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
  Save,
  Loader2,
} from 'lucide-react'
import { useUnderdrainStore } from '@/stores/underdrainStore'
import { useCoordinateStore } from '@/stores/coordinateStore'
import { useProjectStore } from '@/stores/projectStore'
import { useSurveyStore, type SurveyDataRow } from '@/stores/surveyStore'
import { loadSimaFile, type SimaCoordinate } from '@/lib/sima-parser'
import type { SurveyCategory } from '@/types/database'

// タブの種類
type TabType = SurveyCategory

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

// マッチング結果
interface MatchResult {
  designPoint: DesignPoint
  surveyData: SurveyDataRow | null
  matchCandidates: SurveyDataRow[]
  distance: number | null
  dzRaw: number | null
  dzCalibrated: number | null
}

export function SurveyImportPage() {
  const { pipes, fetchPipes } = useUnderdrainStore()
  const { coordinates, fetchCoordinates } = useCoordinateStore()
  const { currentProject } = useProjectStore()
  const {
    surveyData,
    calibration,
    loading,
    fetchSurveyData,
    fetchCalibration,
    importSurveyData,
    updateCalibration,
    saveAllMatches,
    updateSurveyData,
    addSurveyData,
  } = useSurveyStore()

  // プロジェクト選択時にデータを読み込む
  useEffect(() => {
    if (currentProject) {
      fetchPipes(currentProject.id)
      fetchCoordinates(currentProject.id)
      fetchSurveyData(currentProject.id)
      fetchCalibration(currentProject.id)
    }
  }, [currentProject, fetchPipes, fetchCoordinates, fetchSurveyData, fetchCalibration])

  // 状態
  const [activeTab, setActiveTab] = useState<TabType>('control')
  const [showSettings, setShowSettings] = useState(false)
  const [isImportModalOpen, setIsImportModalOpen] = useState(false)
  const [importedData, setImportedData] = useState<SimaCoordinate[]>([])
  const [isSelectionModalOpen, setIsSelectionModalOpen] = useState(false)
  const [selectionTarget, setSelectionTarget] = useState<{
    designPointId: string
    candidates: SurveyDataRow[]
  } | null>(null)
  const [saving, setSaving] = useState(false)
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false)

  // ローカル状態（保存前のマッチング変更を追跡）
  const [localMatches, setLocalMatches] = useState<Map<string, {
    surveyId: string
    matchedPointId: string | null
    matchedPointType: 'pipe' | 'coordinate' | null
    matchDistance: number | null
    category: TabType
    dzRaw: number | null
    dzCalibrated: number | null
  }>>(new Map())

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
    const threshold = calibration.matchingThreshold

    for (const dp of designPoints) {
      // ローカル変更があればそれを使用
      const localMatch = localMatches.get(dp.id)

      if (localMatch) {
        const sd = surveyData.find((s) => s.id === localMatch.surveyId)
        results.push({
          designPoint: { ...dp, type: localMatch.category },
          surveyData: sd || null,
          matchCandidates: [],
          distance: localMatch.matchDistance,
          dzRaw: localMatch.dzRaw,
          dzCalibrated: localMatch.dzCalibrated,
        })
        continue
      }

      // DBに保存されているマッチを使用
      const savedMatch = surveyData.find((s) => s.matchedPointId === dp.id)
      if (savedMatch) {
        results.push({
          designPoint: { ...dp, type: savedMatch.category },
          surveyData: savedMatch,
          matchCandidates: [],
          distance: savedMatch.matchDistance,
          dzRaw: savedMatch.dzRaw,
          dzCalibrated: savedMatch.dzCalibrated,
        })
        continue
      }

      // 自動マッチング
      const candidates: { sd: SurveyDataRow; distance: number }[] = []
      for (const sd of surveyData) {
        // 既にマッチ済みのものはスキップ
        if (sd.matchedPointId) continue

        const distance = calcDistance(dp, sd)
        if (distance <= threshold) {
          candidates.push({ sd, distance })
        }
      }
      candidates.sort((a, b) => a.distance - b.distance)

      const bestMatch = candidates.length > 0 ? candidates[0] : null
      const dzRaw = bestMatch?.sd.z !== null && dp.z !== null && bestMatch
        ? bestMatch.sd.z! - dp.z
        : null
      const dzCalibrated = dzRaw !== null && calibration.isEnabled ? dzRaw - calibration.dzOffset : dzRaw

      results.push({
        designPoint: dp,
        surveyData: bestMatch?.sd || null,
        matchCandidates: candidates.map((c) => c.sd),
        distance: bestMatch?.distance || null,
        dzRaw,
        dzCalibrated,
      })
    }

    return results
  }, [designPoints, surveyData, calibration, localMatches, calcDistance])

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
      if (r.surveyData) stats[r.designPoint.type].matched++
    }

    return stats
  }, [matchResults])

  // 基準点の標高差から補正量を計算
  const recalculateCalibration = useCallback(() => {
    const controlResults = matchResults.filter(
      (r) => r.designPoint.type === 'control' && r.surveyData && r.dzRaw !== null
    )

    if (controlResults.length === 0) {
      updateCalibration({ dzOffset: 0 })
      return
    }

    // 基準点の標高差の平均を補正量とする
    const sum = controlResults.reduce((acc, r) => acc + (r.dzRaw || 0), 0)
    const avg = sum / controlResults.length

    updateCalibration({ dzOffset: avg })
  }, [matchResults, updateCalibration])

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

    // ファイル入力をリセット（同じファイルを再選択できるように）
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  // インポートを確定（Supabaseに保存）
  const confirmImport = async () => {
    const newData: Omit<SurveyDataRow, 'id'>[] = importedData.map((c) => ({
      pointNumber: c.pointNumber,
      x: c.x,
      y: c.y,
      z: c.z,
      matchedPointId: null,
      matchedPointType: null,
      matchDistance: null,
      category: 'other' as TabType,
      dzRaw: null,
      dzCalibrated: null,
      notes: null,
    }))

    await importSurveyData(newData)
    setIsImportModalOpen(false)
    setImportedData([])
    setLocalMatches(new Map())
    setHasUnsavedChanges(false)
  }

  // 選択モーダルを開く
  const openSelectionModal = (designPointId: string, candidates: SurveyDataRow[]) => {
    setSelectionTarget({ designPointId, candidates })
    setIsSelectionModalOpen(true)
  }

  // 測量点を手動選択
  const selectSurveyPoint = (surveyId: string) => {
    if (!selectionTarget) return

    const dp = designPoints.find((d) => d.id === selectionTarget.designPointId)
    const sd = surveyData.find((s) => s.id === surveyId)
    if (!dp || !sd) return

    const distance = calcDistance(dp, sd)
    const dzRaw = sd.z !== null && dp.z !== null ? sd.z - dp.z : null
    const dzCalibrated = dzRaw !== null && calibration.isEnabled ? dzRaw - calibration.dzOffset : dzRaw

    setLocalMatches((prev) => {
      const next = new Map(prev)
      next.set(selectionTarget.designPointId, {
        surveyId,
        matchedPointId: dp.id,
        matchedPointType: dp.source,
        matchDistance: distance,
        category: dp.type,
        dzRaw,
        dzCalibrated,
      })
      return next
    })

    setHasUnsavedChanges(true)
    setIsSelectionModalOpen(false)
    setSelectionTarget(null)
  }

  // マッチング解除
  const clearMatch = (designPointId: string) => {
    setLocalMatches((prev) => {
      const next = new Map(prev)
      // 解除を示すために null を設定
      next.set(designPointId, {
        surveyId: '',
        matchedPointId: null,
        matchedPointType: null,
        matchDistance: null,
        category: 'other',
        dzRaw: null,
        dzCalibrated: null,
      })
      return next
    })
    setHasUnsavedChanges(true)
  }

  // 手入力用のローカル状態（測量データがない点の一時データ）
  const [manualInputs, setManualInputs] = useState<Map<string, {
    pointNumber: string
    x: number
    y: number
    z: number | null
  }>>(new Map())

  // 手入力データを更新
  const updateManualInput = (designPointId: string, field: 'pointNumber' | 'x' | 'y' | 'z', value: string | number | null) => {
    setManualInputs((prev) => {
      const next = new Map(prev)
      const existing = next.get(designPointId)
      const dp = designPoints.find(d => d.id === designPointId)
      if (!dp) return next

      const current = existing || {
        pointNumber: dp.name,
        x: dp.x,
        y: dp.y,
        z: dp.z,
      }

      if (field === 'pointNumber') {
        next.set(designPointId, { ...current, pointNumber: value as string })
      } else if (field === 'x' || field === 'y') {
        next.set(designPointId, { ...current, [field]: value as number })
      } else if (field === 'z') {
        next.set(designPointId, { ...current, z: value as number | null })
      }
      return next
    })
    setHasUnsavedChanges(true)
  }

  // 手入力データを保存
  const saveManualInput = async (designPoint: DesignPoint) => {
    const input = manualInputs.get(designPoint.id)
    if (!input) return

    const newSurvey = await addSurveyData({
      pointNumber: input.pointNumber,
      x: input.x,
      y: input.y,
      z: input.z,
      matchedPointId: designPoint.id,
      matchedPointType: designPoint.source,
      matchDistance: 0,
      category: designPoint.type,
      dzRaw: input.z !== null && designPoint.z !== null ? input.z - designPoint.z : null,
      dzCalibrated: input.z !== null && designPoint.z !== null ? input.z - designPoint.z : null,
      notes: null,
    })

    if (newSurvey) {
      setLocalMatches((prev) => {
        const next = new Map(prev)
        next.set(designPoint.id, {
          surveyId: newSurvey.id,
          matchedPointId: designPoint.id,
          matchedPointType: designPoint.source,
          matchDistance: 0,
          category: designPoint.type,
          dzRaw: input.z !== null && designPoint.z !== null ? input.z - designPoint.z : null,
          dzCalibrated: input.z !== null && designPoint.z !== null ? input.z - designPoint.z : null,
        })
        return next
      })
      // 手入力データをクリア
      setManualInputs((prev) => {
        const next = new Map(prev)
        next.delete(designPoint.id)
        return next
      })
    }
  }

  // カテゴリ変更（その他からの振り分け）
  const changeCategory = (designPointId: string, newCategory: TabType) => {
    const result = matchResults.find((r) => r.designPoint.id === designPointId)
    if (!result || !result.surveyData) return

    setLocalMatches((prev) => {
      const next = new Map(prev)
      next.set(designPointId, {
        surveyId: result.surveyData!.id,
        matchedPointId: designPointId,
        matchedPointType: result.designPoint.source,
        matchDistance: result.distance,
        category: newCategory,
        dzRaw: result.dzRaw,
        dzCalibrated: result.dzCalibrated,
      })
      return next
    })
    setHasUnsavedChanges(true)
  }

  // マッチング結果を保存
  const handleSaveMatches = async () => {
    setSaving(true)
    try {
      // マッチング結果を収集
      const matches: Array<{
        surveyId: string
        matchedPointId: string | null
        matchedPointType: 'pipe' | 'coordinate' | null
        matchDistance: number | null
        category: SurveyCategory
        dzRaw: number | null
        dzCalibrated: number | null
      }> = []

      for (const result of matchResults) {
        if (result.surveyData) {
          const localMatch = localMatches.get(result.designPoint.id)
          if (localMatch && localMatch.surveyId) {
            matches.push({
              surveyId: localMatch.surveyId,
              matchedPointId: localMatch.matchedPointId,
              matchedPointType: localMatch.matchedPointType,
              matchDistance: localMatch.matchDistance,
              category: localMatch.category,
              dzRaw: localMatch.dzRaw,
              dzCalibrated: localMatch.dzCalibrated,
            })
          } else if (!localMatch) {
            // 自動マッチング結果を保存
            matches.push({
              surveyId: result.surveyData.id,
              matchedPointId: result.designPoint.id,
              matchedPointType: result.designPoint.source,
              matchDistance: result.distance,
              category: result.designPoint.type,
              dzRaw: result.dzRaw,
              dzCalibrated: result.dzCalibrated,
            })
          }
        }
      }

      await saveAllMatches(matches)
      setLocalMatches(new Map())
      setHasUnsavedChanges(false)
    } finally {
      setSaving(false)
    }
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
          {surveyData.length > 0 && (
            <button
              onClick={handleSaveMatches}
              disabled={saving || !hasUnsavedChanges}
              className={`flex items-center gap-2 px-4 py-2 rounded ${
                hasUnsavedChanges
                  ? 'bg-green-600 text-white hover:bg-green-500'
                  : 'bg-slate-200 text-slate-500 cursor-not-allowed'
              }`}
            >
              {saving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Save className="h-4 w-4" />
              )}
              保存
            </button>
          )}
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

      {/* 未保存の変更インジケーター */}
      {hasUnsavedChanges && (
        <div className="px-4 py-2 bg-yellow-50 border-b text-sm text-yellow-800 flex items-center gap-2">
          <span className="w-2 h-2 bg-yellow-500 rounded-full animate-pulse" />
          マッチング結果に未保存の変更があります
        </div>
      )}

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
                value={calibration.matchingThreshold}
                onChange={(e) => updateCalibration({ matchingThreshold: parseFloat(e.target.value) || 0.2 })}
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
                  onChange={(e) => updateCalibration({ isEnabled: e.target.checked })}
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

      {/* ローディング */}
      {loading && (
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
        </div>
      )}

      {/* メインコンテンツ */}
      {!loading && (
        <div className="flex-1 overflow-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-100 sticky top-0 z-10">
              <tr>
                <th className="px-2 py-1.5 text-left font-medium w-6 text-xs"></th>
                <th className="px-2 py-1.5 text-left font-medium text-xs">点名</th>
                <th className="px-2 py-1.5 text-right font-medium text-xs">設計X</th>
                <th className="px-2 py-1.5 text-right font-medium text-xs">設計Y</th>
                <th className="px-2 py-1.5 text-right font-medium text-xs">設計Z</th>
                <th className="px-2 py-1.5 text-center font-medium w-6 text-xs">
                  <Link2 className="h-3.5 w-3.5 mx-auto" />
                </th>
                <th className="px-2 py-1.5 text-left font-medium text-xs">測量点名</th>
                <th className="px-2 py-1.5 text-right font-medium text-xs">測量X</th>
                <th className="px-2 py-1.5 text-right font-medium text-xs">測量Y</th>
                <th className="px-2 py-1.5 text-right font-medium text-xs">測量Z</th>
                <th className="px-2 py-1.5 text-right font-medium text-xs">距離</th>
                <th className="px-2 py-1.5 text-right font-medium text-xs">dZ</th>
                {activeTab === 'other' && (
                  <th className="px-2 py-1.5 text-center font-medium text-xs">振り分け</th>
                )}
                <th className="px-2 py-1.5 text-center font-medium w-14 text-xs">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {filteredResults.map((result) => {
                const hasMatch = result.surveyData !== null
                const hasMultipleCandidates = result.matchCandidates.length > 1
                return (
                  <tr
                    key={result.designPoint.id}
                    className={`hover:bg-slate-50 ${
                      hasMatch ? 'bg-green-50' : surveyData.length > 0 ? 'bg-red-50' : ''
                    }`}
                  >
                    <td className="px-2 py-0.5 text-center">
                      {hasMatch ? (
                        <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />
                      ) : surveyData.length > 0 ? (
                        <AlertCircle className="h-3.5 w-3.5 text-red-500" />
                      ) : (
                        <span className="h-3.5 w-3.5 block" />
                      )}
                    </td>
                    <td className="px-2 py-0.5 font-mono font-medium text-xs">
                      {result.designPoint.name}
                      {result.designPoint.source === 'coordinate' && (
                        <span className="ml-1 text-[10px] text-orange-600">(座標)</span>
                      )}
                    </td>
                    <td className="px-2 py-0.5 text-right font-mono text-xs">
                      {result.designPoint.x.toFixed(3)}
                    </td>
                    <td className="px-2 py-0.5 text-right font-mono text-xs">
                      {result.designPoint.y.toFixed(3)}
                    </td>
                    <td className="px-2 py-0.5 text-right font-mono text-xs">
                      {result.designPoint.z?.toFixed(3) ?? '-'}
                    </td>
                    <td className="px-2 py-0.5 text-center">
                      {hasMatch && <Link2 className="h-3.5 w-3.5 mx-auto text-green-600" />}
                    </td>
                    <td className="px-2 py-0.5 font-mono text-xs">
                      {result.surveyData ? (
                        <input
                          type="text"
                          value={result.surveyData.pointNumber}
                          onChange={(e) => {
                            updateSurveyData(result.surveyData!.id, { pointNumber: e.target.value })
                            setHasUnsavedChanges(true)
                          }}
                          className="w-16 px-1 py-0 text-xs font-mono border rounded bg-white"
                        />
                      ) : (
                        <input
                          type="text"
                          value={manualInputs.get(result.designPoint.id)?.pointNumber ?? ''}
                          onChange={(e) => updateManualInput(result.designPoint.id, 'pointNumber', e.target.value)}
                          className="w-16 px-1 py-0 text-xs font-mono border rounded bg-amber-50 border-amber-300"
                          placeholder={result.designPoint.name}
                        />
                      )}
                      {hasMultipleCandidates && (
                        <span className="ml-1 text-[10px] text-orange-600">
                          (+{result.matchCandidates.length - 1})
                        </span>
                      )}
                    </td>
                    <td className="px-1 py-0.5 text-right">
                      {result.surveyData ? (
                        <input
                          type="number"
                          step="0.001"
                          value={result.surveyData.x}
                          onChange={(e) => {
                            const val = parseFloat(e.target.value)
                            if (!isNaN(val)) {
                              updateSurveyData(result.surveyData!.id, { x: val })
                              setHasUnsavedChanges(true)
                            }
                          }}
                          className="w-20 px-1 py-0 text-xs font-mono text-right border rounded bg-white"
                        />
                      ) : (
                        <input
                          type="number"
                          step="0.001"
                          value={manualInputs.get(result.designPoint.id)?.x ?? ''}
                          onChange={(e) => {
                            const val = parseFloat(e.target.value)
                            if (!isNaN(val)) updateManualInput(result.designPoint.id, 'x', val)
                          }}
                          className="w-20 px-1 py-0 text-xs font-mono text-right border rounded bg-amber-50 border-amber-300"
                          placeholder={result.designPoint.x.toFixed(3)}
                        />
                      )}
                    </td>
                    <td className="px-1 py-0.5 text-right">
                      {result.surveyData ? (
                        <input
                          type="number"
                          step="0.001"
                          value={result.surveyData.y}
                          onChange={(e) => {
                            const val = parseFloat(e.target.value)
                            if (!isNaN(val)) {
                              updateSurveyData(result.surveyData!.id, { y: val })
                              setHasUnsavedChanges(true)
                            }
                          }}
                          className="w-20 px-1 py-0 text-xs font-mono text-right border rounded bg-white"
                        />
                      ) : (
                        <input
                          type="number"
                          step="0.001"
                          value={manualInputs.get(result.designPoint.id)?.y ?? ''}
                          onChange={(e) => {
                            const val = parseFloat(e.target.value)
                            if (!isNaN(val)) updateManualInput(result.designPoint.id, 'y', val)
                          }}
                          className="w-20 px-1 py-0 text-xs font-mono text-right border rounded bg-amber-50 border-amber-300"
                          placeholder={result.designPoint.y.toFixed(3)}
                        />
                      )}
                    </td>
                    <td className="px-1 py-0.5 text-right">
                      {result.surveyData ? (
                        <input
                          type="number"
                          step="0.001"
                          value={result.surveyData.z ?? ''}
                          onChange={(e) => {
                            const val = e.target.value === '' ? null : parseFloat(e.target.value)
                            if (val === null || !isNaN(val)) {
                              updateSurveyData(result.surveyData!.id, { z: val })
                              setHasUnsavedChanges(true)
                            }
                          }}
                          className="w-16 px-1 py-0 text-xs font-mono text-right border rounded bg-white"
                          placeholder="-"
                        />
                      ) : (
                        <input
                          type="number"
                          step="0.001"
                          value={manualInputs.get(result.designPoint.id)?.z ?? ''}
                          onChange={(e) => {
                            const val = e.target.value === '' ? null : parseFloat(e.target.value)
                            if (val === null || !isNaN(val)) updateManualInput(result.designPoint.id, 'z', val)
                          }}
                          className="w-16 px-1 py-0 text-xs font-mono text-right border rounded bg-amber-50 border-amber-300"
                          placeholder={result.designPoint.z?.toFixed(3) ?? '-'}
                        />
                      )}
                    </td>
                    <td className="px-2 py-0.5 text-right font-mono text-xs">
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
                    <td className="px-2 py-0.5 text-right font-mono text-xs">
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
                        <span className="text-[10px] text-slate-400 ml-1">
                          (生:{result.dzRaw >= 0 ? '+' : ''}{result.dzRaw.toFixed(3)})
                        </span>
                      )}
                    </td>
                    {activeTab === 'other' && (
                      <td className="px-2 py-0.5 text-center">
                        <select
                          value={result.designPoint.type}
                          onChange={(e) =>
                            changeCategory(result.designPoint.id, e.target.value as TabType)
                          }
                          className="text-xs border rounded px-1 py-0"
                          disabled={!hasMatch}
                        >
                          <option value="other">その他</option>
                          <option value="control">基準点</option>
                          <option value="boundary">外周点</option>
                          <option value="underdrain">暗渠構成点</option>
                        </select>
                      </td>
                    )}
                    <td className="px-2 py-0.5 text-center">
                      <div className="flex items-center justify-center gap-0.5">
                        {/* 手入力データがある場合は保存ボタン */}
                        {!hasMatch && manualInputs.has(result.designPoint.id) && (
                          <button
                            onClick={() => saveManualInput(result.designPoint)}
                            className="px-1.5 py-0.5 text-[10px] bg-green-100 text-green-700 rounded hover:bg-green-200"
                            title="測量データを保存"
                          >
                            保存
                          </button>
                        )}
                        {hasMultipleCandidates && (
                          <button
                            onClick={() =>
                              openSelectionModal(result.designPoint.id, result.matchCandidates)
                            }
                            className="px-1.5 py-0.5 text-[10px] bg-blue-100 text-blue-700 rounded hover:bg-blue-200"
                          >
                            選択
                          </button>
                        )}
                        {hasMatch && (
                          <button
                            onClick={() => clearMatch(result.designPoint.id)}
                            className="p-0.5 text-red-500 hover:bg-red-100 rounded"
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
                  <td colSpan={activeTab === 'other' ? 14 : 13} className="px-4 py-6 text-center text-muted-foreground text-sm">
                    {surveyData.length === 0
                      ? 'SIMファイルをインポートしてください'
                      : 'このカテゴリには該当する点がありません'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

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
                <br />
                <span className="text-orange-600">既存の測量データは上書きされます。</span>
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
                  {selectionTarget.candidates.map((sd) => {
                    const dp = designPoints.find((d) => d.id === selectionTarget.designPointId)
                    const dist = dp ? calcDistance(dp, sd) : 0
                    return (
                      <tr key={sd.id} className="hover:bg-slate-50">
                        <td className="px-3 py-2 font-mono">{sd.pointNumber}</td>
                        <td className="px-3 py-2 text-right font-mono">{sd.x.toFixed(3)}</td>
                        <td className="px-3 py-2 text-right font-mono">{sd.y.toFixed(3)}</td>
                        <td className="px-3 py-2 text-right font-mono">
                          {sd.z?.toFixed(3) ?? '-'}
                        </td>
                        <td className="px-3 py-2 text-right font-mono">
                          {(dist * 100).toFixed(1)}cm
                        </td>
                        <td className="px-3 py-2 text-center">
                          <button
                            onClick={() => selectSurveyPoint(sd.id)}
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
