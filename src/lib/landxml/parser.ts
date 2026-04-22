// LandXML ファイルから中心線形（Alignment）を取り出すパーサ。
// DOMParser を使って XML を構文解析し、<Alignment> / <CoordGeom> 以下の
// <Line> / <Curve> / <Spiral> を型付きのセグメントに変換する。

import type { Alignment, AlignmentSegment, CurveRotation } from './types'

export interface ParseResult {
  alignments: Alignment[]
  warnings: string[]
}

export function parseLandXml(xmlText: string, sourceFile?: string): ParseResult {
  const warnings: string[] = []
  const parser = new DOMParser()
  const doc = parser.parseFromString(xmlText, 'application/xml')

  // パースエラー検出
  const parserError = doc.querySelector('parsererror')
  if (parserError) {
    throw new Error(`LandXML のパースに失敗しました: ${parserError.textContent ?? ''}`)
  }

  const alignmentEls = doc.getElementsByTagName('Alignment')
  const alignments: Alignment[] = []

  for (let i = 0; i < alignmentEls.length; i++) {
    const el = alignmentEls[i]
    const name = el.getAttribute('name') ?? `Alignment${i + 1}`
    const staStart = parseFloatAttr(el, 'staStart', 0)
    const totalLength = parseFloatAttr(el, 'length', 0)

    const segments: AlignmentSegment[] = []

    // CoordGeom が複数ある場合も対応（通常は 1 つ）
    const coordGeomEls = el.getElementsByTagName('CoordGeom')
    for (let g = 0; g < coordGeomEls.length; g++) {
      const coordGeom = coordGeomEls[g]
      for (const child of Array.from(coordGeom.children)) {
        const seg = parseSegment(child, warnings)
        if (seg) segments.push(seg)
      }
    }

    alignments.push({
      id: generateTempId(),
      name,
      staStart,
      totalLength: totalLength || sumSegmentLengths(segments),
      sourceFile,
      segments,
    })
  }

  return { alignments, warnings }
}

function parseSegment(el: Element, warnings: string[]): AlignmentSegment | null {
  const tag = el.tagName
  if (tag === 'Line') {
    const start = parsePointChild(el, 'Start')
    const end = parsePointChild(el, 'End')
    if (!start || !end) {
      warnings.push('Line セグメントで Start / End が見つかりませんでした')
      return null
    }
    const length = parseFloatAttr(el, 'length', dist(start, end))
    return {
      type: 'line',
      startX: start.x,
      startY: start.y,
      endX: end.x,
      endY: end.y,
      length,
    }
  }

  if (tag === 'Curve') {
    const start = parsePointChild(el, 'Start')
    const end = parsePointChild(el, 'End')
    const center = parsePointChild(el, 'Center')
    if (!start || !end || !center) {
      warnings.push('Curve セグメントで Start / End / Center が見つかりませんでした')
      return null
    }
    const radius = parseFloatAttr(el, 'radius', dist(start, center))
    const rotAttr = el.getAttribute('rot')?.toLowerCase()
    const rotation: CurveRotation = rotAttr === 'ccw' ? 'ccw' : 'cw'
    const length =
      parseFloatAttr(el, 'length', 0) || arcLength(start, end, center, radius, rotation)
    return {
      type: 'curve',
      startX: start.x,
      startY: start.y,
      endX: end.x,
      endY: end.y,
      length,
      centerX: center.x,
      centerY: center.y,
      radius,
      rotation,
    }
  }

  if (tag === 'Spiral') {
    const start = parsePointChild(el, 'Start')
    const end = parsePointChild(el, 'End')
    if (!start || !end) {
      warnings.push('Spiral セグメントで Start / End が見つかりませんでした')
      return null
    }
    const length = parseFloatAttr(el, 'length', 0) || dist(start, end)
    const spiralType = el.getAttribute('spiType') ?? el.getAttribute('spiralType') ?? 'clothoid'
    const startRadiusRaw = el.getAttribute('radiusStart')
    const endRadiusRaw = el.getAttribute('radiusEnd')
    const startRadius =
      startRadiusRaw !== null && startRadiusRaw.trim() !== '' && startRadiusRaw.toUpperCase() !== 'INF'
        ? parseFloat(startRadiusRaw)
        : null
    const endRadius =
      endRadiusRaw !== null && endRadiusRaw.trim() !== '' && endRadiusRaw.toUpperCase() !== 'INF'
        ? parseFloat(endRadiusRaw)
        : null
    // クロソイドパラメータ A: L * |r| = A²（一端の R が∞でない場合）
    let spiralA: number | null = null
    const rFinite = startRadius ?? endRadius
    if (rFinite && length > 0) {
      spiralA = Math.sqrt(Math.abs(rFinite) * length)
    }

    return {
      type: 'spiral',
      startX: start.x,
      startY: start.y,
      endX: end.x,
      endY: end.y,
      length,
      spiralType,
      startRadius,
      endRadius,
      spiralA,
    }
  }

  return null
}

// LandXML の座標表記: "Northing Easting [Elevation]" を {x=北, y=東} にマップ
function parsePointChild(parent: Element, childTag: string): { x: number; y: number } | null {
  const child = parent.getElementsByTagName(childTag)[0]
  if (!child) return null
  const text = (child.textContent ?? '').trim()
  if (!text) return null
  const parts = text.split(/\s+/).map((s) => parseFloat(s))
  if (parts.length < 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) return null
  return { x: parts[0], y: parts[1] }
}

function parseFloatAttr(el: Element, name: string, fallback = 0): number {
  const raw = el.getAttribute(name)
  if (raw === null || raw.trim() === '') return fallback
  const n = parseFloat(raw)
  return Number.isFinite(n) ? n : fallback
}

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2)
}

// 円弧長の概算（LandXML の length 属性が欠落時のみ使用）
function arcLength(
  start: { x: number; y: number },
  end: { x: number; y: number },
  center: { x: number; y: number },
  radius: number,
  rotation: CurveRotation,
): number {
  const a1 = Math.atan2(start.y - center.y, start.x - center.x)
  const a2 = Math.atan2(end.y - center.y, end.x - center.x)
  let diff = rotation === 'cw' ? a1 - a2 : a2 - a1
  if (diff < 0) diff += 2 * Math.PI
  return radius * diff
}

function sumSegmentLengths(segments: AlignmentSegment[]): number {
  return segments.reduce((s, seg) => s + (seg.length || 0), 0)
}

function generateTempId(): string {
  return `alignment-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}
