// 地図の背景タイル定義。
//
// ICT の測設画面 (MobileStakingPage) に直書きされていたものを、モビリティの
// ドライバー画面・管理画面からも使えるよう切り出した。定義を複数持つと
// 「片方だけ地理院に切り替わっていない」といったずれが起きる。
//
// 出典: 国土地理院 地理院タイル (https://maps.gsi.go.jp/development/ichiran.html)
// 利用にあたっては出典の明示が必要なので attribution を必ず付ける。

export type BaseLayerKey = 'photo' | 'std' | 'pale' | 'blank' | 'osm' | 'none'

export interface BaseLayerDef {
  label: string
  url: string
  /** タイルが存在する最大ズーム。これを超えると拡大表示で引き伸ばす */
  maxNative?: number
  attribution: string
}

const GSI_ATTR = '&copy; <a href="https://maps.gsi.go.jp/development/ichiran.html">国土地理院</a>'

export const BASE_LAYERS: Record<BaseLayerKey, BaseLayerDef> = {
  photo: {
    label: '航空写真',
    url: 'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg',
    maxNative: 18,
    attribution: GSI_ATTR,
  },
  std: {
    label: '地理院地図',
    url: 'https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png',
    maxNative: 18,
    attribution: GSI_ATTR,
  },
  pale: {
    label: '淡色地図',
    url: 'https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png',
    maxNative: 18,
    attribution: GSI_ATTR,
  },
  blank: {
    label: '白地図',
    url: 'https://cyberjapandata.gsi.go.jp/xyz/blank/{z}/{x}/{y}.png',
    maxNative: 14,
    attribution: GSI_ATTR,
  },
  osm: {
    label: 'OSM',
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  },
  none: {
    label: '背景なし',
    // 透明 1px 画像をタイルにすることで、TileLayer を unmount せず URL のみ更新する
    // → 既存のポリゴンなどの上位レイヤを巻き込んで再描画されるのを防ぐ
    url: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
    attribution: '',
  },
}

/** 画面ごとに選択を localStorage へ保存する。キーは呼出側が決める */
export function loadBaseLayer(storageKey: string, fallback: BaseLayerKey): BaseLayerKey {
  try {
    const saved = localStorage.getItem(storageKey) as BaseLayerKey | null
    if (saved && BASE_LAYERS[saved]) return saved
  } catch {
    /* localStorage 拒否環境 */
  }
  return fallback
}

export function saveBaseLayer(storageKey: string, key: BaseLayerKey): void {
  try {
    localStorage.setItem(storageKey, key)
  } catch {
    /* ignore */
  }
}
