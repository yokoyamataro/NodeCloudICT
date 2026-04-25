// LandXML 1.2 出力ビルダー。
// Alignments（中心線形）と Surfaces（TIN）を一つの LandXML 文字列にまとめる。
//
// 座標は LandXML 仕様どおり「Northing Easting [Elevation]」の順で出力する。
// 本プロジェクトの (x, y) は (北, 東) なので x → Northing, y → Easting。

import type { Alignment, AlignmentSegment } from './types'
import type { TinSurface } from './surface'

export interface LandXmlExportOptions {
  alignments: Alignment[]
  surfaces: { name: string; surface: TinSurface }[]
  /** 出力ファイル名（OriginatingProject 用） */
  projectName?: string
  /** 投影系名（CoordinateSystem horizontalDatum 用、任意） */
  coordinateZoneName?: string
}

/** LandXML 1.2 形式の XML 文字列を組み立てる */
export function buildLandXml(opts: LandXmlExportOptions): string {
  const { alignments, surfaces, projectName, coordinateZoneName } = opts
  const now = new Date()
  const dateStr = now.toISOString().slice(0, 10)
  const timeStr = now.toTimeString().slice(0, 8)

  const lines: string[] = []
  lines.push('<?xml version="1.0" encoding="UTF-8"?>')
  lines.push(
    '<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" ' +
      'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
      'xsi:schemaLocation="http://www.landxml.org/schema/LandXML-1.2 ' +
      'http://www.landxml.org/schema/LandXML-1.2/LandXML-1.2.xsd" ' +
      `version="1.2" date="${dateStr}" time="${timeStr}">`,
  )

  // Project（任意）
  if (projectName) {
    lines.push(`  <Project name="${escapeXml(projectName)}"/>`)
  }

  // Application 情報
  lines.push(
    '  <Application name="NodeCloud" desc="NodeCloud ICT" ' +
      `version="1.0" manufacturer="NodeCloud" timeStamp="${now.toISOString()}"/>`,
  )

  // Units（メートル系）
  lines.push('  <Units>')
  lines.push(
    '    <Metric linearUnit="meter" areaUnit="squareMeter" volumeUnit="cubicMeter" ' +
      'temperatureUnit="celsius" pressureUnit="milliBars" diameterUnit="millimeter" ' +
      'angularUnit="radians" directionUnit="radians"/>',
  )
  lines.push('  </Units>')

  // CoordinateSystem（任意）
  if (coordinateZoneName) {
    lines.push(
      `  <CoordinateSystem horizontalDatum="${escapeXml(coordinateZoneName)}"/>`,
    )
  }

  // Alignments
  if (alignments.length > 0) {
    lines.push('  <Alignments>')
    for (const a of alignments) {
      lines.push(...buildAlignmentLines(a))
    }
    lines.push('  </Alignments>')
  }

  // Surfaces
  if (surfaces.length > 0) {
    lines.push('  <Surfaces>')
    for (const s of surfaces) {
      lines.push(...buildSurfaceLines(s.name, s.surface))
    }
    lines.push('  </Surfaces>')
  }

  lines.push('</LandXML>')
  return lines.join('\n') + '\n'
}

function buildAlignmentLines(a: Alignment): string[] {
  const out: string[] = []
  const totalLen = a.totalLength || sumLen(a.segments)
  const staStart = a.staStart ?? 0
  const safeName = escapeXml(a.name)
  out.push(
    `    <Alignment name="${safeName}" length="${num(totalLen)}" staStart="${num(staStart)}">`,
  )

  // CoordGeom（平面線形）
  out.push('      <CoordGeom>')
  for (const seg of a.segments) {
    out.push(...buildSegmentLines(seg))
  }
  out.push('      </CoordGeom>')

  // Profile（縦断）— Z 値が含まれていれば PVI を出力
  const pvis = collectPvis(a.segments, staStart)
  if (pvis.length >= 2) {
    out.push('      <Profile>')
    out.push(`        <ProfAlign name="${safeName}_design">`)
    for (const pvi of pvis) {
      out.push(`          <PVI>${num(pvi.station)} ${num(pvi.z)}</PVI>`)
    }
    out.push('        </ProfAlign>')
    out.push('      </Profile>')
  }

  out.push('    </Alignment>')
  return out
}

