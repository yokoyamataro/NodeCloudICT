// 座標計算モーダル: 交点計算 / 線上計算 / 2点距離。
// - 交点・線上: 既存座標から点・線を選び、結果を新規点として追加
// - 2点距離   : 起点→終点の平面距離と方向角（度分秒）を表示（座標追加はしない）
import { useEffect, useMemo, useRef, useState } from 'react'
import { X, Calculator, MapPin, Ruler } from 'lucide-react'
import { intersectionCalc, onLineCalc, len, type XY } from '@/lib/coordCalc'

export interface CalcCoordinate {
  id: string
  pointNumber: string
  x: number
  y: number
}

/** 地図で 直接 選んだ 線分 (地番の 辺 / ペイントの 線分)。座標は 平面直角座標 */
export interface CalcPickedLine {
  label: string
  a: XY
  b: XY
}

/** 今 選ばれている もの。地図に 出す ため 親へ 渡す */
export interface CalcSelection {
  lines: { key: string; label: string; a: XY; b: XY }[]
  points: { key: string; label: string; x: number; y: number }[]
}

interface Props {
  coordinates: CalcCoordinate[]
  typeOptions: { code: string; label: string }[]
  defaultType: string
  onAdd: (p: { pointNumber: string; x: number; y: number; type: string }) => void
  onClose: () => void
  /** 地図からの点選択を要求する。assign に座標IDを渡すと確定。null でキャンセル/解除 */
  onPickRequest?: (assign: ((coordId: string) => void) | null) => void
  /** 地図からの境界線選択を要求する。assign に辺の2点座標IDを渡すと確定。null でキャンセル/解除 */
  onLineRequest?: (assign: ((id1: string, id2: string) => void) | null) => void
  /**
   * 置き方。'center' は 画面中央の モーダル (既定、PC)。
   * 'bottom' は 画面下端に 貼り付く パネル (スマホ)。 暗幕は 出さず、
   * 余白と 文字を 詰めて 地図が 隠れないように する。
   */
  placement?: 'center' | 'bottom'
  /**
   * 地図の 線 (地番の 辺 / ペイントの 線分) を 直接 選ばせる。
   * 既存座標の 2 点に 縛られない ので、登録していない 線とも 交点が 出せる。
   */
  onGeomLineRequest?: (assign: ((line: CalcPickedLine) => void) | null) => void
  /** 選択中の 点 / 線 と 計算結果 を 地図に 出す ため の 通知 */
  onSelectionChange?: (sel: CalcSelection) => void
}

type Mode = 'intersection' | 'online' | 'distance'

// 度分秒表記
function formatDMS(deg: number): string {
  const sign = deg < 0 ? '-' : ''
  const abs = Math.abs(deg)
  const d = Math.floor(abs)
  const mFrac = (abs - d) * 60
  const m = Math.floor(mFrac)
  const s = (mFrac - m) * 60
  return `${sign}${d}°${String(m).padStart(2, '0')}′${s.toFixed(2)}″`
}

// 平面直角座標 (x=北, y=東) 上で起点→終点の方向角（北から時計回り、0..360）
function bearingDeg(a: XY, b: XY): number {
  const dN = b.x - a.x
  const dE = b.y - a.y
  if (dN === 0 && dE === 0) return 0
  const rad = Math.atan2(dE, dN)
  return ((rad * 180) / Math.PI + 360) % 360
}

