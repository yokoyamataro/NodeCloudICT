import { create } from 'zustand'
import { supabase } from '@/lib/supabase'

export type AlignmentPointKind = 'bp' | 'ip' | 'ep'

export interface AlignmentPoint {
  /** 座標管理の design_coordinates の id を参照 */
  coordId: string
  kind: AlignmentPointKind
  /** IP の単曲線半径 (m)。0 または未指定で直角折れ */
  radius?: number
  /** IP の IN 側クロソイドパラメータ A (m)。0/未指定で緩和曲線なし */
  spiralAIn?: number
  /** IP の OUT 側クロソイドパラメータ A (m)。0/未指定で緩和曲線なし */
  spiralAOut?: number
}

/** 縦断線形の変化点 */
export interface ProfilePoint {
  /** BP からの追加距離 (m) */
  distance: number
  /** 床高 (m, 標高) */
  floorHeight: number
  /**
   * 縦断曲線長 VCL (m)。省略 or 0 なら 角折れ (曲線なし)。
   * この 変化点 を PVI (勾配変化点) として BVC=PVI-VCL/2、EVC=PVI+VCL/2 に
   * 対称 2 次放物線 を 割り付ける。両端 の 変化点 (BP/EP) では 無視。
   */
  vcl?: number
}

/**
 * 追加 の 縦断 (管理用)。
 *
 * 中心線 の 縦断 は OpenChannelRow.profilePoints (主縦断) で、 測点 の
 * 中心設計高 / 杭打ち / エクスポート は そちら だけ を 使う。 これ は
 * 「道路高 と 側溝高」「河床高 と 左右 の 築堤高」 の ように、 1 路線 で
 * 並べて 管理 したい 高さ を 縦断図 に 重ねて 見る ため の もの。
 */
export interface ExtraProfile {
  /** クライアント 生成 の 一意 ID */
  id: string
  /** 表示名 (道路高 など) */
  name: string
  /** 縦断図 の 線 の 色。 省略 時 は 並び 順 の 既定色 */
  color?: string
  /** 変化点列。 形式 は 主縦断 と 同じ */
  points: ProfilePoint[]
}

/** 勾配の表記単位
 *  - 'ratio'    : 1:i 表記（slopeValue=i, 符号で上下）
 *  - 'percent'  : i % 表記（slopeValue=i, 符号で上下）
 *  - 'vertical' : 直立（水平 0 のまま slopeValue 分だけ高さ変化、+ で上り、- で下り）
 */
export type SlopeUnit = 'ratio' | 'percent' | 'vertical'

/**
 * 標準断面の 1 要素（中心からの 1 区間）。
 *
 * - `width` は水平方向の幅 (m, 正値)。`slopeUnit='vertical'` のときは無視され 0 として扱う。
 * - `slopeValue` は数値で、符号は外側に向かう向きでの上下を表す:
 *   + = 上り（外側に向かって上がる）/ - = 下り。
 *   - `slopeUnit='ratio'`: 「1:value」と解釈。0 は不可（フラットは percent 0% を使用）。
 *   - `slopeUnit='percent'`: 「value %」と解釈（0% フラット）。
 *   - `slopeUnit='vertical'`: 高さ (m) として解釈。dx=0, dy=slopeValue。
 * - `name` はラベル（床 / 法面 / 道路部 など）。色分け等の将来拡張用。
 */
export interface CrossSectionElement {
  id: string
  name: string
  width: number
  slopeValue: number
  slopeUnit: SlopeUnit
  /**
   * 「勾配 の まま 現況線 まで 伸ばす」 区間 (法面 の 摺り付け)。
   *
   * 付いて いる とき、 width は 使わ ない。 長さ は 現況断面 と の 交点 で
   * 決まる ので、 測点 へ 取り込む とき に 解決 する (標準断面 の 定義 時 に は
   * 決まら ない)。 marginW は 交点 から さらに 同じ 勾配 の まま 幅方向 に
   * 伸ばす 量 [m]。
   *
   * この 印 を 知ら ない 古い 処理 (elementStep / buildCrossSectionPath 等) は
   * width=0 の 区間 と して 素通り する。 形 が 崩れる より 短く 出る 方 が
   * 安全 な ため、 保存 時 は width を 0 に して おく。
   */
  toGround?: { marginW: number }
}

export interface StandardCrossSection {
  /** 中心 → 右側へ並ぶ要素列 */
  right: CrossSectionElement[]
  /** 中心 → 左側へ並ぶ要素列 */
  left: CrossSectionElement[]
}

export const emptyStandardCrossSection = (): StandardCrossSection => ({ right: [], left: [] })

/**
 * 路線 の 種別。
 *   channel : 線形物 (水路 / 道路)。 IP と 曲線 を 持てる
 *   grading : 整地。 BP と EP の 直線 だけ。 平行 縦断 で 格子 を 作る
 * データ の 形 は 同じ な ので テーブル と 画面 を 共有 し、 これ で 使い分ける。
 */
