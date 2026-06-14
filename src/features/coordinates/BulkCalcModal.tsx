// 一括座標計算モーダル。
// フロー:
//   ① 計算種別を選択（スライド / ヘルマート / アフィン / 世界測地系 / PatchJGD / ジオイド）
//   ② 選択した種別のパラメータを入力 → 「上書き」or「新規登録」して反映
//
// 計算結果の反映方法は全種別で共通:
//   ・上書き  : 各点の x/y/z を updateCoordinate 経由で pendingChanges に積む（保存ボタンで commit）
//   ・新規登録: 元点はそのまま、別レコードとして importCoordinates。点名衝突を避けるため
//              頭文字 + 元点名 + 末尾文字 の形でリネーム（最低どちらか必須）
//
// 現状実装済みの種別:
//   ・slide   : 平行移動 (dx/dy/dz 加算)
//   ・helmert : 2D 4 パラメータ Helmert (Tx, Ty, スケール m, 回転 θ)
//
// 残り (affine / world_geodetic / patch_jgd / geoid) はカードに「実装予定」を出して
// 選択不可。順次このファイルに追加していく想定。

import { useState } from 'react'
import { Calculator, X, ArrowLeft, Check, Loader2, Move, RotateCw, Grid3x3, Globe, Map as MapIcon, Layers } from 'lucide-react'
import type { CoordinateRow } from '@/stores/coordinateStore'
import type { CoordinateType } from '@/types/database'

// ------------------------------------------------------------------ types

type CalcMethod = 'slide' | 'helmert' | 'affine' | 'world_geodetic' | 'patch_jgd' | 'geoid'

interface MethodMeta {
  key: CalcMethod
  label: string
  description: string
  icon: React.ComponentType<{ className?: string }>
  implemented: boolean
}

const METHODS: MethodMeta[] = [
  {
    key: 'slide',
    label: 'スライド（平行移動）',
    description: '選択した点に dX / dY / dZ を加算',
    icon: Move,
    implemented: true,
  },
  {
    key: 'helmert',
    label: 'ヘルマート変換',
    description: '2D 4 パラメータ（並進 + 縮尺 + 回転）',
    icon: RotateCw,
    implemented: true,
  },
  {
    key: 'affine',
    label: 'アフィン変換',
    description: '2D 6 パラメータ（並進 + 線形変換）',
    icon: Grid3x3,
    implemented: false,
  },
  {
    key: 'world_geodetic',
    label: '世界測地系変換',
    description: '日本測地系 (Tokyo) ⇔ JGD2000 / JGD2011',
    icon: Globe,
    implemented: false,
  },
  {
    key: 'patch_jgd',
    label: 'PatchJGD',
    description: '地殻変動補正（PatchJGD グリッド）',
    icon: MapIcon,
    implemented: false,
  },
  {
    key: 'geoid',
    label: 'ジオイド補正',
    description: '楕円体高 ⇔ 標高（ジオイドモデルによる）',
    icon: Layers,
    implemented: false,
  },
]

// ------------------------------------------------------------------ helpers

/** 入力した文字列を数値化。空文字は null（z 据え置きで使う） */
function parseOptional(s: string): number | null {
  const t = s.trim()
  if (t === '') return null
  const n = parseFloat(t)
  return Number.isNaN(n) ? null : n
}

/** 入力した文字列を数値化。0 を含む有効な数値か */
function parseRequired(s: string): number | null {
  const t = s.trim()
  if (t === '') return null
  const n = parseFloat(t)
  return Number.isNaN(n) ? null : n
}

interface OverwriteUpdate {
  id: string
  x: number
  y: number
  z: number | null | undefined
}

interface NewCoordInput {
  pointNumber: string
  x: number
  y: number
  z: number | null
  type: CoordinateType
  stakeType?: string | null
}

// ------------------------------------------------------------------ main