export function CoordinateCalcModal({ coordinates, typeOptions, defaultType, onAdd, onClose, onPickRequest, onLineRequest, placement = 'center', onGeomLineRequest, onSelectionChange }: Props) {
  /** スマホ向け: 下端 に 貼り付け、余白を 詰める */
  const compact = placement === 'bottom'
  const [mode, setMode] = useState<Mode>('intersection')
  // 地図から選択中のスロット名（null=通常表示）
  const [pickingLabel, setPickingLabel] = useState<string | null>(null)
  const [pickingLineLabel, setPickingLineLabel] = useState<string | null>(null)

  // 交点計算用
  const [l1a, setL1a] = useState('')
  const [l1b, setL1b] = useState('')
  const [l1off, setL1off] = useState('0')
  const [l2a, setL2a] = useState('')
  const [l2b, setL2b] = useState('')
  const [l2off, setL2off] = useState('0')
  // 地図で 線そのもの を 選んだ 場合。 座標登録 の ない 線 (地番の 辺 /
  // ペイントの 線分) も 相手に できる。 点で 選び直したら null に 戻す。
  const [l1geom, setL1geom] = useState<CalcPickedLine | null>(null)
  const [l2geom, setL2geom] = useState<CalcPickedLine | null>(null)

  // 線上計算用
  const [oa, setOa] = useState('') // 起点
  const [ob, setOb] = useState('') // 方向先
  const [ext, setExt] = useState('0')
  const [lat, setLat] = useState('0')
  const [ogeom, setOgeom] = useState<CalcPickedLine | null>(null)

  // 2点距離用
  const [da, setDa] = useState('') // 起点
  const [db, setDb] = useState('') // 終点

  const [name, setName] = useState('')
  const [type, setType] = useState(defaultType)

  const byId = useMemo(() => {
    const m = new Map<string, CalcCoordinate>()
    for (const c of coordinates) m.set(c.id, c)
    return m
  }, [coordinates])
  const xy = (id: string): XY | null => {
    const c = byId.get(id)
    return c ? { x: c.x, y: c.y } : null
  }
  const num = (s: string) => {
    const n = parseFloat(s)
    return Number.isFinite(n) ? n : 0
  }

  /** 交点計算の 1 本。地図で 選んだ 線 が あれば 優先、無ければ 2 点から 作る */
  const lineSeg = (geom: CalcPickedLine | null, aId: string, bId: string): { a: XY; b: XY } | null => {
    if (geom) return { a: geom.a, b: geom.b }
    const a = xy(aId), b = xy(bId)
    return a && b ? { a, b } : null
  }

  const result = useMemo<XY | null>(() => {
    if (mode === 'intersection') {
      const s1 = lineSeg(l1geom, l1a, l1b)
      const s2 = lineSeg(l2geom, l2a, l2b)
      if (!s1 || !s2) return null
      return intersectionCalc(
        { a: s1.a, b: s1.b, offset: num(l1off) },
        { a: s2.a, b: s2.b, offset: num(l2off) },
      )
    } else if (mode === 'online') {
      const seg = lineSeg(ogeom, oa, ob)
      if (!seg) return null
      return onLineCalc(seg.a, seg.b, num(ext), num(lat))
    } else {
      // 距離モードは新規点を作らないので座標結果は返さない
      return null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, l1a, l1b, l1off, l2a, l2b, l2off, l1geom, l2geom, oa, ob, ogeom, ext, lat, byId])

  // 2 点距離の計算結果（距離 [m] と方向角 [deg]）。両点未選択のとき null
  const distanceResult = useMemo<{ dist: number; bearing: number } | null>(() => {
    if (mode !== 'distance') return null
    const a = xy(da), b = xy(db)
    if (!a || !b) return null
    return { dist: len(a, b), bearing: bearingDeg(a, b) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, da, db, byId])

  // 地図からの点選択を開始
  const startPick = (label: string, onChange: (v: string) => void) => {
    if (!onPickRequest) return
    setPickingLabel(label)
    onPickRequest((coordId: string) => {
      onChange(coordId)
      setPickingLabel(null)
      onPickRequest(null)
    })
  }
  const cancelPick = () => {
    setPickingLabel(null)
    onPickRequest?.(null)
  }

  // 地図から境界線（辺）を選んで2点を一度に割り当て
  const startLinePick = (label: string, setA: (v: string) => void, setB: (v: string) => void) => {
    if (!onLineRequest) return
    setPickingLineLabel(label)
    onLineRequest((id1: string, id2: string) => {
      setA(id1)
      setB(id2)
      setPickingLineLabel(null)
      onLineRequest(null)
    })
  }
  const cancelLinePick = () => {
    setPickingLineLabel(null)
    onLineRequest?.(null)
  }

  // 交点計算の 線 1 本を 「始点 → 終点」の 2 タップ で 選ぶ。
  // 1 行に 収める ため、始点/終点 それぞれの ボタンは 置かない。
  const startPointPairPick = (
    label: string,
    setA: (v: string) => void,
    setB: (v: string) => void,
    clearGeom: () => void,
    names: [string, string] = ['の始点', 'の終点'],
  ) => {
    if (!onPickRequest) return
    clearGeom()
    setA('')
    setB('')
    setPickingLabel(`${label} ${names[0]}`)
    onPickRequest((id1: string) => {
      setA(id1)
      setPickingLabel(`${label} ${names[1]}`)
      onPickRequest((id2: string) => {
        setB(id2)
        setPickingLabel(null)
        onPickRequest(null)
      })
    })
  }

  // 地図の 線 (地番の 辺 / ペイントの 線分) を そのまま 1 本 として 選ぶ
  const startGeomLinePick = (
    label: string,
    setGeom: (l: CalcPickedLine) => void,
    clearPoints: () => void,
  ) => {
    if (!onGeomLineRequest) return
    setPickingLineLabel(label)
    onGeomLineRequest((line: CalcPickedLine) => {
      clearPoints()
      setGeom(line)
      setPickingLineLabel(null)
      onGeomLineRequest(null)
    })
  }

  /** 選択中の 線 を 1 行で 表す 文字列 */
  const lineLabelOf = (geom: CalcPickedLine | null, aId: string, bId: string): string | null => {
    if (geom) return geom.label
    const a = aId ? byId.get(aId) : null
    const b = bId ? byId.get(bId) : null
    if (!a && !b) return null
    return `${a?.pointNumber ?? '?'} → ${b?.pointNumber ?? '…'}`
  }

  // 選んでいる 点 / 線 と 計算結果 を 地図に 出して もらう。
  //
  // 親は coordinates を その場で map して 渡す ことが 多く、親が 再描画 する 度に
  // byId / result の 実体が 変わる。 そのまま 通知 すると
  //   通知 → 親が setState → 親 再描画 → 実体 が 変わる → 通知 …
  // で 無限ループ に なって 画面が 固まる ので、中身が 実際に 変わった ときだけ 呼ぶ。
  const lastSelRef = useRef<string>('')
  useEffect(() => {
    if (!onSelectionChange) return
    const lines: CalcSelection['lines'] = []
    const points: CalcSelection['points'] = []
    if (mode === 'intersection') {
      const defs = [
        { key: 'l1', label: '線1', geom: l1geom, aId: l1a, bId: l1b },
        { key: 'l2', label: '線2', geom: l2geom, aId: l2a, bId: l2b },
      ]
      for (const d of defs) {
        const seg = lineSeg(d.geom, d.aId, d.bId)
        if (seg) lines.push({ key: d.key, label: d.label, a: seg.a, b: seg.b })
        if (!d.geom) {
          // 2 点で 選んでいる 途中も 出す (始点だけ 決まった 状態)
          for (const [suffix, id] of [['a', d.aId], ['b', d.bId]] as [string, string][]) {
            const c = id ? byId.get(id) : null
            if (c) points.push({ key: `${d.key}${suffix}`, label: c.pointNumber, x: c.x, y: c.y })
          }
        }
      }
    } else if (mode === 'online') {
      const seg = lineSeg(ogeom, oa, ob)
      if (seg) lines.push({ key: 'o', label: '基準線', a: seg.a, b: seg.b })
      if (!ogeom) {
        for (const [k, id] of [['oa', oa], ['ob', ob]] as [string, string][]) {
          const c = id ? byId.get(id) : null
          if (c) points.push({ key: k, label: c.pointNumber, x: c.x, y: c.y })
        }
      }
    } else {
      const a = xy(da), b = xy(db)
      if (a && b) lines.push({ key: 'd', label: '計測区間', a, b })
      for (const [k, id] of [['da', da], ['db', db]] as [string, string][]) {
        const c = id ? byId.get(id) : null
        if (c) points.push({ key: k, label: c.pointNumber, x: c.x, y: c.y })
      }
    }
    if (result) points.push({ key: 'result', label: '計算結果', x: result.x, y: result.y })
    const sel = { lines, points }
    const key = JSON.stringify(sel)
    if (key === lastSelRef.current) return
    lastSelRef.current = key
    onSelectionChange(sel)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, l1a, l1b, l2a, l2b, l1geom, l2geom, oa, ob, ogeom, da, db, result, byId])

  // 境界線選択ボタン（共通）
  const LinePickButton = ({ label, setA, setB }: { label: string; setA: (v: string) => void; setB: (v: string) => void }) =>
    onLineRequest ? (
      <button
        type="button"
        onClick={() => startLinePick(label, setA, setB)}
        className="w-full flex items-center justify-center gap-1 px-2 py-1 border border-dashed border-blue-400 rounded text-xs text-blue-600 hover:bg-blue-50"
      >
        <MapPin className="h-3.5 w-3.5" />
        境界線を地図で選択（2点まとめて）
      </button>
    ) : null

  // 地図から点を選ぶピッカー（プルダウンは廃止）
  const PointSelect = ({ value, onChange, placeholder, label }: { value: string; onChange: (v: string) => void; placeholder: string; label: string }) => {
    const c = value ? byId.get(value) : null
    return (
      <button
        type="button"
        onClick={() => startPick(label, onChange)}
        className="w-full flex items-center justify-between gap-2 px-2 py-1.5 border rounded text-sm text-left hover:bg-blue-50"
      >
        <span className={c ? 'font-medium text-slate-800' : 'text-slate-400'}>
          {/* 座標は 地図で 見える ので 点名だけ */}
          {c ? c.pointNumber : placeholder}
        </span>
        <span className="flex items-center gap-0.5 text-blue-600 text-xs whitespace-nowrap">
          <MapPin className="h-3.5 w-3.5" />
          地図で選択
        </span>
      </button>
    )
  }

  const handleAdd = () => {
    if (!result) return
    const pn = name.trim() || (mode === 'intersection' ? '交点' : '線上点')
    onAdd({ pointNumber: pn, x: result.x, y: result.y, type })
    onClose()
  }

  /** 地図から 何かを 選んでいる 最中か */
  const picking = pickingLabel != null || pickingLineLabel != null
  /** 選んでいる 間は 説明・結果・追加欄 を 畳んで、地図を 広く 空ける */
  const hideExtras = compact && picking

  // 中央モーダルは 地図を 覆って しまう ので、選択中は バナーだけ に する。
  // 下端パネル (スマホ) は 元から 地図が 見えている ので 出したまま にして、
  // 1 点目を 選んだ 時点で 入力欄に 反映されるように する。
  if (pickingLabel && !compact) {
    return (
      <div className="fixed top-3 left-1/2 -translate-x-1/2 z-[3000] bg-blue-600 text-white px-4 py-2 rounded-full shadow-lg text-sm flex items-center gap-3">
        <MapPin className="h-4 w-4" />
        <span>地図で「{pickingLabel}」をタップしてください</span>
        <button onClick={cancelPick} className="underline whitespace-nowrap">
          キャンセル
        </button>
      </div>
    )
  }
  if (pickingLineLabel && !compact) {
    return (
      <div className="fixed top-3 left-1/2 -translate-x-1/2 z-[3000] bg-blue-600 text-white px-4 py-2 rounded-full shadow-lg text-sm flex items-center gap-3">
        <MapPin className="h-4 w-4" />
        <span>
          地図で「{pickingLineLabel}」にする線
          {onGeomLineRequest ? '（地番の辺 / ペイント）' : '（境界線の辺）'}
          をタップしてください
        </span>
        <button onClick={cancelLinePick} className="underline whitespace-nowrap">
          キャンセル
        </button>
      </div>
    )
  }

  return (
    <div
      className={
        compact
          ? 'fixed left-0 right-0 bottom-0 z-[3000]'
          : 'fixed inset-0 z-[3000] bg-black/40 flex items-center justify-center p-4'
      }
    >
      <div
        className={
          compact
            ? 'bg-white w-full border-t border-slate-300 rounded-t-xl shadow-[0_-4px_16px_rgba(0,0,0,0.18)] flex flex-col max-h-[62vh]'
            : 'bg-white rounded-lg shadow-xl w-full max-w-lg'
        }
      >
        <div className={`${compact ? 'px-3 py-1.5' : 'px-4 py-3'} border-b flex items-center gap-2`}>
          <Calculator className="h-4 w-4 text-blue-600" />
          <span className="font-semibold text-sm">座標計算</span>
          {picking && (
            <>
              <span className="text-[11px] text-blue-700 truncate">
                地図で {pickingLabel ?? pickingLineLabel} をタップ
              </span>
              <button
                onClick={pickingLabel ? cancelPick : cancelLinePick}
                className="shrink-0 px-1.5 py-0.5 text-[11px] border rounded text-slate-600 hover:bg-slate-100"
              >
                中止
              </button>
            </>
          )}
          <button onClick={onClose} className="ml-auto text-slate-400 hover:text-slate-700">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* モード切替 */}
        <div className={`${compact ? 'px-3 pt-2 gap-1 text-xs' : 'px-4 pt-3 gap-2 text-sm'} flex flex-wrap`}>
          {([
            ['intersection', '交点計算'],
            ['online', '線上計算'],
            ['distance', '2点距離'],
          ] as [Mode, string][]).map(([m, label]) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`${compact ? 'px-2.5 py-0.5' : 'px-3 py-1'} rounded border ${
                mode === m ? 'bg-blue-600 text-white border-blue-600' : 'bg-white border-slate-300'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className={`${compact ? 'px-3 py-2 space-y-2' : 'p-4 space-y-3 max-h-[55vh]'} flex-1 overflow-y-auto`}>
          {mode === 'intersection' ? (
            <>
              {!hideExtras && (
                <p className={compact ? 'text-[11px] leading-snug text-slate-500' : 'text-xs text-slate-500'}>
                  2 本の線の交点。各線は右方向にオフセット (m) できます。
                </p>
              )}
              {/* 線 1 本 = 1 行。 点名だけ 出す (座標は 地図で 見える)。
                  「点」= 2 点を 順に タップ、「線」= 地番の 辺 や ペイントの
                  線分 を そのまま 1 本として 選ぶ */}
              {[
                {
                  key: 'l1',
                  label: '線1',
                  a: l1a, sa: setL1a, b: l1b, sb: setL1b,
                  geom: l1geom, sgeom: setL1geom,
                  off: l1off, soff: setL1off,
                },
                {
                  key: 'l2',
                  label: '線2',
                  a: l2a, sa: setL2a, b: l2b, sb: setL2b,
                  geom: l2geom, sgeom: setL2geom,
                  off: l2off, soff: setL2off,
                },
              ].map((ln) => {
                const picked = lineLabelOf(ln.geom, ln.a, ln.b)
                // この行を 選択中か (「線1 の始点」/「線1」 いずれも 拾う)
                const rowPicking = (pickingLabel ?? pickingLineLabel ?? '').startsWith(ln.label)
                return (
                  <div key={ln.key} className="flex items-center gap-1">
                    <span className="w-7 shrink-0 text-[11px] font-medium text-slate-600">
                      {ln.label}
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        startPointPairPick(ln.label, ln.sa, ln.sb, () => ln.sgeom(null))
                      }
                      className={`flex-1 min-w-0 truncate px-2 py-1 border rounded text-sm text-left hover:bg-blue-50 ${
                        rowPicking ? 'border-blue-500 ring-1 ring-blue-400 bg-blue-50' : ''
                      }`}
                      title="2 点を 順に 地図で タップ"
                    >
                      {picked ?? <span className="text-slate-400">2 点を選択</span>}
                    </button>
                    {(onGeomLineRequest || onLineRequest) && (
                      <button
                        type="button"
                        onClick={() => {
                          if (onGeomLineRequest) {
                            startGeomLinePick(ln.label, ln.sgeom, () => {
                              ln.sa('')
                              ln.sb('')
                            })
                          } else {
                            ln.sgeom(null)
                            startLinePick(ln.label, ln.sa, ln.sb)
                          }
                        }}
                        className="shrink-0 inline-flex items-center gap-0.5 px-1.5 py-1 border border-dashed border-blue-400 rounded text-[11px] text-blue-600 hover:bg-blue-50"
                        title="地番の辺 / ペイントの線分 を そのまま 選ぶ"
                      >
                        <MapPin className="h-3 w-3" />
                        線
                      </button>
                    )}
                    <input
                      type="number"
                      step="0.001"
                      value={ln.off}
                      onChange={(e) => ln.soff(e.target.value)}
                      className="shrink-0 px-1 py-1 border rounded text-xs w-14 text-right font-mono"
                      title="右オフセット (m)"
                      aria-label={`${ln.label} 右オフセット (m)`}
                    />
                  </div>
                )
              })}
            </>
          ) : mode === 'online' ? (
            <>
              <p className={compact ? 'text-[11px] leading-snug text-slate-500' : 'text-xs text-slate-500'}>
                基準線の起点から 延長 (+前) ・ 左右 (+右) にずらした点。
              </p>
              {/* 交点計算と 同じく 基準線 は 1 行。 点名 だけ 出す */}
              {(() => {
                const picked = lineLabelOf(ogeom, oa, ob)
                const rowPicking = (pickingLabel ?? pickingLineLabel ?? '').startsWith('基準線')
                return (
                  <div className="flex items-center gap-1">
                    <span className="w-12 shrink-0 text-[11px] font-medium text-slate-600">
                      基準線
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        startPointPairPick('基準線', setOa, setOb, () => setOgeom(null), [
                          'の起点',
                          'の方向先',
                        ])
                      }
                      className={`flex-1 min-w-0 truncate px-2 py-1 border rounded text-sm text-left hover:bg-blue-50 ${
                        rowPicking ? 'border-blue-500 ring-1 ring-blue-400 bg-blue-50' : ''
                      }`}
                      title="起点 → 方向先 の 順に 地図で タップ"
                    >
                      {picked ?? <span className="text-slate-400">起点 → 方向先 を選択</span>}
                    </button>
                    {(onGeomLineRequest || onLineRequest) && (
                      <button
                        type="button"
                        onClick={() => {
                          if (onGeomLineRequest) {
                            startGeomLinePick('基準線', setOgeom, () => {
                              setOa('')
                              setOb('')
                            })
                          } else {
                            setOgeom(null)
                            startLinePick('基準線', setOa, setOb)
                          }
                        }}
                        className="shrink-0 inline-flex items-center gap-0.5 px-1.5 py-1 border border-dashed border-blue-400 rounded text-[11px] text-blue-600 hover:bg-blue-50"
                        title="地番の辺 / ペイントの線分 を そのまま 選ぶ"
                      >
                        <MapPin className="h-3 w-3" />
                        線
                      </button>
                    )}
                  </div>
                )
              })()}
              <div className="flex items-center gap-1">
                <label className="flex-1 min-w-0 flex items-center gap-1 text-[11px] text-slate-600">
                  延長(+前)
                  <input type="number" step="0.001" value={ext} onChange={(e) => setExt(e.target.value)}
                    className="flex-1 min-w-0 px-1 py-1 border rounded text-xs text-right font-mono" />
                </label>
                <label className="flex-1 min-w-0 flex items-center gap-1 text-[11px] text-slate-600">
                  左右(+右)
                  <input type="number" step="0.001" value={lat} onChange={(e) => setLat(e.target.value)}
                    className="flex-1 min-w-0 px-1 py-1 border rounded text-xs text-right font-mono" />
                </label>
              </div>
            </>
          ) : (
            <>
              <p className={compact ? 'text-[11px] leading-snug text-slate-500' : 'text-xs text-slate-500'}>
                2 点間の平面距離と方向角 (北から時計回り)。
              </p>
              <div className={`border rounded ${compact ? 'p-1.5 space-y-1.5' : 'p-2 space-y-2'}`}>
                <LinePickButton label="計測区間（起点→終点）" setA={setDa} setB={setDb} />
                <PointSelect value={da} onChange={setDa} placeholder="起点を選択" label="起点" />
                <PointSelect value={db} onChange={setDb} placeholder="終点を選択" label="終点" />
              </div>
            </>
          )}

          {/* 結果 */}
          {!hideExtras && (
          <div className={compact ? 'border-t pt-2' : 'border-t pt-3'}>
            <div className="text-xs text-slate-500 mb-1 flex items-center gap-1">
              {mode === 'distance' ? (
                <>
                  <Ruler className="h-3.5 w-3.5" />
                  計測結果
                </>
              ) : (
                '計算結果'
              )}
            </div>
            {mode === 'distance' ? (
              distanceResult ? (
                <div className="font-mono text-sm bg-slate-50 rounded p-2 space-y-1">
                  <div>距離 = <span className="font-semibold">{distanceResult.dist.toFixed(3)}</span> m</div>
                  <div>
                    方向角 ={' '}
                    <span className="font-semibold">{formatDMS(distanceResult.bearing)}</span>{' '}
                    <span className="text-slate-500">({distanceResult.bearing.toFixed(4)}°)</span>
                  </div>
                </div>
              ) : (
                <div className="text-sm text-slate-400">起点と終点を選択してください</div>
              )
            ) : result ? (
              <div className="font-mono text-sm bg-slate-50 rounded p-2">
                X = {result.x.toFixed(3)} ／ Y = {result.y.toFixed(3)}
              </div>
            ) : (
              <div className="text-sm text-slate-400">点・線を選択してください（平行線は交点なし）</div>
            )}
          </div>
          )}

          {/* 追加（距離モードでは非表示） */}
          {mode !== 'distance' && !hideExtras && (
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs text-slate-600">
              点名
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={mode === 'intersection' ? '交点' : '線上点'}
                className="mt-1 px-2 py-1 border rounded text-sm w-full"
              />
            </label>
            <label className="text-xs text-slate-600">
              点種
              <select value={type} onChange={(e) => setType(e.target.value)} className="mt-1 px-2 py-1 border rounded text-sm w-full bg-white">
                {typeOptions.map((o) => (
                  <option key={o.code} value={o.code}>{o.label}</option>
                ))}
              </select>
            </label>
          </div>
          )}
        </div>

        {!hideExtras && (
        <div className={`${compact ? 'px-3 py-2' : 'px-4 py-3'} border-t flex justify-end gap-2`}>
          <button onClick={onClose} className="px-3 py-1.5 text-sm border rounded hover:bg-slate-50">
            {mode === 'distance' ? '閉じる' : 'キャンセル'}
          </button>
          {mode !== 'distance' && (
            <button
              onClick={handleAdd}
              disabled={!result}
              className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
            >
              座標に追加
            </button>
          )}
        </div>
        )}
      </div>
    </div>
  )
}