export type ChannelKind = 'channel' | 'grading'

/**
 * 整地 の 格子 (平行 縦断) の 設定。
 * 平行 縦断 の 高さ は 各 測点 の 横断 の 点列 を 縦 に 読んだ もの な ので、
 * ここ に は 「どこ に 何本 引く か」 と 名前 だけ を 持つ。
 */
export interface GridLinesConfig {
  /** 平行 縦断 の 間隔 [m]。 中間点 の ピッチ も これ に 揃える */
  spacing: number
  /** 中心 の 左 に 何本 */
  leftCount: number
  /** 中心 の 右 に 何本 */
  rightCount: number
  /** 中心線 の 名前。 左右 は ここ から アルファベット で 自動 (F → 左 E,D… / 右 G,H…) */
  centerName: string
  /**
   * アルファベット の 進む 向き。 既定 (false) は 右 へ 進む (F → 右 G,H… / 左 E,D…)。
   * true に する と 逆 で、 左 へ 進む (F → 左 G,H… / 右 E,D…)。
   * 現場 の 呼び方 が 右回り / 左回り の どちら でも 合わせ られる ように する。
   */
  reverseNames?: boolean
  /** 自動 の 名前 を 個別 に 上書き。 キー は 中心 から の 本数 (左 が 負) */
  names?: Record<string, string>
}

export const defaultGridLines = (): GridLinesConfig => ({
  spacing: 20,
  leftCount: 3,
  rightCount: 3,
  centerName: 'F',
})

/** grid_lines の 正規化。 欠け や 壊れ は 既定 で 埋める */
export function normalizeGridLines(raw: unknown): GridLinesConfig {
  const d = defaultGridLines()
  if (!raw || typeof raw !== 'object') return d
  const o = raw as Partial<GridLinesConfig>
  const num = (v: unknown, fb: number, min: number) =>
    typeof v === 'number' && Number.isFinite(v) && v >= min ? v : fb
  const names: Record<string, string> = {}
  if (o.names && typeof o.names === 'object') {
    for (const [k, v] of Object.entries(o.names)) {
      if (typeof v === 'string' && v.trim() !== '' && /^-?\d+$/.test(k)) names[k] = v.trim()
    }
  }
  return {
    spacing: num(o.spacing, d.spacing, 0.1),
    leftCount: Math.floor(num(o.leftCount, d.leftCount, 0)),
    rightCount: Math.floor(num(o.rightCount, d.rightCount, 0)),
    centerName:
      typeof o.centerName === 'string' && o.centerName.trim() !== ''
        ? o.centerName.trim()
        : d.centerName,
    reverseNames: o.reverseNames === true,
    names: Object.keys(names).length > 0 ? names : undefined,
  }
}

/**
 * 名前 付き の 標準断面。
 *
 * 現場 で は 「台形水路 B=1.0 H=1.2」「道路部 W=4.0」 の ように 何種類 か を
 * 使い分ける ので、 1 路線 に 複数 持てる ように する。 測点 の 計画断面 に
 * 取り込む とき に ここ から 選ぶ。 他 現場 へ は ファイル で 持ち出す。
 *
 * 旧 の 単一断面 (OpenChannelRow.standardCrossSection) は 残して あり、
 * 計画 を 開いた ときの 自動複製 など は 従来 どおり そちら を 見る。
 */
export interface NamedStandardSection {
  /** クライアント 生成 の 一意 ID */
  id: string
  /** 表示名 */
  name: string
  /** 補足 (省略 可) */
  note?: string
  /** 中心 から 外 向き の 区間列 */
  cross: StandardCrossSection
}

/**
 * トンボ (丁張 の 目印)。
 *
 * 計画横断 の 変化点 を 基準 に、 横 (幅方向) と 高さ の ずらし を 与えて
 * 1 点 を 決める。 現地 に 立てる 杭 の 位置 と 高さ に なる。
 *
 * 基準 の 変化点 は id で 結ぶ が、 計画断面 を 取り込み 直す と 点 の id は
 * 振り直される。 その とき でも 追える ように、 定義 した ときの 離れ を
 * 控えて おき、 id が 見つから なければ 一番 近い 離れ の 点 に 寄せる。
 */
export interface TomboPoint {
  id: string
  /** 基準 に する 計画断面 の 変化点 の id */
  basePointId: string
  /** 定義 した ときの 基準点 の 離れ [m]。 id が 変わった ときの 手がかり */
  baseOffset: number
  /**
   * 基準点 から の 横 の ずらし [m]。 中心 から 遠ざかる 向き が 正。
   * 例) 右側 の 変化点 で +0.5 なら さらに 0.5m 右
   */
  dw: number
  /** 基準点 から の 高さ の ずらし [m]。 上 が 正 */
  dh: number
  /** 点名。 空 なら 測点名 と 基準点 から 自動 で 付ける */
  name?: string
  /** 座標管理 に 登録 した とき の 座標 id (再登録 の 判定 用) */
  coordinateId?: string | null
}