function buildSegmentLines(seg: AlignmentSegment): string[] {
  const out: string[] = []
  if (seg.type === 'line') {
    out.push(`        <Line length="${num(seg.length)}">`)
    out.push(`          <Start>${num(seg.startX)} ${num(seg.startY)}</Start>`)
    out.push(`          <End>${num(seg.endX)} ${num(seg.endY)}</End>`)
    out.push('        </Line>')
  } else if (seg.type === 'curve') {
    const rot = seg.rotation === 'ccw' ? 'ccw' : 'cw'
    const radius = seg.radius ?? 0
    out.push(
      `        <Curve length="${num(seg.length)}" radius="${num(radius)}" rot="${rot}">`,
    )
    out.push(`          <Start>${num(seg.startX)} ${num(seg.startY)}</Start>`)
    if (seg.centerX != null && seg.centerY != null) {
      out.push(`          <Center>${num(seg.centerX)} ${num(seg.centerY)}</Center>`)
    }
    out.push(`          <End>${num(seg.endX)} ${num(seg.endY)}</End>`)
    out.push('        </Curve>')
  } else if (seg.type === 'spiral') {
    const spiType = seg.spiralType ?? 'clothoid'
    const rs = seg.startRadius == null ? 'INF' : num(seg.startRadius)
    const re = seg.endRadius == null ? 'INF' : num(seg.endRadius)
    out.push(
      `        <Spiral length="${num(seg.length)}" spiType="${escapeXml(spiType)}" ` +
        `radiusStart="${rs}" radiusEnd="${re}">`,
    )
    out.push(`          <Start>${num(seg.startX)} ${num(seg.startY)}</Start>`)
    out.push(`          <End>${num(seg.endX)} ${num(seg.endY)}</End>`)
    out.push('        </Spiral>')
  }
  return out
}

interface Pvi {
  station: number
  z: number
}

// セグメント列から PVI（測点 × 標高）列を作る。
// 各セグメントの startZ / endZ が両方 null なら縦断は省略。
function collectPvis(segments: AlignmentSegment[], staStart: number): Pvi[] {
  const pvis: Pvi[] = []
  let sta = staStart
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    if (i === 0 && seg.startZ != null) {
      pvis.push({ station: sta, z: seg.startZ })
    }
    sta += seg.length
    if (seg.endZ != null) {
      // 直前と station/Z が同じなら重複排除
      const last = pvis[pvis.length - 1]
      if (!last || Math.abs(last.station - sta) > 1e-6 || Math.abs(last.z - seg.endZ) > 1e-6) {
        pvis.push({ station: sta, z: seg.endZ })
      }
    }
  }
  return pvis
}

function buildSurfaceLines(name: string, surface: TinSurface): string[] {
  const out: string[] = []
  const safeName = escapeXml(name)
  out.push(`    <Surface name="${safeName}">`)
  out.push('      <Definition surfType="TIN">')
  out.push('        <Pnts>')
  for (let i = 0; i < surface.points.length; i++) {
    const p = surface.points[i]
    // P id は 1 始まり（LandXML 慣例）
    out.push(`          <P id="${i + 1}">${num(p.x)} ${num(p.y)} ${num(p.z)}</P>`)
  }
  out.push('        </Pnts>')
  out.push('        <Faces>')
  // 本プロジェクトの (x, y) は (北, 東) で Delaunator は (x=右, y=上) 系で CCW を返すため、
  // LandXML（座標は Northing Easting）として出力すると上空視点で CW になり面の表裏が反転する。
  // ここで頂点順を b と c で入れ替え、上空から見て CCW（上向き法線）になるよう揃える。
  for (const t of surface.triangles) {
    // インデックスは 1 始まり
    out.push(`          <F>${t.a + 1} ${t.c + 1} ${t.b + 1}</F>`)
  }
  out.push('        </Faces>')
  out.push('      </Definition>')
  out.push('    </Surface>')
  return out
}

function sumLen(segs: AlignmentSegment[]): number {
  return segs.reduce((s, x) => s + (x.length || 0), 0)
}

// 数値の文字列化（無限小数を避けつつ精度を保持）
function num(v: number): string {
  if (!Number.isFinite(v)) return '0'
  // 小数 6 桁、不要な末尾 0 は除去
  return v.toFixed(6).replace(/\.?0+$/, '')
}

// XML 用の最低限のエスケープ
function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}
