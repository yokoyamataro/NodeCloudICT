// 公開圃場ビュー: /share/farm/:farmId
// 認証不要で、起工測量の座標プロット＋点一覧を読み取り専用で表示する。
// 受益者名等の個人情報は返さない（get_shared_farm_view 関数の責務）。

import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { MapContainer, TileLayer, Marker, Polyline, Tooltip } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { Loader2, MapPin, AlertTriangle, ExternalLink } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import {
  CoordinateConverter,
  COORDINATE_TYPE_NAMES,
  type CoordinateType,
} from '@/lib/coordinates'
import type { PipeType } from '@/types/database'

interface ShareCoordinate {
  id: string
  point_number: string
  x: number
  y: number
  z: number | null
  latitude: number | null
  longitude: number | null
  coordinate_type: string
}

interface ShareVertex {
  x: number
  y: number
  z: number | null
}

interface SharePipe {
  id: string
  number: string
  layer_name: string | null
  pipe_type: string | null
  diameter: number | null
  design_length: number | null
  vertices: ShareVertex[]
}

interface ShareRoutePoint {
  name: string
  x: number
  y: number
  z?: number | null
}

interface SharePointType {
  code: string
  label: string
}

interface ShareFarmView {
  farm: {
    id: string
    name: string
    project_id: string
    coordinate_zone: number
  } | null
  coordinates: ShareCoordinate[]
  pipes: SharePipe[]
  point_types?: SharePointType[]
  route: { points: ShareRoutePoint[] } | null
}