/**
 * 丁張 (法面 の 目印)。
 *
 * 法尻 など の 計画点 を 基準 に、 中心 から 遠ざかる 向き に W だけ 離して
 * 幅杭 を 立てる。 対象 の 法面 は 「基準点 と もう 一方 の 端 (法肩)」 の
 * 2 点 で 決まる。 その 法面 の 線 を 杭 の 位置 まで 延ばした 高さ が 丁張高、
 * そこ から 法肩 まで の 斜め の 長さ が 法長 に なる。
 *
 * 点 の id は 計画断面 を 取り込み 直す と 変わる ので、 トンボ と 同じく
 * 定義 した ときの 離れ を 控えて おき、 見つから なければ 近い 点 に 寄せる。
 */
export interface ChohariPoint {
  id: string
  /** 杭 の 基準 に する 計画点 (法尻 など) */
  basePointId: string
  baseOffset: number
  /** 対象 法面 の もう 一方 の 端 (法肩 など) */
  crestPointId: string
  crestOffset: number
  /** 基準点 から の オフセット幅 [m]。 中心 から 遠ざかる 向き が 正 */
  w: number
  /** 点名。 空 なら 測点名 と 基準点 から 自動 */
  name?: string
  /** 座標管理 に 登録 した とき の 座標 id */
  coordinateId?: string | null
}

/**
 * 測定 断面 点 (現況 / 出来形 / トレース由来 の 計画 用)。
 * 中心線からの 垂直方向 距離 (offset) と 標高。
 *   offset > 0 = 右側、offset < 0 = 左側 (WidthStake と 同じ 慣習、sideOrientation に 従う)
 *   note: 地図から 拾った 場合 の 元 座標番号 等 の 任意メモ
 */
export interface MeasuredCrossPoint {
  id: string
  offset: number
  elevation: number
  note?: string
}

/**
 * 各測点 の 「既存 DXF 図面 上の 校正情報」。
 * トレース (DXF 座標 → 実 offset + 実標高 変換) に 使う。
 *   dlY / centerX: DXF 上の 「DL 水平線 の Y」 と 「中心 縦線 の X」 (mm)
 *   dlElevation:   DL に 割り当てる 実標高 (m)。 DXF テキスト「DL=-6.00」の 値
 *   hScale / vScale: 縮尺 分母 (1:100 なら 100)。 水平・垂直 が 別 縮尺 でも 対応
 * 変換式:
 *   offset [m]    = (px - centerX) * hScale / 1000
 *   elevation [m] = dlElevation + (py - dlY) * vScale / 1000
 */
export interface DxfCalibration {
  dlY: number
  centerX: number
  dlElevation: number
  hScale: number
  vScale: number
}

/**
 * 線形物 に 添付する 既存横断図 DXF (複数対応)。
 * 1 チャンネル 内 に 複数 DXF (例: 「並べ図 1」「並べ図 2」…) を 持てる。
 * station.dxfCrossSectionId で 「この 測点は どの DXF を 使うか」を 紐付ける。
 */
export interface DxfCrossSectionFile {
  id: string           // 内部 uuid
  name: string         // 元 ファイル名 (表示用)
  path: string         // storage.objects.name (bucket=open-channel-dxf)
  addedAt?: string     // ISO 追加日時 (任意)
}

