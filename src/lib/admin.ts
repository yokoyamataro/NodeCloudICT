// 管理者（申し込み管理などの権限）判定。
// 必要に応じてメールを追加する。RLS 側（DB）でも同じメールで制限している。
export const ADMIN_EMAILS = ['yokoyama1980@gmail.com']

export function isAdmin(email: string | null | undefined): boolean {
  if (!email) return false
  return ADMIN_EMAILS.includes(email.toLowerCase())
}
