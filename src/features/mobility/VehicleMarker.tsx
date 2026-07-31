// 車両マーカー: 円 + 進行方向を示すコーン (方位が取れれば描画)。
//
// react-leaflet の <CircleMarker> は回転できないため、L.divIcon で SVG を
// レンダするマーカーを作る。heading 度 (北=0 東=90) で三角形を回転させる。

import { useMemo } from 'react'
import { Marker } from 'react-leaflet'
import L from 'leaflet'

export interface VehicleMarkerProps {
  position: [number, number]
  /** 進行方位 (deg, 北 = 0, 東 = 90)。null なら円のみ描画 */
  heading?: number | null
  /** 塗りつぶし色。既定は稼働中の緑 */
  color?: string
  /** 円の直径 (px)。既定 20 */
  size?: number
  onClick?: () => void
  /** マーカーの上に表示する短いラベル (車両名など) */
  label?: string
}

export function VehicleMarker({
  position,
  heading,
  color = '#10b981',
  size = 20,
  onClick,
  label,
}: VehicleMarkerProps) {
  const icon = useMemo(() => {
    const half = size / 2
    // コーン (三角形) は円の外側に少し飛び出すサイズ
    const coneHeight = size * 0.9
    const coneWidth = size * 0.7
    const totalHeight = size + coneHeight // 円 (下) + コーン (上に飛び出し) を含めた縦幅
    const svg = `
<svg xmlns="http://www.w3.org/2000/svg"
     width="${size + coneHeight}"
     height="${size + coneHeight}"
     viewBox="0 0 ${size + coneHeight} ${size + coneHeight}"
     style="overflow:visible;">
  <g transform="translate(${(size + coneHeight) / 2},${(size + coneHeight) / 2})">
    ${heading != null
      ? `<g transform="rotate(${heading})">
           <polygon points="0,${-half - coneHeight * 0.7} ${-coneWidth / 2},${-half + 2} ${coneWidth / 2},${-half + 2}"
                    fill="${color}" opacity="0.9" stroke="#ffffff" stroke-width="1.5"
                    stroke-linejoin="round" />
         </g>`
      : ''}
    <circle cx="0" cy="0" r="${half - 1}" fill="${color}" stroke="#ffffff" stroke-width="2" />
  </g>
</svg>`.trim()
    return L.divIcon({
      className: 'vehicle-marker',
      html: label
        ? `<div style="position:relative; width:${size + coneHeight}px; height:${size + coneHeight}px;">
             ${svg}
             <div style="
               position:absolute; bottom:-14px; left:50%; transform:translateX(-50%);
               background:white; border:1px solid #cbd5e1; border-radius:4px;
               padding:0 4px; font-size:10px; font-weight:600; color:#0f172a;
               white-space:nowrap; box-shadow:0 1px 2px rgba(0,0,0,0.1);
             ">${label.replace(/</g, '&lt;')}</div>
           </div>`
        : svg,
      iconSize: [size + coneHeight, size + coneHeight],
      iconAnchor: [(size + coneHeight) / 2, (size + coneHeight) / 2],
    })
    // totalHeight は将来 anchor 調整用に残す
    void totalHeight
  }, [size, heading, color, label])

  return (
    <Marker
      position={position}
      icon={icon}
      eventHandlers={onClick ? { click: onClick } : undefined}
    />
  )
}
