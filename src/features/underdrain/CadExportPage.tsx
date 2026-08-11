import { useEffect, useMemo, useState } from 'react'
import { PenTool, Download, FileSpreadsheet } from 'lucide-react'
import Encoding from 'encoding-japanese'
import { useFarmStore } from '@/stores/farmStore'
import { useUnderdrainStore } from '@/stores/underdrainStore'
import { useConstructionPlanStore, type PlanRow } from '@/stores/constructionPlanStore'
import { exportAllCrossSectionsDxf } from '@/lib/crossSectionDxfExport'
import { generateSfcPipesContent } from '@/lib/sfcPipeExport'

// 文字列を Shift-JIS の Uint8Array に変換
function toShiftJIS(text: string): Uint8Array {
  const unicodeArray = Encoding.stringToCode(text)
  const sjisArray = Encoding.convert(unicodeArray, {
    to: 'SJIS',
    from: 'UNICODE',
  })
  return new Uint8Array(sjisArray)
}

const SFC_SETTINGS_STORAGE_KEY = 'nodecloud:sfc-export-settings'

interface SfcSettings {
  sfcPreserveSurvey: boolean
  sfcOriginX: string
  sfcOriginY: string
  sfcRotDeg: number
  sfcRotMin: number
  sfcRotSec: number
  sfcIncPipeShapes: boolean
  sfcIncTransitions: boolean
  sfcIncPipeNumbers: boolean
  sfcIncPointNames: boolean
  sfcIncGround: boolean
  sfcIncPlanned: boolean
  sfcIncCutDepth: boolean
  sfcIncSlope: boolean
  sfcIncDistance: boolean
  sfcIncDiameter: boolean
}

const DEFAULT_SFC_SETTINGS: SfcSettings = {
  sfcPreserveSurvey: false,
  sfcOriginX: '',
  sfcOriginY: '',
  sfcRotDeg: 0,
  sfcRotMin: 0,
  sfcRotSec: 0,
  sfcIncPipeShapes: true,
  sfcIncTransitions: true,
  sfcIncPipeNumbers: true,
  sfcIncPointNames: true,
  sfcIncGround: true,
  sfcIncPlanned: true,
  sfcIncCutDepth: true,
  sfcIncSlope: true,
  sfcIncDistance: true,
  sfcIncDiameter: true,
}

function loadSfcSettings(): SfcSettings {
  if (typeof window === 'undefined') return DEFAULT_SFC_SETTINGS
  try {
    const raw = window.localStorage.getItem(SFC_SETTINGS_STORAGE_KEY)
    if (!raw) return DEFAULT_SFC_SETTINGS
    const parsed = JSON.parse(raw) as Partial<SfcSettings>
    return { ...DEFAULT_SFC_SETTINGS, ...parsed }
  } catch {
    return DEFAULT_SFC_SETTINGS
  }
}

