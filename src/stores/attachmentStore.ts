import { create } from 'zustand'
import { supabase } from '@/lib/supabase'
import { resizeImage } from '@/lib/imageResize'

export type AttachmentEntityType = 'coordinate' | 'pipe' | 'work_area' | 'farm'

export interface Attachment {
  id: string
  projectId: string
  entityType: AttachmentEntityType | string
  entityId: string
  filePath: string
  mime: string | null
  byteSize: number | null
  category: string | null
  caption: string | null
  takenAt: string | null
  lat: number | null
  lng: number | null
  /** 撮影方向（端末方位 0=北, 90=東 ...）。座標写真には NULL でも可。 */
  headingDeg: number | null
  sortOrder: number
  createdBy: string | null
  createdAt: string
}

interface RawAttachmentRow {
  id: string
  project_id: string
  entity_type: string
  entity_id: string
  file_path: string
  mime: string | null
  byte_size: number | null
  category: string | null
  caption: string | null
  taken_at: string | null
  lat: number | null
  lng: number | null
  heading_deg: number | string | null
  sort_order: number
  created_by: string | null
  created_at: string
}

function rowToAttachment(r: RawAttachmentRow): Attachment {
  return {
    id: r.id,
    projectId: r.project_id,
    entityType: r.entity_type,
    entityId: r.entity_id,
    filePath: r.file_path,
    mime: r.mime,
    byteSize: r.byte_size,
    category: r.category,
    caption: r.caption,
    takenAt: r.taken_at,
    lat: r.lat,
    lng: r.lng,
    headingDeg: r.heading_deg == null ? null : Number(r.heading_deg),
    sortOrder: r.sort_order,
    createdBy: r.created_by,
    createdAt: r.created_at,
  }
}

const entityKey = (t: string, id: string) => `${t}:${id}`

interface SignedEntry {
  url: string
  expiresAt: number
}

interface State {
  byEntity: Map<string, Attachment[]>
  signedUrls: Map<string, SignedEntry>
  loading: boolean
  error: string | null

  fetchByEntity: (entityType: string, entityId: string) => Promise<void>
  fetchByEntityIds: (entityType: string, entityIds: string[]) => Promise<void>
  uploadPhoto: (params: {
    projectId: string
    entityType: AttachmentEntityType | string
    entityId: string
    file: File | Blob
    category: string
    caption?: string | null
    takenAt?: Date | null
    lat?: number | null
    lng?: number | null
    /** 撮影方向 (0..360 度)。工区写真など現場で「方位」を持つ写真で利用 */
    headingDeg?: number | null
    /** 既に縮小済みの Blob を渡す場合は true（再エンコードしない） */
    skipResize?: boolean
    /** 保存ファイル名（拡張子は .jpg を推奨）。省略時は uuid.jpg */
    fileName?: string
  }) => Promise<Attachment | null>
  /** 写真以外のファイル（PDF 等）を Storage に上げ、attachments 行を作る。
   *  写真と違い再エンコードや拡張子書き換えをしない（元 MIME / 元拡張子のまま保存）。 */
  uploadFile: (params: {
    projectId: string
    entityType: AttachmentEntityType | string
    entityId: string
    file: File | Blob
    /** 任意のラベル（例: 'registry_pdf'） */
    category: string
    caption?: string | null
    /** 保存ファイル名（拡張子付き）。省略時は元 File.name → なければ uuid */
    fileName?: string
  }) => Promise<Attachment | null>
  removeAttachment: (id: string) => Promise<void>
  updateAttachment: (
    id: string,
    patch: {
      takenAt?: Date | null
      caption?: string | null
      lat?: number | null
      lng?: number | null
      headingDeg?: number | null
    },
  ) => Promise<void>
  getSignedUrl: (filePath: string) => Promise<string | null>
}