/** 中間点（測点）。SP / BC / EC / IP などラベル付きで BP からの距離 + 個別断面を保持。 */
export interface StationRow {
  id: string
  /** 表示ラベル（SP12.50 / BC34.20 / IP25.00 等） */
  label: string
  /** BP からの追加距離 (m) */
  distance: number
  /** 個別断面。null / 未指定なら標準断面を使用。 */
  crossSection: StandardCrossSection | null
  /**
   * 現況高 (中心線上の 地盤高) [m]。手入力。null / 未指定なら 未計測扱い。
   * 計画高 (縦断線形 由来) と 差分を 取って 切土/盛土 の 判定 に 使う。
   * currentSection が 中心 (offset=0) を 含む 場合 は そちらが 優先される。
   */
  currentGroundHeight?: number | null
  /**
   * 現況断面 (地盤 の 実測点列)。offset (中心からの 離れ) と 標高 の ペア。
   * 地図の 測点マーカーから 取得 (中心線 に 垂直投影) するか、モーダルから 直接入力。
   */
  currentSection?: MeasuredCrossPoint[] | null
  /**
   * 出来形 断面 (施工後の 実測点列)。現状 プレースホルダ (次ステップで 実装予定)。
   */
  asbuiltSection?: MeasuredCrossPoint[] | null
  /** この 測点 に 置く トンボ (丁張 の 目印) */
  tombos?: TomboPoint[] | null
  /** この 測点 に 掛ける 丁張 (法面 の 目印) */
  chohari?: ChohariPoint[] | null
  /**
   * 計画高 (中心線上の 計画 標高) [m]。 縦断線形 が ない (or 未計測) 時に
   * 個別測点として 直接 セット する 用途。 トレース時 に plannedSectionRaw を
   * offset=0 で 補間して 自動 埋め される。 null なら profile から 内挿。
   */
  plannedCenterHeight?: number | null
  /**
   * トレース由来の 計画断面 (DXF ライン クリックで 拾った 点列)。
   * 対話型エディタで 作る element ベースの crossSection とは 別の 格納で、
   * 参考ラインとして 断面図に 重ねて 表示する 用途。
   */
  plannedSectionRaw?: MeasuredCrossPoint[] | null
  /**
   * この 測点における DXF 図面 上の 校正情報。 トレース で 使う。
   * dxfCrossSectionId (複数 DXF の どれか) に 対して 設定された 値。
   */
  dxfCalibration?: DxfCalibration | null
  /**
   * この 測点が 対象と する DXF ファイル の id (channel.dxfCrossSections[].id)。
   * 未指定は 「先頭 の DXF」or「同一 channel に 1 本しか 無い場合は それ」を 想定。
   */
  dxfCrossSectionId?: string | null
  /**
   * 管理測点。 出来形管理 の 対象 に する 測点 に 立てる フラグ。
   * 中間点 は ピッチ割 で 大量 に 作る ので、実際 に 管理 する 断面 だけ を
   * 絞り込む ため の 目印。 未指定 / false は 通常 の 測点。
   */
  isControlStation?: boolean
}

/**
 * 幅杭。追加距離 (BP からの 内部距離) と 中心線 から の 垂直方向 オフセット
 * (進行方向 右手 が +、左手 が -) を 指定して 平面 XY を 算出する。
 */
export interface WidthStake {
  id: string
  /** BP からの 内部 累積距離 (m) */
  distance: number
  /** 中心線 から の 垂直 オフセット (m)。右 が +、左 が -。 */
  offset: number
  /** 任意 メモ (点名 等) */
  note?: string
}

/** 断面の右/左を判定する基準方向。
 *  - 'forward': BP→EP を見て右/左（道路工事の慣習、デフォルト）
 *  - 'reverse': EP→BP を見て右/左（河川工事の慣習）
 */
export type SideOrientation = 'forward' | 'reverse'

export interface OpenChannelRow {
  id: string
  farmId: string
  name: string
  /** 線形物 か 整地 か。 画面 と メニュー を 分ける 目印 */
  kind: ChannelKind
  /** 整地 の 格子 (平行 縦断) の 設定。 線形物 でも 既定 値 を 持つ が 使わ ない */
  gridLines: GridLinesConfig
  /** 標準断面（要素列）。旧 の 単一断面。自動複製 など は これ を 見る */
  standardCrossSection: StandardCrossSection
  /** 名前 付き の 標準断面 ライブラリ。測点 へ の 取込 は ここ から 選ぶ */
  standardSections: NamedStandardSection[]
  alignmentPoints: AlignmentPoint[]
  /** 縦断線形（変化点列）。中心線 の 主縦断 */
  profilePoints: ProfilePoint[]
  /** 主縦断 と 別 に 管理 する 追加 の 縦断 (表示 のみ) */
  extraProfiles: ExtraProfile[]
  /** 中間点（測点）リスト */
  stations: StationRow[]
  /** 左右の基準方向 */
  sideOrientation: SideOrientation
  /**
   * 先頭測点 (BP) の SP オフセット。デフォルト 0。
   * 路線 の 途中 から IP を 入力する 場合 (例: BP を SP 224.69 に 設定) に、
   * 中間点計算 の SP ラベル が 元路線 と 揃う ように する。
   * 内部距離 (BP からの 累積距離) との 関係: SP = 内部距離 + spOffset
   */
  spOffset: number
  /** 幅杭 (SP + 中心線 から の 垂直方向 オフセット で 定義 する 点) */
  widthStakes: WidthStake[]
  notes: string | null
  /**
   * 既存 横断図 DXF (複数枚 対応)。 各測点は dxfCrossSectionId で いずれか 1 枚を
   * 参照 (未設定は 先頭 を 既定)。 トレース機能で 現況/計画/出来形 の 断面を 読み取る 元。
   */
  dxfCrossSections: DxfCrossSectionFile[]
  /**
   * 旧単一 DXF 保持 用の 後方互換 field (廃止予定)。 新規保存では 使わない。
   * 読込時に dxfCrossSections が 空 かつ ここに 値が あれば 自動的に 配列化 して マイグレート。
   */
  dxfCrossSectionPath: string | null
  dxfCrossSectionName: string | null
}

