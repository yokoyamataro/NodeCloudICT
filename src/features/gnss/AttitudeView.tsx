// GNSS 受信機から取得した 姿勢情報 (heading / pitch / roll) を表示。
//
// - 上部: コンパス円 (heading を 北基準で 針表示)
// - 下部: pitch / roll の 数値 + バー
// - source ラベルで データ由来 を表示 (PSAT/HPR / HDT / RMC COG)
//
// 受信機が PSAT/HPR や HDT を送らない場合、RMC の COG (Course Over Ground)
// にフォールバック。COG は 静止時 意味なしなので source で判別できる。

import { useEffect, useState } from 'react'
import { Compass, ArrowUp } from 'lucide-react'
import { DroggerLocation, getAttitude, type AttitudeInfo } from '@/lib/drogger'

export function AttitudeView() {
  const [att, setAtt] = useState<AttitudeInfo | null>(null)

  useEffect(() => {
    let cancelled = false
    let handle: { remove: () => Promise<void> } | null = null
    void getAttitude()
      .then((a) => {
        if (!cancelled) setAtt(a)
      })
      .catch(() => {
        /* ネイティブ未実装等は無視 */
      })
    void DroggerLocation.addListener('attitude', (ev) => {
      if (!cancelled) setAtt(ev)
    }).then((h) => {
      if (cancelled) void h.remove()
      else handle = h
    })
    return () => {
      cancelled = true
      if (handle) void handle.remove()
    }
  }, [])

  const heading = att?.heading ?? null
  const pitch = att?.pitch ?? null
  const roll = att?.roll ?? null
  const source = att?.source ?? null

  const SIZE = 220
  const CENTER = SIZE / 2
  const RADIUS = SIZE / 2 - 20

  const headingRad = heading != null ? ((heading - 90) * Math.PI) / 180 : 0
  const needleX = heading != null ? CENTER + RADIUS * 0.85 * Math.cos(headingRad) : CENTER
  const needleY = heading != null ? CENTER + RADIUS * 0.85 * Math.sin(headingRad) : CENTER

  return (
    <div className="space-y-4">
      {/* 情報源 + タイムスタンプ */}
      <div className="flex items-center justify-between text-xs">
        <div className="flex items-center gap-1.5 text-slate-600">
          <Compass className="h-4 w-4" />
          <span>姿勢情報</span>
        </div>
        <div className="text-[10px] text-slate-500">
          源: {source ?? '受信なし'}
        </div>
      </div>

      {/* コンパス */}
      <div className="flex justify-center">
        <svg
          width={SIZE}
          height={SIZE}
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          className="bg-slate-50 rounded-full border border-slate-300"
        >
          {/* 目盛 */}
          {[0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330].map((deg) => {
            const theta = ((deg - 90) * Math.PI) / 180
            const x1 = CENTER + RADIUS * Math.cos(theta)
            const y1 = CENTER + RADIUS * Math.sin(theta)
            const x2 =
              CENTER + (RADIUS - (deg % 90 === 0 ? 10 : 5)) * Math.cos(theta)
            const y2 =
              CENTER + (RADIUS - (deg % 90 === 0 ? 10 : 5)) * Math.sin(theta)
            return (
              <line
                key={deg}
                x1={x1}
                y1={y1}
                x2={x2}
                y2={y2}
                stroke="#94a3b8"
                strokeWidth={deg % 90 === 0 ? 2 : 1}
              />
            )
          })}
          {/* 方位ラベル */}
          <text
            x={CENTER}
            y={22}
            textAnchor="middle"
            fontSize="14"
            fontWeight="bold"
            fill="#dc2626"
          >
            N
          </text>
          <text
            x={SIZE - 12}
            y={CENTER + 5}
            textAnchor="end"
            fontSize="12"
            fontWeight="bold"
            fill="#64748b"
          >
            E
          </text>
          <text
            x={CENTER}
            y={SIZE - 8}
            textAnchor="middle"
            fontSize="12"
            fontWeight="bold"
            fill="#64748b"
          >
            S
          </text>
          <text
            x={12}
            y={CENTER + 5}
            textAnchor="start"
            fontSize="12"
            fontWeight="bold"
            fill="#64748b"
          >
            W
          </text>

          {/* heading 針 (heading あれば描く) */}
          {heading != null ? (
            <>
              <line
                x1={CENTER}
                y1={CENTER}
                x2={needleX}
                y2={needleY}
                stroke="#dc2626"
                strokeWidth={3}
                strokeLinecap="round"
              />
              <circle
                cx={needleX}
                cy={needleY}
                r={5}
                fill="#dc2626"
              />
              <circle cx={CENTER} cy={CENTER} r={4} fill="#334155" />
            </>
          ) : (
            <text
              x={CENTER}
              y={CENTER + 5}
              textAnchor="middle"
              fontSize="10"
              fill="#94a3b8"
            >
              (受信なし)
            </text>
          )}
        </svg>
      </div>

      {/* Heading 数値 */}
      <div className="text-center">
        <div className="text-[10px] text-slate-500">方位 (heading)</div>
        <div className="text-xl font-bold font-mono text-slate-800">
          {heading != null ? `${heading.toFixed(1)}°` : '-'}
        </div>
      </div>

      {/* Pitch / Roll */}
      <div className="grid grid-cols-2 gap-3 text-xs">
        <PitchRollGauge label="ピッチ (pitch)" valueDeg={pitch} colorClass="bg-blue-500" />
        <PitchRollGauge label="ロール (roll)" valueDeg={roll} colorClass="bg-emerald-500" />
      </div>

      {/* 対応 NMEA の 説明 */}
      <div className="text-[10px] text-slate-500 border-t pt-2 leading-relaxed">
        対応 NMEA: <span className="font-mono">$PSAT,HPR</span> (ヘディング + ピッチ + ロール) /{' '}
        <span className="font-mono">$GxHDT</span> (ヘディング) /{' '}
        <span className="font-mono">$GxRMC</span> COG (移動時のみ有効なフォールバック)。
        Drogger が これらを 出力しない場合は 「受信なし」表示。
      </div>
    </div>
  )
}

function PitchRollGauge({
  label,
  valueDeg,
  colorClass,
}: {
  label: string
  valueDeg: number | null
  colorClass: string
}) {
  // ±30° を フルスケールとし、中心 = 0°
  const clamped = valueDeg != null ? Math.max(-30, Math.min(30, valueDeg)) : 0
  const pct = ((clamped + 30) / 60) * 100
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-slate-600">{label}</span>
        <span className="font-mono font-bold text-slate-800">
          {valueDeg != null ? `${valueDeg.toFixed(1)}°` : '-'}
        </span>
      </div>
      <div className="relative h-3 bg-slate-100 rounded overflow-hidden border border-slate-200">
        {/* 中心線 */}
        <div className="absolute top-0 bottom-0 left-1/2 w-px bg-slate-400" />
        {valueDeg != null && (
          <div
            className={`absolute top-0 bottom-0 w-1 ${colorClass}`}
            style={{ left: `calc(${pct}% - 2px)` }}
          />
        )}
      </div>
      <div className="flex justify-between text-[9px] text-slate-400">
        <span>-30°</span>
        <span>0</span>
        <span>+30°</span>
      </div>
    </div>
  )
}

// UI から icon 参照用 (親 GpsSettingsModal のタブアイコン)
export { ArrowUp as AttitudeIcon }