export function BulkCalcModal({
  selectedCoords,
  onClose,
  onOverwrite,
  onCreateNew,
}: {
  selectedCoords: CoordinateRow[]
  onClose: () => void
  onOverwrite: (updates: OverwriteUpdate[]) => void
  onCreateNew: (coords: NewCoordInput[]) => Promise<void> | void
}) {
  const [step, setStep] = useState<'select' | 'configure'>('select')
  const [method, setMethod] = useState<CalcMethod | null>(null)

  const selectedMeta = method ? METHODS.find((m) => m.key === method) ?? null : null

  // ステップ ①: 計算種別の選択
  if (step === 'select') {
    return (
      <ModalShell
        title="一括座標計算"
        subtitle={`${selectedCoords.length} 点が対象です。計算種別を選んでください。`}
        onClose={onClose}
      >
        <div className="grid grid-cols-2 gap-2">
          {METHODS.map((m) => {
            const Icon = m.icon
            return (
              <button
                key={m.key}
                type="button"
                disabled={!m.implemented}
                onClick={() => {
                  if (!m.implemented) return
                  setMethod(m.key)
                  setStep('configure')
                }}
                className={`text-left border rounded p-3 transition-colors ${
                  m.implemented
                    ? 'hover:bg-blue-50 hover:border-blue-300 cursor-pointer'
                    : 'opacity-50 bg-slate-50 cursor-not-allowed'
                }`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <Icon className="h-4 w-4 text-blue-600" />
                  <span className="font-semibold text-sm">{m.label}</span>
                  {!m.implemented && (
                    <span className="ml-auto text-[10px] text-slate-400 border border-slate-300 rounded px-1">
                      実装予定
                    </span>
                  )}
                </div>
                <div className="text-xs text-slate-500">{m.description}</div>
              </button>
            )
          })}
        </div>
      </ModalShell>
    )
  }

  // ステップ ②: パラメータ入力 / 反映
  return (
    <ModalShell
      title="一括座標計算"
      subtitle={`${selectedCoords.length} 点が対象 — ${selectedMeta?.label ?? ''}`}
      onClose={onClose}
      onBack={() => {
        setStep('select')
        setMethod(null)
      }}
    >
      {method === 'slide' && (
        <SlidePanel
          selectedCoords={selectedCoords}
          onClose={onClose}
          onOverwrite={onOverwrite}
          onCreateNew={onCreateNew}
        />
      )}
      {method === 'helmert' && (
        <HelmertPanel
          selectedCoords={selectedCoords}
          onClose={onClose}
          onOverwrite={onOverwrite}
          onCreateNew={onCreateNew}
        />
      )}
      {/* 他は未実装。METHODS 側で選択不可なので通常ここには来ない */}
    </ModalShell>
  )
}

// ------------------------------------------------------------------ shell

function ModalShell({
  title,
  subtitle,
  onClose,
  onBack,
  children,
}: {
  title: string
  subtitle?: string
  onClose: () => void
  onBack?: () => void
  children: React.ReactNode
}) {
  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-[9999] p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-lg shadow-xl w-full max-w-lg flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b flex items-center gap-2">
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              className="p-1 text-slate-500 hover:text-slate-800 rounded"
              title="計算種別の選択へ戻る"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
          )}
          <Calculator className="h-4 w-4 text-blue-600" />
          <h3 className="flex-1 text-base font-semibold">{title}</h3>
          <button onClick={onClose} className="p-1 text-slate-400 hover:text-slate-700 rounded">
            <X className="h-5 w-5" />
          </button>
        </div>
        {subtitle && (
          <div className="px-4 py-2 bg-blue-50 text-xs text-blue-700 border-b">{subtitle}</div>
        )}
        <div className="flex-1 overflow-auto">{children}</div>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ common output controls

/** 「上書き / 新規登録」の切替 + リネーム + 適用ボタンを共通ブロックとして提供 */
function OutputControls({
  mode,
  setMode,
  prefix,
  setPrefix,
  suffix,
  setSuffix,
  canApply,
  applying,
  onCancel,
  onApply,
}: {
  mode: 'overwrite' | 'new'
  setMode: (m: 'overwrite' | 'new') => void
  prefix: string
  setPrefix: (s: string) => void
  suffix: string
  setSuffix: (s: string) => void
  canApply: boolean
  applying: boolean
  onCancel: () => void
  onApply: () => void
}) {
  return (
    <>
      <div className="space-y-1 px-4 pb-2">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            checked={mode === 'overwrite'}
            onChange={() => setMode('overwrite')}
          />
          <span>既存座標を上書き</span>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            checked={mode === 'new'}
            onChange={() => setMode('new')}
          />
          <span>新規座標として登録（元の点は残す）</span>
        </label>
      </div>

      {mode === 'new' && (
        <div className="mx-4 mb-3 border rounded p-3 bg-slate-50 space-y-2">
          <div className="text-xs text-slate-600">
            新しい点名は <code className="text-blue-700">頭文字 + 元の点名 + 末尾文字</code> になります。
            頭文字 / 末尾文字 の少なくとも片方を入力してください（点名衝突を避けるため）。
          </div>
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-slate-600">頭文字</span>
              <input
                type="text"
                value={prefix}
                onChange={(e) => setPrefix(e.target.value)}
                placeholder="例: N_"
                className="px-2 py-1 text-sm border rounded"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-slate-600">末尾文字</span>
              <input
                type="text"
                value={suffix}
                onChange={(e) => setSuffix(e.target.value)}
                placeholder="例: '  / _new"
                className="px-2 py-1 text-sm border rounded"
              />
            </label>
          </div>
        </div>
      )}

      <div className="px-4 py-3 border-t flex justify-end gap-2">
        <button
          onClick={onCancel}
          disabled={applying}
          className="px-3 py-1.5 text-sm border rounded hover:bg-slate-50 disabled:opacity-50"
        >
          キャンセル
        </button>
        <button
          onClick={onApply}
          disabled={!canApply}
          className="flex items-center gap-1 px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
        >
          {applying ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Check className="h-3.5 w-3.5" />
          )}
          {mode === 'overwrite' ? '上書き計算' : '新規登録'}
        </button>
      </div>
    </>
  )
}

