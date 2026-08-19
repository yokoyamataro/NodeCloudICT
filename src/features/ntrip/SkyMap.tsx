// GNSS スカイマップ表示。
//
// - SVG 極座標プロット (中心=天頂90°、外周=水平線0°)
// - 方位は 北=上、東=右、南=下、西=左 (時計回り)
// - コンステレーション別に色分け (GPS青 / GLONASS赤 / Galileo緑 / QZSS紫 / BeiDou黄 / SBAS橙)
// - Fix 使用中の衛星は塗りつぶし + 外郭、未使用は 半透明
// - 下部に SNR バー一覧 (PRN + dB-Hz)
//
// データ源: DroggerLocationPlugin の 'satellites' イベント + getSatellites()

import { useEffect, useMemo, useState } from 'react'
import {
  DroggerLocation,
  getSatellites,
  type Constellation,
  type SatelliteInfo,
  type SatellitesSnapshot,
} from '@/lib/drogger'

const CONST_COLOR: Record<Constellation, string> = {
  GPS: '#2563eb',
  GLONASS: '#dc2626',
  Galileo: '#16a34a',
  QZSS: '#9333ea',
  BeiDou: '#ca8a04',
  SBAS: '#ea580c',
  Multi: '#64748b',
  Other: '#94a3b8',
}

const CONST_ORDER: Constellation[] = [
  'GPS',
  'GLONASS',
  'Galileo',
  'QZSS',
  'BeiDou',
  'SBAS',
  'Multi',
  'Other',
]

/** SNR 品質による色 */
function snrColor(snr: number | null): string {
  if (snr == null) return '#94a3b8'
  if (snr >= 40) return '#16a34a'
  if (snr >= 30) return '#ca8a04'
  return '#dc2626'
}

/**
 * (elevation, azimuth) → SVG (x, y) 極座標変換。
 * radius: SVG 円半径, cx/cy: 中心座標
 */
function polarToXY(
  elevation: number,
  azimuth: number,
  cx: number,
  cy: number,
  radius: number,
): { x: number; y: number } {
  // 仰角90°=中心、0°=外周、線形マッピング (航空系スカイマップ標準)
  const r = radius * (1 - Math.max(0, Math.min(90, elevation)) / 90)
  // 方位0°=真北=上、時計回り
  const theta = ((azimuth - 90) * Math.PI) / 180
  return { x: cx + r * Math.cos(theta), y: cy + r * Math.sin(theta) }
}

