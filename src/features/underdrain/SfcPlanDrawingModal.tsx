import { useEffect, useState } from 'react'
import { X, Download, Map as MapIcon } from 'lucide-react'
import Encoding from 'encoding-japanese'
import type { PlanGroup } from '@/stores/constructionPlanStore'
import type { PipeRow } from '@/stores/underdrainStore'
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
  moji: number
  pipeNumberSize: number
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
  sfcCutDepthOnlyIfDiff: boolean
}

const DEFAULT_SFC_SETTINGS: SfcSettings = {
  sfcPreserveSurvey: false,
  sfcOriginX: '',
  sfcOriginY: '',
  sfcRotDeg: 0,
  sfcRotMin: 0,
  sfcRotSec: 0,
  moji: 2,
  pipeNumberSize: 2.5,
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
  sfcCutDepthOnlyIfDiff: true,
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

interface SfcPlanDrawingModalProps {
  open: boolean
  onClose: () => void
  pipes: PipeRow[]
  planGroups: PlanGroup[]
  farmName: string | null
}

export function SfcPlanDrawingModal({
  open,
  onClose,
  pipes,
  planGroups,
  farmName,
}: SfcPlanDrawingModalProps) {
  const [sfcPreserveSurvey, setSfcPreserveSurvey] = useState<boolean>(DEFAULT_SFC_SETTINGS.sfcPreserveSurvey)
  const [sfcOriginX, setSfcOriginX] = useState<string>(DEFAULT_SFC_SETTINGS.sfcOriginX)
  const [sfcOriginY, setSfcOriginY] = useState<string>(DEFAULT_SFC_SETTINGS.sfcOriginY)
  const [sfcRotDeg, setSfcRotDeg] = useState<number>(DEFAULT_SFC_SETTINGS.sfcRotDeg)
  const [sfcRotMin, setSfcRotMin] = useState<number>(DEFAULT_SFC_SETTINGS.sfcRotMin)
  const [sfcRotSec, setSfcRotSec] = useState<number>(DEFAULT_SFC_SETTINGS.sfcRotSec)
  const [moji, setMoji] = useState<number>(DEFAULT_SFC_SETTINGS.moji)
  const [pipeNumberSize, setPipeNumberSize] = useState<number>(DEFAULT_SFC_SETTINGS.pipeNumberSize)
  const [sfcIncPipeShapes, setSfcIncPipeShapes] = useState<boolean>(DEFAULT_SFC_SETTINGS.sfcIncPipeShapes)
  const [sfcIncTransitions, setSfcIncTransitions] = useState<boolean>(DEFAULT_SFC_SETTINGS.sfcIncTransitions)
  const [sfcIncPipeNumbers, setSfcIncPipeNumbers] = useState<boolean>(DEFAULT_SFC_SETTINGS.sfcIncPipeNumbers)
  const [sfcIncPointNames, setSfcIncPointNames] = useState<boolean>(DEFAULT_SFC_SETTINGS.sfcIncPointNames)
  const [sfcIncGround, setSfcIncGround] = useState<boolean>(DEFAULT_SFC_SETTINGS.sfcIncGround)
  const [sfcIncPlanned, setSfcIncPlanned] = useState<boolean>(DEFAULT_SFC_SETTINGS.sfcIncPlanned)
  const [sfcIncCutDepth, setSfcIncCutDepth] = useState<boolean>(DEFAULT_SFC_SETTINGS.sfcIncCutDepth)
  const [sfcIncSlope, setSfcIncSlope] = useState<boolean>(DEFAULT_SFC_SETTINGS.sfcIncSlope)
  const [sfcIncDistance, setSfcIncDistance] = useState<boolean>(DEFAULT_SFC_SETTINGS.sfcIncDistance)
  const [sfcIncDiameter, setSfcIncDiameter] = useState<boolean>(DEFAULT_SFC_SETTINGS.sfcIncDiameter)
  const [sfcCutDepthOnlyIfDiff, setSfcCutDepthOnlyIfDiff] = useState<boolean>(DEFAULT_SFC_SETTINGS.sfcCutDepthOnlyIfDiff)

  // モーダルを開いたとき (open が false→true) に localStorage から読み込む
  useEffect(() => {
    if (!open) return
    const s = loadSfcSettings()
    setSfcPreserveSurvey(s.sfcPreserveSurvey)
    setSfcOriginX(s.sfcOriginX)
    setSfcOriginY(s.sfcOriginY)
    setSfcRotDeg(s.sfcRotDeg)
    setSfcRotMin(s.sfcRotMin)
    setSfcRotSec(s.sfcRotSec)
    setMoji(s.moji)
    setPipeNumberSize(s.pipeNumberSize)
    setSfcIncPipeShapes(s.sfcIncPipeShapes)
    setSfcIncTransitions(s.sfcIncTransitions)
    setSfcIncPipeNumbers(s.sfcIncPipeNumbers)
    setSfcIncPointNames(s.sfcIncPointNames)
    setSfcIncGround(s.sfcIncGround)
    setSfcIncPlanned(s.sfcIncPlanned)
    setSfcIncCutDepth(s.sfcIncCutDepth)
    setSfcIncSlope(s.sfcIncSlope)
    setSfcIncDistance(s.sfcIncDistance)
    setSfcIncDiameter(s.sfcIncDiameter)
    setSfcCutDepthOnlyIfDiff(s.sfcCutDepthOnlyIfDiff)
  }, [open])

  // 変更のたびに localStorage に保存 (モーダルが開いているとき限定)
  useEffect(() => {
    if (!open) return
    if (typeof window === 'undefined') return
    const settings: SfcSettings = {
      sfcPreserveSurvey,
      sfcOriginX,
      sfcOriginY,
      sfcRotDeg,
      sfcRotMin,
      sfcRotSec,
      moji,
      pipeNumberSize,
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
      sfcCutDepthOnlyIfDiff,
    }
    try {
      window.localStorage.setItem(SFC_SETTINGS_STORAGE_KEY, JSON.stringify(settings))
    } catch {
      // ignore quota errors
    }
  }, [
    open,
    sfcPreserveSurvey,
    sfcOriginX,
    sfcOriginY,
    sfcRotDeg,
    sfcRotMin,
    sfcRotSec,
    moji,
    pipeNumberSize,
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
    sfcCutDepthOnlyIfDiff,
  ])

  if (!open) return null

  const handleSfcDownload = () => {
    if (pipes.length === 0) {
      alert('配管データがありません。CAD解析ページで登録してください。')
      return
    }
    const fileBase = farmName || 'plan'
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
      textOptions: {
        moji,
        pipeNumberSize,
        cutDepthOnlyIfDiffFromStd: sfcCutDepthOnlyIfDiff,
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
    onClose()
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[9999]">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl p-6 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold flex items-center gap-2">
            <MapIcon className="h-5 w-5 text-indigo-600" />
            平面図 SFC 出力
          </h2>
          <button
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4 text-sm">
          {/* 座標系 */}
          <section className="border rounded p-3 bg-slate-50">
            <h3 className="text-xs font-bold text-slate-700 mb-2">座標系</h3>
            <div className="space-y-2">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={sfcPreserveSurvey}
                  onChange={(e) => setSfcPreserveSurvey(e.target.checked)}
                />
                <span
                  className="text-xs"
                  title="ON: feature 内の座標を実測 m×1000 で保存し、sfig_locate で 縮尺・原点・回転 を適用する (TREND-ONE の '現地座標' 系)。"
                >
                  現地座標保持
                </span>
              </label>
              <div className="flex items-center gap-2 text-xs flex-wrap">
                <span className="text-slate-600 w-14">原点 X</span>
                <input
                  type="text"
                  value={sfcOriginX}
                  onChange={(e) => setSfcOriginX(e.target.value)}
                  disabled={!sfcPreserveSurvey}
                  placeholder="auto"
                  className="w-28 px-1.5 py-1 border rounded text-right font-mono disabled:bg-slate-100 disabled:text-slate-400"
                />
                <span className="text-slate-500">m</span>
                <span className="text-slate-600 ml-3 w-14">原点 Y</span>
                <input
                  type="text"
                  value={sfcOriginY}
                  onChange={(e) => setSfcOriginY(e.target.value)}
                  disabled={!sfcPreserveSurvey}
                  placeholder="auto"
                  className="w-28 px-1.5 py-1 border rounded text-right font-mono disabled:bg-slate-100 disabled:text-slate-400"
                />
                <span className="text-slate-500">m</span>
              </div>
              <div className="flex items-center gap-1 text-xs flex-wrap">
                <span className="text-slate-600 w-14">回転</span>
                <input
                  type="number"
                  value={sfcRotDeg}
                  onChange={(e) => setSfcRotDeg(parseFloat(e.target.value) || 0)}
                  step="1"
                  className="w-16 px-1.5 py-1 border rounded text-right font-mono"
                />
                <span className="text-slate-500">°</span>
                <input
                  type="number"
                  value={sfcRotMin}
                  onChange={(e) => setSfcRotMin(parseFloat(e.target.value) || 0)}
                  min="0"
                  max="59"
                  step="1"
                  className="w-14 px-1.5 py-1 border rounded text-right font-mono"
                />
                <span className="text-slate-500">'</span>
                <input
                  type="number"
                  value={sfcRotSec}
                  onChange={(e) => setSfcRotSec(parseFloat(e.target.value) || 0)}
                  min="0"
                  max="59.99"
                  step="0.1"
                  className="w-16 px-1.5 py-1 border rounded text-right font-mono"
                />
                <span className="text-slate-500">"</span>
              </div>
            </div>
          </section>

          {/* 文字サイズ */}
          <section className="border rounded p-3 bg-slate-50">
            <h3 className="text-xs font-bold text-slate-700 mb-2">文字サイズ</h3>
            <div className="flex items-center gap-4 flex-wrap text-xs">
              <label className="flex items-center gap-2">
                <span className="text-slate-600">文字サイズ</span>
                <input
                  type="number"
                  value={moji}
                  onChange={(e) => setMoji(parseFloat(e.target.value) || 0)}
                  step="0.1"
                  min="0.1"
                  className="w-20 px-1.5 py-1 border rounded text-right font-mono"
                />
                <span className="text-slate-500">mm</span>
              </label>
              <label className="flex items-center gap-2">
                <span className="text-slate-600">配線番号サイズ</span>
                <input
                  type="number"
                  value={pipeNumberSize}
                  onChange={(e) => setPipeNumberSize(parseFloat(e.target.value) || 0)}
                  step="0.1"
                  min="0.1"
                  className="w-20 px-1.5 py-1 border rounded text-right font-mono"
                />
                <span className="text-slate-500">mm</span>
              </label>
            </div>
          </section>

          {/* 要素選択 */}
          <section className="border rounded p-3 bg-slate-50">
            <h3 className="text-xs font-bold text-slate-700 mb-2">要素選択</h3>
            <div className="grid grid-cols-3 gap-y-1.5 gap-x-3 text-xs">
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={sfcIncPipeShapes}
                  onChange={(e) => setSfcIncPipeShapes(e.target.checked)}
                />
                <span>配線</span>
              </label>
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={sfcIncTransitions}
                  onChange={(e) => setSfcIncTransitions(e.target.checked)}
                />
                <span>記号 (管種切替)</span>
              </label>
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={sfcIncPipeNumbers}
                  onChange={(e) => setSfcIncPipeNumbers(e.target.checked)}
                />
                <span>配線番号</span>
              </label>
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={sfcIncPointNames}
                  onChange={(e) => setSfcIncPointNames(e.target.checked)}
                />
                <span>点名</span>
              </label>
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={sfcIncGround}
                  onChange={(e) => setSfcIncGround(e.target.checked)}
                />
                <span>地盤高</span>
              </label>
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={sfcIncPlanned}
                  onChange={(e) => setSfcIncPlanned(e.target.checked)}
                />
                <span>計画高</span>
              </label>
              <label
                className="flex items-center gap-1.5"
                title="ON: 標準切深 (吸水 0.8m / 集水 0.9m) と異なる測点のみ切深を出力 (旧マクロと同仕様)。OFF: 全ての測点で切深を出す"
              >
                <input
                  type="checkbox"
                  checked={sfcIncCutDepth}
                  onChange={(e) => setSfcIncCutDepth(e.target.checked)}
                />
                <span>切深</span>
                <label className="flex items-center gap-1 ml-1 text-slate-500">
                  <input
                    type="checkbox"
                    checked={sfcCutDepthOnlyIfDiff}
                    onChange={(e) => setSfcCutDepthOnlyIfDiff(e.target.checked)}
                    disabled={!sfcIncCutDepth}
                  />
                  <span className="text-xs">標準と差のみ</span>
                </label>
              </label>
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={sfcIncSlope}
                  onChange={(e) => setSfcIncSlope(e.target.checked)}
                />
                <span>勾配</span>
              </label>
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={sfcIncDistance}
                  onChange={(e) => setSfcIncDistance(e.target.checked)}
                />
                <span>距離</span>
              </label>
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={sfcIncDiameter}
                  onChange={(e) => setSfcIncDiameter(e.target.checked)}
                />
                <span>管径</span>
              </label>
            </div>
          </section>

          <div className="text-xs text-slate-500">
            TrendOne アスキー形式 (Shift-JIS)、縮尺 1/1000 で出力します。
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-6">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm border rounded hover:bg-slate-50"
          >
            キャンセル
          </button>
          <button
            onClick={handleSfcDownload}
            disabled={pipes.length === 0}
            className="px-4 py-2 text-sm bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:opacity-50 flex items-center gap-2"
          >
            <Download className="h-4 w-4" />
            出力
          </button>
        </div>
      </div>
    </div>
  )
}
