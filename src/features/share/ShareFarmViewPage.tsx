// 公開工区ビュー: /share/farm/:farmId
// 認証不要で、起工測量の座標プロット＋点一覧を読み取り専用で表示する。
// 受益者名等の個人情報は返さない（get_shared_farm_view 関数の責務）。

import { Fragment, useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import {
  Circle as LeafletCircle,
  MapContainer,
  Marker,
  Polygon as LeafletPolygon,
  Polyline,
  Popup,
  TileLayer,
  Tooltip,
} from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { Loader2, AlertTriangle, Layers as LayersIcon, ChevronDown, ChevronUp, Crosshair } from 'lucide-react'
import { useMap, CircleMarker, Circle } from 'react-leaflet'
import { supabase } from '@/lib/supabase'
import {
  CoordinateConverter,
  COORDINATE_TYPE_NAMES,
  type CoordinateType,
} from '@/lib/coordinates'
import type { PipeType } from '@/types/database'
import {
  arcThroughPoints,
  circleRadiusMeters,
  dashArrayFor,
  makeTextIcon,
} from '@/components/map/MapDrawingLayer'
import type { LineStyle } from '@/stores/mapDrawingStore'
import { ParcelMapLayer } from '@/components/map/ParcelMapLayer'
import { useParcelMapDatasetStore } from '@/stores/parcelMapDatasetStore'

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

interface ShareDrawing {
  id: string
  kind: 'stroke' | 'text' | 'circle' | 'arc' | 'polygon' | 'point' | 'frame'
  color: string
  width_px: number
  line_style: LineStyle | null
  points: Array<{ lat: number; lng: number }>
  text: string | null
  /** 共有 API が返さない場合もあるので任意 */
  font_size?: number | null
  rotation_deg?: number | null
  arrow?: string | null
  text_anchor?: 'center' | 'above' | 'below' | null
  text_align?: 'left' | 'center' | 'right' | null
}

interface ShareFarmView {
  farm: {
    id: string
    name: string
    project_id: string
    project_name?: string | null
    coordinate_zone: number
  } | null
  coordinates: ShareCoordinate[]
  pipes: SharePipe[]
  point_types?: SharePointType[]
  route: { points: ShareRoutePoint[] } | null
  map_drawings?: ShareDrawing[]
}

/** enabled のときだけ position 変化で地図を再センターする */
function FollowSelf({
  position,
  enabled,
}: {
  position: [number, number] | null
  enabled: boolean
}) {
  const map = useMap()
  useEffect(() => {
    if (!enabled || !position) return
    map.setView(position, Math.max(map.getZoom(), 18), { animate: true })
  }, [map, position, enabled])
  return null
}

export function ShareFarmViewPage() {
  const { farmId } = useParams<{ farmId: string }>()
  const [data, setData] = useState<ShareFarmView | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showParcelMap, setShowParcelMap] = useState(false)

  // レイヤーパネル: 背景地図の選択 + 各要素の表示切替 (localStorage で永続化)
  type BackgroundKind = 'photo' | 'std' | 'pale' | 'blank'
  const [background, setBackground] = useState<BackgroundKind>(() => {
    try {
      const v = localStorage.getItem('share:bg') as BackgroundKind | null
      return v === 'std' || v === 'pale' || v === 'blank' ? v : 'photo'
    } catch {
      return 'photo'
    }
  })
  useEffect(() => {
    try { localStorage.setItem('share:bg', background) } catch { /* quota */ }
  }, [background])
  const loadBool = (k: string, def: boolean) => {
    try {
      const v = localStorage.getItem(k)
      return v == null ? def : v === '1'
    } catch {
      return def
    }
  }
  const [showCoords, setShowCoords] = useState<boolean>(() => loadBool('share:showCoords', true))
  const [showPipes, setShowPipes] = useState<boolean>(() => loadBool('share:showPipes', true))
  const [showPipeVertices, setShowPipeVertices] = useState<boolean>(() => loadBool('share:showPipeVertices', true))
  const [showRoute, setShowRoute] = useState<boolean>(() => loadBool('share:showRoute', true))
  const [showDrawings, setShowDrawings] = useState<boolean>(() => loadBool('share:showDrawings', true))
  useEffect(() => { try { localStorage.setItem('share:showCoords', showCoords ? '1' : '0') } catch { /* quota */ } }, [showCoords])
  useEffect(() => { try { localStorage.setItem('share:showPipes', showPipes ? '1' : '0') } catch { /* quota */ } }, [showPipes])
  useEffect(() => { try { localStorage.setItem('share:showPipeVertices', showPipeVertices ? '1' : '0') } catch { /* quota */ } }, [showPipeVertices])
  useEffect(() => { try { localStorage.setItem('share:showRoute', showRoute ? '1' : '0') } catch { /* quota */ } }, [showRoute])
  useEffect(() => { try { localStorage.setItem('share:showDrawings', showDrawings ? '1' : '0') } catch { /* quota */ } }, [showDrawings])
  const [layerPanelOpen, setLayerPanelOpen] = useState(false)

  // 自己位置追尾: 'self' なら現在地に地図を寄せる。'off' で解除。
  const [followSelf, setFollowSelf] = useState(false)
  const [selfPos, setSelfPos] = useState<{ lat: number; lng: number; accuracy: number } | null>(null)
  useEffect(() => {
    if (!followSelf) return
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      alert('この端末は位置情報に対応していません')
      setFollowSelf(false)
      return
    }
    const id = navigator.geolocation.watchPosition(
      (pos) => {
        setSelfPos({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        })
      },
      (err) => {
        console.warn('geolocation error:', err)
        alert(`現在地取得に失敗しました: ${err.message}`)
        setFollowSelf(false)
      },
      { enableHighAccuracy: true, maximumAge: 3000, timeout: 15000 },
    )
    return () => navigator.geolocation.clearWatch(id)
  }, [followSelf])

  // 法務省地図データセット (公開マスター) を anon SELECT で取得
  const parcelDatasets = useParcelMapDatasetStore((s) => s.datasets)
  const fetchParcelDatasets = useParcelMapDatasetStore((s) => s.fetchAll)
  useEffect(() => {
    void fetchParcelDatasets()
  }, [fetchParcelDatasets])
  const hasActiveParcelDataset = parcelDatasets.some((d) => d.active)

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
          setError('指定された工区のデータが見つかりませんでした。')
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

  const drawings = useMemo<ShareDrawing[]>(() => data?.map_drawings ?? [], [data])

  const bounds = useMemo(() => {
    const all: [number, number][] = []
    for (const p of points) all.push([p.lat, p.lng])
    for (const pl of pipeLines) all.push(...pl.positions)
    if (all.length === 0) return null
    return L.latLngBounds(all)
  }, [points, pipeLines])

  if (loading) {
    return (
      <div className="h-[100dvh] flex items-center justify-center bg-slate-50">
        <Loader2 className="h-8 w-8 animate-spin text-blue-600" />
      </div>
    )
  }

  if (error || !data?.farm) {
    return (
      <div className="h-[100dvh] flex items-center justify-center bg-slate-50 p-4">
        <div className="max-w-md w-full bg-white border rounded-lg p-6 text-center">
          <AlertTriangle className="h-10 w-10 text-amber-500 mx-auto mb-3" />
          <h1 className="text-lg font-semibold mb-2">表示できません</h1>
          <p className="text-sm text-slate-600">
            {error ?? '指定された工区が見つからないか、共有が無効です。'}
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
    <div className="h-[100dvh] flex flex-col bg-slate-50 overflow-hidden">
      {/* ヘッダ (アプリ本体と同じ slate-900 / NodeCloud タイトル + 現場名／工区名) */}
      <header className="bg-slate-900 text-white border-b border-slate-700 px-4 py-3 flex items-center gap-3">
        <div className="flex flex-col leading-none">
          <h1 className="text-xl font-bold">NodeCloud</h1>
          <span className="text-[10px] text-slate-500 mt-0.5">公開ビュー（読み取り専用）</span>
        </div>
        <span className="text-sm flex items-center min-w-0">
          {farm.project_name && (
            <span className="text-slate-200 font-medium truncate">{farm.project_name}</span>
          )}
          {farm.project_name && farm.name && (
            <span className="text-slate-500 mx-1">／</span>
          )}
          {farm.name && (
            <span className="text-slate-200 font-medium truncate">{farm.name}</span>
          )}
        </span>
      </header>

      {/* 地図 */}
      <div className="flex-1 min-h-[320px] relative">
        <MapContainer
          center={mapCenter}
          zoom={17}
          maxZoom={24}
          bounds={bounds ?? undefined}
          className="h-full w-full"
          style={{ minHeight: 320 }}
        >
          {background !== 'blank' && (
            <TileLayer
              key={background}
              attribution='&copy; 国土地理院'
              url={
                background === 'std'
                  ? 'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png'
                  : background === 'pale'
                    ? 'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png'
                    : 'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg'
              }
              maxZoom={24}
              maxNativeZoom={18}
            />
          )}

          {/* 配管ライン */}
          {showPipes && pipeLines.map(({ pipe, positions }) => {
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
          {showRoute && routePoints.length >= 2 && (
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

          {/* 座標マーカー (タップで X/Y/Z popup) */}
          {showCoords && points.map((p) => {
            const color = coordinateColor(p.coordinate_type)
            const label = p.point_number
            const typeName =
              (COORDINATE_TYPE_NAMES as Record<string, string>)[p.coordinate_type] ??
              data?.point_types?.find((t) => t.code === p.coordinate_type)?.label ??
              p.coordinate_type
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
                <Popup>
                  <div className="text-xs space-y-0.5">
                    <div className="font-bold text-sm" style={{ color }}>
                      {label}
                    </div>
                    <div className="text-slate-600">{typeName}</div>
                    <div className="pt-1 font-mono">
                      <div>X: {p.x.toFixed(3)}</div>
                      <div>Y: {p.y.toFixed(3)}</div>
                      <div>Z: {p.z != null ? p.z.toFixed(3) : '-'}</div>
                    </div>
                  </div>
                </Popup>
              </Marker>
            )
          })}

          {/* 暗渠頂点マーカー */}
          {showPipeVertices && pipeVertices.map((v) => {
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

          {/* 描画メモ (読み取り専用) */}
          {showDrawings && drawings.map((d) => {
            const dash = dashArrayFor((d.line_style ?? 'solid') as LineStyle, d.width_px)
            if (d.kind === 'circle') {
              const [center, edge] = d.points
              if (!center || !edge) return null
              const radius = circleRadiusMeters(center, edge)
              return (
                <LeafletCircle
                  key={d.id}
                  center={[center.lat, center.lng]}
                  radius={radius}
                  pathOptions={{
                    color: d.color,
                    weight: d.width_px,
                    opacity: 0.9,
                    fill: false,
                    dashArray: dash,
                  }}
                  interactive={false}
                />
              )
            }
            if (d.kind === 'arc') {
              if (d.points.length < 3) return null
              const [a, b, c] = d.points
              const arcPts = arcThroughPoints(a, b, c)
              return (
                <Polyline
                  key={d.id}
                  positions={arcPts}
                  pathOptions={{
                    color: d.color,
                    weight: d.width_px,
                    opacity: 0.9,
                    lineCap: 'round',
                    lineJoin: 'round',
                    dashArray: dash,
                  }}
                  interactive={false}
                />
              )
            }
            if (d.kind === 'frame') {
              // 図枠は 塗らない
              if (d.points.length < 3) return null
              return (
                <LeafletPolygon
                  key={d.id}
                  positions={d.points.map((p) => [p.lat, p.lng] as [number, number])}
                  pathOptions={{
                    color: d.color,
                    weight: d.width_px,
                    opacity: 0.95,
                    fill: false,
                    dashArray: dash,
                  }}
                  interactive={false}
                />
              )
            }
            if (d.kind === 'polygon') {
              const positions = d.points.map(
                (p) => [p.lat, p.lng] as [number, number],
              )
              return (
                <LeafletPolygon
                  key={d.id}
                  positions={positions}
                  pathOptions={{
                    color: d.color,
                    weight: d.width_px,
                    opacity: 0.9,
                    fillColor: d.color,
                    fillOpacity: 0.2,
                    dashArray: dash,
                  }}
                  interactive={false}
                />
              )
            }
            if (d.kind === 'text') {
              const p = d.points[0]
              if (!p) return null
              return (
                <Marker
                  key={d.id}
                  position={[p.lat, p.lng]}
                  icon={makeTextIcon(
                    d.text ?? '',
                    d.color,
                    d.width_px,
                    false,
                    d.font_size,
                    d.rotation_deg,
                    d.text_anchor,
                    d.text_align,
                  )}
                  interactive={false}
                />
              )
            }
            if (d.kind === 'point') {
              const p = d.points[0]
              if (!p) return null
              const size = Math.max(8, Math.min(20, 6 + d.width_px))
              return (
                <CircleMarker
                  key={d.id}
                  center={[p.lat, p.lng]}
                  radius={size / 2}
                  pathOptions={{
                    color: '#ffffff',
                    weight: 2,
                    fillColor: d.color,
                    fillOpacity: 1,
                  }}
                  interactive={false}
                />
              )
            }
            // stroke (フリーハンド or 直線)
            const positions = d.points.map(
              (p) => [p.lat, p.lng] as [number, number],
            )
            return (
              <Fragment key={d.id}>
                <Polyline
                  positions={positions}
                  pathOptions={{
                    color: d.color,
                    weight: d.width_px,
                    opacity: 0.9,
                    lineCap: 'round',
                    lineJoin: 'round',
                    dashArray: dash,
                  }}
                  interactive={false}
                />
              </Fragment>
            )
          })}

          {/* 法務省地図 (読み取り専用、地番取込ボタン無し) */}
          {hasActiveParcelDataset && showParcelMap && (
            <ParcelMapLayer visible={true} bbox={null} disableClicks />
          )}

          {/* 自己位置 マーカー + 精度円 */}
          {selfPos && (
            <>
              <Circle
                center={[selfPos.lat, selfPos.lng]}
                radius={selfPos.accuracy}
                pathOptions={{ color: '#2563eb', weight: 1, fillColor: '#3b82f6', fillOpacity: 0.15 }}
                interactive={false}
              />
              <CircleMarker
                center={[selfPos.lat, selfPos.lng]}
                radius={7}
                pathOptions={{ color: '#ffffff', weight: 2, fillColor: '#2563eb', fillOpacity: 1 }}
                interactive={false}
              />
            </>
          )}

          {/* 自己位置追尾 (map.setView を effect で発動) */}
          <FollowSelf
            position={selfPos ? [selfPos.lat, selfPos.lng] : null}
            enabled={followSelf}
          />
        </MapContainer>

        {/* 現在地 (自己位置) ボタン (左上、ズームコントロール直下 = 方位マークの下) */}
        <div className="absolute top-[88px] left-2 z-[1200]">
          <button
            type="button"
            onClick={() => setFollowSelf((v) => !v)}
            className={`w-9 h-9 flex items-center justify-center rounded shadow-md border ${
              followSelf
                ? 'bg-blue-600 border-blue-600 text-white'
                : 'bg-white border-slate-400 text-slate-700 hover:bg-slate-50'
            }`}
            title={followSelf ? '現在地追尾中 (クリックで解除)' : '現在地を表示'}
            aria-label="現在地"
          >
            <Crosshair className="h-4 w-4" />
          </button>
        </div>

        {/* 表示要素 パネル (右上): 座標 / 配管 / 順路 / 描画メモ の on/off */}
        <div className="absolute top-2 right-2 z-[1000] w-56">
          <button
            onClick={() => setLayerPanelOpen((v) => !v)}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm bg-white/95 border rounded shadow hover:bg-slate-50"
            title="表示要素"
          >
            <LayersIcon className="h-4 w-4" />
            <span className="flex-1 text-left">表示要素</span>
            {layerPanelOpen ? (
              <ChevronUp className="h-4 w-4 text-slate-500" />
            ) : (
              <ChevronDown className="h-4 w-4 text-slate-500" />
            )}
          </button>
          {layerPanelOpen && (
            <div className="mt-1 bg-white border rounded shadow p-3 text-xs space-y-1 max-h-[70vh] overflow-y-auto">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={showCoords} onChange={(e) => setShowCoords(e.target.checked)} />
                <span>座標点 ({points.length})</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={showPipes} onChange={(e) => setShowPipes(e.target.checked)} />
                <span>配管ライン ({pipeLines.length})</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={showPipeVertices} onChange={(e) => setShowPipeVertices(e.target.checked)} />
                <span>暗渠頂点 ({pipeVertices.length})</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={showRoute} onChange={(e) => setShowRoute(e.target.checked)} />
                <span>順路 ({routePoints.length})</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={showDrawings} onChange={(e) => setShowDrawings(e.target.checked)} />
                <span>描画メモ ({drawings.length})</span>
              </label>
            </div>
          )}
        </div>

        {/* 右下: 法務省地図 (上) + 背景地図セレクタ (下) — スマホ編集ユーザーと同じ配置 */}
        <div className="absolute bottom-5 right-1 z-[1000] flex flex-col items-end gap-1">
          {hasActiveParcelDataset && (
            <button
              onClick={() => setShowParcelMap((v) => !v)}
              className={`px-2 py-1 text-[11px] rounded border shadow ${
                showParcelMap
                  ? 'bg-orange-500 text-white border-orange-500 hover:bg-orange-600'
                  : 'bg-white/95 text-slate-700 border-slate-300 hover:bg-slate-50'
              }`}
              title="法務省地図データを背景に表示する (読み取り専用)"
            >
              法務省地図
            </button>
          )}
          <div className="flex items-center gap-1 px-1.5 py-0.5 rounded shadow border border-slate-300 bg-white/95 text-[11px]">
            <span className="text-slate-500">背景</span>
            <select
              value={background}
              onChange={(e) => setBackground(e.target.value as BackgroundKind)}
              className="px-1 py-0.5 border border-slate-300 rounded bg-white text-[11px]"
            >
              <option value="photo">空中写真</option>
              <option value="std">標準地図</option>
              <option value="pale">淡色地図</option>
              <option value="blank">白地図</option>
            </select>
          </div>
        </div>
      </div>

    </div>
  )
}

function coordinateColor(type: string): string {
  const t = type as CoordinateType
  if (t === 'control') return '#ea580c' // 基準点 = オレンジ
  if (t === 'boundary') return '#0ea5e9' // 境界点 = シアン
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