interface OpenChannelDb {
  id: string
  farm_id: string
  name: string
  kind: string | null
  grid_lines: unknown
  standard_cross_section: StandardCrossSection | null
  alignment_points: AlignmentPoint[]
  profile_points: ProfilePoint[] | null
  extra_profiles: ExtraProfile[] | null
  standard_sections: NamedStandardSection[] | null
  stations: StationRow[] | null
  side_orientation: SideOrientation | null
  sp_offset: number | null
  width_stakes: WidthStake[] | null
  notes: string | null
  /** 新: 複数 DXF (JSONB 配列)。 old scalar は 移行後 廃止予定 */
  dxf_cross_sections?: DxfCrossSectionFile[] | null
  /** 旧: 単一 DXF (後方互換) */
  dxf_cross_section_path?: string | null
  dxf_cross_section_name?: string | null
}

/**
 * 追加 縦断 の 正規化。 壊れた 行 は 落とす (id と points が 無いと 編集 できない)。
 * 既存 の 路線 は この カラム が 空配列 な ので 何も 起き ない。
 */
/**
 * 名前 付き 標準断面 の 正規化。 id / name が 無い 行 は 落とす。
 * cross は normalizeCrossSection に 通して left / right を 必ず 配列 に する。
 */
export function normalizeStandardSections(raw: unknown): NamedStandardSection[] {
  if (!Array.isArray(raw)) return []
  const out: NamedStandardSection[] = []
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue
    const o = r as Partial<NamedStandardSection>
    if (typeof o.id !== 'string' || o.id === '') continue
    out.push({
      id: o.id,
      name: typeof o.name === 'string' && o.name !== '' ? o.name : '標準断面',
      note: typeof o.note === 'string' && o.note !== '' ? o.note : undefined,
      cross: normalizeCrossSection(o.cross),
    })
  }
  return out
}

function normalizeExtraProfiles(raw: unknown): ExtraProfile[] {
  if (!Array.isArray(raw)) return []
  const out: ExtraProfile[] = []
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue
    const o = r as Partial<ExtraProfile>
    if (typeof o.id !== 'string' || o.id === '') continue
    out.push({
      id: o.id,
      name: typeof o.name === 'string' && o.name !== '' ? o.name : '縦断',
      color: typeof o.color === 'string' ? o.color : undefined,
      points: Array.isArray(o.points) ? (o.points as ProfilePoint[]) : [],
    })
  }
  return out
}

function normalizeCrossSection(raw: unknown): StandardCrossSection {
  if (!raw || typeof raw !== 'object') return emptyStandardCrossSection()
  const r = raw as Partial<StandardCrossSection>
  return {
    right: Array.isArray(r.right) ? (r.right as CrossSectionElement[]) : [],
    left: Array.isArray(r.left) ? (r.left as CrossSectionElement[]) : [],
  }
}

function toRow(d: OpenChannelDb): OpenChannelRow {
  // 複数 DXF の 正規化: 新配列 が あれば それを 使う。 無い かつ 旧 scalar が あれば
  // 自動 マイグレート (1 件 だけ 詰めた 配列を 作る)。
  let dxfCrossSections: DxfCrossSectionFile[] = Array.isArray(d.dxf_cross_sections)
    ? d.dxf_cross_sections.filter(
        (x): x is DxfCrossSectionFile =>
          x != null && typeof x === 'object' && typeof x.id === 'string' &&
          typeof x.name === 'string' && typeof x.path === 'string',
      )
    : []
  if (dxfCrossSections.length === 0 && d.dxf_cross_section_path) {
    dxfCrossSections = [
      {
        id: 'legacy',
        name: d.dxf_cross_section_name ?? '横断図',
        path: d.dxf_cross_section_path,
      },
    ]
  }
  return {
    id: d.id,
    farmId: d.farm_id,
    name: d.name,
    kind: d.kind === 'grading' ? 'grading' : 'channel',
    gridLines: normalizeGridLines(d.grid_lines),
    standardCrossSection: normalizeCrossSection(d.standard_cross_section),
    alignmentPoints: Array.isArray(d.alignment_points) ? d.alignment_points : [],
    profilePoints: Array.isArray(d.profile_points) ? d.profile_points : [],
    extraProfiles: normalizeExtraProfiles(d.extra_profiles),
    standardSections: normalizeStandardSections(d.standard_sections),
    stations: Array.isArray(d.stations) ? d.stations : [],
    sideOrientation: d.side_orientation === 'reverse' ? 'reverse' : 'forward',
    spOffset: Number.isFinite(Number(d.sp_offset)) ? Number(d.sp_offset) : 0,
    widthStakes: Array.isArray(d.width_stakes) ? d.width_stakes : [],
    notes: d.notes,
    dxfCrossSections,
    dxfCrossSectionPath: d.dxf_cross_section_path ?? null,
    dxfCrossSectionName: d.dxf_cross_section_name ?? null,
  }
}

