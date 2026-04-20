import { create } from 'zustand'

// ページから AppLayout のグローバル保存へ「保存関数」を登録するための軽量レジストリ
// ページは useEffect 内で register/unregister し、hasChanges と save 関数を提供する。
interface Registration {
  hasChanges: boolean
  save: () => Promise<void>
}

interface GlobalSaveRegistryState {
  registrations: Record<string, Registration>
  register: (key: string, reg: Registration) => void
  unregister: (key: string) => void
}

export const useGlobalSaveRegistry = create<GlobalSaveRegistryState>((set) => ({
  registrations: {},
  register: (key, reg) =>
    set((state) => ({
      registrations: { ...state.registrations, [key]: reg },
    })),
  unregister: (key) =>
    set((state) => {
      const next = { ...state.registrations }
      delete next[key]
      return { registrations: next }
    }),
}))

// 登録されているすべてのエントリに hasChanges があるかを取得するヘルパ
export function hasAnyRegisteredChanges(
  registrations: Record<string, Registration>,
): boolean {
  return Object.values(registrations).some((r) => r.hasChanges)
}

// 登録されているすべての保存関数を実行するヘルパ
export async function runAllRegisteredSaves(
  registrations: Record<string, Registration>,
): Promise<void> {
  const tasks = Object.values(registrations)
    .filter((r) => r.hasChanges)
    .map((r) => r.save())
  await Promise.all(tasks)
}
