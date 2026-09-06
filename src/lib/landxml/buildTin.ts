// LandXML の テキストから 地図描画用の TIN を 作る。
//
// PC の 全体図 と スマホの 測設画面 で 同じ 結果に なるよう、ここ 1 か所に 置く。
// 描画は components/map/TinPane.tsx。

import { renderTin, type RenderedTin } from '@/lib/landxml/tinRender'
import { parseLandXml } from '@/lib/landxml/parser'
import { CoordinateConverter } from '@/lib/coordinates'

/**
 * LandXML の テキストから 描画用 TIN を 作る。
 * 三角形が 一番多い Surface を 採用する (通常は 1 面)。
 */
export function buildTinFromXml(
  xmlText: string | null,
  sourceName: string,
  projectZone: number | null,
): RenderedTin | null {
  if (!xmlText || projectZone == null) return null
  try {
    const parsed = parseLandXml(xmlText, sourceName)
    if (parsed.surfaces.length === 0) return null
    const surface = parsed.surfaces.reduce((best, s) =>
      s.triangles.length > best.triangles.length ? s : best,
    )
    const conv = new CoordinateConverter(projectZone)
    return renderTin(surface, conv)
  } catch (e) {
    console.error(`[tin parse ${sourceName}]`, e)
    return null
  }
}
