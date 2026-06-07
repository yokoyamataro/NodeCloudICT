// JPGIS (JSIMA SIMA XML) 形式の地番データパーサ。
//
// ファイル例: doc/斜里町青葉町.onz.xml
// エンコーディング: Shift_JIS
//
// 構造（簡略化）:
//   jsima:GI
//     jsima:GenbaJoho       … 工区情報（Name, CoordinateSystem, Crs）
//     jsima:dataset
//       jsima:object
//         jps:GM_Point        id, position/coordinate "X Y"
//         jps:GM_Curve        id, segment/GM_LineString/controlPoint/...(2 点参照)
//         jps:GM_OrientableCurve … 反対向きの参照（今回は不使用）
//         jps:GM_Surface      id, patch/GM_Polygon/boundary/exterior/generator(idref) ×N
//         jsima:Kakuchi       id, Number, Name, RefSurface(idref)
//         jsima:Chiban        id, Area, Owner, Rotation, RefKakuchi(idref)
//
// 1 地番 (Chiban) は 1 画地 (Kakuchi) を参照し、画地はサーフェス（GM_Surface）を参照する。
// サーフェスは複数の Curve を順序付きで参照し、各 Curve の始点を順に取れば多角形になる。
//
// 既存の SIMA 取込フロー (BoundarySurveyWorkAreaPage) と組み合わせやすいよう、戻り値の
// 形は sima-parser の SimaParseResult に寄せている。

export interface JpgisCoordinate {
  /** 座標管理に登録する点番号。JPGIS の GM_Point.id を使用（例: "pnt000008"）。
   *  SIMA の点番号と被らないようプレフィックスは残したまま使う。 */
  pointNumber: string
  x: number
  y: number
  z: number | null
}

export interface JpgisPolygon {
  /** Kakuchi.Number（連番） */
  parcelNumber: string
  /** Kakuchi.Name（地番名。例: "67" "1-24"） */
  parcelName: string
  /** Chiban.Owner */
  ownerName: string | null
  /** Chiban.Area（登記地積 m²） */
  registeredAreaSqm: number | null
  /** 外周を構成する点番号の順序付きリスト */
  pointNumbers: string[]
}

export interface JpgisParseResult {
  coordinates: JpgisCoordinate[]
  polygons: JpgisPolygon[]
  projectName: string | null
  /** 平面直角座標系番号（jsima:CoordinateSystem） */
  system: number | null
}

/** "pnt000008" のような id を、座標管理で重複しにくい点番号文字列としてそのまま返す。 */
function pointIdToPointNumber(id: string): string {
  return id
}

function firstChildText(parent: Element, tagName: string): string | null {
  const nodes = parent.getElementsByTagName(tagName)
  if (nodes.length === 0) return null
  return nodes[0].textContent?.trim() ?? null
}

