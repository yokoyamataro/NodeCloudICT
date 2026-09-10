// 例外を 画面に 出せる 文字列 に する。
//
// Supabase (PostgREST / Storage / Auth) の エラー は Error の インスタンス
// では なく ただの オブジェクト ({ message, details, hint, code } など) で
// 飛んでくる。 `err instanceof Error ? err.message : '…に失敗しました'` と
// 書くと 必ず 後者に 落ちて、原因 (RLS / statement timeout / 列違い) が
// 一切 分からなく なる。 その 取りこぼし を 防ぐ ため の 共通処理。

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  if (e && typeof e === 'object') {
    const o = e as {
      message?: unknown
      error_description?: unknown
      hint?: unknown
      details?: unknown
      code?: unknown
    }
    const parts = [o.message, o.error_description, o.details, o.hint]
      .filter((v): v is string => typeof v === 'string' && v.length > 0)
    const code = typeof o.code === 'string' && o.code.length > 0 ? ` (${o.code})` : ''
    if (parts.length > 0) return parts.join(' / ') + code
    try {
      return JSON.stringify(e)
    } catch {
      return '不明なエラー'
    }
  }
  return String(e)
}
