// TIN (LandXML) を 地図に 描く Pane。
//
// PC の 全体図 (OrthophotoPage) と スマホの 測設画面 (MobileStakingPage) の
// 両方から 使う。「全体図と 同じ 見た目」を 保つのが 目的なので、色や 太さを
// 変えるときは ここ 1 か所を 直す。
//
// 色分けメッシュ / 等高線 / ワイヤーフレーム を サブ トグルで 個別に 表示切替。
// tin が null または visible=false で 全体 非表示。
// contourColor / wireframeColor は 現況 (茶) / 設計 (紺) で 使い分ける ため 引数化。

import { Pane, Polygon as LeafletPolygon, Polyline as LeafletPolyline } from 'react-leaflet'
import { hypsometricColor, type RenderedTin } from '@/lib/landxml/tinRender'

export function TinPane({
  paneName,
  zIndex,
  tin,
  visible,
  meshOn,
  contourOn,
  wireframeOn,
  contourColor,
  wireframeColor,
  keyPrefix,
}: {
  paneName: string
  zIndex: number
  tin: RenderedTin | null
  visible: boolean
  meshOn: boolean
  contourOn: boolean
  wireframeOn: boolean
  contourColor: string
  wireframeColor: string
  keyPrefix: string
}) {
  return (
    <Pane name={paneName} style={{ zIndex }}>
      {tin && visible && meshOn &&
        tin.triangles.map((t, i) => (
          <LeafletPolygon
            key={`${keyPrefix}-tri-${i}`}
            positions={t.positions}
            pathOptions={{
              color: hypsometricColor(t.zAvg, tin.zMin, tin.zMax),
              weight: 0,
              fillColor: hypsometricColor(t.zAvg, tin.zMin, tin.zMax),
              fillOpacity: 0.55,
            }}
            interactive={false}
          />
        ))}
      {tin && visible && wireframeOn &&
        tin.edges.map((e, i) => (
          <LeafletPolyline
            key={`${keyPrefix}-edge-${i}`}
            positions={e.positions}
            pathOptions={{
              color: wireframeColor,
              weight: 0.6,
              opacity: 0.55,
            }}
            interactive={false}
          />
        ))}
      {tin && visible && contourOn &&
        tin.contours.flatMap((c) =>
          c.segments.map((seg, j) => (
            <LeafletPolyline
              key={`${keyPrefix}-c-${c.z.toFixed(3)}-${j}`}
              positions={seg}
              pathOptions={{
                color: contourColor,
                weight: Math.abs(c.z % (tin.contourInterval * 5)) < 1e-6 ? 1.2 : 0.7,
                opacity: 0.85,
              }}
              interactive={false}
            />
          )),
        )}
    </Pane>
  )
}