export const useAttachmentStore = create<State>((set, get) => ({
  byEntity: new Map(),
  signedUrls: new Map(),
  loading: false,
  error: null,

  fetchByEntity: async (entityType, entityId) => {
    set({ loading: true, error: null })
    try {
      const { data, error } = await (
        supabase.from('attachments' as never) as unknown as {
          select: (cols: string) => {
            eq: (c: string, v: string) => {
              eq: (c: string, v: string) => {
                order: (c: string, o: { ascending: boolean }) => Promise<{
                  data: RawAttachmentRow[] | null
                  error: { message: string } | null
                }>
              }
            }
          }
        }
      )
        .select('*')
        .eq('entity_type', entityType)
        .eq('entity_id', entityId)
        .order('sort_order', { ascending: true })
      if (error) throw error
      const rows = (data ?? []).map(rowToAttachment)
      const next = new Map(get().byEntity)
      next.set(entityKey(entityType, entityId), rows)
      set({ byEntity: next, loading: false })
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : '写真の取得に失敗しました',
      })
    }
  },

  fetchByEntityIds: async (entityType, entityIds) => {
    if (entityIds.length === 0) return
    set({ loading: true, error: null })
    try {
      const { data, error } = await (
        supabase.from('attachments' as never) as unknown as {
          select: (cols: string) => {
            eq: (c: string, v: string) => {
              in: (c: string, v: string[]) => {
                order: (c: string, o: { ascending: boolean }) => Promise<{
                  data: RawAttachmentRow[] | null
                  error: { message: string } | null
                }>
              }
            }
          }
        }
      )
        .select('*')
        .eq('entity_type', entityType)
        .in('entity_id', entityIds)
        .order('sort_order', { ascending: true })
      if (error) throw error
      const next = new Map(get().byEntity)
      // 該当 entity 全てを一旦空に
      for (const id of entityIds) next.set(entityKey(entityType, id), [])
      for (const r of data ?? []) {
        const a = rowToAttachment(r)
        const k = entityKey(entityType, a.entityId)
        next.set(k, [...(next.get(k) ?? []), a])
      }
      set({ byEntity: next, loading: false })
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : '写真の取得に失敗しました',
      })
    }
  },

  uploadPhoto: async ({
    projectId,
    entityType,
    entityId,
    file,
    category,
    caption = null,
    takenAt = null,
    lat = null,
    lng = null,
    headingDeg = null,
    skipResize = false,
  }) => {
    try {
      // skipResize=true: 既に縮小済みの Blob を再エンコードせずそのまま使う
      const uploadBlob: Blob = skipResize
        ? file
        : (await resizeImage(file, { maxSize: 1600, quality: 0.8 })).blob
      const uploadMime = skipResize ? (file.type || 'image/jpeg') : 'image/jpeg'
      const ext = 'jpg'
      const uuid = (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`)
      const path = `${projectId}/${entityType}/${entityId}/${uuid}.${ext}`

      // Storage へアップロード
      const { error: uploadErr } = await supabase.storage
        .from('attachments')
        .upload(path, uploadBlob, {
          contentType: uploadMime,
          cacheControl: '3600',
          upsert: false,
        })
      if (uploadErr) throw uploadErr

      // 行を insert
      const existing = get().byEntity.get(entityKey(entityType, entityId)) ?? []
      const sortOrder = existing.length
      const userRes = await supabase.auth.getUser()
      const insertPayload = {
        project_id: projectId,
        entity_type: entityType,
        entity_id: entityId,
        file_path: path,
        mime: uploadMime,
        byte_size: uploadBlob.size,
        category,
        caption,
        taken_at: takenAt ? takenAt.toISOString() : null,
        lat,
        lng,
        heading_deg: headingDeg ?? null,
        sort_order: sortOrder,
        created_by: userRes.data.user?.id ?? null,
      }
      const { data, error } = await (
        supabase.from('attachments' as never) as unknown as {
          insert: (p: typeof insertPayload) => {
            select: (cols: string) => {
              single: () => Promise<{
                data: RawAttachmentRow | null
                error: { message: string } | null
              }>
            }
          }
        }
      )
        .insert(insertPayload)
        .select('*')
        .single()
      if (error) {
        // Storage のオブジェクトをロールバック
        await supabase.storage.from('attachments').remove([path]).catch(() => {})
        throw error
      }
      if (!data) throw new Error('保存結果が取得できません')
      const saved = rowToAttachment(data)
      const next = new Map(get().byEntity)
      next.set(entityKey(entityType, entityId), [...existing, saved])
      set({ byEntity: next })
      return saved
    } catch (err) {
      set({ error: err instanceof Error ? err.message : '写真のアップロードに失敗しました' })
      return null
    }
  },

  uploadFile: async ({
    projectId,
    entityType,
    entityId,
    file,
    category,
    caption = null,
    fileName,
  }) => {
    try {
      const sourceName =
        fileName ||
        (file instanceof File && file.name ? file.name : `${crypto.randomUUID?.() ?? Date.now()}.bin`)
      // 拡張子は元ファイル名から取り出す（無ければ bin）
      const dotIdx = sourceName.lastIndexOf('.')
      const ext = dotIdx >= 0 ? sourceName.slice(dotIdx + 1).toLowerCase() : 'bin'
      const mime = file instanceof File && file.type ? file.type : 'application/octet-stream'
      const uuid = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
      // 同種カテゴリのファイル同士でぶつからないよう category を path に含める
      const path = `${projectId}/${entityType}/${entityId}/${category}/${uuid}.${ext}`

      const { error: uploadErr } = await supabase.storage
        .from('attachments')
        .upload(path, file, { contentType: mime, cacheControl: '3600', upsert: false })
      if (uploadErr) throw uploadErr

      const existing = get().byEntity.get(entityKey(entityType, entityId)) ?? []
      const sortOrder = existing.length
      const userRes = await supabase.auth.getUser()
      const insertPayload = {
        project_id: projectId,
        entity_type: entityType,
        entity_id: entityId,
        file_path: path,
        mime,
        byte_size: file.size,
        category,
        caption,
        taken_at: null,
        lat: null,
        lng: null,
        heading_deg: null,
        sort_order: sortOrder,
        created_by: userRes.data.user?.id ?? null,
      }
      const { data, error } = await (
        supabase.from('attachments' as never) as unknown as {
          insert: (p: typeof insertPayload) => {
            select: (cols: string) => {
              single: () => Promise<{
                data: RawAttachmentRow | null
                error: { message: string } | null
              }>
            }
          }
        }
      )
        .insert(insertPayload)
        .select('*')
        .single()
      if (error) {
        await supabase.storage.from('attachments').remove([path]).catch(() => {})
        throw error
      }
      if (!data) throw new Error('保存結果が取得できません')
      const saved = rowToAttachment(data)
      const next = new Map(get().byEntity)
      next.set(entityKey(entityType, entityId), [...existing, saved])
      set({ byEntity: next })
      return saved
    } catch (err) {
      const e = err as Partial<{ message: string }> | null
      set({ error: e?.message || 'ファイルのアップロードに失敗しました' })
      // eslint-disable-next-line no-console
      console.error('[attachmentStore] uploadFile failed', err)
      return null
    }
  },

  removeAttachment: async (id) => {
    const all = Array.from(get().byEntity.values()).flat()
    const target = all.find((a) => a.id === id)
    if (!target) return
    try {
      // Storage オブジェクト削除（無視できるエラーは握りつぶす）
      await supabase.storage.from('attachments').remove([target.filePath]).catch(() => {})
      const { error } = await (
        supabase.from('attachments' as never) as unknown as {
          delete: () => {
            eq: (c: string, v: string) => Promise<{ error: { message: string } | null }>
          }
        }
      )
        .delete()
        .eq('id', id)
      if (error) throw error
      const next = new Map(get().byEntity)
      const k = entityKey(target.entityType, target.entityId)
      next.set(k, (next.get(k) ?? []).filter((a) => a.id !== id))
      set({ byEntity: next })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : '写真の削除に失敗しました' })
    }
  },

  updateAttachment: async (id, patch) => {
    const all = Array.from(get().byEntity.values()).flat()
    const target = all.find((a) => a.id === id)
    if (!target) return
    const payload: Record<string, string | number | null> = {}
    if (Object.prototype.hasOwnProperty.call(patch, 'takenAt')) {
      payload.taken_at = patch.takenAt ? patch.takenAt.toISOString() : null
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'caption')) {
      payload.caption = patch.caption ?? null
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'lat')) {
      payload.lat = patch.lat ?? null
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'lng')) {
      payload.lng = patch.lng ?? null
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'headingDeg')) {
      payload.heading_deg = patch.headingDeg ?? null
    }
    if (Object.keys(payload).length === 0) return
    try {
      const { error } = await (
        supabase.from('attachments' as never) as unknown as {
          update: (p: typeof payload) => {
            eq: (c: string, v: string) => Promise<{ error: { message: string } | null }>
          }
        }
      )
        .update(payload)
        .eq('id', id)
      if (error) throw error
      // ローカルにも反映
      const next = new Map(get().byEntity)
      const k = entityKey(target.entityType, target.entityId)
      next.set(
        k,
        (next.get(k) ?? []).map((a) =>
          a.id === id
            ? {
                ...a,
                takenAt: Object.prototype.hasOwnProperty.call(patch, 'takenAt')
                  ? patch.takenAt
                    ? patch.takenAt.toISOString()
                    : null
                  : a.takenAt,
                caption: Object.prototype.hasOwnProperty.call(patch, 'caption')
                  ? patch.caption ?? null
                  : a.caption,
                lat: Object.prototype.hasOwnProperty.call(patch, 'lat')
                  ? patch.lat ?? null
                  : a.lat,
                lng: Object.prototype.hasOwnProperty.call(patch, 'lng')
                  ? patch.lng ?? null
                  : a.lng,
                headingDeg: Object.prototype.hasOwnProperty.call(patch, 'headingDeg')
                  ? patch.headingDeg ?? null
                  : a.headingDeg,
              }
            : a,
        ),
      )
      set({ byEntity: next })
    } catch (err) {
      set({ error: err instanceof Error ? err.message : '写真の更新に失敗しました' })
    }
  },

  getSignedUrl: async (filePath) => {
    const cached = get().signedUrls.get(filePath)
    const now = Date.now()
    if (cached && cached.expiresAt > now + 60_000) return cached.url
    const { data, error } = await supabase.storage
      .from('attachments')
      .createSignedUrl(filePath, 60 * 30) // 30 分
    if (error || !data) return null
    const next = new Map(get().signedUrls)
    next.set(filePath, { url: data.signedUrl, expiresAt: now + 60 * 30 * 1000 })
    set({ signedUrls: next })
    return data.signedUrl
  },
}))