interface OpenChannelState {
  channels: OpenChannelRow[]
  loading: boolean
  error: string | null

  fetchChannels: (farmId: string) => Promise<void>
  addChannel: (
    farmId: string,
    name?: string,
    kind?: ChannelKind,
  ) => Promise<OpenChannelRow | null>
  updateChannel: (id: string, updates: Partial<Omit<OpenChannelRow, 'id' | 'farmId'>>) => Promise<void>
  deleteChannel: (id: string) => Promise<void>
}

export const useOpenChannelStore = create<OpenChannelState>()((set, get) => ({
  channels: [],
  loading: false,
  error: null,

  fetchChannels: async (farmId) => {
    set({ loading: true, error: null })
    try {
      const { data, error } = await supabase
        .from('open_channels')
        .select('*')
        .eq('farm_id', farmId)
        .order('name')
      if (error) throw error
      set({
        channels: ((data || []) as unknown as OpenChannelDb[]).map(toRow),
        loading: false,
      })
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : '線形物の取得に失敗' })
    }
  },

  addChannel: async (farmId, name, kind = 'channel') => {
    try {
      // 通し番号 は 同じ 種別 の 中 で 数える (線形物 3 と 整地 3 が 混ざら ない ように)
      const existing = get().channels.filter((c) => c.kind === kind).length
      const insert = {
        farm_id: farmId,
        name: name ?? `${kind === 'grading' ? '整地路線' : '線形物'} ${existing + 1}`,
        kind,
        grid_lines: defaultGridLines(),
        standard_cross_section: emptyStandardCrossSection(),
        standard_sections: [],
        alignment_points: [],
        profile_points: [],
        extra_profiles: [],
        stations: [],
        side_orientation: 'forward',
        sp_offset: 0,
        width_stakes: [],
        notes: null,
        dxf_cross_sections: [],
      }
      const { data, error } = await supabase
        .from('open_channels')
        .insert(insert as never)
        .select()
        .single()
      if (error) throw error
      const row = toRow(data as unknown as OpenChannelDb)
      set((s) => ({ channels: [...s.channels, row] }))
      return row
    } catch (e) {
      set({ error: e instanceof Error ? e.message : '線形物の追加に失敗' })
      return null
    }
  },

  updateChannel: async (id, updates) => {
    try {
      const dbUpdates: Record<string, unknown> = {}
      if (updates.name !== undefined) dbUpdates.name = updates.name
      if (updates.standardCrossSection !== undefined)
        dbUpdates.standard_cross_section = updates.standardCrossSection
      if (updates.standardSections !== undefined)
        dbUpdates.standard_sections = updates.standardSections
      if (updates.alignmentPoints !== undefined) dbUpdates.alignment_points = updates.alignmentPoints
      if (updates.profilePoints !== undefined) dbUpdates.profile_points = updates.profilePoints
      if (updates.extraProfiles !== undefined) dbUpdates.extra_profiles = updates.extraProfiles
      if (updates.stations !== undefined) dbUpdates.stations = updates.stations
      if (updates.sideOrientation !== undefined) dbUpdates.side_orientation = updates.sideOrientation
      if (updates.spOffset !== undefined) dbUpdates.sp_offset = updates.spOffset
      if (updates.widthStakes !== undefined) dbUpdates.width_stakes = updates.widthStakes
      if (updates.notes !== undefined) dbUpdates.notes = updates.notes
      if (updates.kind !== undefined) dbUpdates.kind = updates.kind
      if (updates.gridLines !== undefined) dbUpdates.grid_lines = updates.gridLines
      if (updates.dxfCrossSections !== undefined)
        dbUpdates.dxf_cross_sections = updates.dxfCrossSections
      if (updates.dxfCrossSectionPath !== undefined)
        dbUpdates.dxf_cross_section_path = updates.dxfCrossSectionPath
      if (updates.dxfCrossSectionName !== undefined)
        dbUpdates.dxf_cross_section_name = updates.dxfCrossSectionName
      // 楽観的更新
      set((s) => ({
        channels: s.channels.map((c) => (c.id === id ? { ...c, ...updates } : c)),
      }))
      const { error } = await supabase
        .from('open_channels')
        .update(dbUpdates as never)
        .eq('id', id)
      if (error) throw error
    } catch (e) {
      set({ error: e instanceof Error ? e.message : '線形物の更新に失敗' })
    }
  },

  deleteChannel: async (id) => {
    try {
      set((s) => ({ channels: s.channels.filter((c) => c.id !== id) }))
      const { error } = await supabase.from('open_channels').delete().eq('id', id)
      if (error) throw error
    } catch (e) {
      set({ error: e instanceof Error ? e.message : '線形物の削除に失敗' })
    }
  },
}))

