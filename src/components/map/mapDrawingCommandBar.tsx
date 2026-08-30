// ペイントの「今の道具の詳細入力」を置く場所。
//
// 文字の内容、円の半径、平行線の幅…といった入力を、地図に重なるモーダルで
// 出すと地図が隠れて作業しづらい。そこで道具アイコンのすぐ下に 1 行だけ置き、
// MapDrawingLayer からはそこへ portal する。
//
// 置き場所はページごとに違う (PC はツールバーの下、モバイルは地図の下端) ので、
// バーの実体は各ページが描き、MapDrawingLayer は「登録された場所」へ差し込む。

import { useCallback, useSyncExternalStore } from 'react'

let element: HTMLElement | null = null
const listeners = new Set<() => void>()

function emit() {
  for (const l of listeners) l()
}

function subscribe(l: () => void) {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

/** MapDrawingLayer 側: 詳細入力を差し込む先。未設置なら null */
export function useCommandBarEl(): HTMLElement | null {
  return useSyncExternalStore(
    subscribe,
    () => element,
    () => null,
  )
}

/**
 * 詳細入力の置き場所。中身が空のときは高さを持たない (empty:hidden)。
 * 1 ページに 1 つだけ置くこと。
 */
export function MapDrawingCommandBar({ className = '' }: { className?: string }) {
  const register = useCallback((node: HTMLDivElement | null) => {
    element = node
    emit()
  }, [])

  return (
    <div
      ref={register}
      className={`empty:hidden flex flex-wrap items-center gap-2 text-xs ${className}`}
    />
  )
}
