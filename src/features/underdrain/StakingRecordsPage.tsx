import { useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, Trash2, Download, RefreshCw, Link as LinkIcon, X, Settings2 } from 'lucide-react'
import { Marker, Polyline, Tooltip, useMap } from 'react-leaflet'
import L from 'leaflet'
import { useFarmStore } from '@/stores/farmStore'
import { useStakingStore, type StakingRecord } from '@/stores/stakingStore'
import { useCoordinateStore, type CoordinateRow } from '@/stores/coordinateStore'
import { useProjectListStore } from '@/stores/projectListStore'
import { CoordinateMap } from '@/components/map/CoordinateMap'
import { ResizableSplit } from '@/components/layout/ResizableSplit'
import { CoordinateConverter, COORDINATE_TYPE_NAMES, type CoordinateType } from '@/lib/coordinates'
import { setLabel, useSurveySetStore } from '@/stores/surveySetStore'
import {
  deriveRow,
  flattenStakingRecords,
  groupStakingRecords,
  type StakingGroup,
} from '@/lib/stakingGroups'

// SurveyRecordSetsPanel は 全 セッション 一覧 用 だった が、詳細モーダル は
// 現在 セッション 1 件 のみ を 直接 表示 する 方針 に 変更したため 使わない。

// 実測点 用 の 円形 divIcon を 生成。 Marker (HTML) として markerPane に
// 描画 する ので、SVG の CircleMarker と 違って クリック 受け取り が 安定。
// state (通常 / 選択中 / pending-m1) を 色 と サイズ で 表現。
function createMeasuredIcon(opts: {
  fill: string
  isSelected: boolean
  isPending: boolean
}): L.DivIcon {
  const size = opts.isPending ? 20 : opts.isSelected ? 16 : 12
  const borderWidth = opts.isPending ? 3 : opts.isSelected ? 3 : 2
  const borderColor = opts.isPending ? '#a855f7' : opts.isSelected ? '#1d4ed8' : '#fff'
  return L.divIcon({
    className: 'staking-measured-marker',
    html: `<div style="
      width: ${size}px;
      height: ${size}px;
      border-radius: 50%;
      background: ${opts.fill};
      border: ${borderWidth}px solid ${borderColor};
      box-shadow: 0 2px 4px rgba(0,0,0,0.3);
      cursor: pointer;
    "></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  })
}

// 表 の 列 セクション 定義。 折りたたみ (hidden) / Z 表示 制御 は これ を 参照。
// slidedD / revSlideM は dx/dy/dz スライド 補正 廃止 に 伴い 削除。
type SectionKey =
  | 'design'
  | 'm1'
  | 'm2'
  | 'diff'
  | 'avg'
  | 'dvs'
const TABLE_SECTIONS: Array<{
  key: SectionKey
  label: string
  headerTitle: string
  bgHeader: string
  bgSub: string
  cols: Array<{ label: string; align: 'left' | 'right'; isZ?: boolean; hasHorizontal?: boolean }>
}> = [
  {
    key: 'm1',
    label: '実測',
    headerTitle: '観測値 (点名 / X / Y / Z)',
    bgHeader: 'bg-orange-50',
    bgSub: 'bg-orange-50',
    cols: [
      { label: '点名', align: 'left' },
      { label: 'X', align: 'right' },
      { label: 'Y', align: 'right' },
      { label: 'Z', align: 'right', isZ: true },
    ],
  },
  // 当初 (design) / 実測2 / 差 / 平均 / スライド 系 は 座標精度管理表 側 で 扱う。
  // 実測記録 は 素直 な 観測ログ (手簿 / 記簿) の みで 表示 する。
]

// 座標管理 の 点種 色 (CoordinateMap の MARKER_COLORS と 合わせる)。
const TYPE_COLORS: Record<string, string> = {
  control: '#ef4444',
  boundary: '#3b82f6',
  current: '#14b8a6',
  underdrain: '#22c55e',
  soil_import: '#f59e0b',
  stake: '#22c55e',
  map_xml: '#a855f7',
  national_survey: '#d97706',
  cadastral_diagram: '#0891b2',
  witness: '#eab308',
  confirmed_boundary: '#16a34a',
  measured: '#ec4899',
}

// 選択された 記録 の 位置 に 地図 を pan/zoom する 子コンポーネント。
// CoordinateMap の children として 差し込む と useMap で 中の Leaflet Map を 取得できる。
function RecordZoomController({
  target,
}: {
  target: { lat: number; lng: number; tick: number } | null
}) {
  const map = useMap()
  const lastTickRef = useRef<number>(-1)
  useEffect(() => {
    if (!target) return
    if (target.tick === lastTickRef.current) return
    lastTickRef.current = target.tick
    const nextZoom = Math.max(map.getZoom(), 19)
    map.flyTo([target.lat, target.lng], nextZoom, { duration: 0.6 })
  }, [target, map])
  return null
}

// 実測記録を一覧表示し、SIMA/CSV で出力するページ。
// 工区横断のトップレベル経路 /staking-records に紐付け。
// 起工測量/出来形測量 の 区分 は 撤去 のため CATEGORY_LABEL は 削除。

export function StakingRecordsPage() {
  const { currentFarm } = useFarmStore()
  const {
    records,
    loading,
    error,
    fetchRecords,
    deleteRecord,
    updateRecordTarget,
    pairRecords,
    unpairRecord,
    updateRecordName,
  } = useStakingStore()
  const { coordinates, fetchCoordinates } = useCoordinateStore()
  const { projects, members, fetchMembers } = useProjectListStore()
  // プロジェクト メンバー を 引いて uid → 表示名 / メール の 辞書 を 作る。
  useEffect(() => {
    const pid = currentFarm?.project_id
    if (pid) void fetchMembers(pid)
  }, [currentFarm?.project_id, fetchMembers])
  const memberNameById = useMemo(() => {
    const m = new Map<string, string>()
    for (const mb of members) {
      const name = (mb.display_name && mb.display_name.trim()) || mb.email || mb.user_id
      m.set(mb.user_id, name)
    }
    return m
  }, [members])
  // 起工/出来形 の カテゴリ 絞込 は 撤去。

  // 設計座標 の 事後リンク 対象 の 記録 ID。 セット されている 間は 地図クリック
  // で 選んだ 座標 を その 記録 に 割り付ける。
  const [pendingLinkRecordId, setPendingLinkRecordId] = useState<string | null>(null)

  // 「別の 実測点 を 実測2 として 割り付ける」モード。 保持する のは m1 の
  // 記録 ID。 m1 が 設計座標 リンク済み なら updateRecordTarget で 同じ
  // targetRefId に 移動、free なら pairRecords で 対称ペアリング する。
  const [pendingLinkM2ForM1Id, setPendingLinkM2ForM1Id] = useState<string | null>(null)
  // React-leaflet の eventHandlers が 古い クロージャ を 掴んで しまう ケース に
  // 備えて、常に 最新値 を 参照 できる ref も 用意 する。
  const pendingLinkM2ForM1IdRef = useRef<string | null>(null)
  useEffect(() => {
    pendingLinkM2ForM1IdRef.current = pendingLinkM2ForM1Id
  }, [pendingLinkM2ForM1Id])

  // 行 選択 (ハイライト + 地図 ズーム)。 tick は 同じ 行 を 連打 した 時 でも
  // 再ズーム できる ように 単調増加 させる。
  const [selectedRecordId, setSelectedRecordId] = useState<string | null>(null)
  const [zoomTick, setZoomTick] = useState<number>(0)

  // 地図に 表示する 点種 の フィルタ (座標管理 の visibleTypes と 同じ 概念)。
  // null = 未初期化 (初回 に availableTypes で 全 ON 初期化)。
  const [visibleTypesState, setVisibleTypesState] = useState<Set<string> | null>(null)

  // 表 の 列 表示 制御。 セクション 単位 で 折りたたみ + Z 列 全体 を まとめて 非表示。
  const [hiddenSections] = useState<Set<string>>(new Set())
  // Z 列 は 常 に 表示 (「Z 列 を 表示」 チェック は 撤去)
  const showZ = true

  // 座標管理 に 登録 する 行 の 選択 (グループ.key 単位)
  const [selectedGroupKeys, setSelectedGroupKeys] = useState<Set<string>>(new Set())
  // TABLE_SECTIONS に 存在 しない キー (m2 / diff / avg / dvs) は 常に 非表示 扱い。
  // これら の 表示 は 座標精度管理表 側 で 行う。 スライド系 (slidedD / revSlideM) は
  // dx/dy/dz スライド 補正 廃止 に 伴い 削除 済み。
  const VALID_SECTION_KEYS = useMemo(
    () => new Set(TABLE_SECTIONS.map((s) => s.key as string)),
    [],
  )
  const isHidden = (key: string) =>
    !VALID_SECTION_KEYS.has(key) || hiddenSections.has(key)

  useEffect(() => {
    if (currentFarm) {
      fetchRecords(currentFarm.id)
      fetchCoordinates(currentFarm.id)
    }
  }, [currentFarm, fetchRecords, fetchCoordinates])

  // 座標系: プロジェクト の 平面直角 系。 実測 XY → lat/lng 変換 に 使用。
  const zone = useMemo(() => {
    if (!currentFarm) return 13
    return projects.find((p) => p.id === currentFarm.project_id)?.coordinate_zone ?? 13
  }, [currentFarm, projects])
  const converter = useMemo(() => new CoordinateConverter(zone), [zone])

  // 実測点 (measuredX/Y) を lat/lng に 変換 して 地図に 表示 する ため の 集合。
  const measuredPointsForMap = useMemo(() => {
    return records
      .map((r) => {
        const ll = converter.toLatLng(r.measuredX, r.measuredY)
        if (!Number.isFinite(ll.lat) || !Number.isFinite(ll.lng)) return null
        return {
          id: r.id,
          lat: ll.lat,
          lng: ll.lng,
          record: r,
        }
      })
      .filter((x): x is { id: string; lat: number; lng: number; record: typeof records[number] } => x !== null)
  }, [records, converter])

  // 既に 設計座標 に リンク 済み の 座標 ID 集合 (checkedCoordIds で 強調表示)。
  const linkedCoordIds = useMemo(() => {
    const s = new Set<string>()
    for (const r of records) {
      if (r.targetType === 'coordinate' && r.targetRefId) s.add(r.targetRefId)
    }
    return s
  }, [records])

  // 工区内 に 存在する 点種 の 一覧 (フィルタ UI 用)。
  const availableTypes = useMemo(() => {
    const s = new Set<string>()
    for (const c of coordinates) s.add(c.type)
    return Array.from(s).sort()
  }, [coordinates])

  // 初回 に visibleTypesState を 全 ON で 初期化。 その後 は ユーザー 操作 に 委ねる。
  useEffect(() => {
    if (visibleTypesState === null && availableTypes.length > 0) {
      setVisibleTypesState(new Set(availableTypes))
    }
  }, [visibleTypesState, availableTypes])

  const effectiveVisibleTypes = visibleTypesState ?? undefined
  const toggleTypeVisibility = (type: string) => {
    setVisibleTypesState((prev) => {
      const cur = prev ?? new Set(availableTypes)
      const next = new Set(cur)
      if (next.has(type)) next.delete(type)
      else next.add(type)
      return next
    })
  }

  // 選択中 の 行 の 地図ズーム ターゲット (lat/lng + tick)。 tick を 変えて
  // useEffect を 再発火 させる こと で 同じ 行 を 連打 しても 再ズームできる。
  const zoomTarget = useMemo(() => {
    if (!selectedRecordId) return null
    const rec = records.find((r) => r.id === selectedRecordId)
    if (!rec) return null
    const ll = converter.toLatLng(rec.measuredX, rec.measuredY)
    if (!Number.isFinite(ll.lat) || !Number.isFinite(ll.lng)) return null
    return { lat: ll.lat, lng: ll.lng, tick: zoomTick }
  }, [selectedRecordId, records, converter, zoomTick])

  // 行 クリック で 選択 + ズーム 発火 (連打 対応 の tick インクリメント)。
  const handleRowClick = (recordId: string) => {
    setSelectedRecordId(recordId)
    setZoomTick((t) => t + 1)
  }

  // 「実測2 として 割り付け」モード の 起点 と キャンセル。 排他制御 の ため
  // 他モード は 同時に クリア する。
  const handleStartLinkM2 = (m1Id: string) => {
    setPendingLinkM2ForM1Id(m1Id)
    setPendingLinkRecordId(null)
  }
  const handleCancelLinkM2 = () => setPendingLinkM2ForM1Id(null)

  // 実測マーカー クリック は 単純 に 行選択 + ズーム のみ。
  // 実測2 の 割り付け は 「同じ 位置 を 何度 も 測る」 性質上 マーカー が
  // ほぼ 重なる ため、地図クリック で は 選び分け が 不可能。 代わりに
  // 🔗 ボタン → モーダル で 5cm 以内 の 候補 リスト から 選ぶ 方式 に する。
  const handleMeasuredMarkerClick = (recordId: string) => {
    handleRowClick(recordId)
  }

  // 実測1 の 記録 (XY) に 対して 半径 5cm 以内 の 他 の 実測点 を 候補 として
  // 列挙 (実測2 リンク 用)。 pendingLinkM2ForM1Id が セット されて いる 間 だけ
  // 計算。 既 に m1 と 同じ グループ の m2 は 除外 する 必要 は ない
  // (通常 は m2 未確定 の 状態 で 開かれる ため 候補 に は 現れ ない)。
  const M2_CANDIDATE_RADIUS = 0.05 // m (5cm)
  interface M2Candidate {
    record: StakingRecord
    distance: number
  }
  const m2Candidates = useMemo<M2Candidate[]>(() => {
    if (!pendingLinkM2ForM1Id) return []
    const m1 = records.find((r) => r.id === pendingLinkM2ForM1Id)
    if (!m1) return []
    const out: M2Candidate[] = []
    for (const r of records) {
      if (r.id === m1.id) continue
      const dx = r.measuredX - m1.measuredX
      const dy = r.measuredY - m1.measuredY
      const d = Math.hypot(dx, dy)
      if (d > M2_CANDIDATE_RADIUS) continue
      out.push({ record: r, distance: d })
    }
    out.sort((a, b) => a.distance - b.distance)
    return out
  }, [pendingLinkM2ForM1Id, records])

  // 設計座標 リンク の 候補 (半径 2m 以内)。 pendingLinkRecordId が セット
  // されて いる 間 だけ 計算。 「実測2 以外」= 実測 記録 に 由来 する 点
  // (measured 種別) は 除外 し、設計 由来 の 座標 のみ を 対象 と する。
  const DESIGN_CANDIDATE_RADIUS = 2.0 // m
  interface DesignCandidate {
    coord: CoordinateRow
    distance: number
  }
  const designCandidates = useMemo<DesignCandidate[]>(() => {
    if (!pendingLinkRecordId) return []
    const rec = records.find((r) => r.id === pendingLinkRecordId)
    if (!rec) return []
    const out: DesignCandidate[] = []
    for (const c of coordinates) {
      // 実測 記録 由来 の 座標 (type=measured) は 除外 (=「実測2 以外」)
      if (c.type === 'measured') continue
      const dx = c.x - rec.measuredX
      const dy = c.y - rec.measuredY
      const d = Math.hypot(dx, dy)
      if (d > DESIGN_CANDIDATE_RADIUS) continue
      out.push({ coord: c, distance: d })
    }
    out.sort((a, b) => a.distance - b.distance)
    return out
  }, [pendingLinkRecordId, records, coordinates])

  // 候補 の 中 から 1 件 を 選んで 実測2 に 割り付ける。
  const handlePickM2Candidate = (candidateId: string) => {
    const pending = pendingLinkM2ForM1IdRef.current
    if (!pending) return
    const m1 = records.find((r) => r.id === pending)
    if (!m1) {
      setPendingLinkM2ForM1Id(null)
      return
    }
    if (m1.targetType === 'coordinate' && m1.targetRefId) {
      const coord = coordinates.find((c) => c.id === m1.targetRefId)
      if (coord) {
        void updateRecordTarget(candidateId, {
          id: coord.id,
          pointNumber: coord.pointNumber,
          x: coord.x,
          y: coord.y,
          z: coord.z,
        })
      }
    } else {
      void pairRecords(m1.id, candidateId)
    }
    setPendingLinkM2ForM1Id(null)
  }

  // 地図で 座標 が クリック された とき: 設定モード なら 記録に リンク、
  // それ以外 は 何もしない。
  const handleCoordSelectOnMap = (coordId: string) => {
    if (!pendingLinkRecordId) return
    const coord = coordinates.find((c) => c.id === coordId)
    if (!coord) return
    void updateRecordTarget(pendingLinkRecordId, {
      id: coord.id,
      pointNumber: coord.pointNumber,
      x: coord.x,
      y: coord.y,
      z: coord.z,
    })
    setPendingLinkRecordId(null)
  }

  // X/Y/Z 補正値 (実測値に加算)。工区ごとに DB (design_survey_calibration) に
  // 永続化して PC / スマホ間 で 共有 する。 Z 補正 は 従来 localStorage の
  // 記録セット。 dx/dy/dz スライド 補正 は 廃止 のため、 スライド量 の 読み書き は しない。
  const sets = useSurveySetStore((st) => st.sets)
  const fetchSets = useSurveySetStore((st) => st.fetchByFarm)
  const updateSet = useSurveySetStore((st) => st.updateSet)
  const deleteSet = useSurveySetStore((st) => st.deleteSet)
  useEffect(() => {
    if (currentFarm) void fetchSets(currentFarm.id)
  }, [currentFarm, fetchSets])

  /**
   * 見て いる 記録セット。 'all' は 全部、'none' は 未振り分け、
   * それ以外 は セット の id。 セット を 分けた 以上、既定 は 1 つ ずつ 見る 方 が
   * 分かり やすい ので、既定 の セット を 初期選択 に する。
   */
  // PC からの セッション追加 は 廃止。 作成 は スマホ 側 (測定時) に 一元化。
  /** セッション 詳細 (名前 / 日付 / 担当者 / 基準局 / スライド量) の モーダル 表示 */
  const [sessionDetailOpen, setSessionDetailOpen] = useState(false)

  const [setTab, setSetTab] = useState<string>('all')
  const setTabFarmRef = useRef<string | null>(null)
  // 工区 の 記録 の 中 で 「直近 の 記録」 が 属する セット を 選ぶ ため の ヘルパ。
  // 記録 が まだ 無い / 未振り分け しか 無い ときは null。
  const pickMostRecentSetId = (): string | null => {
    const farmId = currentFarm?.id ?? null
    if (!farmId) return null
    let bestSet: string | null = null
    let bestAt = ''
    for (const r of records) {
      if (r.farmId !== farmId) continue
      if (!r.recordSetId) continue
      if (r.recordedAt > bestAt) {
        bestAt = r.recordedAt
        bestSet = r.recordSetId
      }
    }
    return bestSet
  }
  useEffect(() => {
    const farmId = currentFarm?.id ?? null
    const farmChanged = setTabFarmRef.current !== farmId
    setTabFarmRef.current = farmId
    if (farmChanged) {
      // 工区 を 変えた とき / 初回:
      //   1) 直近 の 記録 が 属する セット を 優先 (ユーザー が 直前 に 使って いた 場)
      //   2) 既定 セット、 3) 先頭 の セット、 4) 未振り分け 'none'
      const recent = pickMostRecentSetId()
      if (recent) {
        setSetTab(recent)
        return
      }
      const def = sets.find((x) => x.isDefault) ?? sets[0]
      setSetTab(def ? def.id : 'none')
      return
    }
    // セット が 消えた ときだけ 寄せ 直す (選択中 の タブ は 保つ)
    setSetTab((prev) => {
      if (prev === 'none' || sets.some((x) => x.id === prev)) return prev
      const recent = pickMostRecentSetId()
      if (recent) return recent
      const def = sets.find((x) => x.isDefault) ?? sets[0]
      return def ? def.id : 'none'
    })
    // 記録 の 到着 は 別 の 依存 で 走る の で ここ で は 無視 (records)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentFarm?.id, sets])

  // records が 後 から 届いた 場合、初回 の 「直近 セット」 選択 を もう 1 回 試す
  const initialRecentPickedRef = useRef(false)
  useEffect(() => {
    if (initialRecentPickedRef.current) return
    if (!currentFarm?.id) return
    const recent = pickMostRecentSetId()
    if (recent) {
      setSetTab(recent)
      initialRecentPickedRef.current = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentFarm?.id, records, sets])

  // 工区 が 変わった タイミング で 初回選択 フラグ を リセット
  useEffect(() => {
    initialRecentPickedRef.current = false
  }, [currentFarm?.id])

  /** セッション 詳細 の 表示対象 (タブ で 選ばれた セット)。 */
  const slideTargetSet = setTab === 'none' ? null : (sets.find((x) => x.id === setTab) ?? null)

  const filtered = useMemo(() => {
    // 起工/出来形 の 区分 は 撤去 のため カテゴリ 絞込 は しない
    return setTab === 'none'
      ? records.filter((r) => !r.recordSetId)
      : records.filter((r) => r.recordSetId === setTab)
  }, [records, setTab])

  // dx/dy/dz スライド 補正 は 廃止 のため、 記録 に 効く スライド量 は 常 に 0。
  const slideOfRecord = (_r: StakingRecord | null) => ({ dx: 0, dy: 0, dz: 0 })

  /** この 工区 の 記録 の 数 (タブ の 「すべて」) */

  /** セット ごと の 記録 の 数 (null = 未振り分け) */
  const countBySet = useMemo(() => {
    const m = new Map<string | null, number>()
    for (const r of records) {
      if (r.farmId !== currentFarm?.id) continue
      const k = r.recordSetId ?? null
      m.set(k, (m.get(k) ?? 0) + 1)
    }
    return m
  }, [records, currentFarm?.id])

  // 実測記録 は 素直 な 手簿 / 記簿 形式 (1 記録 = 1 行) で 表示。
  // 差分 / 平均 の 表示 は サブメニュー の 「座標精度管理表」 で 行う。
  const grouped = useMemo<StakingGroup[]>(() => flattenStakingRecords(filtered), [filtered])
  // groupStakingRecords は 今後 精度管理表 で 使う 予定 (import の 保持 の ため 参照)
  void groupStakingRecords

  // 合計 / 測設 / フリー / 平均 dX/dY / RMS の 簡易サマリ 表示 は 撤去。

  const handleDelete = async (id: string, name: string | null) => {
    if (!confirm(`記録「${name ?? '(無題)'}」を削除しますか？`)) return
    await deleteRecord(id)
  }


  // CSV 出力（実測値ベース。 dx/dy/dz スライド 補正 は 廃止 のため 「逆スライド」列 も 削除）
  const handleExportCSV = () => {
    if (filtered.length === 0) return
    const header =
      '点名,X(実測),Y(実測),Z(実測),X(計画),Y(計画),Z(計画),精度(m),サンプル数,測定日時,測定者\n'
    const rows = filtered
      .map((r) =>
        [
          r.targetName ?? '',
          r.measuredX.toFixed(3),
          r.measuredY.toFixed(3),
          r.measuredZ != null ? r.measuredZ.toFixed(3) : '',
          r.targetX != null ? r.targetX.toFixed(3) : '',
          r.targetY != null ? r.targetY.toFixed(3) : '',
          r.targetZ != null ? r.targetZ.toFixed(3) : '',
          r.accuracy != null ? r.accuracy.toFixed(3) : '',
          r.sampleCount ?? '',
          r.recordedAt,
          r.recordedBy ? memberNameById.get(r.recordedBy) ?? '' : '',
        ].join(','),
      )
      .join('\n')
    const blob = new Blob([header + rows], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    const farmName = currentFarm?.name ?? 'farm'
    a.href = url
    a.download = `${farmName}_staking_records.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  /**
   * 表 を その まま Excel に 出す。
   *
   * 画面 で 折りたたんで いる 区分 と Z 列 の ON/OFF を そのまま 反映 する
   * (「見えて いる 表 が 出る」 ように する)。 座標 は 数値 の まま 入れて
   * 表示書式 を 0.000 に する ので、Excel 側 で 再計算 に 使える。
   */
  const handleExportExcel = async () => {
    if (grouped.length === 0) return
    const ExcelJS = (await import('exceljs')).default
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('実測記録')

    // 画面と 同じ 並び で 列 を 組む
    type Col = { group: string; label: string; num: boolean }
    const cols: Col[] = [{ group: '', label: '種別', num: false }]
    for (const sec of TABLE_SECTIONS) {
      if (isHidden(sec.key)) continue
      for (const c of sec.cols) {
        if (c.isZ && !showZ) continue
        cols.push({ group: sec.label, label: c.label, num: c.align === 'right' })
      }
    }
    cols.push({ group: '', label: '精度(m)', num: true })
    cols.push({ group: '', label: '測定日時', num: false })
    cols.push({ group: '', label: '測定者', num: false })

    // 1 行目 = 区分 (同じ 区分 は 結合)、2 行目 = 列名
    ws.addRow(cols.map((c) => c.group))
    ws.addRow(cols.map((c) => c.label))
    let start = 1
    while (start <= cols.length) {
      const g = cols[start - 1].group
      let end = start
      while (end < cols.length && cols[end].group === g) end += 1
      if (g === '') {
        // 区分 の 無い 列 は 2 行 ぶん 結合
        ws.mergeCells(1, start, 2, start)
      } else if (end > start) {
        ws.mergeCells(1, start, 1, end)
      }
      start = end + 1
    }
    for (const r of [1, 2]) {
      const row = ws.getRow(r)
      row.font = { bold: true }
      row.alignment = { horizontal: 'center', vertical: 'middle' }
    }

    for (const g of grouped) {
      const sl = slideOfRecord(g.m1 ?? g.m2)
      const d = deriveRow(g, sl.dx, sl.dy, sl.dz)
      const m1 = g.m1
      const m2 = g.m2
      const designName =
        g.targetType === 'coordinate' && g.designName
          ? g.designName.replace(/^G2?_/, '')
          : m1?.targetName ?? '(無題)'
      const kind =
        g.targetType === 'free' ? 'フリー' : g.targetType === 'pipe_vertex' ? '頂点' : '座標'
      const values: (string | number | null)[] = [
        `${kind}${m2 ? ' ×2' : ''}`,
      ]
      const push = (sec: SectionKey, vals: (string | number | null)[]) => {
        if (isHidden(sec)) return
        // 実測記録 は 素直な観測ログ に する ため design / m1 以外 は TABLE_SECTIONS
        // から 除外 済み。 find で 見つから ない セクション は 静か に スキップ。
        const found = TABLE_SECTIONS.find((s) => s.key === sec)
        if (!found) return
        found.cols.forEach((c, i) => {
          if (c.isZ && !showZ) return
          values.push(vals[i] ?? null)
        })
      }
      push('design', [designName, g.designX, g.designY, g.designZ])
      push('m1', [m1?.targetName ?? null, m1?.measuredX ?? null, m1?.measuredY ?? null, m1?.measuredZ ?? null])
      push('m2', [m2?.targetName ?? null, m2?.measuredX ?? null, m2?.measuredY ?? null, m2?.measuredZ ?? null])
      push('diff', [d.diffX, d.diffY, d.diffZ])
      push('avg', [d.avgX, d.avgY, d.avgZ])
      push('dvs', [d.dvsX, d.dvsY, d.dvsZ, d.dvsH])
      values.push(d.acc)
      values.push(m1?.recordedAt ? new Date(m1.recordedAt).toLocaleString('ja-JP') : '')
      values.push(m1?.recordedBy ? memberNameById.get(m1.recordedBy) ?? '' : '')
      ws.addRow(values)
    }

    // 数値列 は 小数 3 桁 で 表示 (値 は 丸めない)
    cols.forEach((c, i) => {
      const col = ws.getColumn(i + 1)
      col.width = c.num ? 12 : 18
      if (c.num) {
        col.numFmt = '0.000'
        col.alignment = { horizontal: 'right' }
      }
    })
    ws.views = [{ state: 'frozen', ySplit: 2 }]

    const buf = await wb.xlsx.writeBuffer()
    const blob = new Blob([buf], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${currentFarm?.name ?? 'farm'}_実測記録.xlsx`
    a.click()
    URL.revokeObjectURL(url)
  }

  // SIMA 出力（実測値ベース）
  // フォーマットは PipeCoordinateCalcPage の handleExportSIMA に準拠。
  const handleExportSIMA = () => {
    if (filtered.length === 0) return
    const projectName = currentFarm?.name || 'NoName'
    const lines: string[] = []
    lines.push(`G00,04,${projectName},`)
    lines.push('Z00, /* 実測座標 */,')
    lines.push('Z01,2,')
    lines.push('A00,')
    filtered.forEach((r, index) => {
      const name = r.targetName ?? `pt-${index + 1}`
      const paddedName = name.padEnd(20, ' ')
      // dx/dy/dz スライド 補正 は 廃止 のため、 実測値 を そのまま 出力。
      const xStr = r.measuredX.toFixed(3).padStart(10, ' ')
      const yStr = r.measuredY.toFixed(3).padStart(10, ' ')
      const zStr =
        r.measuredZ != null ? r.measuredZ.toFixed(3).padStart(10, ' ') : ''
      const numStr = (index + 1).toString().padStart(5, ' ')
      lines.push(`A01,${numStr},${paddedName},${xStr},${yStr},${zStr},`)
    })
    lines.push('A99,')
    const content = lines.join('\r\n')
    const blob = new Blob([content], { type: 'text/plain;charset=shift_jis' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${projectName}_staking.sim`
    a.click()
    URL.revokeObjectURL(url)
  }

  if (!currentFarm) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground">
        工区を選択してください
      </div>
    )
  }

  return (
    <div className="h-full w-full min-w-0 max-w-full flex flex-col overflow-hidden">
      {/* ヘッダー (タイトル / サマリ / 型 の 注記 バー は 撤去)。
          点種 フィルタ の 右端 に 再読込 と Excel/CSV/SIMA ダウンロード を まとめて 配置。 */}

      {/* pendingLink 系 の 案内 バー (発動中 だけ 出す。 通常時 は 非表示) */}
      {(pendingLinkRecordId || pendingLinkM2ForM1Id || error) && (
        <div className="px-3 py-1 border-b bg-slate-50 flex items-center gap-2 text-xs text-slate-600 flex-wrap">
          {pendingLinkRecordId && (
            <span className="flex items-center gap-2 text-blue-700 font-semibold">
              📍 地図上の 当初 の 座標 を クリック で 割り付け
              <button
                onClick={() => setPendingLinkRecordId(null)}
                className="p-0.5 rounded border hover:bg-white"
                title="キャンセル"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          )}
          {pendingLinkM2ForM1Id && (
            <span className="flex items-center gap-2 text-purple-700 font-semibold">
              🎯 実測2 の 候補 を 選択 (5cm 以内 の 実測点)
              <button
                onClick={handleCancelLinkM2}
                className="p-0.5 rounded border hover:bg-white"
                title="キャンセル"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          )}
          {error && <span className="text-red-600">{error}</span>}
        </div>
      )}

      {/* 点種 フィルタ + ダウンロード / 再読込 ボタン */}
      {availableTypes.length > 0 && (
        <div className="px-3 py-1.5 border-b bg-white flex items-center gap-1 flex-wrap">
          <span className="text-[11px] text-slate-500 mr-1">表示点種:</span>
          {availableTypes.map((type) => {
            const on = effectiveVisibleTypes?.has(type) ?? true
            const color = TYPE_COLORS[type] ?? '#666'
            const label = COORDINATE_TYPE_NAMES[type as CoordinateType] ?? type
            return (
              <button
                key={type}
                onClick={() => toggleTypeVisibility(type)}
                title={on ? '非表示に する' : '表示する'}
                className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[11px] border rounded ${
                  on
                    ? 'bg-white border-slate-300 text-slate-700'
                    : 'bg-slate-100 border-slate-200 text-slate-400 line-through'
                }`}
              >
                <span
                  className="inline-block w-2 h-2 rounded-full shrink-0"
                  style={{ backgroundColor: color, opacity: on ? 1 : 0.3 }}
                />
                {label}
              </button>
            )
          })}
          <button
            onClick={() => setVisibleTypesState(new Set(availableTypes))}
            className="text-[11px] text-slate-500 hover:text-blue-600"
          >
            全 ON
          </button>
          <button
            onClick={() => setVisibleTypesState(new Set())}
            className="text-[11px] text-slate-500 hover:text-blue-600"
          >
            全 OFF
          </button>
          {/* 点種 の 右側 に 再読込 と 出力 系 を まとめる */}
          <div className="ml-auto flex items-center gap-1">
            <button
              onClick={() => fetchRecords(currentFarm.id)}
              className="flex items-center gap-1 px-2 py-0.5 text-[11px] border rounded hover:bg-slate-50"
              title="再読み込み"
            >
              <RefreshCw className="h-3 w-3" />
              再読込
            </button>
            <button
              onClick={() => void handleExportExcel()}
              disabled={grouped.length === 0}
              className="flex items-center gap-1 px-2 py-0.5 text-[11px] bg-emerald-700 text-white rounded hover:bg-emerald-800 disabled:opacity-50"
              title="画面の表をそのまま Excel に出力 (座標は小数 3 桁表示)"
            >
              <Download className="h-3 w-3" />
              Excel
            </button>
            <button
              onClick={handleExportCSV}
              disabled={filtered.length === 0}
              className="flex items-center gap-1 px-2 py-0.5 text-[11px] bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
            >
              <Download className="h-3 w-3" />
              CSV
            </button>
            <button
              onClick={handleExportSIMA}
              disabled={filtered.length === 0}
              className="flex items-center gap-1 px-2 py-0.5 text-[11px] bg-emerald-600 text-white rounded hover:bg-emerald-700 disabled:opacity-50"
            >
              <Download className="h-3 w-3" />
              SIMA
            </button>
          </div>
        </div>
      )}

      {/* 地図 は 左右 分割 の 右側 に 移動 (下 の 左右 スプリット 内) */}

      {/* 記録セット の タブ。 セット を 分けた 以上、1 つ ずつ 見る 方 が 分かり やすい。
          右端 の 「+ セット」 が セット を 作る 唯一 の 入口。 */}
      {currentFarm && (
        <div className="px-3 pt-1.5 border-b bg-white flex items-end gap-0 overflow-x-auto">
          {[
            ...sets.map((st) => ({
              key: st.id,
              label: setLabel(st),
              n: countBySet.get(st.id) ?? 0,
            })),
            ...((countBySet.get(null) ?? 0) > 0
              ? [{ key: 'none', label: '未振り分け', n: countBySet.get(null) ?? 0 }]
              : []),
          ].map((t) => {
            const on = setTab === t.key
            const isSession = t.key !== 'none'
            return (
              <div
                key={t.key}
                className={`inline-flex items-center -mb-px border-b-2 whitespace-nowrap ${
                  on
                    ? 'border-blue-600'
                    : 'border-transparent'
                }`}
              >
                <button
                  type="button"
                  onClick={() => setSetTab(t.key)}
                  className={`px-3 py-1.5 text-xs whitespace-nowrap ${
                    on
                      ? 'text-blue-700 font-medium'
                      : 'text-slate-600 hover:text-slate-800'
                  }`}
                >
                  {t.label}
                  <span className="ml-1 text-slate-400">{t.n}</span>
                </button>
                {/* タブ の 右 に 詳細 編集 ボタン。 未振り分け に は 出さない。 */}
                {isSession && on && (
                  <button
                    type="button"
                    onClick={() => setSessionDetailOpen(true)}
                    title="この セッション の 詳細 (名前 / 日付 / 担当者 / 基準局) を 編集"
                    className="mr-1 p-1 rounded text-slate-400 hover:text-slate-700 hover:bg-slate-100"
                  >
                    <Settings2 className="h-3 w-3" />
                  </button>
                )}
              </div>
            )
          })}
          {/* PC からの セッション追加 / 削除 / 記録移動 は 廃止。
              セッション の 作成 は スマホ の 測定 時 に 一元化 (誤操作 防止)。 */}
        </div>
      )}

      {/* 左右 分割: 左 = テーブル、右 = 地図。 幅 は ドラッグ で 変え られる。
          isolate で テーブル 内 sticky thead の z-index が 地図側 と 干渉 しない。 */}
      <ResizableSplit
        storageKey="staking-records"
        defaultLeft={860}
        minLeft={420}
        maxLeft={1600}
        className="flex-1 min-h-0"
        left={
      <div className="flex-1 min-h-0 min-w-0 overflow-auto bg-white isolate w-full">
        {loading ? (
          <div className="h-full flex items-center justify-center text-slate-500">
            <Loader2 className="h-5 w-5 animate-spin mr-2" />
            読み込み中…
          </div>
        ) : filtered.length === 0 ? (
          <div className="h-full flex items-center justify-center text-slate-400 text-sm">
            記録がありません
          </div>
        ) : (
          <table className="min-w-max text-xs border-collapse whitespace-nowrap">
            <thead className="bg-slate-100 sticky top-0 z-10">
              <tr className="text-slate-700">
                <th
                  className="px-2 py-2 border-b border-r text-center w-8"
                  rowSpan={2}
                  title="セッション を 移す 行 を 選択"
                >
                  <input
                    type="checkbox"
                    checked={
                      grouped.length > 0 &&
                      selectedGroupKeys.size === grouped.length
                    }
                    onChange={(e) => {
                      if (e.target.checked) {
                        setSelectedGroupKeys(new Set(grouped.map((g) => g.key)))
                      } else {
                        setSelectedGroupKeys(new Set())
                      }
                    }}
                    onClick={(e) => e.stopPropagation()}
                  />
                </th>
                <th className="px-2 py-2 border-b border-r text-left whitespace-nowrap" rowSpan={2}>
                  種別
                </th>
                {TABLE_SECTIONS.map((sec) => {
                  if (isHidden(sec.key)) return null
                  const cs = sec.cols.filter((c) => showZ || !c.isZ).length
                  return (
                    <th
                      key={sec.key}
                      className={`px-2 py-1 border-b border-r text-center ${sec.bgHeader}`}
                      colSpan={cs}
                      title={sec.headerTitle}
                    >
                      {sec.label}
                    </th>
                  )
                })}
                <th className="px-2 py-2 border-b border-r text-right" rowSpan={2}>精度(m)</th>
                <th className="px-2 py-2 border-b border-r text-left" rowSpan={2}>測定日時</th>
                <th className="px-2 py-2 border-b border-r text-left" rowSpan={2}>測定者</th>
                <th className="px-2 py-2 border-b text-center w-10" rowSpan={2}></th>
              </tr>
              <tr className="text-slate-700">
                {TABLE_SECTIONS.map((sec) => {
                  if (isHidden(sec.key)) return null
                  return sec.cols
                    .filter((c) => showZ || !c.isZ)
                    .map((c) => (
                      <th
                        key={`${sec.key}-${c.label}`}
                        className={`px-2 py-1 border-b border-r ${sec.bgSub} ${
                          c.align === 'left' ? 'text-left' : 'text-right'
                        }`}
                      >
                        {c.label}
                      </th>
                    ))
                })}
              </tr>
            </thead>
            <tbody>
              {grouped.map((g) => {
                const { m1, m2 } = g
                const isSelected = selectedRecordId === g.m1?.id
                // 点名: 実測1 の targetName → G_ / G2_ プレフィックス を 剥がした 設計名
                const designName =
                  g.targetType === 'coordinate' && g.designName
                    ? g.designName.replace(/^G2?_/, '')
                    : m1?.targetName ?? '(無題)'
                // 表 に 出す 値 は Excel 出力 と 同じ 計算 を 使う。
                // dx/dy/dz スライド 補正 は 廃止 のため 常 に 0。
                const {
                  diffX, diffY, diffZ,
                  avgX, avgY, avgZ,
                  dvsX, dvsY, dvsZ, dvsH,
                  acc,
                } = deriveRow(g, 0, 0, 0)
                const clickId = m1?.id ?? null
                return (
                  <tr
                    key={g.key}
                    onClick={() => clickId && handleRowClick(clickId)}
                    className={`cursor-pointer ${
                      isSelected ? 'bg-blue-100 hover:bg-blue-200' : 'hover:bg-slate-50'
                    }`}
                  >
                    <td className="px-2 py-1.5 border-b border-r text-center">
                      <input
                        type="checkbox"
                        checked={selectedGroupKeys.has(g.key)}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => {
                          setSelectedGroupKeys((prev) => {
                            const next = new Set(prev)
                            if (e.target.checked) next.add(g.key)
                            else next.delete(g.key)
                            return next
                          })
                        }}
                      />
                    </td>
                    <td className="px-2 py-1.5 border-b border-r whitespace-nowrap">
                      <span
                        className={`text-[10px] px-1.5 py-0.5 rounded ${
                          g.targetType === 'free'
                            ? 'bg-amber-100 text-amber-800'
                            : g.targetType === 'pipe_vertex'
                              ? 'bg-emerald-100 text-emerald-800'
                              : 'bg-blue-100 text-blue-800'
                        }`}
                      >
                        {g.targetType === 'free'
                          ? 'フリー'
                          : g.targetType === 'pipe_vertex'
                            ? '頂点'
                            : '座標'}
                      </span>
                      {/* 起工/出来形 の 区分 表示 は 撤去 */}
                      {m2 && (
                        <span
                          className="ml-1 text-[10px] px-1 py-0.5 rounded bg-purple-100 text-purple-700"
                          title="2 回 測定"
                        >
                          ×2
                        </span>
                      )}
                      {/* 行 の 高さ を 増やさない ため、選択欄 は 置かない。
                          点 ごと の 移動 は 行 を 選んで 上 の 「セットへ移動」 から。
                          どの セット か は タブ で 分かる ので、「すべて」 の ときだけ 添える。 */}
                      {setTab === 'all' && sets.length > 0 && (() => {
                        const sid = (g.m1 ?? g.m2)?.recordSetId ?? null
                        const st = sid ? sets.find((x) => x.id === sid) : null
                        return (
                          <span
                            className="ml-1 text-[10px] text-slate-500"
                            title="セッション"
                          >
                            {st ? setLabel(st) : '未振り分け'}
                          </span>
                        )
                      })()}
                    </td>
                    {/* 当初 (点名 + XYZ + リンク 操作 ボタン) — 実測1 の record を 対象 */}
                    {!isHidden('design') && <>
                    <td
                      className={`px-2 py-1.5 border-b border-r font-medium ${
                        m1 && pendingLinkRecordId === m1.id
                          ? 'bg-blue-100 text-blue-800'
                          : 'text-slate-700'
                      }`}
                    >
                      <div className="flex items-center gap-1">
                        <span className="flex-1 min-w-0 truncate">
                          {g.targetType === 'coordinate' && g.designName ? (
                            designName
                          ) : (
                            <span className="text-slate-400 italic">未設定</span>
                          )}
                        </span>
                        {g.targetType === 'coordinate' && m1?.targetRefId ? (
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              // グループ 内 全 record を 一斉 に 解除
                              const ids = [m1?.id, m2?.id].filter(Boolean) as string[]
                              for (const id of ids) void updateRecordTarget(id, null)
                            }}
                            title="当初 の 座標 の リンク を 解除 (グループ 全体)"
                            className="p-0.5 text-slate-400 hover:text-red-500"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        ) : m1 && pendingLinkRecordId === m1.id ? (
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              setPendingLinkRecordId(null)
                            }}
                            title="当初 の 座標 の 選択 を キャンセル"
                            className="p-0.5 text-blue-600 hover:bg-blue-200 rounded"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        ) : m1 ? (
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              setPendingLinkRecordId(m1.id)
                              setPendingLinkM2ForM1Id(null)
                            }}
                            title="地図 から 当初 の 座標 を 選んで リンク"
                            className="p-0.5 text-blue-500 hover:bg-blue-50 rounded"
                          >
                            <LinkIcon className="h-3 w-3" />
                          </button>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-2 py-1.5 border-b border-r font-mono text-right text-slate-600">
                      {g.designX != null ? g.designX.toFixed(3) : '—'}
                    </td>
                    <td className="px-2 py-1.5 border-b border-r font-mono text-right text-slate-600">
                      {g.designY != null ? g.designY.toFixed(3) : '—'}
                    </td>
                    {showZ && (
                      <td className="px-2 py-1.5 border-b border-r font-mono text-right text-slate-600">
                        {g.designZ != null ? g.designZ.toFixed(3) : '—'}
                      </td>
                    )}
                    </>}
                    {/* 実測1 (点名 / X / Y / Z)。 点名 は 変更可 (blur/Enter で 保存)、
                        座標 (X/Y/Z) は 読取専用。 */}
                    {!isHidden('m1') && <>
                    <td className="px-1 py-1 border-b border-r bg-orange-50/50 max-w-[8rem]">
                      {m1 ? (
                        <input
                          type="text"
                          key={`${m1.id}:${m1.targetName ?? ''}`}
                          defaultValue={m1.targetName ?? ''}
                          onClick={(e) => e.stopPropagation()}
                          onBlur={(e) => {
                            const v = e.target.value.trim()
                            if (v !== (m1.targetName ?? '')) {
                              void updateRecordName(m1.id, v || null)
                            }
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter')
                              (e.currentTarget as HTMLInputElement).blur()
                          }}
                          className="w-full px-1 py-0.5 border rounded text-sm bg-white"
                        />
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-2 py-1.5 border-b border-r font-mono text-right bg-orange-50/50">
                      {m1 ? m1.measuredX.toFixed(3) : '—'}
                    </td>
                    <td className="px-2 py-1.5 border-b border-r font-mono text-right bg-orange-50/50">
                      {m1 ? m1.measuredY.toFixed(3) : '—'}
                    </td>
                    {showZ && (
                      <td className="px-2 py-1.5 border-b border-r font-mono text-right bg-orange-50/50">
                        {m1?.measuredZ != null ? m1.measuredZ.toFixed(3) : '—'}
                      </td>
                    )}
                    </>}
                    {/* 実測2 (点名 + リンク操作 / X / Y / Z)。 別 の 実測点 を リンク
                        させる こと で 「後追い で 2 回目 の 実測」を 表現できる。 */}
                    {!isHidden('m2') && <>
                    <td
                      className={`px-1 py-1 border-b border-r max-w-[8rem] ${
                        m1 && pendingLinkM2ForM1Id === m1.id
                          ? 'bg-purple-100'
                          : 'bg-orange-50/50'
                      }`}
                    >
                      <div className="flex items-center gap-1">
                        {m2 ? (
                          <input
                            type="text"
                            key={`${m2.id}:${m2.targetName ?? ''}`}
                            defaultValue={m2.targetName ?? ''}
                            onClick={(e) => e.stopPropagation()}
                            onBlur={(e) => {
                              const v = e.target.value.trim()
                              if (v !== (m2.targetName ?? '')) {
                                void updateRecordName(m2.id, v || null)
                              }
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter')
                                (e.currentTarget as HTMLInputElement).blur()
                            }}
                            className="flex-1 min-w-0 px-1 py-0.5 border rounded text-sm bg-white"
                          />
                        ) : (
                          <span className="flex-1 min-w-0 truncate text-slate-400 italic">
                            —
                          </span>
                        )}
                        {m2 ? (
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              // グループ 種別 に 応じて 解除方法 を 切替:
                              // 設計座標 リンク済み → updateRecordTarget(null) で free 化
                              // free ペア → unpairRecord で 双方 の paired_with_id を NULL
                              if (m1?.targetType === 'coordinate' && m1.targetRefId) {
                                void updateRecordTarget(m2.id, null)
                              } else {
                                void unpairRecord(m2.id)
                              }
                            }}
                            title="実測2 を グループ から 外す"
                            className="p-0.5 text-slate-400 hover:text-red-500"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        ) : m1 && pendingLinkM2ForM1Id === m1.id ? (
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              handleCancelLinkM2()
                            }}
                            title="キャンセル"
                            className="p-0.5 text-purple-600 hover:bg-purple-200 rounded"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        ) : m1 ? (
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              handleStartLinkM2(m1.id)
                            }}
                            title="別 の 実測点 を 実測2 として リンク"
                            className="p-0.5 text-purple-500 hover:bg-purple-50 rounded"
                          >
                            <LinkIcon className="h-3 w-3" />
                          </button>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-2 py-1.5 border-b border-r font-mono text-right bg-orange-50/50">
                      {m2 ? m2.measuredX.toFixed(3) : '—'}
                    </td>
                    <td className="px-2 py-1.5 border-b border-r font-mono text-right bg-orange-50/50">
                      {m2 ? m2.measuredY.toFixed(3) : '—'}
                    </td>
                    {showZ && (
                      <td className="px-2 py-1.5 border-b border-r font-mono text-right bg-orange-50/50">
                        {m2?.measuredZ != null ? m2.measuredZ.toFixed(3) : '—'}
                      </td>
                    )}
                    </>}
                    {/* 実測差 (m2 - m1) */}
                    {!isHidden('diff') && (
                      <>
                        <td className="px-2 py-1.5 border-b border-r font-mono text-right bg-rose-50/50">
                          {diffX != null ? diffX.toFixed(3) : '—'}
                        </td>
                        <td className="px-2 py-1.5 border-b border-r font-mono text-right bg-rose-50/50">
                          {diffY != null ? diffY.toFixed(3) : '—'}
                        </td>
                        {showZ && (
                          <td className="px-2 py-1.5 border-b border-r font-mono text-right bg-rose-50/50">
                            {diffZ != null ? diffZ.toFixed(3) : '—'}
                          </td>
                        )}
                      </>
                    )}
                    {/* 実測平均 (X/Y/Z) */}
                    {!isHidden('avg') && (
                      <>
                        <td className="px-2 py-1.5 border-b border-r font-mono text-right bg-emerald-50/50 font-semibold">
                          {avgX != null ? avgX.toFixed(3) : '—'}
                        </td>
                        <td className="px-2 py-1.5 border-b border-r font-mono text-right bg-emerald-50/50 font-semibold">
                          {avgY != null ? avgY.toFixed(3) : '—'}
                        </td>
                        {showZ && (
                          <td className="px-2 py-1.5 border-b border-r font-mono text-right bg-emerald-50/50 font-semibold">
                            {avgZ != null ? avgZ.toFixed(3) : '—'}
                          </td>
                        )}
                      </>
                    )}
                    {/* 実測平均 - 設計 (dX / dY / dZ / 水平) */}
                    {!isHidden('dvs') && (
                      <>
                        <td className="px-2 py-1.5 border-b border-r font-mono text-right bg-blue-50/50">
                          {dvsX != null ? dvsX.toFixed(3) : '—'}
                        </td>
                        <td className="px-2 py-1.5 border-b border-r font-mono text-right bg-blue-50/50">
                          {dvsY != null ? dvsY.toFixed(3) : '—'}
                        </td>
                        {showZ && (
                          <td className="px-2 py-1.5 border-b border-r font-mono text-right bg-blue-50/50">
                            {dvsZ != null ? dvsZ.toFixed(3) : '—'}
                          </td>
                        )}
                        <td className="px-2 py-1.5 border-b border-r font-mono text-right bg-blue-50/50">
                          {dvsH != null ? dvsH.toFixed(3) : '—'}
                        </td>
                      </>
                    )}
                    {/* スライド設計 / 逆スライド実測 の 列 は dx/dy/dz スライド 廃止 のため 削除 */}
                    <td className="px-2 py-1.5 border-b border-r font-mono text-right">
                      {acc != null ? acc.toFixed(3) : '—'}
                    </td>
                    <td className="px-2 py-1.5 border-b border-r text-slate-600">
                      {m1
                        ? new Date(m1.recordedAt).toLocaleString('ja-JP', {
                            year: 'numeric',
                            month: '2-digit',
                            day: '2-digit',
                            hour: '2-digit',
                            minute: '2-digit',
                          })
                        : '—'}
                    </td>
                    <td
                      className="px-2 py-1.5 border-b border-r text-slate-600 whitespace-nowrap"
                      title={m1?.recordedBy ?? ''}
                    >
                      {m1?.recordedBy
                        ? memberNameById.get(m1.recordedBy) ?? '(未登録)'
                        : '—'}
                    </td>
                    <td className="px-2 py-1.5 border-b text-center">
                      <div className="flex gap-0.5 justify-center">
                        {m1 && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              void handleDelete(m1.id, m1.targetName)
                            }}
                            className="p-1 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded"
                            title="実測1 を 削除"
                          >
                            <Trash2 className="h-3 w-3" />
                          </button>
                        )}
                        {m2 && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              void handleDelete(m2.id, m2.targetName)
                            }}
                            className="p-1 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded text-[9px]"
                            title="実測2 を 削除"
                          >
                            <Trash2 className="h-3 w-3" />
                            <span className="text-[9px] absolute">2</span>
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

        }
        right={
          // 右側: 地図 (座標管理 と 同じ CoordinateMap)。設計座標 を クリック で
          // 事後リンク 可能。 実測点 は オレンジ 十字マーカー で 表示。
          // isolate で 地図 内 の z-[1000] HUD が 隣 の テーブル に 被らない よう
          // 独立 スタッキング コンテキスト を 作る。
      <div className="flex-1 min-h-0 min-w-0 relative overflow-hidden isolate h-full">
        <CoordinateMap
          farmId={currentFarm.id}
          showLabels
          visibleTypes={effectiveVisibleTypes}
          dimmedCoordIds={linkedCoordIds}
          onPointSelect={handleCoordSelectOnMap}
        >
          <RecordZoomController target={zoomTarget} />
          {measuredPointsForMap.map((m) => {
            const linkedCoord =
              m.record.targetType === 'coordinate' && m.record.targetRefId
                ? coordinates.find((c) => c.id === m.record.targetRefId)
                : null
            if (!linkedCoord) return null
            const linkedLL = converter.toLatLng(linkedCoord.x, linkedCoord.y)
            return (
              <Polyline
                key={`line-${m.id}`}
                positions={[
                  [linkedLL.lat, linkedLL.lng],
                  [m.lat, m.lng],
                ]}
                pathOptions={{
                  color: '#f97316',
                  weight: 1.5,
                  opacity: 0.7,
                  dashArray: '3,3',
                }}
              />
            )
          })}
          {measuredPointsForMap.map((m) => {
            const isSelected = selectedRecordId === m.id
            const isPending = pendingLinkM2ForM1Id === m.id
            // 起工/出来形 の 色分け は 撤去。 実測点 は 一律 で 橙。
            const fill = '#f97316'
            return (
              <Marker
                key={`meas-${m.id}`}
                position={[m.lat, m.lng]}
                icon={createMeasuredIcon({ fill, isSelected, isPending })}
                zIndexOffset={isPending ? 2000 : 1000}
                eventHandlers={{
                  click: () => handleMeasuredMarkerClick(m.id),
                }}
              >
                <Tooltip
                  permanent
                  direction="right"
                  offset={[10, 0]}
                  className="point-label-tooltip"
                >
                  <span
                    style={{
                      color: fill,
                      textShadow:
                        '-1px -1px 0 #fff, 1px -1px 0 #fff, -1px 1px 0 #fff, 1px 1px 0 #fff, 0 -1px 0 #fff, 0 1px 0 #fff, -1px 0 0 #fff, 1px 0 0 #fff',
                    }}
                  >
                    {m.record.targetName ?? '(実測)'}
                  </span>
                </Tooltip>
              </Marker>
            )
          })}
        </CoordinateMap>
      </div>
        }
      />
      {/* /左右 分割 */}

      {/* 実測2 選択 モーダル: 5cm 以内 の 候補 リスト から 選ぶ。
          地図上 で は 実測1 と ほぼ 重なる ため マーカー クリック では
          選び分け が 難しい ので、この 方式 に した。 */}
      {pendingLinkM2ForM1Id && (() => {
        const m1 = records.find((r) => r.id === pendingLinkM2ForM1Id)
        if (!m1) return null
        return (
          <div
            className="fixed inset-0 z-[9999] bg-black/40 flex items-center justify-center p-4"
            onClick={handleCancelLinkM2}
          >
            <div
              className="bg-white rounded-lg shadow-xl max-w-lg w-full max-h-[80vh] flex flex-col"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="px-4 py-3 border-b flex items-center gap-2">
                <div className="font-semibold text-sm">実測2 を 選択</div>
                <div className="text-xs text-slate-500 ml-auto">
                  基準: <span className="font-mono">{m1.targetName ?? '(無題)'}</span>{' '}
                  ({m1.measuredX.toFixed(3)}, {m1.measuredY.toFixed(3)})
                </div>
                <button
                  onClick={handleCancelLinkM2}
                  className="p-1 rounded hover:bg-slate-100"
                  title="閉じる"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="px-4 py-2 text-[11px] text-slate-500 border-b">
                実測1 の XY から 5cm 以内 の 実測点 を 一覧。 別 グループ に 属する
                記録 も 含む (選択 で 移動 する)。
              </div>
              <div className="flex-1 overflow-auto">
                {m2Candidates.length === 0 ? (
                  <div className="p-6 text-center text-sm text-slate-400">
                    5cm 以内 に 他 の 実測点 が ありません。
                  </div>
                ) : (
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 text-xs text-slate-600 sticky top-0">
                      <tr>
                        <th className="px-2 py-1 text-left">点名</th>
                        <th className="px-2 py-1 text-right">距離 (mm)</th>
                        <th className="px-2 py-1 text-right">X</th>
                        <th className="px-2 py-1 text-right">Y</th>
                        <th className="px-2 py-1 text-left">現状</th>
                        <th className="px-2 py-1"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {m2Candidates.map(({ record, distance }) => {
                        const status =
                          record.targetType === 'coordinate' && record.targetRefId
                            ? '別設計座標 に リンク'
                            : record.pairedWithId
                              ? '既 ペア あり'
                              : 'free'
                        return (
                          <tr key={record.id} className="border-t hover:bg-slate-50">
                            <td className="px-2 py-1 font-medium">
                              {record.targetName ?? '(無題)'}
                            </td>
                            <td className="px-2 py-1 text-right tabular-nums font-mono">
                              {(distance * 1000).toFixed(1)}
                            </td>
                            <td className="px-2 py-1 text-right tabular-nums font-mono">
                              {record.measuredX.toFixed(3)}
                            </td>
                            <td className="px-2 py-1 text-right tabular-nums font-mono">
                              {record.measuredY.toFixed(3)}
                            </td>
                            <td className="px-2 py-1 text-xs text-slate-500">
                              {status}
                            </td>
                            <td className="px-2 py-1 text-right">
                              <button
                                onClick={() => handlePickM2Candidate(record.id)}
                                className="px-2 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700"
                              >
                                これを 実測2 に
                              </button>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                )}
              </div>
              <div className="px-4 py-2 border-t flex justify-end">
                <button
                  onClick={handleCancelLinkM2}
                  className="px-3 py-1 text-sm border rounded hover:bg-slate-50"
                >
                  キャンセル
                </button>
              </div>
            </div>
          </div>
        )
      })()}

      {/* 設計座標 リンク モーダル: 実測 記録 の XY から 半径 2m 以内 の
          設計座標 (measured 種別 を 除く) を 一覧。 実測2 と 同じ 感覚 で
          近接値 を リスト から 選べる。 地図 クリック も 引き続き 有効。 */}
      {pendingLinkRecordId && (() => {
        const rec = records.find((r) => r.id === pendingLinkRecordId)
        if (!rec) return null
        return (
          <div
            className="fixed inset-0 z-[9999] bg-black/40 flex items-center justify-center p-4"
            onClick={() => setPendingLinkRecordId(null)}
          >
            <div
              className="bg-white rounded-lg shadow-xl max-w-xl w-full max-h-[80vh] flex flex-col"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="px-4 py-3 border-b flex items-center gap-2">
                <div className="font-semibold text-sm">設計座標 を リンク</div>
                <div className="text-xs text-slate-500 ml-auto">
                  基準: <span className="font-mono">{rec.targetName ?? '(無題)'}</span>{' '}
                  ({rec.measuredX.toFixed(3)}, {rec.measuredY.toFixed(3)})
                </div>
                <button
                  onClick={() => setPendingLinkRecordId(null)}
                  className="p-1 rounded hover:bg-slate-100"
                  title="閉じる"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="px-4 py-2 text-[11px] text-slate-500 border-b">
                実測 XY から 2m 以内 の 設計座標 (実測 由来 の 点 は 除く) を
                距離 順 で 一覧。 モーダル を 閉じて 地図 上 の 座標 を クリック
                しても リンク できます。
              </div>
              <div className="flex-1 overflow-auto">
                {designCandidates.length === 0 ? (
                  <div className="p-6 text-center text-sm text-slate-400">
                    2m 以内 に 設計座標 が ありません。
                  </div>
                ) : (
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 text-xs text-slate-600 sticky top-0">
                      <tr>
                        <th className="px-2 py-1 text-left">点名</th>
                        <th className="px-2 py-1 text-left">種別</th>
                        <th className="px-2 py-1 text-right">距離 (m)</th>
                        <th className="px-2 py-1 text-right">X</th>
                        <th className="px-2 py-1 text-right">Y</th>
                        <th className="px-2 py-1 text-left">状態</th>
                        <th className="px-2 py-1"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {designCandidates.map(({ coord, distance }) => {
                        const alreadyLinked = linkedCoordIds.has(coord.id)
                        const typeLabel =
                          COORDINATE_TYPE_NAMES[coord.type as CoordinateType] ?? coord.type
                        return (
                          <tr key={coord.id} className="border-t hover:bg-slate-50">
                            <td className="px-2 py-1 font-medium">
                              {coord.pointNumber || '(無題)'}
                            </td>
                            <td className="px-2 py-1 text-xs text-slate-600">
                              {typeLabel}
                            </td>
                            <td className="px-2 py-1 text-right tabular-nums font-mono">
                              {distance.toFixed(3)}
                            </td>
                            <td className="px-2 py-1 text-right tabular-nums font-mono">
                              {coord.x.toFixed(3)}
                            </td>
                            <td className="px-2 py-1 text-right tabular-nums font-mono">
                              {coord.y.toFixed(3)}
                            </td>
                            <td className="px-2 py-1 text-xs text-slate-500">
                              {alreadyLinked ? '別記録 に リンク済' : ''}
                            </td>
                            <td className="px-2 py-1 text-right">
                              <button
                                onClick={() => handleCoordSelectOnMap(coord.id)}
                                className="px-2 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700"
                              >
                                これに リンク
                              </button>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                )}
              </div>
              <div className="px-4 py-2 border-t flex justify-end">
                <button
                  onClick={() => setPendingLinkRecordId(null)}
                  className="px-3 py-1 text-sm border rounded hover:bg-slate-50"
                >
                  キャンセル
                </button>
              </div>
            </div>
          </div>
        )
      })()}

      {/* セッション 詳細 モーダル (開いている セッション 1 件のみ を 直接 表示 / 編集) */}
      {sessionDetailOpen && slideTargetSet && (
        <div
          className="fixed inset-0 bg-black/50 z-[3000] flex items-center justify-center p-4"
          onClick={() => setSessionDetailOpen(false)}
        >
          <div
            className="bg-white rounded-lg shadow-xl w-full max-w-lg flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 px-3 py-2 border-b">
              <Settings2 className="h-4 w-4 text-slate-500" />
              <h3 className="text-sm font-semibold">
                セッション 詳細
                <span className="ml-2 text-[11px] text-slate-500 font-normal font-mono">
                  {setLabel(slideTargetSet)}
                </span>
              </h3>
              <button
                onClick={() => setSessionDetailOpen(false)}
                className="ml-auto p-1 hover:bg-slate-100 rounded"
                title="閉じる"
              >
                <X className="h-4 w-4 text-slate-500" />
              </button>
            </div>
            <div className="p-3 space-y-2 text-xs">
              <div className="grid grid-cols-2 gap-2">
                <label className="block">
                  <span className="text-[11px] text-slate-500">名前</span>
                  <input
                    className="w-full px-2 py-1 border rounded font-mono"
                    value={slideTargetSet.name ?? ''}
                    onChange={(e) =>
                      void updateSet(slideTargetSet.id, { name: e.target.value || null })
                    }
                    placeholder="空なら 日付 + 担当者"
                  />
                </label>
                <label className="block">
                  <span className="text-[11px] text-slate-500">測量日</span>
                  <input
                    type="date"
                    className="w-full px-2 py-1 border rounded font-mono"
                    value={slideTargetSet.measuredOn ?? ''}
                    onChange={(e) =>
                      void updateSet(slideTargetSet.id, {
                        measuredOn: e.target.value || null,
                      })
                    }
                  />
                </label>
                <label className="block">
                  <span className="text-[11px] text-slate-500">担当者</span>
                  <input
                    className="w-full px-2 py-1 border rounded"
                    value={slideTargetSet.operator ?? ''}
                    onChange={(e) =>
                      void updateSet(slideTargetSet.id, {
                        operator: e.target.value || null,
                      })
                    }
                  />
                </label>
                <label className="block">
                  <span className="text-[11px] text-slate-500">基準局</span>
                  <input
                    className="w-full px-2 py-1 border rounded"
                    value={slideTargetSet.baseStation ?? ''}
                    onChange={(e) =>
                      void updateSet(slideTargetSet.id, {
                        baseStation: e.target.value || null,
                      })
                    }
                    placeholder="例: ネットワーク型RTK / 自営局"
                  />
                </label>
                <label className="block col-span-2">
                  <span className="text-[11px] text-slate-500">基準局 位置情報</span>
                  <input
                    className="w-full px-2 py-1 border rounded font-mono"
                    value={slideTargetSet.baseStationPosition ?? ''}
                    onChange={(e) =>
                      void updateSet(slideTargetSet.id, {
                        baseStationPosition: e.target.value || null,
                      })
                    }
                    placeholder="例: TS7788 / X=-3826589.785 Y=3449477.552 Z=3748335.634"
                  />
                </label>
                <label className="block">
                  <span className="text-[11px] text-slate-500">アンテナ名</span>
                  <input
                    className="w-full px-2 py-1 border rounded"
                    value={slideTargetSet.antennaName ?? ''}
                    onChange={(e) =>
                      void updateSet(slideTargetSet.id, {
                        antennaName: e.target.value || null,
                      })
                    }
                    placeholder="例: DG-PRO1RWS_HA / 1232"
                  />
                </label>
                <label className="block">
                  <span className="text-[11px] text-slate-500">受信機</span>
                  <input
                    className="w-full px-2 py-1 border rounded"
                    value={slideTargetSet.receiverName ?? ''}
                    onChange={(e) =>
                      void updateSet(slideTargetSet.id, {
                        receiverName: e.target.value || null,
                      })
                    }
                    placeholder="例: DG-PRO1RWS_HA / 1231"
                  />
                </label>
              </div>
              <label className="block">
                <span className="text-[11px] text-slate-500">設定のメモ</span>
                <input
                  className="w-full px-2 py-1 border rounded"
                  value={slideTargetSet.settingsNote ?? ''}
                  onChange={(e) =>
                    void updateSet(slideTargetSet.id, {
                      settingsNote: e.target.value || null,
                    })
                  }
                  placeholder="例: アンテナ高 1.800 / FIX のみ採用"
                />
              </label>
              <div className="text-[11px] text-slate-500 font-mono pt-1 border-t">
                作業{' '}
                {slideTargetSet.startedAt
                  ? slideTargetSet.startedAt.slice(0, 16).replace('T', ' ')
                  : '—'}{' '}
                〜{' '}
                {slideTargetSet.endedAt
                  ? slideTargetSet.endedAt.slice(0, 16).replace('T', ' ')
                  : '—'}
              </div>
              <div className="text-[10px] text-slate-400">
                名前 は 空 に すると 日付 + 担当者 で 表示 されます。
              </div>
            </div>
            {/* 手簿 (セッション) の 削除。 記録 が 残って いる 場合 は 警告 を 出す。
                削除 して も staking_records は ON DELETE SET NULL で 残り、
                未振り分け タブ に 移る (記録 本体 は 消え ない)。 */}
            <div className="px-3 py-2 border-t bg-slate-50 flex items-center justify-between">
              <div className="text-[10px] text-slate-500">
                {(countBySet.get(slideTargetSet.id) ?? 0) > 0
                  ? `この 手簿 に は 記録 が ${countBySet.get(slideTargetSet.id)} 点 あります。`
                  : '記録 は ありません。'}
              </div>
              <button
                type="button"
                onClick={async () => {
                  const n = countBySet.get(slideTargetSet.id) ?? 0
                  const label = setLabel(slideTargetSet)
                  const msg =
                    n > 0
                      ? `「${label}」 を 削除 します。\n` +
                        `この 手簿 に ぶら下がる 記録 ${n} 点 は 未振り分け に なります (記録 自体 は 残ります)。\n\n削除 して よろしい ですか？`
                      : `「${label}」 を 削除 します。 記録 は ありません。\n\n削除 して よろしい ですか？`
                  if (!window.confirm(msg)) return
                  const deletedId = slideTargetSet.id
                  await deleteSet(deletedId)
                  setSessionDetailOpen(false)
                  // 直近 削除 した タブ を 見て いたら 「すべて」 に 戻す
                  setSetTab((cur) => (cur === deletedId ? 'all' : cur))
                }}
                className="inline-flex items-center gap-1 px-2 py-1 text-[11px] rounded border border-red-300 text-red-700 hover:bg-red-50"
                title={
                  (countBySet.get(slideTargetSet.id) ?? 0) > 0
                    ? '記録 が ある セッション を 削除 (確認 あり)'
                    : 'この セッション を 削除'
                }
              >
                <Trash2 className="h-3 w-3" />
                この 手簿 を 削除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
