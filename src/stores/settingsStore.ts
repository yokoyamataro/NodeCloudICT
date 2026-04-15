import { create } from 'zustand'
import { persist } from 'zustand/middleware'

type SaveMode = 'auto' | 'manual'

interface SettingsState {
  // 保存モード
  saveMode: SaveMode
  setSaveMode: (mode: SaveMode) => void

  // 未保存の変更があるか
  hasUnsavedChanges: boolean
  setHasUnsavedChanges: (value: boolean) => void
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      saveMode: 'manual',
      setSaveMode: (mode) => set({ saveMode: mode }),

      hasUnsavedChanges: false,
      setHasUnsavedChanges: (value) => set({ hasUnsavedChanges: value }),
    }),
    {
      name: 'nodecloud-design-settings',
    }
  )
)
