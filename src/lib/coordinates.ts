import proj4 from 'proj4'

// 日本の平面直角座標系の定義
// 参考: https://www.gsi.go.jp/LAW/heimencho.html

// 各系の原点（緯度・経度）と系番号
export const JGD2011_ZONES: Record<number, { name: string; origin: [number, number] }> = {
  1: { name: '第1系（長崎・鹿児島西部）', origin: [129.5, 33.0] },
  2: { name: '第2系（福岡・佐賀・熊本・大分・宮崎・鹿児島）', origin: [131.0, 33.0] },
  3: { name: '第3系（山口・島根・広島）', origin: [132.166666667, 36.0] },
  4: { name: '第4系（香川・愛媛・徳島・高知）', origin: [133.5, 33.0] },
  5: { name: '第5系（兵庫・鳥取・岡山）', origin: [134.333333333, 36.0] },
  6: { name: '第6系（京都・大阪・福井・滋賀・三重・奈良・和歌山）', origin: [136.0, 36.0] },
  7: { name: '第7系（石川・富山・岐阜・愛知）', origin: [137.166666667, 36.0] },
  8: { name: '第8系（新潟・長野・山梨・静岡）', origin: [138.5, 36.0] },
  9: { name: '第9系（東京・神奈川・千葉・埼玉・茨城・栃木・群馬・福島）', origin: [139.833333333, 36.0] },
  10: { name: '第10系（青森・秋田・山形・岩手・宮城）', origin: [140.833333333, 40.0] },
  11: { name: '第11系（北海道西部）', origin: [140.25, 44.0] },
  12: { name: '第12系（北海道中部）', origin: [142.25, 44.0] },
  13: { name: '第13系（北海道東部）', origin: [144.25, 44.0] },
  14: { name: '第14系（小笠原諸島）', origin: [142.0, 26.0] },
  15: { name: '第15系（沖縄本島）', origin: [127.5, 26.0] },
  16: { name: '第16系（沖縄先島）', origin: [124.0, 26.0] },
  17: { name: '第17系（沖縄大東諸島）', origin: [131.0, 26.0] },
  18: { name: '第18系（東京（本州）小笠原）', origin: [136.0, 20.0] },
  19: { name: '第19系（硫黄島）', origin: [154.0, 26.0] },
}

// proj4の座標系定義を生成
export function getProj4Definition(zone: number): string {
  const zoneInfo = JGD2011_ZONES[zone]
  if (!zoneInfo) {
    throw new Error(`Invalid zone number: ${zone}`)
  }
  const [lon0, lat0] = zoneInfo.origin
  // JGD2011 平面直角座標系
  return `+proj=tmerc +lat_0=${lat0} +lon_0=${lon0} +k=0.9999 +x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs`
}

// WGS84 (緯度経度)
const WGS84 = '+proj=longlat +datum=WGS84 +no_defs'

// 座標変換クラス
export class CoordinateConverter {
  private zone: number
  private proj4Def: string

  constructor(zone: number) {
    this.zone = zone
    this.proj4Def = getProj4Definition(zone)
  }

  // 平面直角座標 → WGS84 (緯度経度)
  toLatLng(x: number, y: number): { lat: number; lng: number } {
    const [lng, lat] = proj4(this.proj4Def, WGS84, [y, x]) // X=北方向、Y=東方向なので入れ替え
    return { lat, lng }
  }

  // WGS84 (緯度経度) → 平面直角座標
  toXY(lat: number, lng: number): { x: number; y: number } {
    const [y, x] = proj4(WGS84, this.proj4Def, [lng, lat])
    return { x, y }
  }

  // 系番号を取得
  getZone(): number {
    return this.zone
  }

  // 系名を取得
  getZoneName(): string {
    return JGD2011_ZONES[this.zone]?.name || ''
  }
}

// 座標の種類
// 基本3種 + 地籍測量で使う 7 種類。
export type CoordinateType =
  | 'control'
  | 'boundary'
  | 'current'
  | 'existing_control'   // 既設基準点
  | 'new_control'        // 新設基準点
  | 'map_xml'            // 地図XML
  | 'national_survey'    // 国調成果
  | 'cadastral_diagram'  // 地積測量図
  | 'witness'            // 立会点
  | 'confirmed_boundary' // 確定筆界点

export const COORDINATE_TYPE_NAMES: Record<CoordinateType, string> = {
  control: '基準点',
  boundary: '境界点',
  current: '現況',
  existing_control: '既設基準点',
  new_control: '新設基準点',
  map_xml: '地図XML',
  national_survey: '国調成果',
  cadastral_diagram: '地積測量図',
  witness: '立会点',
  confirmed_boundary: '確定筆界点',
}
