// 座標計算モーダル: 交点計算 / 線上計算。既存座標から点・線を選び、結果を新規点として追加する。
import { useMemo, useState } from 'react'
import { X, Calculator, MapPin } from 'lucide-react'
import { intersectionCalc, onLineCalc, type XY } from '@/lib/coordCalc'

export interface CalcCoordinate {
  id: string
  pointNumber: string
  x: number
  y: number
}

interface Props {
  coordinates: CalcCoordinate[]
  typeOptions: { code: string; label: string }[]
  defaultType: string
  onAdd: (p: { pointNumber: string; x: number; y: number; type: string }) => void
  onClose: () => void
  /** 地図からの点選択を要求する。assign に座標IDを渡すと確定。null でキャンセル/解除 */
  onPickRequest?: (assign: ((coordId: string) => void) | null) => void
}

type Mode = 'intersection' | 'online'

export function CoordinateCalcModal({ coordinates, typeOptions, defaultType, onAdd, onClose, onPickRequest }: Props) {
  const [mode, setMode] = useState<Mode>('intersection')
  // 地図から選択中のスロット名（null=通常表示）
  const [pickingLabel, setPickingLabel] = useState<string | null>(null)

  // 交点計算用
  const [l1a, setL1a] = useState('')
  const [l1b, setL1b] = useState('')
  const [l1off, setL1off] = useState('0')
  const [l2a, setL2a] = useState('')
  const [l2b, setL2b] = useState('')
  const [l2off, setL2off] = useState('0')

  // 線上計算用
  const [oa, setOa] = useState('') // 起点
  const [ob, setOb] = useState('') // 方向先
  const [ext, setExt] = useState('0')
  const [lat, setLat] = useState('0')

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

  const result = useMemo<XY | null>(() => {
    if (mode === 'intersection') {
      const a1 = xy(l1a), b1 = xy(l1b), a2 = xy(l2a), b2 = xy(l2b)
      if (!a1 || !b1 || !a2 || !b2) return null
      return intersectionCalc(
        { a: a1, b: b1, offset: num(l1off) },
        { a: a2, b: b2, offset: num(l2off) },
      )
    } else {
      const a = xy(oa), b = xy(ob)
      if (!a || !b) return null
      return onLineCalc(a, b, num(ext), num(lat))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, l1a, l1b, l1off, l2a, l2b, l2off, oa, ob, ext, lat, byId])

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
          {c ? `${c.pointNumber}（${c.x.toFixed(2)}, ${c.y.toFixed(2)}）` : placeholder}
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

  // 地図選択中は全画面を覆わず、上部バナーのみ表示（地図をクリック可能にする）
  if (pickingLabel) {
    return (
      <div className="fixed top-3 left-1/2 -translate-x-1/2 z-[3000] bg-blue-600 text-white px-4 py-2 rounded-full shadow-lg text-sm flex items-center gap-3">
        <MapPin className="h-4 w-4" />
        <span>地図で「{pickingLabel}」の点をタップしてください</span>
        <button onClick={cancelPick} className="underline whitespace-nowrap">
          キャンセル
        </button>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-[3000] bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-lg">
        <div className="px-4 py-3 border-b flex items-center gap-2">
          <Calculator className="h-4 w-4 text-blue-600" />
          <span className="font-semibold text-sm">座標計算</span>
          <button onClick={onClose} className="ml-auto text-slate-400 hover:text-slate-700">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* モード切替 */}
        <div className="px-4 pt-3 flex gap-2 text-sm">
          {([
            ['intersection', '交点計算'],
            ['online', '線上計算'],
          ] as [Mode, string][]).map(([m, label]) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`px-3 py-1 rounded border ${
                mode === m ? 'bg-blue-600 text-white border-blue-600' : 'bg-white border-slate-300'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="p-4 space-y-3 max-h-[55vh] overflow-y-auto">
          {mode === 'intersection' ? (
            <>
              <p className="text-xs text-slate-500">
                2本の線（各2点）の交点を計算します。線を右方向に平行移動（オフセット, m）も指定できます。
              </p>
              {[
                { label: '線1', a: l1a, sa: setL1a, b: l1b, sb: setL1b, off: l1off, soff: setL1off },
                { label: '線2', a: l2a, sa: setL2a, b: l2b, sb: setL2b, off: l2off, soff: setL2off },
              ].map((ln) => (
                <div key={ln.label} className="border rounded p-2 space-y-2">
                  <div className="text-xs font-medium text-slate-600">{ln.label}</div>
                  <PointSelect value={ln.a} onChange={ln.sa} placeholder="始点を選択" label={`${ln.label} 始点`} />
                  <PointSelect value={ln.b} onChange={ln.sb} placeholder="終点を選択" label={`${ln.label} 終点`} />
                  <label className="flex items-center gap-2 text-xs">
                    右オフセット(m)
                    <input
                      type="number"
                      step="0.001"
                      value={ln.off}
                      onChange={(e) => ln.soff(e.target.value)}
                      className="px-2 py-1 border rounded text-sm w-28 text-right font-mono"
                    />
                  </label>
                </div>
              ))}
            </>
          ) : (
            <>
              <p className="text-xs text-slate-500">
                線（2点）を選び、起点から延長方向(+前方) ・ 左右(+右) にずらした点を計算します。
              </p>
              <div className="border rounded p-2 space-y-2">
                <PointSelect value={oa} onChange={setOa} placeholder="起点を選択" label="起点" />
                <PointSelect value={ob} onChange={setOb} placeholder="方向先（終点）を選択" label="方向先" />
                <div className="flex gap-3">
                  <label className="flex items-center gap-2 text-xs">
                    延長(m,+前)
                    <input type="number" step="0.001" value={ext} onChange={(e) => setExt(e.target.value)}
                      className="px-2 py-1 border rounded text-sm w-24 text-right font-mono" />
                  </label>
                  <label className="flex items-center gap-2 text-xs">
                    左右(m,+右)
                    <input type="number" step="0.001" value={lat} onChange={(e) => setLat(e.target.value)}
                      className="px-2 py-1 border rounded text-sm w-24 text-right font-mono" />
                  </label>
                </div>
              </div>
            </>
          )}

          {/* 結果 */}
          <div className="border-t pt-3">
            <div className="text-xs text-slate-500 mb-1">計算結果</div>
            {result ? (
              <div className="font-mono text-sm bg-slate-50 rounded p-2">
                X = {result.x.toFixed(3)} ／ Y = {result.y.toFixed(3)}
              </div>
            ) : (
              <div className="text-sm text-slate-400">点・線を選択してください（平行線は交点なし）</div>
            )}
          </div>

          {/* 追加 */}
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
        </div>

        <div className="px-4 py-3 border-t flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 text-sm border rounded hover:bg-slate-50">
            キャンセル
          </button>
          <button
            onClick={handleAdd}
            disabled={!result}
            className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
          >
            座標に追加
          </button>
        </div>
      </div>
    </div>
  )
}
