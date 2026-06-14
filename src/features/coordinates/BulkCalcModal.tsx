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

import { useMemo, useState } from 'react'
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

// ------------------------------------------------------------------ 2D Helmert solver

/** 2D 4 パラメータ ヘルマート変換の最小二乗解。
 *
 *  モデル（日本の測量業界で一般的な符号 — X は北、Y は東、回転は時計回り正）:
 *      x' =  a·X + b·Y + x0
 *      y' = -b·X + a·Y + y0
 *      (a = m·cosθ,  b = m·sinθ)
 *
 *  各基準点 i について (X_i, Y_i) → (x'_i, y'_i) が既知。N >= 2 で解ける。
 *  N が 4 つの未知数より多いとき(>= 3)は過剰決定 → 正規方程式で最小二乗解を取る。
 */
interface HelmertCommonPoint {
  id: string
  X: number
  Y: number
  xp: number
  yp: number
}

interface HelmertResult {
  a: number
  b: number
  x0: number
  y0: number
  m: number       // 伸縮率 = sqrt(a²+b²)
  thetaRad: number // 回転角 (rad) = atan2(b, a)
  MX: number      // X 残差の二乗平均平方根
  MY: number      // Y 残差の二乗平均平方根
  residuals: Array<{ id: string; dx: number; dy: number }>
}

function solveHelmert2D(common: HelmertCommonPoint[]): HelmertResult | null {
  const N = common.length
  if (N < 2) return null
  // 正規方程式 AᵀA · p = Aᵀ·b  ( p = [a, b, x0, y0] )
  const AtA: number[][] = [
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]
  const Atb = [0, 0, 0, 0]
  for (const p of common) {
    // 行 1: x'_i = X·a + Y·b + 1·x0 + 0·y0
    const r1 = [p.X, p.Y, 1, 0]
    // 行 2: y'_i = (-X)·b + Y·a + 0·x0 + 1·y0
    //              = a·Y + b·(-X) + y0
    //   ⇒ 係数ベクトル [Y, -X, 0, 1]
    const r2 = [p.Y, -p.X, 0, 1]
    for (let j = 0; j < 4; j++) {
      Atb[j] += r1[j] * p.xp + r2[j] * p.yp
      for (let k = 0; k < 4; k++) {
        AtA[j][k] += r1[j] * r1[k] + r2[j] * r2[k]
      }
    }
  }
  const sol = solve4x4(AtA, Atb)
  if (!sol) return null
  const [a, b, x0, y0] = sol

  // 残差 (基準点に変換式を当ててみて、観測値との差)
  const residuals: Array<{ id: string; dx: number; dy: number }> = []
  let sumDxSq = 0
  let sumDySq = 0
  for (const p of common) {
    const xPred = a * p.X + b * p.Y + x0
    const yPred = -b * p.X + a * p.Y + y0
    const dx = p.xp - xPred
    const dy = p.yp - yPred
    residuals.push({ id: p.id, dx, dy })
    sumDxSq += dx * dx
    sumDySq += dy * dy
  }
  // 自由度: 観測 2N、未知数 4
  const dof = Math.max(1, 2 * N - 4)
  const MX = Math.sqrt(sumDxSq / dof)
  const MY = Math.sqrt(sumDySq / dof)
  return {
    a,
    b,
    x0,
    y0,
    m: Math.sqrt(a * a + b * b),
    thetaRad: Math.atan2(b, a),
    MX,
    MY,
    residuals,
  }
}

/** 4x4 連立一次方程式を部分ピボット付き Gauss 消去法で解く。特異なら null。 */
function solve4x4(A: number[][], b: number[]): number[] | null {
  const n = 4
  const M: number[][] = []
  for (let i = 0; i < n; i++) M.push([...A[i], b[i]])
  for (let i = 0; i < n; i++) {
    // 部分ピボット
    let maxRow = i
    let maxAbs = Math.abs(M[i][i])
    for (let r = i + 1; r < n; r++) {
      const v = Math.abs(M[r][i])
      if (v > maxAbs) {
        maxAbs = v
        maxRow = r
      }
    }
    if (maxAbs < 1e-12) return null
    if (maxRow !== i) {
      const tmp = M[i]
      M[i] = M[maxRow]
      M[maxRow] = tmp
    }
    // 前進消去
    for (let r = i + 1; r < n; r++) {
      const factor = M[r][i] / M[i][i]
      for (let c = i; c <= n; c++) M[r][c] -= factor * M[i][c]
    }
  }
  // 後退代入
  const x = new Array<number>(n)
  for (let i = n - 1; i >= 0; i--) {
    let s = M[i][n]
    for (let j = i + 1; j < n; j++) s -= M[i][j] * x[j]
    x[i] = s / M[i][i]
  }
  return x
}