// ------------------------------------------------------------------ slide panel

function SlidePanel({
  selectedCoords,
  onClose,
  onOverwrite,
  onCreateNew,
}: {
  selectedCoords: CoordinateRow[]
  onClose: () => void
  onOverwrite: (updates: OverwriteUpdate[]) => void
  onCreateNew: (coords: NewCoordInput[]) => Promise<void> | void
}) {
  const [dx, setDx] = useState('0')
  const [dy, setDy] = useState('0')
  const [dz, setDz] = useState('')
  const [mode, setMode] = useState<'overwrite' | 'new'>('overwrite')
  const [prefix, setPrefix] = useState('')
  const [suffix, setSuffix] = useState("'")
  const [applying, setApplying] = useState(false)

  const dxNum = parseRequired(dx)
  const dyNum = parseRequired(dy)
  const dzNum = parseOptional(dz)
  const numericsValid = dxNum !== null && dyNum !== null && (dz.trim() === '' || dzNum !== null)
  const allZero = (dxNum ?? 0) === 0 && (dyNum ?? 0) === 0 && (dzNum ?? 0) === 0
  const renameOk = mode !== 'new' || prefix.trim() !== '' || suffix.trim() !== ''
  const canApply =
    numericsValid &&
    selectedCoords.length > 0 &&
    renameOk &&
    !(mode === 'overwrite' && allZero) &&
    !applying

  const transformXY = (c: CoordinateRow) => ({
    x: c.x + (dxNum ?? 0),
    y: c.y + (dyNum ?? 0),
    z: dzNum === null ? c.z : (c.z ?? 0) + dzNum,
  })

  const sample = selectedCoords[0]
  const samplePreview = sample ? transformXY(sample) : null

  const apply = async () => {
    if (!canApply) return
    setApplying(true)
    try {
      if (mode === 'overwrite') {
        const updates = selectedCoords.map((c) => ({ id: c.id, ...transformXY(c) }))
        onOverwrite(updates)
      } else {
        const pre = prefix.trim()
        const suf = suffix.trim()
        const newCoords = selectedCoords.map<NewCoordInput>((c) => {
          const t = transformXY(c)
          return {
            pointNumber: `${pre}${c.pointNumber}${suf}`,
            x: t.x,
            y: t.y,
            z: t.z ?? null,
            type: c.type,
            stakeType: c.stakeType,
          }
        })
        await onCreateNew(newCoords)
      }
    } finally {
      setApplying(false)
    }
  }

  return (
    <div className="space-y-4 pt-4">
      <div className="px-4 grid grid-cols-3 gap-2">
        {([
          ['dX (北方向)', dx, setDx, '0'],
          ['dY (東方向)', dy, setDy, '0'],
          ['dZ (空欄なら据え置き)', dz, setDz, ''],
        ] as const).map(([label, val, setter, placeholder]) => (
          <label key={label} className="flex flex-col gap-1 text-xs">
            <span className="text-slate-600">{label}</span>
            <input
              type="text"
              inputMode="decimal"
              value={val}
              onChange={(e) => setter(e.target.value)}
              placeholder={placeholder}
              className="px-2 py-1 text-sm border rounded"
            />
          </label>
        ))}
      </div>

      {sample && samplePreview && (
        <PreviewBlock
          source={sample}
          newPointName={
            mode === 'new' ? `${prefix.trim()}${sample.pointNumber}${suffix.trim()}` : sample.pointNumber
          }
          newX={samplePreview.x}
          newY={samplePreview.y}
          newZ={samplePreview.z}
        />
      )}

      <div className="px-4 space-y-1">
        {!numericsValid && (
          <div className="text-xs text-red-600">dX / dY / dZ に数値以外が入っています。</div>
        )}
        {mode === 'overwrite' && allZero && (
          <div className="text-xs text-amber-600">
            上書きモードでは dX / dY / dZ のいずれかに非ゼロを指定してください。
          </div>
        )}
        {mode === 'new' && !renameOk && (
          <div className="text-xs text-amber-600">頭文字 / 末尾文字 のどちらかを入力してください。</div>
        )}
      </div>

      <OutputControls
        mode={mode}
        setMode={setMode}
        prefix={prefix}
        setPrefix={setPrefix}
        suffix={suffix}
        setSuffix={setSuffix}
        canApply={canApply}
        applying={applying}
        onCancel={onClose}
        onApply={apply}
      />
    </div>
  )
}

