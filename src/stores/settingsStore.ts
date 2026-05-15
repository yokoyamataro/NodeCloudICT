import { create } from 'zustand'

// 保存モードは「手動のみ」に統一済み（UI も 2026-04 に削除）。
// 旧 persist に saveMode='auto' が残っていると更新が即時 DB 書き込みされ
// hasUnsavedChanges が立たず保存ボタンが押せなくなるため、persist 自体を撤廃。
interface SettingsState {
  // 未保存の変更があるか
  hasUnsavedChanges: boolean
  setHasUnsavedChanges: (value: boolean) => void
}

export const useSettingsStore = create<SettingsState>()((set) => ({
  hasUnsavedChanges: false,
  setHasUnsavedChanges: (value) => set({ hasUnsavedChanges: value }),
}))

// 旧バージョンの localStorage に残っているキーを掃除（一度だけ）
if (typeof window !== 'undefined') {
  try {
    window.localStorage.removeItem('nodecloud-design-settings')
  } catch {
    // ignore
  }
}
