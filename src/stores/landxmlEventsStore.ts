// LandXML の アップロード / 削除 を 他 ページ に 通知 する 軽い イベント ストア。
//   - version: 単調 増加 カウンタ (どこ で 何 が 変わった かは 気にしない)
//   - bump():  1 増やす
//
// 使用例:
//   const v = useLandxmlEventsStore((s) => s.version)
//   useEffect(() => { refetch() }, [farmId, v])
//
// LandXML の 追加/差替/削除 を 行った 側 で bump() を 呼べば、購読側 は 自動再取得。
// Zustand 経由 で 同一 タブ 内 の 全 コンポーネント に 伝播 する。

import { create } from 'zustand'

interface LandxmlEventsState {
  version: number
  bump: () => void
}

export const useLandxmlEventsStore = create<LandxmlEventsState>((set) => ({
  version: 0,
  bump: () => set((s) => ({ version: s.version + 1 })),
}))
