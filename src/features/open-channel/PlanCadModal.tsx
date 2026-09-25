import { useEffect, useMemo, useState } from 'react'
import { X, Loader2, FolderOpen, Upload } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { decodeDxfBytes } from '@/lib/dxfRender'
import { parseSxfFile } from '@/lib/sxf'
import { DxfCrossSectionViewer } from '@/components/dxf/DxfCrossSectionViewer'
import { listFarmFiles, downloadFarmFileBytes, type FarmFileRow } from '@/lib/farmFiles'
import {
  solvePlanCadTransform,
  planCadToWorld,
  type PlanCadAnchor,
  type PlanCadConfig,
} from '@/lib/openChannel/planCad'
import type { DxfCrossSectionFile, OpenChannelRow } from '@/stores/openChannelStore'

/** 実 座標 を 選ぶ ため の 候補 (座標管理) */
export interface PlanCadCoord {
  id: string
  pointNumber: string
  x: number
  y: number
}

const blankAnchor = (): PlanCadAnchor => ({ dx: 0, dy: 0, x: 0, y: 0 })

/**
 * 平面図 CAD を 地図 に 合わせる。
 *
 * 図面 の 2 点 を 押して、 その 点 の 実 座標 を 座標管理 から 選ぶ (または 直接 入力)。
 * 2 組 決まれば 回転 + 倍率 + 平行移動 が 決まる ので、 地図 に 敷ける。
 * 3 点 以上 は 取ら ない。 現場 で 押さえる の は 基準 の 2 点 で 足りる。
 */