/** XMLString を JpgisParseResult にパース */
export function parseJpgisXml(xmlText: string): JpgisParseResult {
  const parser = new DOMParser()
  const doc = parser.parseFromString(xmlText, 'application/xml')
  const err = doc.querySelector('parsererror')
  if (err) {
    throw new Error('XML パースに失敗しました: ' + (err.textContent ?? '原因不明'))
  }

  // ---- メタデータ ----
  let projectName: string | null = null
  let system: number | null = null
  const genbaList = doc.getElementsByTagName('jsima:GenbaJoho')
  if (genbaList.length > 0) {
    const node = genbaList[0]
    projectName = firstChildText(node, 'jsima:Name')
    const csText = firstChildText(node, 'jsima:CoordinateSystem')
    if (csText) {
      const n = Number(csText)
      if (Number.isFinite(n)) system = n
    }
  }

  // ---- GM_Point: id -> 座標 ----
  const points = new Map<string, JpgisCoordinate>()
  const pointNodes = doc.getElementsByTagName('jps:GM_Point')
  for (let i = 0; i < pointNodes.length; i++) {
    const node = pointNodes[i]
    const id = node.getAttribute('id')
    if (!id) continue
    const coordNode = node.getElementsByTagName('jps:coordinate')[0]
    const text = coordNode?.textContent?.trim()
    if (!text) continue
    const parts = text.split(/\s+/)
    if (parts.length < 2) continue
    const x = Number(parts[0])
    const y = Number(parts[1])
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    const z = parts.length >= 3 ? Number(parts[2]) : NaN
    points.set(id, {
      pointNumber: pointIdToPointNumber(id),
      x,
      y,
      z: Number.isFinite(z) ? z : null,
    })
  }

  // ---- GM_Curve: id -> { from, to } 点 id 参照 ----
  const curves = new Map<string, { from: string; to: string }>()
  const curveNodes = doc.getElementsByTagName('jps:GM_Curve')
  for (let i = 0; i < curveNodes.length; i++) {
    const node = curveNodes[i]
    const id = node.getAttribute('id')
    if (!id) continue
    // controlPoint > column > indirect > point[idref]
    const refs = node.getElementsByTagName('jps:point')
    if (refs.length < 2) continue
    const from = refs[0].getAttribute('idref') ?? ''
    const to = refs[refs.length - 1].getAttribute('idref') ?? ''
    if (!from || !to) continue
    curves.set(id, { from, to })
  }

  // ---- GM_OrientableCurve: id (`_crv...`) -> 元 curve の primitiveId + orientation ----
  // 一部のサーフェスはこの逆向き curve を generator として参照する。
  // primitive を辿って元の GM_Curve を見つけ、orientation が '-' なら from/to を入れ替える。
  const orientableCurves = new Map<
    string,
    { primitiveId: string; orientation: '+' | '-' }
  >()
  const ocNodes = doc.getElementsByTagName('jps:GM_OrientableCurve')
  for (let i = 0; i < ocNodes.length; i++) {
    const node = ocNodes[i]
    const id = node.getAttribute('id')
    if (!id) continue
    const primNode = node.getElementsByTagName('jps:primitive')[0]
    const primitiveId = primNode?.getAttribute('idref') ?? ''
    if (!primitiveId) continue
    const orientText = firstChildText(node, 'jps:orientation') ?? '+'
    const orientation: '+' | '-' = orientText === '-' ? '-' : '+'
    orientableCurves.set(id, { primitiveId, orientation })
  }

  // ---- GM_Surface: id -> [curveId...] (外周構成順) ----
  const surfaces = new Map<string, string[]>()
  const surfaceNodes = doc.getElementsByTagName('jps:GM_Surface')
  for (let i = 0; i < surfaceNodes.length; i++) {
    const node = surfaceNodes[i]
    const id = node.getAttribute('id')
    if (!id) continue
    const exteriors = node.getElementsByTagName('jps:exterior')
    if (exteriors.length === 0) continue
    const generators = exteriors[0].getElementsByTagName('jps:generator')
    const curveIds: string[] = []
    for (let j = 0; j < generators.length; j++) {
      const idref = generators[j].getAttribute('idref')
      if (idref) curveIds.push(idref)
    }
    if (curveIds.length > 0) surfaces.set(id, curveIds)
  }

  // ---- Kakuchi: id -> { number, name, surfaceId } ----
  const kakuchis = new Map<
    string,
    { number: string; name: string; surfaceId: string }
  >()
  const kakuchiNodes = doc.getElementsByTagName('jsima:Kakuchi')
  for (let i = 0; i < kakuchiNodes.length; i++) {
    const node = kakuchiNodes[i]
    const id = node.getAttribute('id')
    if (!id) continue
    const number = firstChildText(node, 'jsima:Number') ?? ''
    const name = firstChildText(node, 'jsima:Name') ?? ''
    const refSurface = node.getElementsByTagName('jsima:RefSurface')[0]
    const surfaceId = refSurface?.getAttribute('idref') ?? ''
    if (!surfaceId) continue
    kakuchis.set(id, { number, name, surfaceId })
  }

  // ---- Chiban: 地番をパースして polygons を組み立て ----
  const polygons: JpgisPolygon[] = []
  const chibanNodes = doc.getElementsByTagName('jsima:Chiban')
  for (let i = 0; i < chibanNodes.length; i++) {
    const node = chibanNodes[i]
    const refKakuchi = node.getElementsByTagName('jsima:RefKakuchi')[0]
    const kakuchiId = refKakuchi?.getAttribute('idref')
    if (!kakuchiId) continue
    const kakuchi = kakuchis.get(kakuchiId)
    if (!kakuchi) continue
    const surfaceCurves = surfaces.get(kakuchi.surfaceId)
    if (!surfaceCurves || surfaceCurves.length === 0) continue

    // Curve を順番に辿り、各曲線の始点を polygon 頂点として集める。
    // 末尾の曲線の終点は最初の頂点と一致する想定なので追加しない（閉じた多角形）。
    // generator の idref は GM_Curve だけでなく GM_OrientableCurve (`_crv...`) も指す
    // ことがあるので、見つからなければ OrientableCurve 経由で本体 curve を辿り、
    // orientation が '-' のときは from/to を入れ替える。
    const pointNumbers: string[] = []
    for (const curveId of surfaceCurves) {
      let curve = curves.get(curveId)
      let reversed = false
      if (!curve) {
        const oc = orientableCurves.get(curveId)
        if (oc) {
          curve = curves.get(oc.primitiveId)
          reversed = oc.orientation === '-'
        }
      }
      if (!curve) continue
      const startId = reversed ? curve.to : curve.from
      const startPoint = points.get(startId)
      if (startPoint) pointNumbers.push(startPoint.pointNumber)
    }
    if (pointNumbers.length < 3) continue

    const areaText = firstChildText(node, 'jsima:Area')
    const area = areaText ? Number(areaText) : NaN
    const ownerText = firstChildText(node, 'jsima:Owner')
    polygons.push({
      parcelNumber: kakuchi.number,
      parcelName: kakuchi.name,
      ownerName: ownerText && ownerText !== '' ? ownerText : null,
      registeredAreaSqm: Number.isFinite(area) ? area : null,
      pointNumbers,
    })
  }

  const coordinates: JpgisCoordinate[] = Array.from(points.values())

  return { coordinates, polygons, projectName, system }
}

/**
 * File から JpgisParseResult を読み込む。
 * XML 宣言は Shift_JIS 想定。失敗時 UTF-8 でリトライ。
 */
export async function loadJpgisXmlFile(file: File): Promise<JpgisParseResult> {
  const buffer = await file.arrayBuffer()
  let text: string
  try {
    text = new TextDecoder('shift-jis').decode(buffer)
  } catch {
    text = await file.text()
  }
  return parseJpgisXml(text)
}