export function ShareFarmViewPage() {
  const { farmId } = useParams<{ farmId: string }>()
  const [data, setData] = useState<ShareFarmView | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!farmId) return
    let cancelled = false
    setLoading(true)
    ;(
      supabase.rpc as unknown as (
        fn: string,
        args: Record<string, unknown>,
      ) => Promise<{ data: unknown; error: { message: string } | null }>
    )('get_shared_farm_view', { p_farm_id: farmId }).then(
      ({ data: rpcData, error: rpcError }) => {
        if (cancelled) return
        if (rpcError) {
          setError(rpcError.message)
          setLoading(false)
          return
        }
        const view = rpcData as ShareFarmView | null
        if (!view || !view.farm) {
          setError('指定された圃場のデータが見つかりませんでした。')
          setLoading(false)
          return
        }
        setData(view)
        setLoading(false)
      },
    )
    return () => {
      cancelled = true
    }
  }, [farmId])

  const converter = useMemo(() => {
    if (!data?.farm) return null
    return new CoordinateConverter(data.farm.coordinate_zone)
  }, [data])

  // 座標を lat/lng 付きで整形（latitude/longitude が無い座標は補完）
  const points = useMemo(() => {
    if (!data || !converter) return []
    return data.coordinates
      .map((c) => {
        let lat = c.latitude
        let lng = c.longitude
        if (lat == null || lng == null) {
          try {
            const { lat: la, lng: ln } = converter.toLatLng(c.x, c.y)
            lat = la
            lng = ln
          } catch {
            return null
          }
        }
        return { ...c, lat, lng }
      })
      .filter((p): p is ShareCoordinate & { lat: number; lng: number } => p != null)
  }, [data, converter])

  const pipeLines = useMemo(() => {
    if (!data || !converter) return []
    return data.pipes
      .map((p) => {
        const positions: [number, number][] = []
        for (const v of p.vertices) {
          try {
            const { lat, lng } = converter.toLatLng(v.x, v.y)
            positions.push([lat, lng])
          } catch {
            // skip
          }
        }
        return { pipe: p, positions }
      })
      .filter((p) => p.positions.length >= 2)
  }, [data, converter])

  // 暗渠頂点もマーカーで表示する（順路がある場合は順路点を優先）
  const pipeVertices = useMemo(() => {
    if (!data || !converter) return []
    const out: Array<{
      id: string
      name: string
      lat: number
      lng: number
      pipeType: string | null
    }> = []
    for (const p of data.pipes) {
      const total = p.vertices.length
      for (let i = 0; i < total; i++) {
        const v = p.vertices[i]
        try {
          const { lat, lng } = converter.toLatLng(v.x, v.y)
          let suffix: string
          if (i === 0) suffix = 'C'
          else if (i === total - 1) suffix = 'A'
          else suffix = `B${total - 1 - i}`
          out.push({
            id: `${p.id}-${i}`,
            name: `${p.number}${suffix}`,
            lat,
            lng,
            pipeType: p.pipe_type,
          })
        } catch {
          // skip
        }
      }
    }
    return out
  }, [data, converter])

  const routePoints = useMemo(() => {
    if (!data?.route || !converter) return []
    return data.route.points
      .map((rp) => {
        try {
          const { lat, lng } = converter.toLatLng(rp.x, rp.y)
          return { ...rp, lat, lng }
        } catch {
          return null
        }
      })
      .filter((p): p is ShareRoutePoint & { lat: number; lng: number } => p != null)
  }, [data, converter])

  const bounds = useMemo(() => {
    const all: [number, number][] = []
    for (const p of points) all.push([p.lat, p.lng])
    for (const pl of pipeLines) all.push(...pl.positions)
    if (all.length === 0) return null
    return L.latLngBounds(all)
  }, [points, pipeLines])

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
      </div>
    )
  }

  if (error || !data?.farm) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 p-4">
        <div className="max-w-md w-full bg-white border rounded-lg p-6 text-center">
          <AlertTriangle className="h-10 w-10 text-amber-500 mx-auto mb-3" />
          <h1 className="text-lg font-semibold mb-2">表示できません</h1>
          <p className="text-sm text-slate-600">
            {error ?? '指定された圃場が見つからないか、共有が無効です。'}
          </p>
        </div>
      </div>
    )
  }

  const farm = data.farm
  const mapCenter: [number, number] = bounds
    ? [bounds.getCenter().lat, bounds.getCenter().lng]
    : [36, 138]

  return (
    <div className="min-h-screen flex flex-col bg-slate-50">
      {/* ヘッダ */}
      <header className="bg-white border-b px-4 py-3 flex items-center gap-2">
        <MapPin className="h-5 w-5 text-blue-600" />
        <div className="flex-1 min-w-0">
          <h1 className="text-base font-bold truncate">{farm.name}</h1>
          <p className="text-xs text-slate-500">公開ビュー（読み取り専用）</p>
        </div>
        <span className="text-[11px] px-2 py-0.5 rounded bg-slate-100 text-slate-600">
          座標 {points.length} ／ 配管 {data.pipes.length}
        </span>
      </header>

      {/* 地図 */}
      <div className="flex-1 min-h-[320px] relative">
        <MapContainer
          center={mapCenter}
          zoom={17}
          maxZoom={22}
          bounds={bounds ?? undefined}
          className="h-full w-full"
          style={{ minHeight: 320 }}
        >
          <TileLayer
            attribution='&copy; 国土地理院'
            url="https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg"
            maxZoom={22}
            maxNativeZoom={18}
          />

          {/* 配管ライン */}
          {pipeLines.map(({ pipe, positions }) => {
            const color = pipeLineColor(pipe.pipe_type)
            return (
              <Polyline
                key={pipe.id}
                positions={positions}
                pathOptions={{ color, weight: 3, opacity: 0.9 }}
              />
            )
          })}

          {/* 順路ライン（点線） */}
          {routePoints.length >= 2 && (
            <Polyline
              positions={routePoints.map((p) => [p.lat, p.lng] as [number, number])}
              pathOptions={{
                color: '#f97316',
                weight: 3,
                opacity: 0.9,
                dashArray: '8 6',
              }}
            />
          )}

          {/* 座標マーカー */}
          {points.map((p) => {
            const color = coordinateColor(p.coordinate_type)
            const label = p.point_number
            return (
              <Marker
                key={p.id}
                position={[p.lat, p.lng]}
                icon={L.divIcon({
                  className: 'staking-target',
                  html: `<div style="width:12px;height:12px;background:${color};border:2px solid white;border-radius:50%;box-shadow:0 1px 3px rgba(0,0,0,0.4);"></div>`,
                  iconSize: [12, 12],
                  iconAnchor: [6, 6],
                })}
              >
                <Tooltip
                  className="staking-label-tooltip"
                  direction="top"
                  offset={[0, -6]}
                  permanent
                  opacity={1}
                >
                  <span
                    style={{
                      color,
                      textShadow:
                        '-1px -1px 0 #fff, 1px -1px 0 #fff, -1px 1px 0 #fff, 1px 1px 0 #fff, 0 -1px 0 #fff, 0 1px 0 #fff, -1px 0 0 #fff, 1px 0 0 #fff',
                    }}
                  >
                    {label}
                  </span>
                </Tooltip>
              </Marker>
            )
          })}

          {/* 暗渠頂点マーカー */}
          {pipeVertices.map((v) => {
            const color = pipeLineColor(v.pipeType)
            return (
              <Marker
                key={v.id}
                position={[v.lat, v.lng]}
                icon={L.divIcon({
                  className: 'staking-target',
                  html: `<div style="width:10px;height:10px;background:${color};border:2px solid white;border-radius:50%;box-shadow:0 1px 2px rgba(0,0,0,0.4);"></div>`,
                  iconSize: [10, 10],
                  iconAnchor: [5, 5],
                })}
              >
                <Tooltip
                  className="staking-label-tooltip"
                  direction="top"
                  offset={[0, -6]}
                  permanent
                  opacity={1}
                >
                  <span
                    style={{
                      color,
                      textShadow:
                        '-1px -1px 0 #fff, 1px -1px 0 #fff, -1px 1px 0 #fff, 1px 1px 0 #fff, 0 -1px 0 #fff, 0 1px 0 #fff, -1px 0 0 #fff, 1px 0 0 #fff',
                    }}
                  >
                    {v.name}
                  </span>
                </Tooltip>
              </Marker>
            )
          })}
        </MapContainer>
      </div>

      {/* 点一覧 */}
      <details className="bg-white border-t" open>
        <summary className="px-4 py-2 text-sm font-semibold cursor-pointer flex items-center gap-2">
          <ExternalLink className="h-4 w-4 text-slate-500" />
          点一覧（{points.length} 点）
        </summary>
        <div className="max-h-[40vh] overflow-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-100 sticky top-0">
              <tr>
                <th className="text-left px-3 py-1.5">点番</th>
                <th className="text-left px-3 py-1.5">点種</th>
                <th className="text-right px-3 py-1.5">X</th>
                <th className="text-right px-3 py-1.5">Y</th>
                <th className="text-right px-3 py-1.5">Z</th>
              </tr>
            </thead>
            <tbody>
              {points.map((p) => (
                <tr key={p.id} className="border-b last:border-0">
                  <td className="px-3 py-1 font-medium">{p.point_number}</td>
                  <td className="px-3 py-1 text-slate-600">
                    {(COORDINATE_TYPE_NAMES as Record<string, string>)[p.coordinate_type] ??
                      data?.point_types?.find((t) => t.code === p.coordinate_type)?.label ??
                      p.coordinate_type}
                  </td>
                  <td className="px-3 py-1 text-right font-mono">{p.x.toFixed(3)}</td>
                  <td className="px-3 py-1 text-right font-mono">{p.y.toFixed(3)}</td>
                  <td className="px-3 py-1 text-right font-mono">
                    {p.z != null ? p.z.toFixed(3) : '-'}
                  </td>
                </tr>
              ))}
              {points.length === 0 && (
                <tr>
                  <td colSpan={5} className="text-center text-slate-400 py-3">
                    座標データなし
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  )
}

function coordinateColor(type: string): string {
  const t = type as CoordinateType
  if (t === 'control') return '#ea580c' // 基準点 = オレンジ
  if (t === 'boundary') return '#0ea5e9' // 外周点 = シアン
  if (t === 'current') return '#22c55e' // 現況 = 緑
  return '#3b82f6'
}

function pipeLineColor(pipeType: string | null): string {
  const t = pipeType as PipeType | null
  if (t === 'branch') return '#2563eb' // 吸水 = 青
  if (t === 'main') return '#16a34a' // 集水 = 緑
  if (t === 'outlet') return '#dc2626' // 落口 = 赤
  return '#6b7280'
}

