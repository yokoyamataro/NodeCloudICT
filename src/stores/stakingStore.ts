import { create } from 'zustand'
import { Capacitor } from '@capacitor/core'
import { supabase } from '@/lib/supabase'
import { CoordinateConverter } from '@/lib/coordinates'
import {
  enqueueMeasurement,
  isQueueFull,
  queueLength,
  readQueue,
  removeFromQueue,
  type QueuedCoordinate,
  type QueuedMeasurement,
} from '@/lib/offlineStakingQueue'

export type StakingTargetType = 'coordinate' | 'pipe_vertex' | 'free'
export type SurveyCategory = 'initial' | 'asbuilt' // 起工 / 出来形

export interface StakingRecord {
  id: string
  farmId: string
  surveyCategory: SurveyCategory
  targetType: StakingTargetType
  targetRefId: string | null
  targetVertexIndex: number | null
  targetName: string | null
  targetX: number | null
  targetY: number | null
  targetZ: number | null
  measuredX: number
  measuredY: number
  measuredZ: number | null
  accuracy: number | null
  sampleCount: number | null
  durationSeconds: number | null
  recordedAt: string
  notes: string | null
  /** true = まだ Supabase に 送れていない ローカル退避分 (iOS オフライン計測)。
   *  UI は これを 見て 「未送信」表示 + 写真操作の 抑止を 行う。 */
  pending?: boolean
}

interface StakingRecordRow {
  id: string
  farm_id: string
  survey_category: SurveyCategory | null
  target_type: StakingTargetType
  target_ref_id: string | null
  target_vertex_index: number | null
  target_name: string | null
  target_x: number | null
  target_y: number | null
  target_z: number | null
  measured_x: number
  measured_y: number
  measured_z: number | null
  accuracy: number | null
  sample_count: number | null
  duration_seconds: number | null
  recorded_at: string
  notes: string | null
}

function rowToRecord(r: StakingRecordRow): StakingRecord {
  return {
    id: r.id,
    farmId: r.farm_id,
    surveyCategory: r.survey_category ?? 'initial',
    targetType: r.target_type,
    targetRefId: r.target_ref_id,
    targetVertexIndex: r.target_vertex_index,
    targetName: r.target_name,
    targetX: r.target_x != null ? Number(r.target_x) : null,
    targetY: r.target_y != null ? Number(r.target_y) : null,
    targetZ: r.target_z != null ? Number(r.target_z) : null,
    measuredX: Number(r.measured_x),
    measuredY: Number(r.measured_y),
    measuredZ: r.measured_z != null ? Number(r.measured_z) : null,
    accuracy: r.accuracy != null ? Number(r.accuracy) : null,
    sampleCount: r.sample_count,
    durationSeconds: r.duration_seconds != null ? Number(r.duration_seconds) : null,
    recordedAt: r.recorded_at,
    notes: r.notes,
  }
}

// ============================================================================
// オフライン退避 (iOS のみ)
// ============================================================================

/** オフライン退避を 使うのは iOS ネイティブのみ。Web / Android は 従来どおり */
function offlineEnabled(): boolean {
  return Capacitor.getPlatform() === 'ios'
}

/**
 * 「通信できなかった」失敗かを 判定する。
 * RLS 違反や 制約違反を キューに 積むと 永久に 送れず 溜まり続けるので、
 * 通信系の 失敗だけを 退避対象に する。
 */
function isNetworkError(err: unknown): boolean {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true
  // fetch の 失敗は TypeError で 飛んでくる
  if (err instanceof TypeError) return true
  const msg = err instanceof Error ? err.message : String(err)
  return /failed to fetch|networkerror|load failed|network request failed|the internet connection|timeout|timed out|ECONNREFUSED|ENOTFOUND/i.test(
    msg,
  )
}

function queuedToRecord(q: QueuedMeasurement): StakingRecord {
  return {
    id: q.id,
    farmId: q.record.farmId,
    surveyCategory: q.record.surveyCategory as SurveyCategory,
    targetType: q.record.targetType as StakingTargetType,
    targetRefId: q.record.targetRefId,
    targetVertexIndex: q.record.targetVertexIndex,
    targetName: q.record.targetName,
    targetX: q.record.targetX,
    targetY: q.record.targetY,
    targetZ: q.record.targetZ,
    measuredX: q.record.measuredX,
    measuredY: q.record.measuredY,
    measuredZ: q.record.measuredZ,
    accuracy: q.record.accuracy,
    sampleCount: q.record.sampleCount,
    durationSeconds: q.record.durationSeconds,
    recordedAt: q.queuedAt,
    notes: q.record.notes,
    pending: true,
  }
}

