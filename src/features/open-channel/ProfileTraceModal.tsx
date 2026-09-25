import { useEffect, useMemo, useState } from 'react'
import { X, Upload, Loader2, FolderOpen } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { decodeDxfBytes } from '@/lib/dxfRender'
import { parseSxfFile } from '@/lib/sxf'
import { DxfCrossSectionViewer } from '@/components/dxf/DxfCrossSectionViewer'
import { listFarmFiles, downloadFarmFileBytes, type FarmFileRow } from '@/lib/farmFiles'
import {
  dxfToWorld,
  worldToDxf,
  sampleProfileAtStations,
  type TracedProfilePoint,
} from '@/lib/openChannel/cadTrace'
import type {
  DxfCalibration,
  DxfCrossSectionFile,
  OpenChannelRow,
  StationRow,
} from '@/stores/openChannelStore'

/** 取込 先。 グリッド表 の 3 つ と 同じ */
export type ProfileTraceTarget = 'current' | 'planned' | 'asbuilt'

const TARGETS: { key: ProfileTraceTarget; label: string; color: string }[] = [
  { key: 'current', label: '現況', color: '#b45309' },
  { key: 'planned', label: '計画', color: '#0ea5e9' },
  { key: 'asbuilt', label: '出来形', color: '#059669' },
]

/** トレース した 点 */
interface TracePoint extends TracedProfilePoint {
  id: string
}

