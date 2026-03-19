// LandXML生成ユーティリティ

import type { TINSurface, Point3D, Face } from './types'

// XMLエスケープ
function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

// 現在の日時を取得
function getCurrentDateTime(): { date: string; time: string } {
  const now = new Date()
  const date = now.toISOString().split('T')[0]
  const time = now.toTimeString().split(' ')[0]
  return { date, time }
}

// 点IDを数値IDに変換するマップを作成
function createPointIdMap(points: Map<string, Point3D>): Map<string, number> {
  const idMap = new Map<string, number>()
  let numId = 1000

  for (const [id] of points) {
    idMap.set(id, numId++)
  }

  return idMap
}

// LandXML文字列を生成
export function generateLandXML(
  surface: TINSurface,
  projectName: string = 'Construction Plan'
): string {
  const { date, time } = getCurrentDateTime()
  const idMap = createPointIdMap(surface.points)

  // XMLヘッダー
  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.landxml.org/schema/LandXML-1.0 http://www.landxml.org/schema/LandXML-1.0.xsd" version="1.0" date="${date}" time="${time}" readOnly="false" language="Japanese">
    <Project name="${escapeXml(projectName)}" />
    <Units>
        <Metric areaUnit="squareMeter" linearUnit="meter" volumeUnit="cubicMeter" temperatureUnit="celsius" pressureUnit="HPA" />
    </Units>
    <Application name="NodeCloud-Design" manufacturer="yokoyama-survey" version="1.00" manufacturerURL="http://www.yokoyama-s.jp/" />
    <Surfaces>
        <Surface name="${escapeXml(surface.name)}">
            <Definition surfType="TIN">
                <Pnts>
`

  // 点を出力
  for (const [id, point] of surface.points) {
    const numId = idMap.get(id)!
    // LandXMLの点フォーマット: Y X Z（北、東、高さ）
    xml += `                    <P id="${numId}">${point.y.toFixed(6)} ${point.x.toFixed(6)} ${point.z.toFixed(6)} </P>\n`
  }

  xml += `                </Pnts>
                <Faces>
`

  // 面を出力
  for (const face of surface.faces) {
    const id1 = idMap.get(face.p1)
    const id2 = idMap.get(face.p2)
    const id3 = idMap.get(face.p3)

    if (id1 !== undefined && id2 !== undefined && id3 !== undefined) {
      xml += `                    <F>${id1} ${id2} ${id3}</F>\n`
    }
  }

  xml += `                </Faces>
            </Definition>
        </Surface>
    </Surfaces>
</LandXML>
`

  return xml
}

// ファイルとしてダウンロード
export function downloadLandXML(xml: string, filename: string = 'construction_plan.xml'): void {
  const blob = new Blob([xml], { type: 'application/xml;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}