// ------------------------------------------------------------------ helmert panel

/** 2D 4 パラメータ ヘルマート変換:
 *    X' = a*X - b*Y + Tx
 *    Y' = b*X + a*Y + Ty   ( a = m*cos(θ), b = m*sin(θ) )
 *
 *  パラメータ入力モードのみ対応（共通点からの最小二乗フィッティングは後続で追加）。
 *  Z は基本的に変化させない。dZ 入力欄のみ用意し、空欄なら据え置き / 数値なら加算。
 *
 *  回転 θ は度（degrees, ±360）で入力。スケール m は無次元（既定 1.0）。
 *  Tx / Ty の単位は座標と同じ（m）。
 */
function HelmertPanel({
  selectedCoords,
  onClose,
  onOverwrite,
  onCreateNew,
}: {
  selectedCoords: CoordinateRow[]
  onClose: () => void
  onOverwrite: (updates: OverwriteUpdate[]) => void
  onCreateNew: (coords: NewCoordInput[]) => Promise<void> | void
}) {
  const [tx, setTx] = useState('0')
  const [ty, setTy] = useState('0')
  const [scale, setScale] = useState('1')
  const [thetaDeg, setThetaDeg] = useState('0')
  const [dz, setDz] = useState('')
  const [mode, setMode] = useState<'overwrite' | 'new'>('overwrite')
  const [prefix, setPrefix] = useState('')
  const [suffix, setSuffix] = useState("'")
  const [applying, setApplying] = useState(false)

  const txNum = parseRequired(tx)
  const tyNum = parseRequired(ty)
  const scaleNum = parseRequired(scale)
  const thetaNum = parseRequired(thetaDeg)
  const dzNum = parseOptional(dz)
  const numericsValid =
    txNum !== null &&
    tyNum !== null &&
    scaleNum !== null &&
    scaleNum > 0 &&
    thetaNum !== null &&
    (dz.trim() === '' || dzNum !== null)

  // 「何も変えない」入力（恒等変換）は上書きモードでは無効
  const isIdentity =
    (txNum ?? 0) === 0 &&
    (tyNum ?? 0) === 0 &&
    (scaleNum ?? 1) === 1 &&
    (thetaNum ?? 0) === 0 &&
    (dzNum ?? 0) === 0

  const renameOk = mode !== 'new' || prefix.trim() !== '' || suffix.trim() !== ''
  const canApply =
    numericsValid &&
    selectedCoords.length > 0 &&
    renameOk &&
    !(mode === 'overwrite' && isIdentity) &&
    !applying

  const thetaRad = (thetaNum ?? 0) * (Math.PI / 180)
  const a = (scaleNum ?? 1) * Math.cos(thetaRad)
  const b = (scaleNum ?? 1) * Math.sin(thetaRad)

  const transformXY = (c: CoordinateRow) => ({
    x: a * c.x - b * c.y + (txNum ?? 0),
    y: b * c.x + a * c.y + (tyNum ?? 0),
    z: dzNum === null ? c.z : (c.z ?? 0) + dzNum,
  })

  const sample = selectedCoords[0]
  const samplePreview = sample ? transformXY(sample) : null

  const apply = async () => {
    if (!canApply) return
    setApplying(true)
    try {
      if (mode === 'overwrite') {
        const updates = selectedCoords.map((c) => ({ id: c.id, ...transformXY(c) }))
        onOverwrite(updates)
      } else {
        const pre = prefix.trim()
        const suf = suffix.trim()
        const newCoords = selectedCoords.map<NewCoordInput>((c) => {
          const t = transformXY(c)
          return {
            pointNumber: `${pre}${c.pointNumber}${suf}`,
            x: t.x,
            y: t.y,
            z: t.z ?? null,
            type: c.type,
            stakeType: c.stakeType,
          }
        })
        await onCreateNew(newCoords)
      }
    } finally {
      setApplying(false)
    }
  }

  return (
    <div className="space-y-4 pt-4">
      <div className="px-4 text-xs text-slate-500">
        式: <code className="text-slate-700">X' = a·X − b·Y + Tx</code>,{' '}
        <code className="text-slate-700">Y' = b·X + a·Y + Ty</code>{' '}
        (<code className="text-slate-700">a = m·cosθ, b = m·sinθ</code>)
      </div>
      <div className="px-4 grid grid-cols-2 gap-2">
        {([
          ['Tx (m)', tx, setTx, '並進量 X 方向'],
          ['Ty (m)', ty, setTy, '並進量 Y 方向'],
          ['スケール m', scale, setScale, '既定 1.0（無次元）'],
          ['回転 θ (度)', thetaDeg, setThetaDeg, '反時計回り +'],
        ] as const).map(([label, val, setter, hint]) => (
          <label key={label} className="flex flex-col gap-1 text-xs">
            <span className="text-slate-600">{label}</span>
            <input
              type="text"
              inputMode="decimal"
              value={val}
              onChange={(e) => setter(e.target.value)}
              className="px-2 py-1 text-sm border rounded"
            />
            <span className="text-[10px] text-slate-400">{hint}</span>
          </label>
        ))}
      </div>

      <div className="px-4">
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-slate-600">dZ (空欄なら据え置き)</span>
          <input
            type="text"
            inputMode="decimal"
            value={dz}
            onChange={(e) => setDz(e.target.value)}
            placeholder=""
            className="px-2 py-1 text-sm border rounded"
          />
        </label>
      </div>

      {sample && samplePreview && (
        <PreviewBlock
          source={sample}
          newPointName={
            mode === 'new' ? `${prefix.trim()}${sample.pointNumber}${suffix.trim()}` : sample.pointNumber
          }
          newX={samplePreview.x}
          newY={samplePreview.y}
          newZ={samplePreview.z}
        />
      )}

      <div className="px-4 space-y-1">
        {!numericsValid && (
          <div className="text-xs text-red-600">
            パラメータに数値以外、またはスケール ≤ 0 が含まれています。
          </div>
        )}
        {mode === 'overwrite' && numericsValid && isIdentity && (
          <div className="text-xs text-amber-600">
            すべて既定値（Tx=Ty=0, m=1, θ=0, dZ なし）なので変換結果は変わりません。
          </div>
        )}
        {mode === 'new' && !renameOk && (
          <div className="text-xs text-amber-600">頭文字 / 末尾文字 のどちらかを入力してください。</div>
        )}
      </div>

      <OutputControls
        mode={mode}
        setMode={setMode}
        prefix={prefix}
        setPrefix={setPrefix}
        suffix={suffix}
        setSuffix={setSuffix}
        canApply={canApply}
        applying={applying}
        onCancel={onClose}
        onApply={apply}
      />
    </div>
  )
}

// ------------------------------------------------------------------ preview block

function PreviewBlock({
  source,
  newPointName,
  newX,
  newY,
  newZ,
}: {
  source: CoordinateRow
  newPointName: string
  newX: number
  newY: number
  newZ: number | null | undefined
}) {
  const formatNum = (n: number) => n.toFixed(3)
  const formatZ = (z: number | null | undefined) =>
    z === null || z === undefined ? '—' : typeof z === 'number' ? z.toFixed(3) : String(z)
  return (
    <div className="mx-4 border-t pt-2 text-xs text-slate-600 space-y-0.5">
      <div className="font-medium text-slate-700">プレビュー（先頭 1 点）</div>
      <div>
        {source.pointNumber} →{' '}
        <span className="text-blue-700 font-mono">{newPointName}</span>
      </div>
      <div className="font-mono">
        X: {formatNum(source.x)} → {formatNum(newX)} ／ Y: {formatNum(source.y)} → {formatNum(newY)} ／ Z:{' '}
        {formatZ(source.z)} → {formatZ(newZ)}
      </div>
    </div>
  )
}
