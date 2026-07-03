// Word テンプレートの CRUD ストア。
// テンプレート本体 (.docx) は Supabase Storage 'templates' に、
// メタは document_templates テーブルに、共有先は document_template_shares に保存する。

import { create } from 'zustand'
import { supabase } from '@/lib/supabase'
import type { DocumentTemplate } from '@/types/database'

// Supabase の PostgrestError / StorageError は Error 継承ではないので、
// message / details / hint / code を拾って 1 行にまとめる。
function msg(err: unknown, fallback: string): string {
  const e = err as
    | (Partial<{ message: string; code: string; details: string; hint: string; error: string }> &
        Record<string, unknown>)
    | null
  const parts = [
    e?.message,
    e?.error,
    e?.details,
    e?.hint,
    e?.code ? `(code: ${e.code})` : null,
  ].filter((s): s is string => typeof s === 'string' && s.length > 0)
  return parts.length > 0 ? parts.join(' — ') : fallback
}

export interface ShareCandidate {
  user_id: string
  email: string
  full_name: string | null
}

interface State {
  templates: DocumentTemplate[]
  /** templateId → 共有先 user_id[] */
  sharesByTemplateId: Map<string, string[]>
  shareCandidates: ShareCandidate[]
  loading: boolean
  error: string | null

  fetchAll: () => Promise<void>
  fetchShares: (templateId: string) => Promise<void>
  fetchShareCandidates: () => Promise<void>
  uploadTemplate: (params: {
    name: string
    description?: string | null
    file: File | Blob
  }) => Promise<DocumentTemplate | null>
  updateTemplate: (
    id: string,
    patch: Partial<Pick<DocumentTemplate, 'name' | 'description'>>,
  ) => Promise<void>
  deleteTemplate: (id: string) => Promise<void>
  setShares: (templateId: string, userIds: string[]) => Promise<void>
  downloadTemplateBlob: (template: DocumentTemplate) => Promise<Blob | null>
}

interface ShareRow {
  template_id: string
  shared_with_user_id: string
}