/**
 * 同名の 点が 既にあれば "名前(2)" → "名前(3)" … と 空きを 探す。
 * オフライン中は 最新の 座標一覧が 引けないため、送信時 (オンライン) に 解決する。
 */
async function resolveUniquePointNumber(farmId: string, base: string): Promise<string> {
  const { data, error } = await supabase
    .from('design_coordinates')
    .select('point_number')
    .eq('farm_id', farmId)
    .like('point_number', `${base}%`)
  if (error) return base // 引けないなら そのまま出す (重複は 許容)
  const taken = new Set((data ?? []).map((r) => (r as { point_number: string }).point_number))
  if (!taken.has(base)) return base
  for (let n = 2; n <= 999; n += 1) {
    const cand = `${base}(${n})`
    if (!taken.has(cand)) return cand
  }
  return `${base}(${Date.now()})`
}

export type SaveMeasurementResult =
  | { status: 'saved'; record: StakingRecord }
  | { status: 'queued'; record: StakingRecord }
  | { status: 'full' }
  | { status: 'error'; message: string }

interface StakingState {
  records: StakingRecord[]
  loading: boolean
  saving: boolean
  error: string | null
  /** 未送信 (ローカル退避) 件数。UI の バッジ表示用 */
  pendingCount: number
  /** 直前の addRecord の 失敗が 通信断由来だったか (退避するかの 判定に 使う) */
  lastFailureWasNetwork: boolean

  fetchRecords: (farmId: string) => Promise<void>
  /** オフライン スナップショット (staking_records の 生行) から 復元する。
   *  未送信の ローカル退避分も 併せて 載せる */
  hydrateRecords: (rows: unknown[], farmId: string) => void
  addRecord: (record: Omit<StakingRecord, 'id' | 'recordedAt'>) => Promise<StakingRecord | null>
  /**
   * 実測記録を 保存する。オンラインなら 従来どおり Supabase に insert し、
   * iOS で 通信断なら 座標管理行と セットで ローカルに 退避する。
   * coordinate は 退避時のみ 使う (オンライン時の 座標管理登録は
   * 呼出側が importCoordinates で 行い、地図に 即反映させる)。
   */
  saveMeasurement: (
    record: Omit<StakingRecord, 'id' | 'recordedAt'>,
    coordinate: QueuedCoordinate | null,
    meta: { zone: number },
  ) => Promise<SaveMeasurementResult>
  /** 未送信分を 古い順に 送る。1 件でも 通信で 落ちたら そこで 中断して 残す */
  flushOfflineQueue: () => Promise<{ sent: number; remaining: number }>
  refreshPendingCount: () => void
  deleteRecord: (id: string) => Promise<void>
}

