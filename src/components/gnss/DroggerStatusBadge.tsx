// GPS 設定バッジ。 Fix 品質と NTRIP RTCM 受信状態を コンパクトに表示し、
// タップで GpsSettingsModal を 開く。
//
// BT 接続の ライフサイクルは 全アプリ横断の droggerConnectionStore が 管理。
// バッジは 表示専用 で 「マウント/アンマウント で BT を 触らない」ため、
// ページ遷移 (工区 → 工区一覧 → 別工区) で 接続が 切れない。

import { useEffect, useState } from 'react'
import { Radio, RadioTower, WifiOff, Settings } from 'lucide-react'
import { getActiveSource } from '@/lib/geolocation'
import { correctionSource, CORRECTION_SOURCE_LABEL, type DroggerFixQuality } from '@/lib/drogger'
import { useDroggerConnection } from '@/stores/droggerConnectionStore'
import { GpsSettingsModal } from '@/features/gnss/GpsSettingsModal'

const FIX_LABEL: Record<DroggerFixQuality, string> = {
  0: '受信中',
  1: 'GPS',
  2: 'DGPS',
  4: 'RTK-FIX',
  5: 'RFLOAT',
}

/**
 * GPS ランプが 緑に なる 衛星数。
 * 3D 測位に 最低 4 機、冗長を 見て 5 機を 目安に する。
 */
const MIN_SATS_FOR_GREEN = 5
/** 位置更新が これだけ 止まったら GPS ランプを 黄に する [ms] */
const POS_STALE_MS = 5_000
/** RTCM が これだけ 来なければ NTRIP ランプを 黄に する [ms] */
const NTRIP_STALE_MS = 10_000

type LampColor = 'red' | 'amber' | 'green' | 'slate'

const LAMP_CLASS: Record<LampColor, string> = {
  red: 'bg-red-500 border-red-600',
  amber: 'bg-amber-400 border-amber-500',
  green: 'bg-emerald-500 border-emerald-600',
  slate: 'bg-slate-300 border-slate-400',
}

/** 信号ランプ 1 個。左= GPS、右= NTRIP */
function Lamp({ color, title }: { color: LampColor; title: string }) {
  return (
    <span
      className={`inline-block w-2.5 h-2.5 rounded-full border shrink-0 ${LAMP_CLASS[color]}`}
      title={title}
    />
  )
}

const FIX_CLASS: Record<DroggerFixQuality, string> = {
  0: 'bg-red-100 border-red-400 text-red-800',
  1: 'bg-slate-100 border-slate-400 text-slate-700',
  2: 'bg-blue-100 border-blue-400 text-blue-800',
  4: 'bg-emerald-100 border-emerald-500 text-emerald-800',
  5: 'bg-amber-100 border-amber-500 text-amber-800',
}

