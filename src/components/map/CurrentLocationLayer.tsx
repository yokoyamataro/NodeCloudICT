import { useEffect, useState } from 'react'
import { CircleMarker, Marker, Tooltip } from 'react-leaflet'
import L from 'leaflet'

// 現在位置（Geolocation）をマップに表示するレイヤー
// react-leaflet の MapContainer の中に配置して使う
export function CurrentLocationLayer() {
  const [position, setPosition] = useState<[number, number] | null>(null)
  const [accuracy, setAccuracy] = useState<number | null>(null)

  useEffect(() => {
    if (!('geolocation' in navigator)) return
    const watchId = navigator.geolocation.watchPosition(
      (pos) => {
        setPosition([pos.coords.latitude, pos.coords.longitude])
        setAccuracy(pos.coords.accuracy)
      },
      () => {
        // 失敗時は表示しない
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 },
    )
    return () => navigator.geolocation.clearWatch(watchId)
  }, [])

  if (!position) return null

  const dotIcon = L.divIcon({
    className: 'current-location-dot',
    html: `<div style="
      width: 16px;
      height: 16px;
      background: #2563eb;
      border: 3px solid white;
      border-radius: 50%;
      box-shadow: 0 0 0 2px rgba(37,99,235,0.4), 0 2px 6px rgba(0,0,0,0.4);
    "></div>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  })

  return (
    <>
      {accuracy !== null && (
        <CircleMarker
          center={position}
          radius={Math.min(40, Math.max(6, accuracy / 2))}
          pathOptions={{ color: '#2563eb', fillColor: '#2563eb', fillOpacity: 0.15, weight: 1 }}
        />
      )}
      <Marker position={position} icon={dotIcon} interactive={false} zIndexOffset={2000}>
        <Tooltip permanent direction="top" offset={[0, -12]}>
          現在位置{accuracy !== null ? ` (±${accuracy.toFixed(0)}m)` : ''}
        </Tooltip>
      </Marker>
    </>
  )
}