/** 要素 1 区間の "外側 1m あたり何 m 上昇するか"（符号付き）。vertical 用ではない。 */
export function elementSlopePerMeter(e: CrossSectionElement): number {
  if (e.slopeUnit === 'percent') return e.slopeValue / 100
  if (e.slopeUnit === 'ratio') {
    if (Math.abs(e.slopeValue) < 1e-9) return 0
    return Math.sign(e.slopeValue) * (1 / Math.abs(e.slopeValue))
  }
  return 0 // vertical: 水平変化なし（dy は slopeValue を直接用いる）
}

/**
 * 要素 1 区間の (dx, dy) を返す。`sideSign=+1` で右側、`-1` で左側。
 *  - 'ratio' / 'percent': dx = sideSign * width, dy = width * slopeFactor
 *  - 'vertical'         : dx = 0, dy = slopeValue
 */
export function elementStep(
  e: CrossSectionElement,
  sideSign: 1 | -1,
): { dx: number; dy: number } {
  if (e.slopeUnit === 'vertical') return { dx: 0, dy: e.slopeValue }
  const slopeFactor = elementSlopePerMeter(e)
  return { dx: sideSign * e.width, dy: e.width * slopeFactor }
}

/** 標準断面を、中心 (0,0) を含む 2D 折れ線（左端 → 右端）に展開する。 */
export function buildCrossSectionPath(cs: StandardCrossSection): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = []
  // 左側：中心から外側へ展開し、配列を逆順にして先頭に置く
  let cx = 0
  let cy = 0
  const leftPoints: { x: number; y: number }[] = []
  for (const e of cs.left) {
    const { dx, dy } = elementStep(e, -1)
    cx += dx
    cy += dy
    leftPoints.push({ x: cx, y: cy })
  }
  out.push(...leftPoints.reverse())
  out.push({ x: 0, y: 0 })
  cx = 0
  cy = 0
  for (const e of cs.right) {
    const { dx, dy } = elementStep(e, 1)
    cx += dx
    cy += dy
    out.push({ x: cx, y: cy })
  }
  return out
}

/** 勾配を人間可読な文字列に整形。 */
export function formatSlope(e: CrossSectionElement): string {
  const trim = (n: number, d = 2) => n.toFixed(d).replace(/\.?0+$/, '')
  if (e.slopeUnit === 'vertical') {
    if (Math.abs(e.slopeValue) < 1e-9) return '直立0m'
    return e.slopeValue > 0 ? `↑${trim(e.slopeValue)}m` : `↓${trim(-e.slopeValue)}m`
  }
  if (e.slopeUnit === 'percent') {
    if (Math.abs(e.slopeValue) < 1e-9) return '0%'
    return `${e.slopeValue >= 0 ? '+' : ''}${trim(e.slopeValue)}%`
  }
  if (Math.abs(e.slopeValue) < 1e-9) return '水平'
  const sign = e.slopeValue < 0 ? '↓' : '↑'
  return `1:${trim(Math.abs(e.slopeValue))}${sign}`
}

/**
 * 断面 1 区間 の コンパクト 表記 を パース する。
 *
 * 各 区間 は 2 値 を カンマ 区切り で 記述:
 *   -2%,2.000       → 勾配 -2% と 水平距離 dW=2m
 *   +1.0,-1.0       → dW=+1m と dH=-1m (両方 距離指定、勾配 は 自動計算)
 *   1:1.5,H-5.0     → 勾配 1:1.5 と 垂直距離 dH=-5m (H 接頭辞 で dH 指定)
 *   -1:1.5,2.000    → 勾配 1:1.5 下向き と 水平距離 2m
 *   0,H1.5          → 直立 上向き 1.5m (dW=0)
 *
 * 各 トークン の 判別:
 *   - `%` で 終わる      → 勾配 (%)
 *   - `1:...` を 含む   → 勾配 (1:i、符号 は 上下)
 *   - `H` / `h` 接頭辞 → 垂直距離 dH (符号付き)
 *   - それ以外         → 水平距離 dW (符号付き)
 *
 * 戻り値 は CrossSectionElement の (width, slopeValue, slopeUnit) 部分。
 */