export function CadExportPage() {
  const { currentFarm } = useFarmStore()
  const { pipes, fetchPipes } = useUnderdrainStore()
  const { planGroups, fetchPlan, loading: planLoading } = useConstructionPlanStore()

  // 縦断図 DXF 一括出力
  const [dxfVScale, setDxfVScale] = useState<100 | 200 | 500 | 1000>(200)

  const initialSfcSettings = useMemo(() => loadSfcSettings(), [])
  const [sfcPreserveSurvey, setSfcPreserveSurvey] = useState<boolean>(initialSfcSettings.sfcPreserveSurvey)
  const [sfcOriginX, setSfcOriginX] = useState<string>(initialSfcSettings.sfcOriginX)
  const [sfcOriginY, setSfcOriginY] = useState<string>(initialSfcSettings.sfcOriginY)
  const [sfcRotDeg, setSfcRotDeg] = useState<number>(initialSfcSettings.sfcRotDeg)
  const [sfcRotMin, setSfcRotMin] = useState<number>(initialSfcSettings.sfcRotMin)
  const [sfcRotSec, setSfcRotSec] = useState<number>(initialSfcSettings.sfcRotSec)
  const [sfcIncPipeShapes, setSfcIncPipeShapes] = useState<boolean>(initialSfcSettings.sfcIncPipeShapes)
  const [sfcIncTransitions, setSfcIncTransitions] = useState<boolean>(initialSfcSettings.sfcIncTransitions)
  const [sfcIncPipeNumbers, setSfcIncPipeNumbers] = useState<boolean>(initialSfcSettings.sfcIncPipeNumbers)
  const [sfcIncPointNames, setSfcIncPointNames] = useState<boolean>(initialSfcSettings.sfcIncPointNames)
  const [sfcIncGround, setSfcIncGround] = useState<boolean>(initialSfcSettings.sfcIncGround)
  const [sfcIncPlanned, setSfcIncPlanned] = useState<boolean>(initialSfcSettings.sfcIncPlanned)
  const [sfcIncCutDepth, setSfcIncCutDepth] = useState<boolean>(initialSfcSettings.sfcIncCutDepth)
  const [sfcIncSlope, setSfcIncSlope] = useState<boolean>(initialSfcSettings.sfcIncSlope)
  const [sfcIncDistance, setSfcIncDistance] = useState<boolean>(initialSfcSettings.sfcIncDistance)
  const [sfcIncDiameter, setSfcIncDiameter] = useState<boolean>(initialSfcSettings.sfcIncDiameter)

  useEffect(() => {
    if (!currentFarm) return
    fetchPipes(currentFarm.id)
    fetchPlan(currentFarm.id)
  }, [currentFarm, fetchPipes, fetchPlan])

  useEffect(() => {
    if (typeof window === 'undefined') return
    const settings: SfcSettings = {
      sfcPreserveSurvey,
      sfcOriginX,
      sfcOriginY,
      sfcRotDeg,
      sfcRotMin,
      sfcRotSec,
      sfcIncPipeShapes,
      sfcIncTransitions,
      sfcIncPipeNumbers,
      sfcIncPointNames,
      sfcIncGround,
      sfcIncPlanned,
      sfcIncCutDepth,
      sfcIncSlope,
      sfcIncDistance,
      sfcIncDiameter,
    }
    try {
      window.localStorage.setItem(SFC_SETTINGS_STORAGE_KEY, JSON.stringify(settings))
    } catch {
      // ignore quota errors
    }
  }, [
    sfcPreserveSurvey,
    sfcOriginX,
    sfcOriginY,
    sfcRotDeg,
    sfcRotMin,
    sfcRotSec,
    sfcIncPipeShapes,
    sfcIncTransitions,
    sfcIncPipeNumbers,
    sfcIncPointNames,
    sfcIncGround,
    sfcIncPlanned,
    sfcIncCutDepth,
    sfcIncSlope,
    sfcIncDistance,
    sfcIncDiameter,
  ])

  const handleSfcDownload = () => {
    if (pipes.length === 0) {
      alert('配管データがありません。CAD解析ページで登録してください。')
      return
    }
    const fileBase = currentFarm?.name || 'plan'
    // 度分秒 → decimal deg
    const rotDecimal = sfcRotDeg + sfcRotMin / 60 + sfcRotSec / 3600
    const origX = sfcOriginX.trim() === '' ? undefined : parseFloat(sfcOriginX)
    const origY = sfcOriginY.trim() === '' ? undefined : parseFloat(sfcOriginY)
    const sfcText = generateSfcPipesContent(pipes, {
      fileBaseName: fileBase,
      scale: 1000,
      preserveSurveyCoords: sfcPreserveSurvey,
      rotationDeg: rotDecimal,
      originX: Number.isFinite(origX) ? origX : undefined,
      originY: Number.isFinite(origY) ? origY : undefined,
      planGroups,
      include: {
        pipeShapes: sfcIncPipeShapes,
        transitions: sfcIncTransitions,
        pipeNumbers: sfcIncPipeNumbers,
        pointNames: sfcIncPointNames,
        groundHeight: sfcIncGround,
        plannedHeight: sfcIncPlanned,
        cutDepth: sfcIncCutDepth,
        segmentSlope: sfcIncSlope,
        segmentDistance: sfcIncDistance,
        pipeDiameter: sfcIncDiameter,
      },
    })
    const sjis = toShiftJIS(sfcText)
    const buf = sjis.slice().buffer
    const blob = new Blob([buf], { type: 'application/octet-stream' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${fileBase}_pipes.sfc`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  // 縦断図用の補助マップ
  const pipeNumberById = useMemo(() => {
    const m = new Map<string, string>()
    for (const p of pipes) m.set(p.id, p.number)
    return m
  }, [pipes])
  const pipeDiameterById = useMemo(() => {
    const m = new Map<string, number>()
    for (const p of pipes) if (p.diameter != null) m.set(p.id, p.diameter)
    return m
  }, [pipes])

  // 全系統 × 全行のフラットなタブリスト（縦断図 DXF 用）
  const flatTabs = useMemo(() => {
    const tabs: Array<{
      systemRows: PlanRow[]
      systemIndex: number
      endType: 'outlet' | 'merge' | null
      groupName: string
    }> = []
    for (const group of planGroups) {
      const bySys = new Map<number, { rows: PlanRow[]; endType: 'outlet' | 'merge' | null }>()
      for (const r of group.rows) {
        const k = r.systemIndex ?? 1
        const cur = bySys.get(k) ?? { rows: [], endType: null }
        cur.rows.push(r)
        if (r.isSystemEnd && r.systemEndType) cur.endType = r.systemEndType
        bySys.set(k, cur)
      }
      for (const [systemIndex, info] of bySys) {
        tabs.push({
          systemRows: info.rows,
          systemIndex,
          endType: info.endType,
          groupName: group.name,
        })
      }
    }
    return tabs
  }, [planGroups])

  const handleAllDxfExport = () => {
    if (flatTabs.length === 0) {
      alert('施工計画がありません。施工計画ページで生成してください。')
      return
    }
    exportAllCrossSectionsDxf({
      systems: flatTabs,
      verticalScale: dxfVScale,
      pipeNumberById,
      pipeDiameterById,
      allPlanGroups: planGroups,
      farmName: currentFarm?.name,
    })
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="p-4 border-b bg-white">
        <h1 className="text-xl font-bold flex items-center gap-2">
          <PenTool className="h-5 w-5" />
          CAD転記
        </h1>
        <p className="text-sm text-muted-foreground">
          施工計画から TrendOne アスキー形式（Shift-JIS）の文字データを出力します
        </p>
      </div>

      <div className="flex-1 overflow-auto p-4 space-y-4">
        {/* 操作 */}
        <section className="bg-white border rounded-lg p-4">
          <h2 className="text-sm font-bold mb-3">操作</h2>
          <div className="flex gap-2">
            <div className="flex items-center gap-2 border rounded px-2 py-1 text-xs bg-slate-50 flex-wrap">
              <label className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={sfcPreserveSurvey}
                  onChange={(e) => setSfcPreserveSurvey(e.target.checked)}
                />
                <span title="ON: feature 内の座標を実測 m×1000 で保存し、sfig_locate で 縮尺・原点・回転 を適用する (TREND-ONE の '現地座標' 系)。">
                  現地座標保持
                </span>
              </label>
              <label className="flex items-center gap-1 ml-2" title="データの原点 (実 m)。空欄なら bbox 最小 X を使用。">
                <span className="text-slate-600">原点X</span>
                <input
                  type="text"
                  value={sfcOriginX}
                  onChange={(e) => setSfcOriginX(e.target.value)}
                  disabled={!sfcPreserveSurvey}
                  placeholder="auto"
                  className="w-24 px-1 py-0.5 border rounded text-right font-mono disabled:bg-slate-100 disabled:text-slate-400"
                />
                <span className="text-slate-500">m</span>
              </label>
              <label className="flex items-center gap-1" title="データの原点 (実 m)。空欄なら bbox 最小 Y を使用。">
                <span className="text-slate-600">Y</span>
                <input
                  type="text"
                  value={sfcOriginY}
                  onChange={(e) => setSfcOriginY(e.target.value)}
                  disabled={!sfcPreserveSurvey}
                  placeholder="auto"
                  className="w-24 px-1 py-0.5 border rounded text-right font-mono disabled:bg-slate-100 disabled:text-slate-400"
                />
                <span className="text-slate-500">m</span>
              </label>
              <label className="flex items-center gap-1 ml-2" title="回転角 (度分秒)。現地座標保持 ON でも OFF でも回転できる。">
                <span className="text-slate-600">回転</span>
                <input
                  type="number"
                  value={sfcRotDeg}
                  onChange={(e) => setSfcRotDeg(parseFloat(e.target.value) || 0)}
                  step="1"
                  className="w-14 px-1 py-0.5 border rounded text-right font-mono"
                />
                <span className="text-slate-500">°</span>
                <input
                  type="number"
                  value={sfcRotMin}
                  onChange={(e) => setSfcRotMin(parseFloat(e.target.value) || 0)}
                  min="0"
                  max="59"
                  step="1"
                  className="w-12 px-1 py-0.5 border rounded text-right font-mono"
                />
                <span className="text-slate-500">'</span>
                <input
                  type="number"
                  value={sfcRotSec}
                  onChange={(e) => setSfcRotSec(parseFloat(e.target.value) || 0)}
                  min="0"
                  max="59.99"
                  step="0.1"
                  className="w-14 px-1 py-0.5 border rounded text-right font-mono"
                />
                <span className="text-slate-500">"</span>
              </label>
            </div>
            <div className="flex flex-col gap-1 border rounded px-2 py-1 text-xs bg-slate-50">
              <div className="flex items-center gap-3 flex-wrap">
                <span className="text-slate-600 font-semibold">SFC 出力要素:</span>
                <span className="text-slate-600">形状</span>
                <label className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={sfcIncPipeShapes}
                    onChange={(e) => setSfcIncPipeShapes(e.target.checked)}
                  />
                  <span>配線</span>
                </label>
                <label className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={sfcIncTransitions}
                    onChange={(e) => setSfcIncTransitions(e.target.checked)}
                  />
                  <span>記号(管種切替)</span>
                </label>
                <label className="flex items-center gap-1 ml-2">
                  <input
                    type="checkbox"
                    checked={sfcIncPipeNumbers}
                    onChange={(e) => setSfcIncPipeNumbers(e.target.checked)}
                  />
                  <span>配線番号</span>
                </label>
              </div>
              <div className="flex items-center gap-3 flex-wrap">
                <span className="text-slate-600 font-semibold">測点属性:</span>
                <label className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={sfcIncPointNames}
                    onChange={(e) => setSfcIncPointNames(e.target.checked)}
                  />
                  <span>点名</span>
                </label>
                <label className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={sfcIncGround}
                    onChange={(e) => setSfcIncGround(e.target.checked)}
                  />
                  <span>地盤高</span>
                </label>
                <label className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={sfcIncPlanned}
                    onChange={(e) => setSfcIncPlanned(e.target.checked)}
                  />
                  <span>計画高</span>
                </label>
                <label className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={sfcIncCutDepth}
                    onChange={(e) => setSfcIncCutDepth(e.target.checked)}
                  />
                  <span>切深</span>
                </label>
                <label className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={sfcIncSlope}
                    onChange={(e) => setSfcIncSlope(e.target.checked)}
                  />
                  <span>勾配</span>
                </label>
                <label className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={sfcIncDistance}
                    onChange={(e) => setSfcIncDistance(e.target.checked)}
                  />
                  <span>距離</span>
                </label>
                <label className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={sfcIncDiameter}
                    onChange={(e) => setSfcIncDiameter(e.target.checked)}
                  />
                  <span>管径</span>
                </label>
              </div>
            </div>
            <button
              type="button"
              onClick={handleSfcDownload}
              disabled={pipes.length === 0}
              className="flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white rounded hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed text-sm"
              title="配線 (吸水/集水 …) の形状 + 施工計画データ (測点/地盤高/計画高/切深/勾配) を SFC 形式で出力。縮尺 1/1000。"
            >
              <Download className="h-4 w-4" />
              SFC 出力（Shift-JIS）
            </button>
          </div>
        </section>

        {/* 縦断図 DXF 一括出力 */}
        <section className="bg-white border rounded-lg p-4">
          <h2 className="text-sm font-bold mb-3 flex items-center gap-2">
            <FileSpreadsheet className="h-4 w-4 text-sky-600" />
            縦断図 DXF 一括出力
          </h2>
          <div className="text-xs text-slate-600 mb-3">
            全系統の集水縦断図を 1 つの DXF ファイルに縦並びで出力します。
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <label className="flex items-center gap-2 text-sm">
              <span className="text-slate-600">縦縮尺</span>
              <select
                value={dxfVScale}
                onChange={(e) =>
                  setDxfVScale(parseInt(e.target.value, 10) as 100 | 200 | 500 | 1000)
                }
                className="px-2 py-1 text-sm border rounded bg-white"
              >
                <option value={100}>1/100</option>
                <option value={200}>1/200</option>
                <option value={500}>1/500</option>
                <option value={1000}>1/1000</option>
              </select>
            </label>
            <span className="text-xs text-slate-600">
              {planLoading
                ? '施工計画を読み込み中...'
                : flatTabs.length === 0
                ? '施工計画がありません'
                : `系統 ${flatTabs.length} 件`}
            </span>
            <button
              type="button"
              onClick={handleAllDxfExport}
              disabled={flatTabs.length === 0 || planLoading}
              className="flex items-center gap-2 px-4 py-2 bg-sky-600 text-white rounded hover:bg-sky-700 disabled:opacity-50 disabled:cursor-not-allowed text-sm"
            >
              <Download className="h-4 w-4" />
              縦断図 DXF を出力
            </button>
          </div>
        </section>
      </div>
    </div>
  )
}