export function DroggerStatusBadge({ className }: { className?: string }) {
  const [source, setSource] = useState(() => getActiveSource())
  const {
    connected,
    deviceName,
    fixQuality,
    hdop,
    satellites,
    diffAge,
    stationId,
    lastUpdateAt,
    ntrip,
    ensureStarted,
  } = useDroggerConnection()
  const [showSettings, setShowSettings] = useState(false)

  // source は URL クエリ or プラットフォーム判定で決まる。
  // ページ遷移で 変わり得るため 一応 poll する (URL 変更検知の代替)。
  useEffect(() => {
    const t = window.setInterval(() => {
      const s = getActiveSource()
      setSource((prev) => (prev !== s ? s : prev))
    }, 2000)
    return () => window.clearInterval(t)
  }, [])

  // 鮮度 (stale) の 判定は Date.now() を 見るので、値が 来なくなった ときこそ
  // 再描画が 要る。受信が 止まると ストアの 更新も 止まって しまい、そのままでは
  // ランプが 緑の まま 固まる。1 秒ごとに 自分で 時計を 進める。
  const [, setTick] = useState(0)
  useEffect(() => {
    const t = window.setInterval(() => setTick((n) => n + 1), 1000)
    return () => window.clearInterval(t)
  }, [])

  // Drogger モード の 時に BT を 開始 (グローバル store が 1 回だけ実行)。
  // バッジ アンマウント時 は 何もしない = 接続維持
  useEffect(() => {
    if (source === 'drogger') void ensureStarted()
  }, [source, ensureStarted])

  if (source !== 'drogger') return null

  const fq = fixQuality
  // 鮮度。Fix ラベルにも ランプにも 使うので 先に 出す
  const staleMs = lastUpdateAt != null ? Date.now() - lastUpdateAt : null
  const isStale = staleMs != null && staleMs > POS_STALE_MS
  const ntripStaleMs = ntrip.lastRtcmAt > 0 ? Date.now() - ntrip.lastRtcmAt : null
  const ntripStale = ntrip.connected && ntripStaleMs != null && ntripStaleMs > NTRIP_STALE_MS
  // 補正の 出どころ。NTRIP を 繋いでいないのに 補正が 効いていれば CLAS
  const corrSrc = connected ? correctionSource({ fixQuality, diffAge }, ntrip.connected) : 'none'
  const isClas = corrSrc === 'clas'
  // CLAS で 解けている 間は 出どころが 一目で 分かる 名前にする。
  // Float は 精度が 落ちるので 色 (琥珀) は 残したまま 名前だけ 変える
  const boxClass =
    fq != null
      ? isClas && fq === 4
        ? 'bg-violet-100 border-violet-500 text-violet-800'
        : FIX_CLASS[fq]
      : connected
        ? 'bg-slate-100 border-slate-400 text-slate-700'
        : 'bg-red-100 border-red-400 text-red-800'
  const fixLabel = !connected
    ? '切断'
    : isStale
      // BLE は 生きているのに NMEA が 止まった (受信機が 黙った) 状態。
      // 直前の Fix を 出し続けると 今も 測位しているように 見えてしまう
      ? '受信断'
      : fq == null
      ? '受信中'
      : isClas && fq === 4
        ? 'CLAS'
        : isClas && fq === 5
          ? 'CLAS-F'
          : FIX_LABEL[fq]
  const icon = !connected ? (
    <WifiOff className="h-3 w-3" />
  ) : fq === 4 ? (
    <RadioTower className="h-3 w-3" />
  ) : (
    <Radio className="h-3 w-3" />
  )
  // GPS ランプ: 赤= BLE 未接続 / 黄= 繋がっているが 測位が 足りない or 止まった /
  // 緑= 測位中で 衛星も 足りている
  const gpsLamp: { color: LampColor; title: string } = !connected
    ? { color: 'red', title: 'GPS: Bluetooth 未接続' }
    : isStale
      ? {
          color: 'amber',
          title: `GPS: 受信が 止まっています (${Math.round((staleMs ?? 0) / 1000)} 秒前)`,
        }
      : fq == null || fq === 0
        ? { color: 'amber', title: 'GPS: 接続済み、測位待ち' }
        : (satellites ?? 0) < MIN_SATS_FOR_GREEN
          ? {
              color: 'amber',
              title: `GPS: 衛星 ${satellites ?? 0} 機 (${MIN_SATS_FOR_GREEN} 機未満)`,
            }
          : { color: 'green', title: `GPS: 測位中 / 衛星 ${satellites} 機` }

  // NTRIP ランプ: 灰= 未設定 (CLAS のみの 運用) / 赤= 切断 /
  // 黄= 繋がっているが RTCM が 来ない / 緑= 受信中
  const ntripLamp: { color: LampColor; title: string } =
    ntrip.host == null
      ? { color: 'slate', title: 'NTRIP: 未設定' }
      : !ntrip.connected
        ? { color: 'red', title: 'NTRIP: 切断' }
        : ntripStale
          ? {
              color: 'amber',
              title: `NTRIP: ${Math.round((ntripStaleMs ?? 0) / 1000)} 秒 受信なし`,
            }
          : {
              color: 'green',
              title: `NTRIP: 受信中 (${(ntrip.bytesReceived / 1024).toFixed(1)} KB)`,
            }

  const tooltip = [
    `GPS: ${deviceName ?? '(未接続)'}`,
    fq != null ? `Fix: ${FIX_LABEL[fq]}` : null,
    hdop != null ? `HDOP: ${hdop.toFixed(2)}` : null,
    satellites != null ? `Sats: ${satellites}` : null,
    `補正: ${CORRECTION_SOURCE_LABEL[corrSrc]}${
      diffAge != null ? ` (経過 ${diffAge.toFixed(1)} 秒)` : ''
    }${stationId ? ` / 基準局 ${stationId}` : ''}`,
    isStale ? `更新: ${Math.round((staleMs ?? 0) / 1000)} 秒前` : null,
    ntrip.connected
      ? `NTRIP: ${ntrip.host}/${ntrip.mountpoint} (${(ntrip.bytesReceived / 1024).toFixed(1)} KB${
          ntripStale ? ' / stale' : ''
        })`
      : 'NTRIP: 未接続',
    '(タップで GPS 設定)',
  ]
    .filter(Boolean)
    .join(' / ')

  return (
    <>
      <span className={`inline-flex items-center gap-1 ${className ?? ''}`}>
        {/* 信号: 左= GPS 接続状況、右= NTRIP 受信状況 */}
        <Lamp {...gpsLamp} />
        <Lamp {...ntripLamp} />
        <button
          type="button"
          onClick={() => setShowSettings(true)}
          className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-semibold cursor-pointer hover:brightness-110 ${boxClass} ${
            isStale ? 'opacity-60' : ''
          }`}
          title={tooltip}
        >
          <Settings className="h-3 w-3" />
          {icon}
          <span>{fixLabel}</span>
        </button>
      </span>
      <GpsSettingsModal open={showSettings} onClose={() => setShowSettings(false)} />
    </>
  )
}