/** ラジアン → 「DD-MM-SS」フォーマット（例: 37-09-48）。負数は先頭に "-"。 */
function formatDMS(rad: number): string {
  const deg = (rad * 180) / Math.PI
  const sign = deg < 0 ? '-' : ''
  const abs = Math.abs(deg)
  let d = Math.floor(abs)
  let mDec = (abs - d) * 60
  let m = Math.floor(mDec)
  let s = Math.round((mDec - m) * 60)
  if (s === 60) {
    s = 0
    m += 1
  }
  if (m === 60) {
    m = 0
    d += 1
  }
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${sign}${d}-${pad(m)}-${pad(s)}`
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
        className="bg-white rounded-lg shadow-xl w-full max-w-3xl flex flex-col max-h-[90vh]"
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

/** 2D 4 パラメータ ヘルマート変換（測量業界の符号慣習）:
 *    x = a·X + b·Y + x0
 *    y = -b·X + a·Y + y0   ( a = m·cosθ, b = m·sinθ )
 *
 *  パラメータは選択点の中の「基準点」 (2 点以上) の "変換後 X' / Y'" を入力させ、
 *  最小二乗で a, b, x0, y0 を解いて求める。
 *  算出されたパラメータを 選択中の全点 に適用する。
 *  Z 軸は通常変化させないので、dZ を別フィールドで オプション加算（空欄なら据え置き）。
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
  // 各座標点ごとの「基準点フラグ + 変換後 X'/Y' 入力」
  const [basis, setBasis] = useState<Map<string, { isBasis: boolean; xp: string; yp: string }>>(
    () => new Map(),
  )
  const [dz, setDz] = useState('')
  const [mode, setMode] = useState<'overwrite' | 'new'>('overwrite')
  const [prefix, setPrefix] = useState('')
  const [suffix, setSuffix] = useState("'")
  const [applying, setApplying] = useState(false)

  const updateBasis = (
    id: string,
    patch: Partial<{ isBasis: boolean; xp: string; yp: string }>,
  ) => {
    setBasis((prev) => {
      const next = new Map(prev)
      const cur = next.get(id) ?? { isBasis: false, xp: '', yp: '' }
      next.set(id, { ...cur, ...patch })
      return next
    })
  }

  // 入力済みの基準点だけ集める（チェック ON + xp/yp が両方とも数値）
  const commonPoints = useMemo<HelmertCommonPoint[]>(() => {
    const out: HelmertCommonPoint[] = []
    for (const c of selectedCoords) {
      const d = basis.get(c.id)
      if (!d?.isBasis) continue
      const xp = parseRequired(d.xp)
      const yp = parseRequired(d.yp)
      if (xp === null || yp === null) continue
      out.push({ id: c.id, X: c.x, Y: c.y, xp, yp })
    }
    return out
  }, [selectedCoords, basis])

  const calc = useMemo(() => solveHelmert2D(commonPoints), [commonPoints])
  const residByCoordId = useMemo(() => {
    const m = new Map<string, { dx: number; dy: number }>()
    if (calc) for (const r of calc.residuals) m.set(r.id, { dx: r.dx, dy: r.dy })
    return m
  }, [calc])

  const dzNum = parseOptional(dz)
  const dzValid = dz.trim() === '' || dzNum !== null

  const renameOk = mode !== 'new' || prefix.trim() !== '' || suffix.trim() !== ''
  const canApply =
    calc !== null && selectedCoords.length > 0 && renameOk && dzValid && !applying

  const transformXY = (c: CoordinateRow) => {
    if (!calc) return { x: c.x, y: c.y, z: c.z }
    const { a, b, x0, y0 } = calc
    return {
      x: a * c.x + b * c.y + x0,
      y: -b * c.x + a * c.y + y0,
      z: dzNum === null ? c.z : (c.z ?? 0) + dzNum,
    }
  }

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

  // 基準点として入力済みのチェック行数（パラメータ未確定の "isBasis ON だが値未入力" も含めて表示用）
  const checkedCount = Array.from(basis.values()).filter((v) => v.isBasis).length

  return (
    <div className="space-y-3 pt-3">
      <div className="px-4 text-xs text-slate-600">
        計算式: <code className="text-slate-700">x = a·X + b·Y + x0</code> ／
        <code className="text-slate-700"> y = −b·X + a·Y + y0</code>
      </div>
      <div className="px-4 text-xs text-slate-500">
        選択中 {selectedCoords.length} 点のうち、変換後座標が分かっている点を 2 点以上
        「基準点」にチェックして変換後 X'/Y' を入力してください。算出したパラメータを
        選択中の全点に適用します。
      </div>

      {/* 点リスト + 基準点入力 */}
      <div className="mx-4 border rounded overflow-hidden">
        <div className="max-h-72 overflow-auto">
          <table className="w-full text-[11px]">
            <thead className="bg-slate-100 sticky top-0">
              <tr>
                <th className="px-1 py-1 text-center w-8">基準</th>
                <th className="px-1 py-1 text-left">点名</th>
                <th className="px-1 py-1 text-right">X</th>
                <th className="px-1 py-1 text-right">Y</th>
                <th className="px-1 py-1 text-right">変換後 X'</th>
                <th className="px-1 py-1 text-right">変換後 Y'</th>
                <th className="px-1 py-1 text-right">DX</th>
                <th className="px-1 py-1 text-right">DY</th>
              </tr>
            </thead>
            <tbody>
              {selectedCoords.map((c) => {
                const d = basis.get(c.id) ?? { isBasis: false, xp: '', yp: '' }
                const r = residByCoordId.get(c.id)
                return (
                  <tr key={c.id} className={d.isBasis ? 'bg-blue-50/60' : 'hover:bg-slate-50'}>
                    <td className="px-1 py-0.5 text-center">
                      <input
                        type="checkbox"
                        checked={d.isBasis}
                        onChange={(e) => updateBasis(c.id, { isBasis: e.target.checked })}
                      />
                    </td>
                    <td className="px-1 py-0.5 font-mono">{c.pointNumber}</td>
                    <td className="px-1 py-0.5 text-right font-mono">{c.x.toFixed(3)}</td>
                    <td className="px-1 py-0.5 text-right font-mono">{c.y.toFixed(3)}</td>
                    <td className="px-1 py-0.5 text-right">
                      {d.isBasis ? (
                        <input
                          type="text"
                          inputMode="decimal"
                          value={d.xp}
                          onChange={(e) => updateBasis(c.id, { xp: e.target.value })}
                          className="w-24 px-1 py-0.5 border rounded text-right font-mono"
                        />
                      ) : (
                        <span className="text-slate-300">—</span>
                      )}
                    </td>
                    <td className="px-1 py-0.5 text-right">
                      {d.isBasis ? (
                        <input
                          type="text"
                          inputMode="decimal"
                          value={d.yp}
                          onChange={(e) => updateBasis(c.id, { yp: e.target.value })}
                          className="w-24 px-1 py-0.5 border rounded text-right font-mono"
                        />
                      ) : (
                        <span className="text-slate-300">—</span>
                      )}
                    </td>
                    <td className="px-1 py-0.5 text-right font-mono text-slate-600">
                      {r ? r.dx.toFixed(3) : ''}
                    </td>
                    <td className="px-1 py-0.5 text-right font-mono text-slate-600">
                      {r ? r.dy.toFixed(3) : ''}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <div className="px-2 py-1 bg-slate-50 border-t text-[10px] text-slate-500">
          基準点 {checkedCount} 点指定中 ／ 計算に使用できているのは {commonPoints.length} 点
          （変換後 X'/Y' が両方とも数値で入っている点）
        </div>
      </div>

      {/* 算出パラメータ表示 */}
      {calc ? (
        <div className="mx-4 border rounded p-2 bg-slate-50 text-xs">
          <div className="font-medium text-slate-700 mb-1">変換パラメータ（最小二乗解）</div>
          <div className="grid grid-cols-2 gap-x-3 font-mono">
            <div>a = {calc.a.toFixed(9)}</div>
            <div>b = {calc.b.toFixed(9)}</div>
            <div>x0 = {calc.x0.toFixed(3)}</div>
            <div>y0 = {calc.y0.toFixed(3)}</div>
            <div>伸縮率 m = {calc.m.toFixed(9)}</div>
            <div>回転角 θ = {formatDMS(calc.thetaRad)}</div>
            <div>MX = {calc.MX.toFixed(5)}</div>
            <div>MY = {calc.MY.toFixed(5)}</div>
          </div>
        </div>
      ) : (
        <div className="mx-4 text-xs text-amber-600">
          基準点を 2 点以上指定し、変換後 X'/Y' を入力するとパラメータが計算されます。
        </div>
      )}

      {/* Z シフト（任意） */}
      <div className="px-4">
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-slate-600">dZ (空欄なら据え置き、数値なら加算)</span>
          <input
            type="text"
            inputMode="decimal"
            value={dz}
            onChange={(e) => setDz(e.target.value)}
            className="px-2 py-1 text-sm border rounded"
          />
        </label>
      </div>

      <div className="px-4 space-y-1">
        {!dzValid && <div className="text-xs text-red-600">dZ に数値以外が入っています。</div>}
        {calc && mode === 'new' && !renameOk && (
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
