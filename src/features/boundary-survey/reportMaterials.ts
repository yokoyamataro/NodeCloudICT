// 05 資料調査 の 資料一覧。
// フォーム UI (ReportSectionMaterials) と Excel 出力 (landReportExport) で共有する。

export interface MaterialItem {
  /** body.materials の キー */
  key: string
  /** 表示ラベル */
  label: string
  /** テンプレのトークン名。実際には {{M.<token>}} として出力される */
  token: string
  /** true のとき 追加の文字列入力欄あり (証言者名など) */
  hasText?: boolean
  /** テキスト値の body.materials キー */
  textKey?: string
  /** テンプレのテキストトークン名 */
  textToken?: string
  textPlaceholder?: string
}

export interface MaterialGroup {
  label: string
  items: MaterialItem[]
}

export const MATERIAL_GROUPS: MaterialGroup[] = [
  {
    label: '登記記録・図面等',
    items: [
      { key: 'land_reg',        token: 'LAND_REG',        label: '土地登記記録' },
      { key: 'land_closed',     token: 'LAND_CLOSED',     label: '土地閉鎖登記記録・閉鎖登記簿' },
      { key: 'bldg_reg',        token: 'BLDG_REG',        label: '建物登記記録' },
      { key: 'bldg_closed',     token: 'BLDG_CLOSED',     label: '建物閉鎖登記記録・閉鎖登記簿' },
      { key: 'map',             token: 'MAP',             label: '地図' },
      { key: 'map_alt',         token: 'MAP_ALT',         label: '地図に準ずる図面' },
      { key: 'map_closed',      token: 'MAP_CLOSED',      label: '閉鎖地図及び閉鎖地図に準ずる図面' },
      { key: 'survey_map',      token: 'SURVEY_MAP',      label: '地積測量図・土地所在図' },
      { key: 'boundary_spec',   token: 'BOUNDARY_SPEC',   label: '筆界特定関係資料等' },
      { key: 'old_ledger',      token: 'OLD_LEDGER',      label: '旧土地台帳' },
      { key: 'old_ledger_map',  token: 'OLD_LEDGER_MAP',  label: '旧土地台帳附属地図（和紙公図）' },
      { key: 'reg_ctrl_point',  token: 'REG_CTRL_POINT',  label: '基準点成果' },
      { key: 'reg_other_1',     token: 'REG_OTHER_1',     label: 'その他 (1)' },
      { key: 'reg_other_2',     token: 'REG_OTHER_2',     label: 'その他 (2)' },
    ],
  },
  {
    label: '役所調査',
    items: [
      { key: 'ledger_app',      token: 'LEDGER_APP',      label: '台帳申告書写し' },
      { key: 'cadastral',       token: 'CADASTRAL',       label: '地籍図等' },
      { key: 'national_survey', token: 'NATIONAL_SURVEY', label: '国土調査等関係資料' },
      { key: 'road_ledger',     token: 'ROAD_LEDGER',     label: '道路台帳' },
      { key: 'road_map',        token: 'ROAD_MAP',        label: '道路台帳附属地図' },
      { key: 'road_boundary',   token: 'ROAD_BOUNDARY',   label: '道路境界確定図等' },
      { key: 'pub_agree',       token: 'PUB_AGREE',       label: '法定外公共物確定協議書等' },
      { key: 'pub_sell',        token: 'PUB_SELL',        label: '公共用地払下げ図面等' },
      { key: 'river_boundary',  token: 'RIVER_BOUNDARY',  label: '河川法の適用河川境界承認図等' },
      { key: 'land_exchange',   token: 'LAND_EXCHANGE',   label: '換地確定図' },
      { key: 'war_recovery',    token: 'WAR_RECOVERY',    label: '戦災復興区画整理図' },
      { key: 'aerial',          token: 'AERIAL',          label: '空中写真' },
      { key: 'agri_permit',     token: 'AGRI_PERMIT',     label: '農業委員会の許可書等' },
      { key: 'gov_ctrl_point',  token: 'GOV_CTRL_POINT',  label: '基準点成果' },
      { key: 'gov_other_1',     token: 'GOV_OTHER_1',     label: 'その他 (1)' },
      { key: 'gov_other_2',     token: 'GOV_OTHER_2',     label: 'その他 (2)' },
    ],
  },
  {
    label: '現地調査',
    items: [
      { key: 'terrain',   token: 'TERRAIN',   label: '地形地物：段差・石垣・のり地・崖・沢・道路・水路・尾根・谷・その他' },
      { key: 'structure', token: 'STRUCTURE', label: '工作物：境界標識・土留め・ブロック塀・コンクリート擁壁・その他' },
    ],
  },
  {
    label: 'その他の資料',
    items: [
      { key: 'boundary_confirm', token: 'BOUNDARY_CONFIRM', label: '筆界確認書, 立会証明書等' },
      { key: 'sale_map',         token: 'SALE_MAP',         label: '売渡図面' },
      { key: 'consent',          token: 'CONSENT',          label: '承諾書' },
      {
        key: 'testimony',
        token: 'TESTIMONY',
        label: '証言',
        hasText: true,
        textKey: 'testimony_name',
        textToken: 'TESTIMONY_NAME',
        textPlaceholder: '証言者',
      },
      { key: 'misc_other', token: 'MISC_OTHER', label: 'その他' },
    ],
  },
]

/** 補足メモ用 (自由記述) の キー / トークン */
export const MATERIALS_NOTES_KEY = '_notes'
export const MATERIALS_NOTES_TOKEN = 'NOTES'
