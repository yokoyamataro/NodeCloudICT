// 地図 の 要素 表示 / 非表示 を 全ページ 共通 で 管理 する ストア。
//
// 従来 は 各ページ (OrthophotoPage, CoordinatesPage 等) が それぞれ 独立 の
// state + localStorage key で レイヤ 表示 を 持って いた。 新しい 共通 スキーム
// (地図 左下 の レイヤ ボタン) では この ストア の 値 を 参照 し、 どの ページ でも
// 同じ 設定 が 効く ように する (「全体図 で 建物 を 隠した ら 他 の 画面 でも 隠れる」)。
//
// キー は 文字列 で 定義。 ページ 固有 の 要素 (例: 線形物 の 幅杭) を 増やし たい 場合 は
// LAYER_KEYS に 追加 し、 その ページ で は render 時 に isLayerVisible で ガード する。
//
// 永続化 は localStorage。 工区 を 跨い でも 設定 を 引き継ぐ (ユーザー の 好み なので)。

import { create } from 'zustand'

export const LAYER_KEYS = [
  // 座標 の 点種 (個別 に 切り替え可)
  'points.control',           // 基準点
  'points.boundary',          // 境界点
  'points.current',           // 現況
  'points.measured',          // 実測点
  'points.underdrain',        // 暗渠
  'points.other',             // その他 (map_xml, witness, confirmed_boundary 等 の まとめ)
  // 読取 専用 の 業務 オーバーレイ
  'parcels',                  // 地番 (区域ポリゴン)
  'pipes',                    // 暗渠 配線
  'channels',                 // 線形物 (中心線 / 幅杭 等)
  'cameras',                  // 工区 写真 ピン
  'memos',                    // 工区 メモ
  // 作図 (ペイント) レイヤ の 既定
  'draw.genkyo',              // 現況
  'draw.tatemono',            // 建物
  'draw.doro',                // 道路
  'draw.keikaku',             // 計画
  'draw.zuwaku',              // 図枠
] as const

export type LayerKey = (typeof LAYER_KEYS)[number]

const STORAGE_KEY = 'nc:layers:v1'

function readAll(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object') {
      return parsed as Record<string, boolean>
    }
  } catch {
    /* 旧 データ 不正 は 無視 */
  }
  return {}
}

function writeAll(all: Record<string, boolean>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all))
  } catch {
    /* 容量不足 等 は 無視 */
  }
}

interface State {
  /** 既知 の キー の 可視性。 未登録 は 既定 で true 扱い */
  visibility: Record<string, boolean>
  /** key を 可視 と 判定 する (未登録 は true) */
  isVisible: (key: string) => boolean
  /** 単一 key の 可視性 を 切替 */
  setVisible: (key: string, visible: boolean) => void
  /** 単一 key の 可視性 を トグル */
  toggle: (key: string) => void
}

export const useMapLayersStore = create<State>((set, get) => ({
  visibility: readAll(),
  isVisible: (key) => get().visibility[key] !== false,
  setVisible: (key, visible) => {
    const next = { ...get().visibility, [key]: visible }
    writeAll(next)
    set({ visibility: next })
  },
  toggle: (key) => {
    const current = get().visibility[key] !== false
    const next = { ...get().visibility, [key]: !current }
    writeAll(next)
    set({ visibility: next })
  },
}))

/** 便利 短縮 hook: 1 key の 可視性 を 購読。 ストア 変更 で 再レンダ */
export function useLayerVisible(key: string): boolean {
  return useMapLayersStore((s) => s.visibility[key] !== false)
}