export function SkyMap() {
  const [snapshot, setSnapshot] = useState<SatellitesSnapshot | null>(null)

  useEffect(() => {
    let cancelled = false
    let handle: { remove: () => Promise<void> } | null = null
    // 初回スナップショット
    void getSatellites()
      .then((s) => {
        if (!cancelled) setSnapshot(s)
      })
      .catch(() => {
        /* ネイティブ未実装環境等は無視 */
      })
    void DroggerLocation.addListener('satellites', (ev) => {
      if (!cancelled) setSnapshot(ev)
    }).then((h) => {
      if (cancelled) void h.remove()
      else handle = h
    })
    return () => {
      cancelled = true
      if (handle) void handle.remove()
    }
  }, [])

  const sats = snapshot?.satellites ?? []
  const drawable = sats.filter(
    (s) => s.elevation != null && s.azimuth != null,
  )

  // 統計
  const stats = useMemo(() => {
    const perConst: Record<string, { total: number; used: number }> = {}
    let totalUsed = 0
    for (const s of sats) {
      const p = perConst[s.constellation] ?? { total: 0, used: 0 }
      p.total += 1
      if (s.usedInFix) {
        p.used += 1
        totalUsed += 1
      }
      perConst[s.constellation] = p
    }
    return { perConst, totalUsed, total: sats.length }
  }, [sats])

  // SVG レイアウト
  const SIZE = 280
  const CENTER = SIZE / 2
  const RADIUS = SIZE / 2 - 12

  // SNR バー ソート (Fix使用中 → SNR降順)
  const sortedForBars = useMemo(() => {
    return [...sats].sort((a, b) => {
      if (a.usedInFix !== b.usedInFix) return a.usedInFix ? -1 : 1
      return (b.snr ?? 0) - (a.snr ?? 0)
    })
  }, [sats])

  return (
    <div className="space-y-3">
      {/* 統計サマリ */}
      <div className="flex items-center gap-3 text-xs">
        <span className="font-semibold">
          {stats.totalUsed} / {stats.total} 衛星使用中
        </span>
        <div className="flex flex-wrap gap-1.5">
          {CONST_ORDER.filter((c) => stats.perConst[c]).map((c) => (
            <span
              key={c}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px]"
              style={{ borderColor: CONST_COLOR[c], color: CONST_COLOR[c] }}
            >
              <span
                className="inline-block w-2 h-2 rounded-full"
                style={{ background: CONST_COLOR[c] }}
              />
              {c} {stats.perConst[c].used}/{stats.perConst[c].total}
            </span>
          ))}
        </div>
      </div>

      {/* スカイマップ SVG */}
      <div className="flex justify-center">
        <svg
          width={SIZE}
          height={SIZE}
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          className="bg-slate-50 rounded-full border border-slate-300"
        >
          {/* 仰角リング */}
          {[0, 30, 60].map((el) => (
            <circle
              key={el}
              cx={CENTER}
              cy={CENTER}
              r={RADIUS * (1 - el / 90)}
              fill="none"
              stroke="#cbd5e1"
              strokeDasharray={el === 0 ? undefined : '2 3'}
            />
          ))}
          {/* 方位線 (十字 N-S / E-W) */}
          <line
            x1={CENTER}
            y1={CENTER - RADIUS}
            x2={CENTER}
            y2={CENTER + RADIUS}
            stroke="#cbd5e1"
            strokeDasharray="2 3"
          />
          <line
            x1={CENTER - RADIUS}
            y1={CENTER}
            x2={CENTER + RADIUS}
            y2={CENTER}
            stroke="#cbd5e1"
            strokeDasharray="2 3"
          />
          {/* 方位ラベル */}
          <text x={CENTER} y={10} textAnchor="middle" fontSize="10" fill="#64748b" fontWeight="bold">
            N
          </text>
          <text x={SIZE - 4} y={CENTER + 4} textAnchor="end" fontSize="10" fill="#64748b" fontWeight="bold">
            E
          </text>
          <text x={CENTER} y={SIZE - 2} textAnchor="middle" fontSize="10" fill="#64748b" fontWeight="bold">
            S
          </text>
          <text x={4} y={CENTER + 4} textAnchor="start" fontSize="10" fill="#64748b" fontWeight="bold">
            W
          </text>
          {/* 仰角ラベル */}
          <text x={CENTER + 3} y={CENTER + 3} fontSize="8" fill="#94a3b8">
            90°
          </text>
          <text x={CENTER + 3} y={CENTER + RADIUS * (1 - 30 / 90) - 2} fontSize="8" fill="#94a3b8">
            60°
          </text>
          <text x={CENTER + 3} y={CENTER + RADIUS * (1 - 60 / 90) - 2} fontSize="8" fill="#94a3b8">
            30°
          </text>

          {/* 衛星プロット */}
          {drawable.map((s) => {
            const { x, y } = polarToXY(s.elevation!, s.azimuth!, CENTER, CENTER, RADIUS)
            const color = CONST_COLOR[s.constellation]
            const r = s.usedInFix ? 8 : 6
            return (
              <g key={`${s.constellation}-${s.prn}`}>
                <circle
                  cx={x}
                  cy={y}
                  r={r}
                  fill={s.usedInFix ? color : 'white'}
                  stroke={color}
                  strokeWidth={s.usedInFix ? 1.5 : 1.5}
                  opacity={s.usedInFix ? 1 : 0.7}
                />
                <text
                  x={x}
                  y={y + 2}
                  textAnchor="middle"
                  fontSize="7"
                  fill={s.usedInFix ? 'white' : color}
                  fontWeight="bold"
                  pointerEvents="none"
                >
                  {s.prn}
                </text>
              </g>
            )
          })}
        </svg>
      </div>

      {/* SNR バー一覧 */}
      <div className="border-t pt-2">
        <div className="text-[10px] text-slate-600 mb-1 flex items-center justify-between">
          <span>信号強度 (SNR / dB-Hz)</span>
          <span className="text-slate-400">塗り=使用中 / 白抜き=未使用</span>
        </div>
        {sats.length === 0 ? (
          <div className="text-xs text-slate-500 py-4 text-center">
            衛星データ 待機中… (Drogger 側から GSV/GSA を待つ)
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-1 text-[10px] font-mono">
            {sortedForBars.map((s) => {
              const color = CONST_COLOR[s.constellation]
              const bar = snrColor(s.snr)
              const pct = Math.min(100, Math.max(0, ((s.snr ?? 0) / 55) * 100))
              return (
                <div
                  key={`${s.constellation}-${s.prn}-bar`}
                  className="flex items-center gap-1"
                >
                  <span
                    className="inline-block w-1.5 h-3 rounded-sm shrink-0"
                    style={{ background: color, opacity: s.usedInFix ? 1 : 0.4 }}
                  />
                  <span className="w-8 text-right shrink-0 tabular-nums">
                    {s.prn}
                  </span>
                  <div className="flex-1 h-2 bg-slate-100 rounded overflow-hidden">
                    <div
                      className="h-full"
                      style={{
                        width: `${pct}%`,
                        background: bar,
                        opacity: s.usedInFix ? 1 : 0.5,
                      }}
                    />
                  </div>
                  <span className="w-6 text-right shrink-0 tabular-nums">
                    {s.snr ?? '-'}
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

/** 単体 export (テスト用) */
export type { SatelliteInfo }
