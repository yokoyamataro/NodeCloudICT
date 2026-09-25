import { useEffect, useMemo, useState } from 'react'
import { Polyline } from 'react-leaflet'
import { decodeDxfBytes, parseDxf, type DxfDocument } from '@/lib/dxfRender'
import { parseSxfFile } from '@/lib/sxf'
import { downloadFarmFileBytes } from '@/lib/farmFiles'
import { CoordinateConverter } from '@/lib/coordinates'
import {
  solvePlanCadTransform,
  planCadToWorld,
  planCadShapeToPolylines,
} from '@/lib/openChannel/planCad'
import type { FarmPlanCad } from '@/stores/farmStore'

/**
 * 読み込み 済み の 図面 を 使い回す ため の 置き場。
 * ページ を 行き来 する たび に 落とし 直す と 重い ので、
 * storage_path を 鍵 に して モジュール 側 で 抱えて おく。
 */
const docCache = new Map<string, DxfDocument>()
const loading = new Set<string>()

/** 1 枚 ぶん の 図形 を 落として 読む */
function usePlanCadDoc(storagePath: string | null): DxfDocument | null {
  const [, force] = useState(0)
  useEffect(() => {
    if (!storagePath) return
    if (docCache.has(storagePath) || loading.has(storagePath)) return
    loading.add(storagePath)
    let cancelled = false
    void downloadFarmFileBytes(storagePath)
      .then((buf) => {
        const text = decodeDxfBytes(buf)
        const ext = storagePath.split('.').pop()?.toLowerCase() ?? ''
        const doc = ext === 'sfc' || ext === 'p21' ? parseSxfFile(text) : parseDxf(text)
        docCache.set(storagePath, doc)
      })
      .catch((e) => {
        console.error('[plan cad]', storagePath, e)
      })
      .finally(() => {
        loading.delete(storagePath)
        if (!cancelled) force((n) => n + 1)
      })
    return () => {
      cancelled = true
    }
  }, [storagePath])
  return storagePath ? (docCache.get(storagePath) ?? null) : null
}

/** 上限。 これ 以上 は 地図 が 重く なる ので 打ち切る */
const MAX_LINES = 8000

function PlanCadOne({ cad, zone }: { cad: FarmPlanCad; zone: number }) {
  const doc = usePlanCadDoc(cad.storagePath)
  const lines = useMemo(() => {
    if (!doc) return []
    const t = solvePlanCadTransform(cad.p1, cad.p2)
    if (!t) return []
    const converter = new CoordinateConverter(zone)
    const out: { key: string; color: string; pts: [number, number][] }[] = []
    for (let i = 0; i < doc.shapes.length && out.length < MAX_LINES; i++) {
      const sh = doc.shapes[i]
      for (const poly of planCadShapeToPolylines(sh)) {
        if (poly.length < 2) continue
        out.push({
          key: `${cad.id}-${i}-${out.length}`,
          color: sh.color || '#64748b',
          pts: poly.map((p) => {
            const w = planCadToWorld(t, p.x, p.y)
            const ll = converter.toLatLng(w.x, w.y)
            return [ll.lat, ll.lng] as [number, number]
          }),
        })
      }
      if (out.length >= MAX_LINES) break
    }
    return out
  }, [doc, cad, zone])

  return (
    <>
      {lines.map((l) => (
        <Polyline
          key={l.key}
          positions={l.pts}
          interactive={false}
          pathOptions={{ color: l.color, weight: 1, opacity: cad.opacity ?? 0.7 }}
        />
      ))}
    </>
  )
}

/**
 * 工区 に 登録 した 平面図 CAD を 地図 の 下敷き に する。
 *
 * 地図 を 出す 画面 なら どこ でも 同じ 見え方 に なる ように、
 * 描画 は この 部品 に 寄せて ある。 図面 は ファイル管理 の もの を 使う。
 */
export function PlanCadLayers({
  cads,
  zone,
  /** 種類 で 「CAD」 を 選んで いる 間 は 全部 出す */
  forceAll = false,
}: {
  cads: FarmPlanCad[] | null | undefined
  zone: number
  forceAll?: boolean
}) {
  const list = (cads ?? []).filter((c) => forceAll || c.visible !== false)
  if (list.length === 0) return null
  return (
    <>
      {list.map((c) => (
        <PlanCadOne key={c.id} cad={c} zone={zone} />
      ))}
    </>
  )
}
