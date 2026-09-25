import { useEffect, useMemo, useState } from 'react'
import { X, Loader2, Trash2, Plus } from 'lucide-react'
import { decodeDxfBytes, parseDxf, type DxfDocument } from '@/lib/dxfRender'
import { parseSxfFile } from '@/lib/sxf'
import { DxfCrossSectionViewer } from '@/components/dxf/DxfCrossSectionViewer'
import { listFarmFiles, downloadFarmFileBytes, type FarmFileRow } from '@/lib/farmFiles'
import {
  solvePlanCadTransform,
  planCadToWorld,
  type PlanCadAnchor,
} from '@/lib/openChannel/planCad'
import { useFarmStore, type FarmPlanCad } from '@/stores/farmStore'
import { useCoordinateStore } from '@/stores/coordinateStore'
import { useOpenChannelStore } from '@/stores/openChannelStore'

const newId = () => `pc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
const blank = (): PlanCadAnchor => ({ dx: 0, dy: 0, x: 0, y: 0 })

/**
 * 工区 の 背景 CAD を 束ねて 面倒 を 見る。
 *
 * 図面 は ファイル管理 に 上げた CAD を そのまま 使う。 ここ で 決める の は
 * 「どの 図面 を、 どの 2 点 で 実 座標 に 合わせるか」 と 表示 の 有無 だけ。
 * 工区 単位 な ので、 決めれば 全 工種 と スマホ で 同じ 位置 に 出る。
 */
export function FarmPlanCadModal({ farmId, onClose }: { farmId: string; onClose: () => void }) {
  const farms = useFarmStore((s) => s.farms)
  const currentFarm = useFarmStore((s) => s.currentFarm)
  const updateFarm = useFarmStore((s) => s.updateFarm)
  const farm = farms.find((f) => f.id === farmId) ?? currentFarm
  const cads = useMemo(() => farm?.plan_cads ?? [], [farm])

  const { coordinates } = useCoordinateStore()
  const channels = useOpenChannelStore((s) => s.channels)
  /** 位置合わせ の 候補。 任意測点 を 先 に 出す */
  const coordOptions = useMemo(() => {
    const free = channels
      .filter((c) => c.farmId === farmId)
      .flatMap((c) => (c.freePoints ?? []).map((p) => ({ id: p.id, label: p.name || '任意測点', x: p.x, y: p.y })))
    const reg = coordinates.map((c) => ({
      id: c.id,
      label: c.pointNumber ?? '(名前なし)',
      x: c.x,
      y: c.y,
    }))
    return [...free, ...reg]
  }, [channels, coordinates, farmId])

  /** ファイル管理 の CAD */
  const [files, setFiles] = useState<FarmFileRow[] | null>(null)
  useEffect(() => {
    let cancelled = false
    void listFarmFiles(farmId)
      .then((rows) => {
        if (!cancelled) {
          setFiles(rows.filter((r) => r.kind === 'dxf' || r.kind === 'sfc' || r.kind === 'p21'))
        }
      })
      .catch((e) => {
        console.error('[farm files]', e)
        if (!cancelled) setFiles([])
      })
    return () => {
      cancelled = true
    }
  }, [farmId])

  /** 位置合わせ を 開いて いる 図面。 null は 一覧 */
  const [editing, setEditing] = useState<FarmPlanCad | null>(null)
  const [doc, setDoc] = useState<DxfDocument | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [picking, setPicking] = useState<1 | 2 | null>(null)

  /** 位置合わせ を 開く。 読み込み の 支度 も ここ で 済ませる */
  const openEditing = (cad: FarmPlanCad) => {
    setEditing(cad)
    setDoc(null)
    setLoading(true)
    setError(null)
    setPicking(null)
  }

  const storagePath = editing?.storagePath ?? null
  useEffect(() => {
    if (!storagePath) return
    let cancelled = false
    void downloadFarmFileBytes(storagePath)
      .then((buf) => {
        if (cancelled) return
        const text = decodeDxfBytes(buf)
        const ext = storagePath.split('.').pop()?.toLowerCase() ?? ''
        setDoc(ext === 'sfc' || ext === 'p21' ? parseSxfFile(text) : parseDxf(text))
      })
      .catch((e) => {
        console.error('[plan cad]', e)
        if (!cancelled) setError(e instanceof Error ? e.message : '読み込み に 失敗')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [storagePath])

  const save = (next: FarmPlanCad[]) => {
    if (!farm) return
    void updateFarm(farm.id, { plan_cads: next })
  }

  const transform = useMemo(
    () => (editing ? solvePlanCadTransform(editing.p1, editing.p2) : null),
    [editing],
  )
  const residual = useMemo(() => {
    if (!transform || !editing) return null
    const w = planCadToWorld(transform, editing.p2.dx, editing.p2.dy)
    return Math.hypot(w.x - editing.p2.x, w.y - editing.p2.y)
  }, [transform, editing])

  const anchorRow = (no: 1 | 2) => {
    if (!editing) return null
    const a = no === 1 ? editing.p1 : editing.p2
    const set = (v: PlanCadAnchor) =>
      setEditing({ ...editing, ...(no === 1 ? { p1: v } : { p2: v }) })
    return (
      <div className="border rounded p-1.5 space-y-1">
        <div className="flex items-center gap-1">
          <span className="font-semibold text-slate-700">基準点 {no}</span>
          <button
            onClick={() => setPicking(picking === no ? null : no)}
            className={
              'ml-auto px-2 py-0.5 border rounded ' +
              (picking === no
                ? 'bg-purple-600 text-white border-purple-600'
                : 'bg-white hover:bg-slate-50')
            }
          >
            {picking === no ? '図面 を 押して ください' : '図面 で 拾う'}
          </button>
        </div>
        <div className="flex items-center gap-1 text-[11px]">
          <span className="text-slate-500 w-10">図面</span>
          <input
            type="number"
            step={0.001}
            value={a.dx}
            onChange={(e) => set({ ...a, dx: parseFloat(e.target.value) || 0 })}
            className="flex-1 min-w-0 px-1 py-0.5 border rounded text-right font-mono"
          />
          <input
            type="number"
            step={0.001}
            value={a.dy}
            onChange={(e) => set({ ...a, dy: parseFloat(e.target.value) || 0 })}
            className="flex-1 min-w-0 px-1 py-0.5 border rounded text-right font-mono"
          />
        </div>
        <div className="flex items-center gap-1 text-[11px]">
          <span className="text-slate-500 w-10">実 X/Y</span>
          <input
            type="number"
            step={0.001}
            value={a.x}
            onChange={(e) => set({ ...a, x: parseFloat(e.target.value) || 0 })}
            title="北 (X)"
            className="flex-1 min-w-0 px-1 py-0.5 border rounded text-right font-mono"
          />
          <input
            type="number"
            step={0.001}
            value={a.y}
            onChange={(e) => set({ ...a, y: parseFloat(e.target.value) || 0 })}
            title="東 (Y)"
            className="flex-1 min-w-0 px-1 py-0.5 border rounded text-right font-mono"
          />
        </div>
        <select
          value=""
          onChange={(e) => {
            const c = coordOptions.find((q) => q.id === e.target.value)
            if (c) set({ ...a, x: c.x, y: c.y })
          }}
          className="w-full px-1 py-0.5 border rounded text-[11px]"
        >
          <option value="">座標 から 選ぶ… (任意測点 が 先)</option>
          {coordOptions.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-[2000] bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded shadow-xl w-full h-full max-w-[1500px] flex flex-col">
        <div className="flex items-center gap-2 px-3 py-2 border-b shrink-0">
          <h3 className="text-sm font-semibold">背景 CAD (工区 共通)</h3>
          <span className="text-[11px] text-slate-500">
            ここ で 決める と 全 工種 と スマホ の 地図 に 出ます
          </span>
          <button onClick={onClose} className="ml-auto p-1 hover:bg-slate-100 rounded" title="閉じる">
            <X className="h-4 w-4 text-slate-500" />
          </button>
        </div>

        {editing ? (
          <div className="flex-1 min-h-0 flex">
            <div className="w-72 border-r p-3 overflow-y-auto text-xs flex flex-col gap-3 shrink-0">
              <div className="font-semibold truncate" title={editing.name}>
                {editing.name}
              </div>
              {anchorRow(1)}
              {anchorRow(2)}
              <div className="text-[11px]">
                {!transform ? (
                  <span className="text-amber-700">
                    2 点 が 同じ 位置 です。 離れた 2 点 を 決めて ください。
                  </span>
                ) : (
                  <span className="text-slate-600">
                    倍率 <span className="font-mono">1:{(1 / transform.scale).toFixed(1)}</span> / 回転{' '}
                    <span className="font-mono">
                      {((transform.rotation * 180) / Math.PI).toFixed(3)}°
                    </span>
                    {residual != null && residual > 0.001 && (
                      <span className="ml-1 text-amber-700">(ずれ {residual.toFixed(3)}m)</span>
                    )}
                  </span>
                )}
              </div>
              <div className="mt-auto flex gap-1">
                <button
                  onClick={() => {
                    setEditing(null)
                    setDoc(null)
                    setPicking(null)
                  }}
                  className="flex-1 px-2 py-1 border rounded bg-white hover:bg-slate-50"
                >
                  戻る
                </button>
                <button
                  onClick={() => {
                    if (!transform) return
                    const exists = cads.some((c) => c.id === editing.id)
                    save(
                      exists
                        ? cads.map((c) => (c.id === editing.id ? editing : c))
                        : [...cads, editing],
                    )
                    setEditing(null)
                    setPicking(null)
                  }}
                  disabled={!transform}
                  className="flex-1 px-2 py-1 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40"
                >
                  保存
                </button>
              </div>
            </div>
            <div className="flex-1 min-w-0 p-2 flex flex-col">
              {loading && <div className="text-xs text-slate-500">図面 読込中...</div>}
              {error && <div className="text-xs text-red-600">{error}</div>}
              <div className="flex-1 min-h-0">
                {doc ? (
                  <DxfCrossSectionViewer
                    dxfText=""
                    parsedDoc={doc}
                    onCanvasPick={(p) => {
                      if (picking == null) return
                      const r3 = (v: number) => Math.round(v * 1000) / 1000
                      const patch = { dx: r3(p.x), dy: r3(p.y) }
                      setEditing((cur) =>
                        cur
                          ? picking === 1
                            ? { ...cur, p1: { ...cur.p1, ...patch } }
                            : { ...cur, p2: { ...cur.p2, ...patch } }
                          : cur,
                      )
                      setPicking(null)
                    }}
                    pickCursorHint="trace"
                    snapEnabled
                    cursorLabelFormatter={(p) => [`図面 ${p.x.toFixed(2)}, ${p.y.toFixed(2)}`]}
                  />
                ) : (
                  !loading && (
                    <div className="h-full flex items-center justify-center text-xs text-slate-400">
                      図面 を 読み込め ません でした
                    </div>
                  )
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="flex-1 min-h-0 overflow-auto p-3 text-xs space-y-3">
            <div>
              <div className="font-semibold mb-1">登録 済み</div>
              {cads.length === 0 ? (
                <div className="text-slate-400 border rounded bg-slate-50 px-2 py-2">
                  まだ ありません。 下 の 一覧 から 図面 を 選んで ください。
                </div>
              ) : (
                <div className="border rounded divide-y">
                  {cads.map((c) => (
                    <div key={c.id} className="flex items-center gap-2 px-2 py-1.5">
                      <label className="flex items-center gap-1 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={c.visible !== false}
                          onChange={(e) =>
                            save(
                              cads.map((q) =>
                                q.id === c.id ? { ...q, visible: e.target.checked } : q,
                              ),
                            )
                          }
                        />
                        表示
                      </label>
                      <span className="flex-1 min-w-0 truncate font-mono" title={c.name}>
                        {c.name}
                      </span>
                      <label className="flex items-center gap-1 text-slate-500">
                        濃さ
                        <input
                          type="range"
                          min={0.1}
                          max={1}
                          step={0.1}
                          value={c.opacity ?? 0.7}
                          onChange={(e) =>
                            save(
                              cads.map((q) =>
                                q.id === c.id ? { ...q, opacity: parseFloat(e.target.value) } : q,
                              ),
                            )
                          }
                          className="w-20"
                        />
                      </label>
                      <button
                        onClick={() => openEditing(c)}
                        className="px-2 py-0.5 border rounded bg-white hover:bg-slate-50"
                      >
                        位置合わせ
                      </button>
                      <button
                        onClick={() => {
                          if (!window.confirm(`「${c.name}」を 背景 から 外します。`)) return
                          save(cads.filter((q) => q.id !== c.id))
                        }}
                        className="p-1 text-red-600 hover:bg-red-50 rounded"
                        title="外す"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div>
              <div className="font-semibold mb-1">ファイル管理 の CAD</div>
              {files == null ? (
                <div className="flex items-center gap-1 text-slate-500">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  読込中...
                </div>
              ) : files.length === 0 ? (
                <div className="text-slate-400 border rounded bg-slate-50 px-2 py-2">
                  CAD (DXF / SFC / P21) が ありません。 ファイル管理 から 先 に 上げて ください。
                </div>
              ) : (
                <div className="border rounded divide-y">
                  {files.map((f) => (
                    <div key={f.id} className="flex items-center gap-2 px-2 py-1.5">
                      <span className="px-1 rounded bg-slate-100 text-[10px] uppercase text-slate-500 shrink-0">
                        {f.kind}
                      </span>
                      <span className="flex-1 min-w-0 truncate font-mono" title={f.name}>
                        {f.name}
                      </span>
                      <button
                        onClick={() =>
                          openEditing({
                            id: newId(),
                            name: f.name,
                            storagePath: f.storagePath,
                            p1: blank(),
                            p2: blank(),
                            visible: true,
                            opacity: 0.7,
                          })
                        }
                        className="flex items-center gap-1 px-2 py-0.5 border rounded bg-blue-600 text-white hover:bg-blue-700"
                      >
                        <Plus className="h-3 w-3" />
                        背景 に する
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