export const useDocumentTemplateStore = create<State>((set, get) => ({
  templates: [],
  sharesByTemplateId: new Map(),
  shareCandidates: [],
  loading: false,
  error: null,

  fetchAll: async () => {
    set({ loading: true, error: null })
    try {
      // RLS で「自分の or 共有された」ものだけ返る
      const { data, error } = await supabase
        .from('document_templates')
        .select('*')
        .order('created_at', { ascending: false })
      if (error) throw error
      set({ templates: (data ?? []) as DocumentTemplate[], loading: false })
    } catch (err) {
      set({
        loading: false,
        error: msg(err, 'テンプレート一覧の取得に失敗しました'),
      })
    }
  },

  fetchShares: async (templateId) => {
    try {
      const { data, error } = await supabase
        .from('document_template_shares')
        .select('template_id, shared_with_user_id')
        .eq('template_id', templateId)
      if (error) throw error
      const ids = ((data ?? []) as ShareRow[]).map((r) => r.shared_with_user_id)
      const next = new Map(get().sharesByTemplateId)
      next.set(templateId, ids)
      set({ sharesByTemplateId: next })
    } catch (err) {
      set({
        error: msg(err, '共有情報の取得に失敗しました'),
      })
    }
  },

  fetchShareCandidates: async () => {
    try {
      const { data, error } = await (
        supabase.rpc as unknown as (
          fn: string,
        ) => Promise<{ data: ShareCandidate[] | null; error: { message: string } | null }>
      )('list_share_candidates')
      if (error) throw error
      set({ shareCandidates: (data ?? []) as ShareCandidate[] })
    } catch (err) {
      set({
        error: msg(err, '共有候補ユーザーの取得に失敗しました'),
      })
    }
  },

  uploadTemplate: async ({ name, description, file }) => {
    set({ error: null })
    // eslint-disable-next-line no-console
    console.info('[documentTemplateStore] uploadTemplate start', { name, size: file.size })
    try {
      const { data: userData, error: uErr } = await supabase.auth.getUser()
      if (uErr) throw uErr
      const uid = userData.user?.id
      if (!uid) throw new Error('ログインが必要です')

      // 先に document_templates 行を作って id を確保 → その id を使って Storage に配置
      const templateId =
        crypto.randomUUID?.() ??
        `${Date.now()}-${Math.random().toString(36).slice(2)}`
      const storagePath = `${uid}/${templateId}.docx`

      // Storage にアップロード
      const { error: upErr } = await supabase.storage
        .from('templates')
        .upload(storagePath, file, {
          contentType:
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          cacheControl: '3600',
          upsert: false,
        })
      if (upErr) throw upErr

      // メタ行を INSERT
      const insertBody = {
        id: templateId,
        owner_user_id: uid,
        name,
        description: description ?? null,
        storage_path: storagePath,
      }
      const { data, error } = await supabase
        .from('document_templates')
        .insert(insertBody as never)
        .select('*')
        .single()
      if (error) {
        // Storage のオーファンを掃除
        await supabase.storage.from('templates').remove([storagePath]).catch(() => {})
        throw error
      }
      const created = data as DocumentTemplate
      set((state) => ({ templates: [created, ...state.templates] }))
      return created
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[documentTemplateStore] uploadTemplate failed', err)
      set({
        error: msg(err, 'テンプレートのアップロードに失敗しました'),
      })
      return null
    }
  },

  updateTemplate: async (id, patch) => {
    const prev = get().templates
    // 楽観更新
    set({
      templates: prev.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    })
    try {
      const payload: Record<string, string | null> = {}
      if (patch.name !== undefined) payload.name = patch.name
      if (patch.description !== undefined) payload.description = patch.description ?? null
      if (Object.keys(payload).length === 0) return
      const { error } = await supabase
        .from('document_templates')
        .update(payload as never)
        .eq('id', id)
      if (error) throw error
    } catch (err) {
      set({
        templates: prev,
        error: msg(err, 'テンプレート更新に失敗しました'),
      })
    }
  },

  deleteTemplate: async (id) => {
    const prev = get().templates
    const target = prev.find((t) => t.id === id)
    // 楽観削除
    set({ templates: prev.filter((t) => t.id !== id) })
    try {
      // Storage 本体
      if (target?.storage_path) {
        await supabase.storage.from('templates').remove([target.storage_path]).catch(() => {})
      }
      // メタ行（shares は CASCADE で消える）
      const { error } = await supabase.from('document_templates').delete().eq('id', id)
      if (error) throw error
    } catch (err) {
      set({
        templates: prev,
        error: msg(err, 'テンプレート削除に失敗しました'),
      })
    }
  },

  setShares: async (templateId, userIds) => {
    try {
      // 既存を全削除して置換（件数少ないので単純に）
      const { error: delErr } = await supabase
        .from('document_template_shares')
        .delete()
        .eq('template_id', templateId)
      if (delErr) throw delErr
      if (userIds.length > 0) {
        const rows = userIds.map((uid) => ({
          template_id: templateId,
          shared_with_user_id: uid,
        }))
        const { error: insErr } = await supabase
          .from('document_template_shares')
          .insert(rows as never)
        if (insErr) throw insErr
      }
      const next = new Map(get().sharesByTemplateId)
      next.set(templateId, userIds)
      set({ sharesByTemplateId: next })
    } catch (err) {
      set({
        error: msg(err, '共有設定の保存に失敗しました'),
      })
      throw err
    }
  },

  downloadTemplateBlob: async (template) => {
    try {
      const { data, error } = await supabase.storage
        .from('templates')
        .download(template.storage_path)
      if (error) throw error
      return data
    } catch (err) {
      set({
        error: msg(err, 'テンプレートのダウンロードに失敗しました'),
      })
      return null
    }
  },
}))