const newId = () =>
  `tp${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

/** 点 と 線分 の 距離 (図面 座標)。 どの 区間 を 押した か を 決める のに 使う */
function distToSegment(
  p: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  if (len2 < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y)
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t))
}

/**
 * 縦断 (平行縦断 の 1 本) を CAD 図面 から トレース して 取り込む。
 *
 * 校正 の 考え方 は 横断 と 同じ。 DL (水平線) と その 標高、 縦線 を 1 本 選んで
 * その SP、 H / V 縮尺。 横軸 が 離れ で は なく SP に なる だけ な ので、
 * 換算 は cadTrace の 共通 式 を そのまま 使う。
 *
 * 確定 する と、 トレース した 折れ線 を 各 測点 の SP で 内挿 して その 線 の
 * グリッド高 に 入れる。 図面 に 無い 範囲 の 測点 は 触ら ない。
 */
export function ProfileTraceModal({
  channel,
  lineName,
  stations,
  spOffset,
  target,
  onChangeTarget,
  carry,
  onCarry,
  calib: savedCalib,
  dxfId: savedDxfId,
  onSaveCalib,
  onApply,
  existingPoints,
  prevLine,
  nextLine,
  onSwitchLine,
  onUploadDxf,
  onClose,
}: {
  channel: OpenChannelRow
  lineName: string
  /** 距離 順 の 測点 */
  stations: StationRow[]
  spOffset: number
  /** 取込 先。 線 を 送って も 変わら ない よう 親 が 持つ */
  target: ProfileTraceTarget
  onChangeTarget: (t: ProfileTraceTarget) => void
  /**
   * 線 を 送って も 持ち越す もの。 校正 が 保存 されて いない 線 で は
   * 今 見て いる 図面 と 縮尺 を そのまま 使う (横断 の 測点 送り と 同じ)。
   */
  carry: { dxfId: string | null; hScale: string; vScale: string }
  onCarry: (next: { dxfId: string | null; hScale: string; vScale: string }) => void
  /** この 線 に 保存 して ある 校正 */
  calib: DxfCalibration | null
  /** この 線 で 使う 図面 */
  dxfId: string | null
  onSaveCalib: (calib: DxfCalibration | null, dxfId: string | null) => void
  /**
   * 取込。 heights は 測点 で 内挿 した 高さ、 traced は なぞった 点 そのもの。
   * 格子 に 乗ら ない 点 を どう 残す か は 親 が 決める。
   */
  onApply: (
    target: ProfileTraceTarget,
    heights: { stationId: string; elevation: number }[],
    traced: TracedProfilePoint[],
  ) => void
  /** その 対象 で 今 入って いる 高さ (登録済み の 線)。 開いた とき に 読み込む */
  existingPoints: (target: ProfileTraceTarget) => TracedProfilePoint[]
  /** 左隣 / 右隣 の 線 (端 なら null) */
  prevLine: { idx: number; name: string } | null
  nextLine: { idx: number; name: string } | null
  /** 線 を 切り替える。 親 は この 番号 で 開き 直す */
  onSwitchLine: (idx: number) => void
  onUploadDxf: (file: File) => Promise<void>
  onClose: () => void
}) {
  const dxfFiles = channel.dxfCrossSections ?? []
  const [activeDxfId, setActiveDxfId] = useState<string | null>(
    savedDxfId ?? carry.dxfId ?? dxfFiles[0]?.id ?? null,
  )
  const activeDxf = dxfFiles.find((f) => f.id === activeDxfId) ?? null

  const [dxfText, setDxfText] = useState<string | null>(null)
  const [parsedDoc, setParsedDoc] = useState<import('@/lib/dxfRender').DxfDocument | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // 校正 の 入力
  const [dlY, setDlY] = useState<number | null>(savedCalib?.dlY ?? null)
  const [refX, setRefX] = useState<number | null>(savedCalib?.centerX ?? null)
  const [dlEl, setDlEl] = useState<string>(
    savedCalib?.dlElevation != null ? String(savedCalib.dlElevation) : '',
  )
  const [hScale, setHScale] = useState<string>(
    savedCalib?.hScale != null ? String(savedCalib.hScale) : carry.hScale,
  )
  const [vScale, setVScale] = useState<string>(
    savedCalib?.vScale != null ? String(savedCalib.vScale) : carry.vScale,
  )
  const [refSp, setRefSp] = useState<string>(
    savedCalib?.centerShift != null ? String(savedCalib.centerShift) : String(spOffset),
  )

  /**
   * 掴んで いる 変化点。 コマンド を 何 も 選んで いない とき に
   * 図 の 点 を 押す と ここ に 入り、 次 に 押した 所 へ 動く。
   */
  const [movingId, setMovingId] = useState<string | null>(null)

  /** 図面 と 縮尺 は 次 の 線 に 持ち越す ので、 変えた とき に 覚えて おく */
  const changeDxf = (id: string | null) => {
    setActiveDxfId(id)
    onCarry({ ...carry, dxfId: id })
  }
  const changeHScale = (v: string) => {
    setHScale(v)
    onCarry({ ...carry, hScale: v })
  }
  const changeVScale = (v: string) => {
    setVScale(v)
    onCarry({ ...carry, vScale: v })
  }

  const [pickMode, setPickMode] = useState<'dl' | 'ref' | 'trace' | 'insert' | null>(null)
  const [snapEnabled, setSnapEnabled] = useState(true)
  /**
   * 手元 の 点列。 横断 の トレース と 同じ で、 今 登録 されて いる 線 を
   * 初め に 読み込んで おき、 確定 まで は ここ だけ を 触る。
   */
  const [points, setPoints] = useState<TracePoint[]>(() =>
    existingPoints(target).map((p) => ({ ...p, id: newId() })),
  )
  /** 次 の 1 点 を 入れる 位置。 null は 末尾 */
  const [insertIndex, setInsertIndex] = useState<number | null>(null)
  /**
   * どちら の 端 に 伸ばす か。 横断 の 左右 と 同じ 考え 方 で、
   * 縦断 は 起点側 (SP 小) が 左、 終点側 (SP 大) が 右。
   *   left  … 拾う たび に 列 の 先頭 へ
   *   right … 拾う たび に 列 の 末尾 へ
   * null は 「位置指定」 で、 挿入位置 (既定 は 末尾) に 従う。
   */
  const [traceSide, setTraceSide] = useState<'left' | 'right' | null>(null)

  /** 対象 を 変える と その 対象 の 今 の 線 を 読み 直す */
  const switchTarget = (t: ProfileTraceTarget) => {
    onChangeTarget(t)
    setPoints(existingPoints(t).map((p) => ({ ...p, id: newId() })))
    setInsertIndex(null)
    setTraceSide(null)
  }

  const undoLast = () => {
    setPoints((prev) => {
      if (prev.length === 0) return prev
      // 先頭 に 積んで いる とき は 先頭 を 取り消す
      if (traceSide === 'left') return prev.slice(1)
      if (traceSide === 'right') return prev.slice(0, -1)
      const at = insertIndex == null ? prev.length : Math.min(insertIndex, prev.length)
      if (at === 0) return prev
      return [...prev.slice(0, at - 1), ...prev.slice(at)]
    })
    setInsertIndex((i) => (i == null ? null : Math.max(0, i - 1)))
  }

  // 図面 の 読み込み。 SFC / P21 は 変換 して から 渡す
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
        console.error('[profile trace download]', e)
        setError(e instanceof Error ? e.message : '取得 失敗')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [activeDxf])

  /** 揃って いれば 校正 と して 成立 */
  const calib = useMemo<DxfCalibration | null>(() => {
    if (dlY == null || refX == null) return null
    const dl = parseFloat(dlEl)
    const h = parseFloat(hScale)
    const v = parseFloat(vScale)
    const sp = parseFloat(refSp)
    if (!Number.isFinite(dl) || !Number.isFinite(h) || h <= 0) return null
    if (!Number.isFinite(v) || v <= 0) return null
    return {
      dlY,
      centerX: refX,
      dlElevation: dl,
      hScale: h,
      vScale: v,
      centerShift: Number.isFinite(sp) ? sp : 0,
    }
  }, [dlY, refX, dlEl, hScale, vScale, refSp])

  // 校正 は 揃った そば から 保存 (横断 と 同じ)
  useEffect(() => {
    if (!calib) return
    const c = savedCalib
    if (
      c &&
      c.dlY === calib.dlY &&
      c.centerX === calib.centerX &&
      c.dlElevation === calib.dlElevation &&
      c.hScale === calib.hScale &&
      c.vScale === calib.vScale &&
      (c.centerShift ?? 0) === (calib.centerShift ?? 0) &&
      savedDxfId === activeDxfId
    ) {
      return
    }
    const t = setTimeout(() => onSaveCalib(calib, activeDxfId), 400)
    return () => clearTimeout(t)
    // onSaveCalib は 毎 レンダ 作り直される ので 依存 に 入れない
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [calib, savedCalib, activeDxfId, savedDxfId])

  // BS で 直前 1 点 を 取消 (横断 の トレース と 同じ)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && movingId != null) {
        setMovingId(null)
        return
      }
      if (e.key !== 'Backspace') return
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return
      e.preventDefault()
      undoLast()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // undoLast は 毎 レンダ 作り直される ので 依存 に 入れない
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, insertIndex, movingId])

  /**
   * 図面 の 座標 で、 押した 所 に 一番 近い 変化点 を 探す。
   * 許容 は 線 の 広がり の 3% (図面 の 縮尺 に 依ら ず 効く ように)。
   */
  const nearestPoint = (p: { x: number; y: number }): TracePoint | null => {
    if (!calib || points.length === 0) return null
    const dxf = points.map((q) => ({ q, d: worldToDxf(q.sp, q.elevation, calib) }))
    const xs = dxf.map((e) => e.d.x)
    const ys = dxf.map((e) => e.d.y)
    const span = Math.hypot(
      Math.max(...xs) - Math.min(...xs),
      Math.max(...ys) - Math.min(...ys),
    )
    const tol = Math.max(span * 0.03, 1e-6)
    let best: TracePoint | null = null
    let bestD = tol
    for (const e of dxf) {
      const d = Math.hypot(p.x - e.d.x, p.y - e.d.y)
      if (d <= bestD) {
        bestD = d
        best = e.q
      }
    }
    return best
  }

  /** 図面 を クリック した とき */
  const handlePick = (p: { x: number; y: number }) => {
    // コマンド 無し: 変化点 を 掴む → もう 一度 押した 所 へ 動かす
    if (pickMode == null) {
      if (!calib) return
      if (movingId != null) {
        const w = dxfToWorld(p.x, p.y, calib)
        setPoints((prev) =>
          prev
            .map((q) => (q.id === movingId ? { ...q, sp: w.offset, elevation: w.elevation } : q))
            .sort((a, b) => a.sp - b.sp),
        )
        setMovingId(null)
        return
      }
      const hit = nearestPoint(p)
      if (hit) setMovingId(hit.id)
      return
    }
    if (pickMode === 'dl') {
      setDlY(Math.round(p.y * 1000) / 1000)
      setPickMode(null)
      return
    }
    if (pickMode === 'ref') {
      setRefX(Math.round(p.x * 1000) / 1000)
      setPickMode(null)
      return
    }
    if (pickMode === 'insert') {
      // 既存 の 線 の どの 区間 を 押した か を 見て、 その 間 を 入り 先 に する
      if (!calib || points.length < 2) return
      // 図 に 出て いる 折れ線 (= SP 順) の 区間 で 判定 する
      const line = [...points].sort((a, b) => a.sp - b.sp)
      const dxf = line.map((q) => worldToDxf(q.sp, q.elevation, calib))
      let best = -1
      let bestD = Infinity
      for (let i = 0; i < dxf.length - 1; i++) {
        const d = distToSegment(p, dxf[i], dxf[i + 1])
        if (d < bestD) {
          bestD = d
          best = i
        }
      }
      if (best < 0) return
      setInsertIndex(best + 1)
      setTraceSide(null)
      setPickMode('trace')
      return
    }
    if (pickMode === 'trace' && calib) {
      const w = dxfToWorld(p.x, p.y, calib)
      const pt: TracePoint = { id: newId(), sp: w.offset, elevation: w.elevation }
      // SP 順 に 入れる。 どこ を 押して も その SP の 位置 に 収まる ので、
      // 図 の 折れ線 と 点列 の 並び が 常に 一致 する。
      setPoints((prev) => [...prev, pt].sort((a, b) => a.sp - b.sp))
      // 区間 を 選んで 入れた ら その 指定 は 済み
      setInsertIndex(null)
    }
  }

  /** 測点 の SP。 内挿 の 行き先 */
  const stationSps = useMemo(
    () => stations.map((st) => ({ id: st.id, sp: st.distance + spOffset })),
    [stations, spOffset],
  )

  const sampled = useMemo(
    () => (points.length >= 2 ? sampleProfileAtStations(points, stationSps) : []),
    [points, stationSps],
  )

  /** 図 に 重ねる: トレース した 折れ線 と 点、 測点 で 拾った 位置 */
  const overlays = useMemo(() => {
    if (!calib || points.length === 0) return []
    const color = TARGETS.find((t) => t.key === target)?.color ?? '#b45309'
    const sorted = [...points].sort((a, b) => a.sp - b.sp)
    const items: NonNullable<React.ComponentProps<typeof DxfCrossSectionViewer>['overlays']> = []
    if (sorted.length >= 2) {
      items.push({
        kind: 'line',
        color,
        pts: sorted.map((p) => worldToDxf(p.sp, p.elevation, calib)),
      })
    }
    for (const p of points) {
      const q = worldToDxf(p.sp, p.elevation, calib)
      items.push({ kind: 'dot', x: q.x, y: q.y, color, r: 3 })
    }
    // 掴んで いる 点 は 大きく 出す
    if (movingId != null) {
      const m = points.find((q) => q.id === movingId)
      if (m) {
        const q = worldToDxf(m.sp, m.elevation, calib)
        items.push({ kind: 'dot', x: q.x, y: q.y, color: '#dc2626', r: 6, label: '移動中' })
      }
    }
    // 選んだ 区間 は 橙 の 破線 で 示す。 次 の 1 点 は この 間 に 入る
    if (insertIndex != null && insertIndex > 0 && insertIndex < sorted.length) {
      const a = sorted[insertIndex - 1]
      const b = sorted[insertIndex]
      items.push({
        kind: 'line',
        color: '#f59e0b',
        dashed: true,
        pts: [worldToDxf(a.sp, a.elevation, calib), worldToDxf(b.sp, b.elevation, calib)],
      })
    }
    const byId = new Map(stations.map((st) => [st.id, st]))
    for (const s of sampled) {
      const st = byId.get(s.stationId)
      if (!st) continue
      const q = worldToDxf(st.distance + spOffset, s.elevation, calib)
      items.push({ kind: 'dot', x: q.x, y: q.y, color: '#7c3aed', r: 2, label: st.label })
    }
    return items
  }, [calib, points, sampled, stations, spOffset, target, insertIndex, movingId])

  const rubberFrom = useMemo(() => {
    if (!calib || points.length === 0) return null
    // 点 を 動かして いる 間 は その 前後 から 引く
    if (movingId != null) {
      const line = [...points].sort((a, b) => a.sp - b.sp)
      const at = line.findIndex((q) => q.id === movingId)
      if (at >= 0) {
        const ends = [line[at - 1], line[at + 1]].filter((q) => q != null)
        if (ends.length > 0) return ends.map((q) => worldToDxf(q.sp, q.elevation, calib))
      }
      return null
    }
    if (pickMode !== 'trace') return null
    const line = [...points].sort((a, b) => a.sp - b.sp)
    // 区間 を 選んで いる とき は その 前後 2 点 から 引く。
    // 入れた 後 の 形 が 両側 とも 見える ように する ため。
    if (traceSide == null && insertIndex != null) {
      const at = Math.min(Math.max(insertIndex, 0), line.length)
      const ends = [line[at - 1], line[at]].filter((p) => p != null)
      if (ends.length > 0) return ends.map((p) => worldToDxf(p.sp, p.elevation, calib))
    }
    const from =
      traceSide === 'left' ? line[0] : line[line.length - 1]
    return worldToDxf(from.sp, from.elevation, calib)
  }, [calib, pickMode, points, traceSide, insertIndex, movingId])

  /* ===== 工区 の ファイル から 図面 を 持って くる ===== */
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
      console.error('[farm file → cad]', e)
      setError(e instanceof Error ? e.message : '取込 に 失敗')
    } finally {
      setBusy(false)
    }
  }

  /** 測点 と 重なら ない (= 格子 に 乗ら ない) 点 */
  const offGrid = useMemo(
    () =>
      points.filter(
        (p) => !stationSps.some((st) => Math.abs(st.sp - p.sp) <= 0.05),
      ),
    [points, stationSps],
  )

  /** 今 の 線 の 分 を 入れる (閉じ ない) */
  const commit = () => {
    if (sampled.length === 0) return
    onApply(
      target,
      sampled,
      [...points].sort((a, b) => a.sp - b.sp).map((p) => ({ sp: p.sp, elevation: p.elevation })),
    )
  }

  /** いつ 確定 した か (手応え 用) */
  const [confirmedAt, setConfirmedAt] = useState<string | null>(null)

  /** 確定。 横断 の トレース と 同じ で 閉じ ない */
  const handleApply = () => {
    if (sampled.length === 0) return
    commit()
    setConfirmedAt(
      `${lineName} の ${TARGETS.find((t) => t.key === target)?.label} に ${sampled.length} 測点 分 を 入れました (${new Date().toLocaleTimeString('ja-JP')})`,
    )
  }

  /**
   * 隣 の 線 へ。 横断 の 測点 送り と 同じ で、 今 の 分 は 自動 で 入れて から 移る。
   * 図面 と 校正 は 線 ごと に 持って いる ので、 移った 先 で 読み 直される。
   */
  const switchLine = (idx: number) => {
    commit()
    onSwitchLine(idx)
  }

  const cursorLabel = (p: { x: number; y: number }): string[] | null => {
    if (!calib) return null
    const w = dxfToWorld(p.x, p.y, calib)
    return [`SP ${w.offset.toFixed(2)}`, `標高 ${w.elevation.toFixed(3)}`]
  }

  return (
    <div className="fixed inset-0 z-[1500] bg-black/40 flex items-center justify-center p-4">
      <div className="bg-white rounded shadow-xl w-full h-full max-w-[1600px] flex flex-col">
        {/* 見出し */}
        <div className="flex items-center gap-2 px-3 py-2 border-b shrink-0">
          {/* 隣 の 線 へ。 H → I の ように 送れる */}
          <div className="flex items-center gap-0.5 shrink-0">
            <button
              onClick={() => prevLine && switchLine(prevLine.idx)}
              disabled={!prevLine}
              className="px-2 py-0.5 text-[11px] border rounded bg-white hover:bg-slate-50 disabled:opacity-30"
              title="左隣 の 線 へ (今 の 分 は 入れて から 移ります)"
            >
              ◀ {prevLine?.name ?? '—'}
            </button>
            <button
              onClick={() => nextLine && switchLine(nextLine.idx)}
              disabled={!nextLine}
              className="px-2 py-0.5 text-[11px] border rounded bg-white hover:bg-slate-50 disabled:opacity-30"
              title="右隣 の 線 へ (今 の 分 は 入れて から 移ります)"
            >
              {nextLine?.name ?? '—'} ▶
            </button>
          </div>
          <h3 className="text-sm font-semibold">
            CAD から 縦断 を トレース —{' '}
            <span className="font-mono text-slate-600">{lineName}</span>
          </h3>
          <div className="flex items-center gap-0.5 ml-2">
            <span className="text-[10px] text-slate-500 mr-1">対象</span>
            {TARGETS.map((t) => (
              <button
                key={t.key}
                onClick={() => switchTarget(t.key)}
                className={
                  'px-2 py-0.5 text-[11px] border rounded ' +
                  (target === t.key
                    ? 'bg-slate-800 text-white border-slate-800'
                    : 'bg-white hover:bg-slate-50 text-slate-600')
                }
              >
                {t.label}
              </button>
            ))}
          </div>
          <button onClick={onClose} className="ml-auto p-1 hover:bg-slate-100 rounded" title="閉じる">
            <X className="h-4 w-4 text-slate-500" />
          </button>
        </div>

        <div className="flex-1 min-h-0 flex">
          {/* 左: 図面 / 校正 / 点 */}
          <div className="w-72 border-r p-3 overflow-y-auto text-xs flex flex-col gap-3 shrink-0">
            <div>
              <div className="font-semibold mb-1">CAD 図面 (DXF / SFC / P21)</div>
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
                        (f.id === activeDxfId
                          ? 'bg-blue-50 border-blue-400'
                          : 'bg-white hover:bg-slate-50')
                      }
                    >
                      <input
                        type="radio"
                        name="profile-dxf"
                        checked={f.id === activeDxfId}
                        onChange={() => changeDxf(f.id)}
                        className="cursor-pointer"
                      />
                      <span className="flex-1 text-[11px] font-mono truncate" title={f.name}>
                        {f.name}
                      </span>
                    </label>
                  ))}
                </div>
              )}
              <div className="mt-1">
                <ProfileTraceUploadButton
                  busy={busy}
                  onPick={(f) => {
                    setBusy(true)
                    setError(null)
                    onUploadDxf(f)
                      .catch((e) => {
                        console.error('[cad upload]', e)
                        setError(e instanceof Error ? e.message : 'アップロード 失敗')
                      })
                      .finally(() => setBusy(false))
                  }}
                />
              </div>
              <button
                onClick={() => void openFarmPicker()}
                disabled={busy}
                className={
                  'mt-1 w-full flex items-center justify-center gap-1 px-2 py-1 border rounded disabled:opacity-50 ' +
                  (farmPickOpen
                    ? 'bg-slate-700 text-white border-slate-700'
                    : 'bg-white hover:bg-slate-50 text-slate-700')
                }
                title="ファイル に 上げて ある DXF / SFC / P21 から 選ぶ"
              >
                {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <FolderOpen className="h-3 w-3" />}
                ファイルから選ぶ
              </button>
              {farmPickOpen && (
                <div className="mt-1 border rounded bg-slate-50 p-1 max-h-48 overflow-auto">
                  {farmFiles == null ? (
                    <div className="text-[11px] text-slate-500 px-1 py-2">読込中...</div>
                  ) : farmFiles.length === 0 ? (
                    <div className="text-[11px] text-slate-500 px-1 py-2">
                      この 工区 の ファイル に CAD が ありません。
                    </div>
                  ) : (
                    <div className="flex flex-col gap-0.5">
                      {farmFiles.map((r) => (
                        <button
                          key={r.id}
                          onClick={() => void importFarmFile(r)}
                          disabled={busy}
                          className="flex items-center gap-1 px-1.5 py-1 border rounded bg-white hover:bg-blue-50 text-left disabled:opacity-40"
                          title={r.name}
                        >
                          <span className="px-1 rounded bg-slate-100 text-[10px] uppercase text-slate-500 shrink-0">
                            {r.kind}
                          </span>
                          <span className="flex-1 text-[11px] font-mono truncate">{r.name}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* 校正 */}
            <div>
              <div className="font-semibold mb-1">① 校正</div>
              <div className="grid grid-cols-1 gap-1.5">
                <div className="grid grid-cols-2 gap-1.5">
                  <label className="flex items-center gap-1">
                    <span className="text-slate-500 shrink-0">H 1:</span>
                    <input
                      type="number"
                      step={1}
                      value={hScale}
                      onChange={(e) => changeHScale(e.target.value)}
                      title="横 (SP 方向) の 縮尺"
                      className="w-full min-w-0 px-1 py-0.5 border rounded font-mono text-right"
                    />
                  </label>
                  <label className="flex items-center gap-1">
                    <span className="text-slate-500 shrink-0">V 1:</span>
                    <input
                      type="number"
                      step={1}
                      value={vScale}
                      onChange={(e) => changeVScale(e.target.value)}
                      title="縦 (標高 方向) の 縮尺"
                      className="w-full min-w-0 px-1 py-0.5 border rounded font-mono text-right"
                    />
                  </label>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setPickMode(pickMode === 'dl' ? null : 'dl')}
                    className={
                      'flex-1 min-w-0 px-2 py-1 border rounded text-left ' +
                      (pickMode === 'dl'
                        ? 'bg-purple-600 text-white border-purple-600'
                        : 'bg-white hover:bg-slate-50')
                    }
                  >
                    DL 選択
                    {dlY != null && <span className="ml-1 text-emerald-600">✓</span>}
                  </button>
                  <input
                    type="number"
                    step={0.01}
                    value={dlEl}
                    onChange={(e) => setDlEl(e.target.value)}
                    placeholder="標高"
                    title="DL の 実標高 (m)"
                    className="w-20 shrink-0 px-1 py-0.5 border rounded font-mono text-right"
                  />
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setPickMode(pickMode === 'ref' ? null : 'ref')}
                    className={
                      'flex-1 min-w-0 px-2 py-1 border rounded text-left ' +
                      (pickMode === 'ref'
                        ? 'bg-purple-600 text-white border-purple-600'
                        : 'bg-white hover:bg-slate-50')
                    }
                  >
                    基準線 選択
                    {refX != null && <span className="ml-1 text-emerald-600">✓</span>}
                  </button>
                  <input
                    type="number"
                    step={0.01}
                    value={refSp}
                    onChange={(e) => setRefSp(e.target.value)}
                    placeholder="SP"
                    title="選んだ 縦線 の SP 値"
                    className="w-20 shrink-0 px-1 py-0.5 border rounded font-mono text-right"
                  />
                </div>
                <div className="text-[11px] text-slate-400">
                  {calib ? '校正 は 自動 で 保存 されます' : 'DL と 基準線 を 図面 で 選ぶ と 校正 が 決まります'}
                </div>
              </div>
            </div>

            {/* トレース。 並び は 横断 の トレース と 同じ */}
            <div className="flex flex-col gap-1.5">
              <div className="font-semibold">② トレース</div>
              {/* 縦断 も 端 を 決めて から なぞる。 左 は 起点側 (SP 小) で 列 の 先頭、
                  右 は 終点側 (SP 大) で 列 の 末尾 に 積む。 */}
              <div className="flex gap-1">
                {(
                  [
                    { side: 'left' as const, label: '← 左 (起点側)' },
                    { side: 'right' as const, label: '右 (終点側) →' },
                  ]
                ).map((b) => {
                  const on = pickMode === 'trace' && traceSide === b.side
                  return (
                    <button
                      key={b.side}
                      disabled={!calib}
                      onClick={() => {
                        if (on) {
                          setPickMode(null)
                          setTraceSide(null)
                          return
                        }
                        setTraceSide(b.side)
                        setInsertIndex(null)
                        setPickMode('trace')
                      }}
                      className={
                        'flex-1 px-1.5 py-1 border rounded disabled:opacity-40 ' +
                        (on
                          ? 'bg-emerald-600 text-white border-emerald-600'
                          : 'bg-white hover:bg-slate-50')
                      }
                    >
                      {b.label}
                    </button>
                  )
                })}
              </div>
              <div className="flex items-center gap-1 text-[11px]">
                <button
                  onClick={() => setPickMode(pickMode === 'insert' ? null : 'insert')}
                  disabled={points.length < 2}
                  className={
                    'px-2 py-0.5 border rounded disabled:opacity-40 ' +
                    (pickMode === 'insert'
                      ? 'bg-amber-500 text-white border-amber-500'
                      : 'bg-white hover:bg-slate-50')
                  }
                  title="図 の 上 で 既存 の 線 を 選ぶ と、 その 区間 の 間 に 入る"
                >
                  内側に追加 (線分を選ぶ)
                </button>
                {insertIndex != null && (
                  <button
                    onClick={() => setInsertIndex(null)}
                    className="px-2 py-0.5 border rounded bg-white hover:bg-slate-50"
                    title="末尾 に 足す 状態 に 戻す"
                  >
                    末尾に戻す
                  </button>
                )}
              </div>
              {pickMode === 'insert' && (
                <div className="text-[11px] text-amber-700">
                  図 の 上 で 線 の 区間 を 押して ください。 その 間 に 入ります。
                </div>
              )}
              {pickMode === 'trace' && traceSide == null && (
                <div className="text-[11px] text-emerald-700">
                  トレース 中 (クリックで 追加)
                </div>
              )}
              {traceSide != null && (
                <div className="text-[11px] text-slate-500">
                  {traceSide === 'left' ? '起点側 (左)' : '終点側 (右)'} に 伸ばして います。
                  拾った 点 は 列 の {traceSide === 'left' ? '先頭' : '末尾'} に 積まれます。
                </div>
              )}
              {pickMode == null && (
                <div className={movingId != null ? 'text-[11px] text-red-600' : 'text-[11px] text-slate-500'}>
                  {movingId != null
                    ? '変化点 を 掴んで います。 動かす 先 を 押して ください (Esc で やめる)'
                    : 'コマンド を 押して いない 間 は、 図 の 変化点 を 押す と 掴めます'}
                </div>
              )}
              <div className="flex items-center gap-1 text-[11px] pt-1 border-t">
                <span className="text-slate-500">拾い済 {points.length} 点</span>
                <button
                  onClick={undoLast}
                  disabled={points.length === 0}
                  className="ml-auto px-2 py-0.5 border rounded bg-white hover:bg-slate-50 disabled:opacity-40"
                  title="直前 1 点を 取消 (BS でも 可)"
                >
                  1 点 戻す (BS)
                </button>
                <button
                  onClick={() => {
                    setPoints([])
                    setInsertIndex(null)
                    setMovingId(null)
                  }}
                  disabled={points.length === 0}
                  className="px-2 py-0.5 border rounded text-red-600 hover:bg-red-50 disabled:opacity-40"
                >
                  全クリア
                </button>
              </div>
              <label className="flex items-center gap-1.5 text-[11px] cursor-pointer select-none pt-1 border-t">
                <input
                  type="checkbox"
                  checked={snapEnabled}
                  onChange={(e) => setSnapEnabled(e.target.checked)}
                  className="cursor-pointer"
                />
                <span>ピック (端点 / 交点に 吸着)</span>
              </label>
              {insertIndex != null && pickMode !== 'insert' && (
                <div className="text-[11px] text-amber-700">
                  橙 の 破線 の 区間 に 入れます (点 は SP 順 に 収まります)
                </div>
              )}
            </div>
          </div>

          {/* 中央: ビューア */}
          <div className="flex-1 min-w-0 p-2 flex flex-col">
            {loading && <div className="text-xs text-slate-500">図面 読込中...</div>}
            {error && <div className="text-xs text-red-600">{error}</div>}
            <div className="flex-1 min-h-0">
              {dxfText || parsedDoc ? (
                <DxfCrossSectionViewer
                  dxfText={dxfText ?? ''}
                  parsedDoc={parsedDoc}
                  onCanvasPick={(p) => handlePick(p)}
                  pickCursorHint={
                    pickMode === 'ref' ? 'center' : pickMode === 'dl' ? 'dl' : 'trace'
                  }
                  highlightDlY={dlY}
                  highlightCenterX={refX}
                  overlays={overlays}
                  snapEnabled={snapEnabled && pickMode !== 'insert' && movingId == null}
                  cursorLabelFormatter={calib ? cursorLabel : undefined}
                  traceRubberBandFrom={rubberFrom}
                />
              ) : (
                <div className="h-full flex items-center justify-center text-xs text-slate-400">
                  左 で 図面 を 選ぶ か、 取り込んで ください。
                </div>
              )}
            </div>
          </div>
        </div>

        {/* 下: 確定 */}
        <div className="flex items-center gap-2 px-3 py-2 border-t bg-slate-50 shrink-0">
          <span className="text-[11px] text-slate-500">
            {points.length === 0
              ? 'トレース した 点 が ありません'
              : sampled.length === 0
                ? 'トレース した 範囲 に 測点 が ありません'
                : `${lineName} の ${TARGETS.find((t) => t.key === target)?.label} に ${sampled.length} 測点 分 を 入れます (トレース ${points.length} 点)`}
            {offGrid.length > 0 && (
              <span className={target === 'planned' ? 'ml-2 text-slate-500' : 'ml-2 text-amber-700'}>
                {target === 'planned'
                  ? `格子 以外 の ${offGrid.length} 点 は 中間点 と して 残ります`
                  : `格子 以外 の ${offGrid.length} 点 は 入りません (中間点 と して 残せる の は 計画 だけ)`}
              </span>
            )}
          </span>
          {confirmedAt && <span className="text-[11px] text-emerald-700">{confirmedAt}</span>}
          <button
            onClick={onClose}
            className="ml-auto px-3 py-1 border rounded bg-white hover:bg-slate-50 text-slate-600"
            title="確定 して いない 分 は 捨てて 閉じる"
          >
            閉じる
          </button>
          <button
            onClick={handleApply}
            disabled={sampled.length === 0}
            className="px-4 py-1 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40"
          >
            確定
          </button>
        </div>
      </div>
    </div>
  )
}

/** アップロード の 入口 (図面 が 1 枚 も 無い とき 用) */
export function ProfileTraceUploadButton({
  onPick,
  busy,
}: {
  onPick: (file: File) => void
  busy?: boolean
}) {
  return (
    <label className="w-full flex items-center justify-center gap-1 px-2 py-1 border rounded bg-blue-600 text-white hover:bg-blue-700 cursor-pointer">
      {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Upload className="h-3 w-3" />}
      CAD 図面 を 取込
      <input
        type="file"
        accept=".dxf,.sfc,.p21,.DXF,.SFC,.P21"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) onPick(f)
          e.target.value = ''
        }}
        className="hidden"
      />
    </label>
  )
}