export const useStakingStore = create<StakingState>()((set, get) => ({
  records: [],
  loading: false,
  saving: false,
  error: null,
  pendingCount: queueLength(),
  lastFailureWasNetwork: false,

  refreshPendingCount: () => set({ pendingCount: queueLength() }),

  fetchRecords: async (farmId) => {
    set({ loading: true, error: null })
    // 未送信分は サーバに 無いので、取得結果に 必ず 混ぜる。
    // これを しないと 画面遷移や 再取得の たびに ローカル計測が 消える。
    const pending = readQueue()
      .filter((q) => q.farmId === farmId)
      .map(queuedToRecord)
    try {
      const { data, error } = await supabase
        .from('staking_records')
        .select('*')
        .eq('farm_id', farmId)
        .order('recorded_at', { ascending: false })
      if (error) throw error
      const server = (data as StakingRecordRow[]).map(rowToRecord)
      const serverIds = new Set(server.map((r) => r.id))
      set({
        records: [...pending.filter((p) => !serverIds.has(p.id)), ...server],
        loading: false,
        pendingCount: queueLength(),
      })
    } catch (err) {
      // 圏外で 一覧が 引けなくても、ローカル退避分だけは 見せる
      set({
        records: pending,
        loading: false,
        pendingCount: queueLength(),
        error: err instanceof Error ? err.message : '実測記録の取得に失敗しました',
      })
    }
  },

  hydrateRecords: (rows, farmId) => {
    const server = (rows as StakingRecordRow[]).map(rowToRecord)
    const serverIds = new Set(server.map((r) => r.id))
    const pending = readQueue()
      .filter((q) => q.farmId === farmId)
      .map(queuedToRecord)
      .filter((p) => !serverIds.has(p.id))
    set({
      records: [...pending, ...server],
      loading: false,
      pendingCount: queueLength(),
      error: null,
    })
  },

  addRecord: async (rec) => {
    set({ saving: true, error: null })
    try {
      const row = {
        farm_id: rec.farmId,
        survey_category: rec.surveyCategory,
        target_type: rec.targetType,
        target_ref_id: rec.targetRefId,
        target_vertex_index: rec.targetVertexIndex,
        target_name: rec.targetName,
        target_x: rec.targetX,
        target_y: rec.targetY,
        target_z: rec.targetZ,
        measured_x: rec.measuredX,
        measured_y: rec.measuredY,
        measured_z: rec.measuredZ,
        accuracy: rec.accuracy,
        sample_count: rec.sampleCount,
        duration_seconds: rec.durationSeconds,
        notes: rec.notes,
      }
      const { data, error } = await supabase
        .from('staking_records')
        .insert(row as never)
        .select()
        .single()
      if (error) throw error
      const saved = rowToRecord(data as StakingRecordRow)
      set((s) => ({ records: [saved, ...s.records], saving: false, lastFailureWasNetwork: false }))
      return saved
    } catch (err) {
      set({
        saving: false,
        lastFailureWasNetwork: isNetworkError(err),
        error: err instanceof Error ? err.message : '実測記録の保存に失敗しました',
      })
      return null
    }
  },

  saveMeasurement: async (rec, coordinate, meta) => {
    const saved = await get().addRecord(rec)
    if (saved) return { status: 'saved', record: saved }

    // ここに来たのは insert 失敗。通信断 かつ iOS のときだけ ローカル退避する
    if (!offlineEnabled() || !get().lastFailureWasNetwork) {
      return { status: 'error', message: get().error ?? '実測記録の保存に失敗しました' }
    }
    if (isQueueFull()) return { status: 'full' }

    let userId: string | null = null
    try {
      const { data } = await supabase.auth.getUser()
      userId = data.user?.id ?? null
    } catch {
      /* オフラインで 引けないことがある。null のまま 送信時に 埋める */
    }
    const item: QueuedMeasurement = {
      id: crypto.randomUUID(),
      farmId: rec.farmId,
      zone: meta.zone,
      userId,
      queuedAt: new Date().toISOString(),
      record: {
        farmId: rec.farmId,
        surveyCategory: rec.surveyCategory,
        targetType: rec.targetType,
        targetRefId: rec.targetRefId,
        targetVertexIndex: rec.targetVertexIndex,
        targetName: rec.targetName,
        targetX: rec.targetX,
        targetY: rec.targetY,
        targetZ: rec.targetZ,
        measuredX: rec.measuredX,
        measuredY: rec.measuredY,
        measuredZ: rec.measuredZ,
        accuracy: rec.accuracy,
        sampleCount: rec.sampleCount,
        durationSeconds: rec.durationSeconds,
        notes: rec.notes,
      },
      coordinate,
    }
    if (!enqueueMeasurement(item)) {
      return { status: 'error', message: 'ローカル保存に失敗しました (端末の空き容量を確認してください)' }
    }
    const local = queuedToRecord(item)
    set((s) => ({
      records: [local, ...s.records],
      pendingCount: queueLength(),
      error: null,
    }))
    return { status: 'queued', record: local }
  },

  flushOfflineQueue: async () => {
    const queue = readQueue()
    if (queue.length === 0) {
      set({ pendingCount: 0 })
      return { sent: 0, remaining: 0 }
    }
    let uid: string | null = null
    try {
      const { data } = await supabase.auth.getUser()
      uid = data.user?.id ?? null
    } catch {
      /* 送信できる状態なら 通常は 引ける */
    }

    const sentIds: string[] = []
    const touchedFarms = new Set<string>()
    for (const q of queue) {
      try {
        // 点名の 重複解決は オンラインの 今しかできない。
        // staking_records 側の 点名も 揃えて 食い違いを 防ぐ。
        let pointNumber = q.coordinate?.pointNumber ?? null
        if (q.coordinate) {
          pointNumber = await resolveUniquePointNumber(q.farmId, q.coordinate.pointNumber)
        }
        const targetName =
          q.coordinate && pointNumber && q.record.targetName === q.coordinate.pointNumber
            ? pointNumber
            : q.record.targetName

        // id を 明示して upsert。二重送信でも 1 行にしか ならない
        const { error: recErr } = await supabase.from('staking_records').upsert(
          {
            id: q.id,
            farm_id: q.record.farmId,
            survey_category: q.record.surveyCategory,
            target_type: q.record.targetType,
            target_ref_id: q.record.targetRefId,
            target_vertex_index: q.record.targetVertexIndex,
            target_name: targetName,
            target_x: q.record.targetX,
            target_y: q.record.targetY,
            target_z: q.record.targetZ,
            measured_x: q.record.measuredX,
            measured_y: q.record.measuredY,
            measured_z: q.record.measuredZ,
            accuracy: q.record.accuracy,
            sample_count: q.record.sampleCount,
            duration_seconds: q.record.durationSeconds,
            recorded_at: q.queuedAt,
            notes: q.record.notes,
          } as never,
          { onConflict: 'id' },
        )
        if (recErr) throw recErr

        if (q.coordinate && pointNumber) {
          const converter = new CoordinateConverter(q.zone)
          const { lat, lng } = converter.toLatLng(q.coordinate.x, q.coordinate.y)
          const owner = q.userId ?? uid
          const { error: coordErr } = await supabase.from('design_coordinates').insert({
            farm_id: q.farmId,
            point_number: pointNumber,
            x: q.coordinate.x,
            y: q.coordinate.y,
            z: q.coordinate.z,
            coordinate_type: q.coordinate.type,
            stake_type: null,
            latitude: lat,
            longitude: lng,
            notes: q.coordinate.notes,
            created_by: owner,
            updated_by: owner,
          } as never)
          // 座標管理側の 失敗は 測点本体を 巻き戻す ほどではない。
          // (点名衝突などは 上で 解決済み。残るのは 権限系)
          if (coordErr) console.warn('[offline flush] 座標管理登録に失敗:', coordErr.message)
        }
        sentIds.push(q.id)
        touchedFarms.add(q.farmId)
      } catch (err) {
        if (isNetworkError(err)) break // まだ 圏外。残りは 次回に 回す
        // 通信以外の 恒久的な 失敗は 積んでも 送れないので 落とす
        console.warn('[offline flush] 送信不能のため破棄:', q.id, err)
        sentIds.push(q.id)
      }
    }

    removeFromQueue(sentIds)
    const remaining = queueLength()
    set({ pendingCount: remaining })
    if (touchedFarms.size > 0) {
      // 座標管理の キャッシュを 落として マーカーを 出し直す
      const { useCoordinateStore } = await import('./coordinateStore')
      useCoordinateStore.getState().invalidateCache()
      const farmId = [...touchedFarms][0]
      await get().fetchRecords(farmId)
    }
    return { sent: sentIds.length, remaining }
  },

  deleteRecord: async (id) => {
    // 未送信分は サーバに 無いので キューから 落とすだけ
    if (readQueue().some((q) => q.id === id)) {
      removeFromQueue([id])
      set((s) => ({
        records: s.records.filter((r) => r.id !== id),
        pendingCount: queueLength(),
      }))
      return
    }
    set({ saving: true, error: null })
    try {
      const { error } = await supabase.from('staking_records').delete().eq('id', id)
      if (error) throw error
      set((s) => ({ records: s.records.filter((r) => r.id !== id), saving: false }))
    } catch (err) {
      set({
        saving: false,
        error: err instanceof Error ? err.message : '実測記録の削除に失敗しました',
      })
    }
  },
}))
