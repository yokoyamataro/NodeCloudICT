// 立入通知書などの文書作成で使う「事務所情報」を profiles.document_settings に
// 保存 / 取得するストア。同一ユーザーなら 1 度入れれば全デバイスで使い回せる。

import { create } from 'zustand'
import { supabase } from '@/lib/supabase'
import type { DocumentSettings } from '@/types/database'

interface State {
  loading: boolean
  loadedUserId: string | null
  settings: DocumentSettings
  error: string | null

  /** 現在のユーザーの document_settings を取得（未取得 or ユーザーが変わったときのみ実行） */
  fetch: (userId: string) => Promise<void>
  /** 事務所情報を patch 保存（部分更新） */
  save: (userId: string, patch: DocumentSettings) => Promise<void>
}

export const useDocumentSettingsStore = create<State>((set, get) => ({
  loading: false,
  loadedUserId: null,
  settings: {},
  error: null,

  fetch: async (userId) => {
    if (get().loadedUserId === userId && !get().loading) return
    set({ loading: true, error: null })
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('user_id, document_settings')
        .eq('user_id', userId)
        .maybeSingle<{ user_id: string; document_settings: DocumentSettings | null }>()
      if (error) throw error
      set({
        settings: (data?.document_settings ?? {}) as DocumentSettings,
        loading: false,
        loadedUserId: userId,
      })
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : '事務所情報の取得に失敗しました',
      })
    }
  },

  save: async (userId, patch) => {
    // 楽観更新: office 部分を deep merge
    const prev = get().settings
    const next: DocumentSettings = {
      ...prev,
      office: { ...(prev.office ?? {}), ...(patch.office ?? {}) },
    }
    set({ settings: next, error: null })
    try {
      const { error } = await supabase
        .from('profiles')
        .update({ document_settings: next } as never)
        .eq('user_id', userId)
      if (error) throw error
    } catch (err) {
      set({
        settings: prev,
        error: err instanceof Error ? err.message : '事務所情報の保存に失敗しました',
      })
      throw err
    }
  },
}))