export function PlanCadModal({
  channel,
  coords,
  value,
  onChange,
  onUploadDxf,
  onClose,
}: {
  channel: OpenChannelRow
  /** 実 座標 の 候補 */
  coords: PlanCadCoord[]
  value: PlanCadConfig | null
  onChange: (next: PlanCadConfig | null) => void
  onUploadDxf: (file: File) => Promise<void>
  onClose: () => void
}) {
  const dxfFiles = channel.dxfCrossSections ?? []
  const [dxfId, setDxfId] = useState<string | null>(value?.dxfId ?? dxfFiles[0]?.id ?? null)
  const activeDxf = dxfFiles.find((f) => f.id === dxfId) ?? null

  const [dxfText, setDxfText] = useState<string | null>(null)
  const [parsedDoc, setParsedDoc] = useState<import('@/lib/dxfRender').DxfDocument | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [p1, setP1] = useState<PlanCadAnchor>(value?.p1 ?? blankAnchor())
  const [p2, setP2] = useState<PlanCadAnchor>(value?.p2 ?? blankAnchor())
  /** どちら の 点 を 図面 で 拾う か */
  const [picking, setPicking] = useState<1 | 2 | null>(null)

  // 図面 の 読み込み
  useEffect(() => {
    if (!activeDxf) {
      setDxfText(null)
      setParsedDoc(null)
      return
    }
    let cancelled = false
    setDxfText(null)
    setParsedDoc(null)
    setLoading(true)
    setError(null)
    const ext =
      (activeDxf.path.split('.').pop()?.toLowerCase() ?? '') ||
      (activeDxf.name.split('.').pop()?.toLowerCase() ?? '')
    supabase.storage
      .from('open-channel-dxf')
      .download(activeDxf.path)
      .then(async ({ data, error: dlErr }) => {
        if (cancelled) return
        if (dlErr || !data) throw dlErr ?? new Error('DL 失敗')
        const text = decodeDxfBytes(await data.arrayBuffer())
        if (cancelled) return
        if (ext === 'sfc' || ext === 'p21') {
          const doc = parseSxfFile(text)
          if (cancelled) return
          setParsedDoc(doc)
          if (doc.shapes.length === 0) setError(`${ext.toUpperCase()} に 図形 が ありません`)
        } else {
          setDxfText(text)
        }
      })
      .catch((e) => {
        if (cancelled) return
        console.error('[plan cad download]', e)
        setError(e instanceof Error ? e.message : '取得 失敗')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [activeDxf])

  const transform = useMemo(() => solvePlanCadTransform(p1, p2), [p1, p2])

  /** 合わせ の 確からしさ: 2 点 目 を 変換 に 通して 元 の 実 座標 と 比べる */
  const residual = useMemo(() => {
    if (!transform) return null
    const w = planCadToWorld(transform, p2.dx, p2.dy)
    return Math.hypot(w.x - p2.x, w.y - p2.y)
  }, [transform, p2])

  const handlePick = (p: { x: number; y: number }) => {
    if (picking == null) return
    const r3 = (v: number) => Math.round(v * 1000) / 1000
    const patch = { dx: r3(p.x), dy: r3(p.y) }
    if (picking === 1) setP1((s) => ({ ...s, ...patch }))
    else setP2((s) => ({ ...s, ...patch }))
    setPicking(null)
  }

  /* 工区 の ファイル から 図面 を 取り込む */
  const [farmPickOpen, setFarmPickOpen] = useState(false)
  const [farmFiles, setFarmFiles] = useState<FarmFileRow[] | null>(null)
  const openFarmPicker = async () => {
    if (farmPickOpen) {
      setFarmPickOpen(false)
      return
    }
    setFarmPickOpen(true)
    if (farmFiles) return
    try {
      const rows = await listFarmFiles(channel.farmId)
      setFarmFiles(rows.filter((r) => r.kind === 'dxf' || r.kind === 'sfc' || r.kind === 'p21'))
    } catch (e) {
      console.error('[farm files]', e)
      setError(e instanceof Error ? e.message : 'ファイル 一覧 の 取得 に 失敗')
      setFarmFiles([])
    }
  }
  const importFarmFile = async (row: FarmFileRow) => {
    setBusy(true)
    setError(null)
    try {
      const buf = await downloadFarmFileBytes(row.storagePath)
      await onUploadDxf(new File([buf], row.name))
      setFarmPickOpen(false)
    } catch (e) {
      console.error('[farm file → plan cad]', e)
      setError(e instanceof Error ? e.message : '取込 に 失敗')
    } finally {
      setBusy(false)
    }
  }

  const anchorRow = (no: 1 | 2, a: PlanCadAnchor, set: (v: PlanCadAnchor) => void) => (
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
          const c = coords.find((q) => q.id === e.target.value)
          if (c) set({ ...a, x: c.x, y: c.y })
        }}
        className="w-full px-1 py-0.5 border rounded text-[11px]"
      >
        <option value="">座標管理 から 選ぶ…</option>
        {coords.map((c) => (
          <option key={c.id} value={c.id}>
            {c.pointNumber}
          </option>
        ))}
      </select>
    </div>
  )

  return (
    <div className="fixed inset-0 z-[1500] bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded shadow-xl w-full h-full max-w-[1600px] flex flex-col">
        <div className="flex items-center gap-2 px-3 py-2 border-b shrink-0">
          <h3 className="text-sm font-semibold">平面図 CAD を 地図 に 合わせる</h3>
          <span className="text-[11px] text-slate-500">
            図面 の 2 点 と その 実 座標 を 決める と 地図 に 敷けます
          </span>
          <button onClick={onClose} className="ml-auto p-1 hover:bg-slate-100 rounded" title="閉じる">
            <X className="h-4 w-4 text-slate-500" />
          </button>
        </div>

        <div className="flex-1 min-h-0 flex">
          <div className="w-72 border-r p-3 overflow-y-auto text-xs flex flex-col gap-3 shrink-0">
            <div>
              <div className="font-semibold mb-1">図面 (DXF / SFC / P21)</div>
              {dxfFiles.length === 0 ? (
                <div className="text-[11px] text-slate-400 border rounded bg-slate-50 px-2 py-2">
                  図面 が ありません。 下 の ボタン で 取り込んで ください。
                </div>
              ) : (
                <div className="flex flex-col gap-1">
                  {dxfFiles.map((f: DxfCrossSectionFile) => (
                    <label
                      key={f.id}
                      className={
                        'flex items-center gap-1 border rounded px-1.5 py-1 cursor-pointer ' +
                        (f.id === dxfId ? 'bg-blue-50 border-blue-400' : 'bg-white hover:bg-slate-50')
                      }
                    >
                      <input
                        type="radio"
                        name="plan-cad-dxf"
                        checked={f.id === dxfId}
                        onChange={() => setDxfId(f.id)}
                        className="cursor-pointer"
                      />
                      <span className="flex-1 text-[11px] font-mono truncate" title={f.name}>
                        {f.name}
                      </span>
                    </label>
                  ))}
                </div>
              )}
              <label className="mt-1 w-full flex items-center justify-center gap-1 px-2 py-1 border rounded bg-blue-600 text-white hover:bg-blue-700 cursor-pointer">
                {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Upload className="h-3 w-3" />}
                図面 を 取込
                <input
                  type="file"
                  accept=".dxf,.sfc,.p21,.DXF,.SFC,.P21"
                  onChange={(e) => {
                    const f = e.target.files?.[0]
                    e.target.value = ''
                    if (!f) return
                    setBusy(true)
                    setError(null)
                    onUploadDxf(f)
                      .catch((err) => {
                        console.error('[plan cad upload]', err)
                        setError(err instanceof Error ? err.message : 'アップロード 失敗')
                      })
                      .finally(() => setBusy(false))
                  }}
                  className="hidden"
                />
              </label>
              <button
                onClick={() => void openFarmPicker()}
                disabled={busy}
                className={
                  'mt-1 w-full flex items-center justify-center gap-1 px-2 py-1 border rounded disabled:opacity-50 ' +
                  (farmPickOpen
                    ? 'bg-slate-700 text-white border-slate-700'
                    : 'bg-white hover:bg-slate-50 text-slate-700')
                }
              >
                <FolderOpen className="h-3 w-3" />
                ファイルから選ぶ
              </button>
              {farmPickOpen && (
                <div className="mt-1 border rounded bg-slate-50 p-1 max-h-40 overflow-auto">
                  {farmFiles == null ? (
                    <div className="text-[11px] text-slate-500 px-1 py-2">読込中...</div>
                  ) : farmFiles.length === 0 ? (
                    <div className="text-[11px] text-slate-500 px-1 py-2">CAD が ありません。</div>
                  ) : (
                    farmFiles.map((r) => (
                      <button
                        key={r.id}
                        onClick={() => void importFarmFile(r)}
                        disabled={busy}
                        className="w-full flex items-center gap-1 px-1.5 py-1 border rounded bg-white hover:bg-blue-50 text-left disabled:opacity-40 mb-0.5"
                      >
                        <span className="px-1 rounded bg-slate-100 text-[10px] uppercase text-slate-500 shrink-0">
                          {r.kind}
                        </span>
                        <span className="flex-1 text-[11px] font-mono truncate">{r.name}</span>
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>

            <div className="space-y-2">
              <div className="font-semibold">位置合わせ</div>
              {anchorRow(1, p1, setP1)}
              {anchorRow(2, p2, setP2)}
              <div className="text-[11px]">
                {!transform ? (
                  <span className="text-amber-700">
                    2 点 が 同じ 位置 です。 離れた 2 点 を 決めて ください。
                  </span>
                ) : (
                  <span className="text-slate-600">
                    倍率{' '}
                    <span className="font-mono">
                      1:{(1 / transform.scale).toFixed(1)}
                    </span>{' '}
                    / 回転{' '}
                    <span className="font-mono">
                      {((transform.rotation * 180) / Math.PI).toFixed(3)}°
                    </span>
                    {residual != null && residual > 0.001 && (
                      <span className="ml-1 text-amber-700">
                        (ずれ {residual.toFixed(3)}m)
                      </span>
                    )}
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="flex-1 min-w-0 p-2 flex flex-col">
            {loading && <div className="text-xs text-slate-500">図面 読込中...</div>}
            {error && <div className="text-xs text-red-600">{error}</div>}
            <div className="flex-1 min-h-0">
              {dxfText || parsedDoc ? (
                <DxfCrossSectionViewer
                  dxfText={dxfText ?? ''}
                  parsedDoc={parsedDoc}
                  onCanvasPick={(p) => handlePick(p)}
                  pickCursorHint="trace"
                  snapEnabled
                  cursorLabelFormatter={(p) => [
                    `図面 ${p.x.toFixed(2)}, ${p.y.toFixed(2)}`,
                  ]}
                />
              ) : (
                <div className="h-full flex items-center justify-center text-xs text-slate-400">
                  左 で 図面 を 選ぶ か、 取り込んで ください。
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 px-3 py-2 border-t bg-slate-50 shrink-0">
          <span className="text-[11px] text-slate-500">
            基準点 は 離れた 2 点 ほど 精度 が 出ます (対角 の 基準点 など)
          </span>
          {value && (
            <button
              onClick={() => {
                if (!window.confirm('地図 の 背景 から 平面図 を 外します。')) return
                onChange(null)
                onClose()
              }}
              className="ml-auto px-3 py-1 text-xs border rounded bg-white hover:bg-red-50 text-red-600"
            >
              背景 から 外す
            </button>
          )}
          <button
            onClick={onClose}
            className={(value ? '' : 'ml-auto ') + 'px-3 py-1 text-xs border rounded bg-white hover:bg-slate-50'}
          >
            閉じる
          </button>
          <button
            onClick={() => {
              if (!dxfId || !transform) return
              onChange({
                dxfId,
                p1,
                p2,
                visible: value?.visible ?? true,
                opacity: value?.opacity ?? 0.7,
                hiddenLayers: value?.hiddenLayers,
              })
              onClose()
            }}
            disabled={!dxfId || !transform}
            className="px-4 py-1 text-xs rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40"
          >
            地図 に 敷く
          </button>
        </div>
      </div>
    </div>
  )
}