export function parseSegmentNotation(
  text: string,
): Pick<CrossSectionElement, 'width' | 'slopeValue' | 'slopeUnit'> | null {
  const parts = text.split(',').map((s) => s.trim()).filter(Boolean)
  if (parts.length !== 2) return null

  type Token =
    | { kind: 'percent'; value: number }
    | { kind: 'ratio'; value: number }
    | { kind: 'dW'; value: number }
    | { kind: 'dH'; value: number }

  const parseToken = (s: string): Token | null => {
    const ratioMatch = s.match(/^([+-]?)1:([+-]?\d+(?:\.\d+)?)$/)
    if (ratioMatch) {
      const sign = ratioMatch[1] === '-' ? -1 : 1
      const v = parseFloat(ratioMatch[2])
      if (!Number.isFinite(v) || Math.abs(v) < 1e-9) return null
      return { kind: 'ratio', value: sign * Math.abs(v) }
    }
    const pctMatch = s.match(/^([+-]?\d+(?:\.\d+)?)%$/)
    if (pctMatch) {
      const v = parseFloat(pctMatch[1])
      if (!Number.isFinite(v)) return null
      return { kind: 'percent', value: v }
    }
    const dhMatch = s.match(/^[Hh]([+-]?\d+(?:\.\d+)?)$/)
    if (dhMatch) {
      const v = parseFloat(dhMatch[1])
      if (!Number.isFinite(v)) return null
      return { kind: 'dH', value: v }
    }
    const dwMatch = s.match(/^([+-]?\d+(?:\.\d+)?)$/)
    if (dwMatch) {
      const v = parseFloat(dwMatch[1])
      if (!Number.isFinite(v)) return null
      return { kind: 'dW', value: v }
    }
    return null
  }

  const t1 = parseToken(parts[0])
  const t2 = parseToken(parts[1])
  if (!t1 || !t2) return null

  const distTok =
    t1.kind === 'dW' || t1.kind === 'dH'
      ? t1
      : t2.kind === 'dW' || t2.kind === 'dH'
      ? t2
      : null
  const slopeTok =
    t1.kind === 'percent' || t1.kind === 'ratio'
      ? t1
      : t2.kind === 'percent' || t2.kind === 'ratio'
      ? t2
      : null

  // (距離 + 勾配) の 組合せ
  if (distTok && slopeTok) {
    if (distTok.kind === 'dW') {
      const width = Math.abs(distTok.value)
      if (slopeTok.kind === 'percent') {
        return { width, slopeValue: slopeTok.value, slopeUnit: 'percent' }
      }
      return { width, slopeValue: slopeTok.value, slopeUnit: 'ratio' }
    }
    // dH + 勾配 → 幅 を 逆算
    const dh = distTok.value
    if (Math.abs(dh) < 1e-9) {
      // dH=0 なら 幅 0 の 水平点 (無意味)
      return { width: 0, slopeValue: 0, slopeUnit: slopeTok.kind }
    }
    if (slopeTok.kind === 'percent') {
      const factor = slopeTok.value / 100
      if (Math.abs(factor) < 1e-9) return null
      const width = Math.abs(dh / factor)
      // 勾配 の 符号 は dH に 合わせる (下り なら 負)
      const signedSlope = Math.sign(dh) * Math.abs(slopeTok.value)
      return { width, slopeValue: signedSlope, slopeUnit: 'percent' }
    }
    // ratio: dH = width * sign / |i| → width = |dH * i|
    const i = Math.abs(slopeTok.value)
    const width = Math.abs(dh * i)
    const signedSlope = Math.sign(dh) * i
    return { width, slopeValue: signedSlope, slopeUnit: 'ratio' }
  }

  // (dW + dH) の 組合せ → 勾配 % を 算出
  const dwTok = t1.kind === 'dW' ? t1 : t2.kind === 'dW' ? t2 : null
  const dhTok = t1.kind === 'dH' ? t1 : t2.kind === 'dH' ? t2 : null
  if (dwTok && dhTok) {
    const dw = dwTok.value
    const dh = dhTok.value
    const width = Math.abs(dw)
    if (width < 1e-9) {
      return { width: 0, slopeValue: dh, slopeUnit: 'vertical' }
    }
    const pct = (dh / width) * 100
    return { width, slopeValue: pct, slopeUnit: 'percent' }
  }

  // (勾配 + 勾配) は 不定
  return null
}

/**
 * CrossSectionElement を コンパクト 表記 (parseSegmentNotation の 逆) に 整形。
 */
export function formatSegmentNotation(e: CrossSectionElement): string {
  const trim = (n: number, d = 3) => {
    const s = n.toFixed(d)
    return s.includes('.') ? s.replace(/\.?0+$/, '') : s
  }
  if (e.slopeUnit === 'vertical') {
    const sign = e.slopeValue >= 0 ? '+' : ''
    return `0,H${sign}${trim(e.slopeValue)}`
  }
  if (e.slopeUnit === 'percent') {
    const sign = e.slopeValue >= 0 ? '+' : ''
    return `${sign}${trim(e.slopeValue, 2)}%,${trim(e.width)}`
  }
  // ratio
  const sign = e.slopeValue < 0 ? '-' : ''
  return `${sign}1:${trim(Math.abs(e.slopeValue), 2)},${trim(e.width)}`
}
