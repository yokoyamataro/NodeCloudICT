// 契約内容 の 変更 / 退会 の 申請 窓口 ページ。 /settings/account
//
// 役割別 の 挙動:
//   - サイトオーナー (isAdmin): 自分 で 組織台帳 を 直接 編集 できる ので 簡易案内 のみ
//   - 組織管理者 (isOrgAdmin): メール / 電話 で NodeCloud 事務局 へ 申請
//   - 一般 メンバー: 組織管理者 に 連絡 する よう 案内 (自分 で は 退会 できない)
//
// Apple App Store Guideline 5.1.1(v) で、 アカウント 作成 を 持つ アプリ は
// 退会 導線 を アプリ内 で 提供 する 必要 が ある。 本サービス は B2B SaaS で
// 契約 変更 等 も 営業 対応 を 伴う ため、 「アプリ内 で 申請 を 開始 できる」
// 方式 (= この ページ) で 要件 を 満たす。

import { Link } from 'react-router-dom'
import { ArrowLeft, Mail, Phone, UserX, Wallet, Info } from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { isAdmin } from '@/lib/admin'
import { useOrgAdminContact } from '@/lib/useOrgAdminContact'

const SUPPORT_EMAIL = 'mail@nodecloud.jp'
const SUPPORT_PHONE = '0152-23-1311'

function buildMailto(to: string, subject: string, body: string) {
  const params = new URLSearchParams({ subject, body })
  return `mailto:${to}?${params.toString()}`
}

export function AccountSettingsPage() {
  const { user, displayName, organizationName, isOrgAdmin } = useAuth()
  const { contact: adminContact } = useOrgAdminContact()
  const siteOwner = isAdmin(user?.email)

  const unsubscribeMailto = buildMailto(
    SUPPORT_EMAIL,
    '【NodeCloud】退会申請',
    `退会 (組織 の 解約) を 申請 します。\n\n` +
      `お名前: ${displayName ?? ''}\n` +
      `メール: ${user?.email ?? ''}\n` +
      `所属組織: ${organizationName ?? ''}\n` +
      `\n` +
      `退会 理由 (任意):\n\n` +
      `※ 退会 処理 の 完了 まで 数営業日 かかる 場合 が あります。`,
  )

  const contractMailto = buildMailto(
    SUPPORT_EMAIL,
    '【NodeCloud】契約内容の変更申請',
    `契約内容 の 変更 を 申請 します。\n\n` +
      `お名前: ${displayName ?? ''}\n` +
      `メール: ${user?.email ?? ''}\n` +
      `所属組織: ${organizationName ?? ''}\n` +
      `\n` +
      `変更 内容 (ユーザー数 / 製品 / 期間 等):\n\n`,
  )

  // 一般 メンバー 用: 組織管理者 宛 の mailto
  const memberLeaveMailto = adminContact?.adminEmail
    ? buildMailto(
        adminContact.adminEmail,
        '【NodeCloud】退会のご相談',
        `お疲れ様です。${displayName ?? ''} です。\n\n` +
          `NodeCloud の 利用 を 停止 させて いただき たく、\n` +
          `組織 メンバー から の 削除 を お願い いたします。\n\n` +
          `ご確認 の うえ、 事務局 (${SUPPORT_EMAIL}) へ の 連絡 を\n` +
          `お願い いたします。`,
      )
    : null

  return (
    <div className="min-h-screen bg-slate-50 overflow-y-auto">
      <div className="bg-white border-b">
        <div className="max-w-2xl mx-auto px-4 py-3 flex items-center gap-3">
          <Link to="/" className="text-slate-500 hover:text-slate-800" title="アプリへ">
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <h1 className="font-bold">アカウント・契約の変更</h1>
        </div>
      </div>

      <div className="max-w-2xl mx-auto px-4 py-6 space-y-6">
        {/* 役割 の 表示 (理解 を 助ける ため) */}
        <div className="bg-blue-50 border border-blue-200 rounded p-3 text-sm text-blue-900 flex gap-2">
          <Info className="h-4 w-4 shrink-0 mt-0.5" />
          <div>
            {siteOwner ? (
              <>サイトオーナー としてログイン中。 組織台帳 から 直接 契約 を 操作 できます。</>
            ) : isOrgAdmin ? (
              <>
                組織管理者 としてログイン中。 契約変更 や 退会 は 下記 の 申請 窓口 から
                NodeCloud 事務局 へ ご連絡 ください。
              </>
            ) : (
              <>
                一般 メンバー としてログイン中。 契約変更 や 退会 は <strong>組織管理者</strong>
                を 通じて ご依頼 ください。
              </>
            )}
          </div>
        </div>

        {/* ===== 一般 メンバー 向け: 組織管理者 の 連絡先 を 案内 ===== */}
        {!siteOwner && !isOrgAdmin && (
          <section className="bg-white border rounded-lg p-5">
            <div className="flex items-center gap-2 mb-3">
              <UserX className="h-5 w-5 text-slate-600" />
              <h2 className="font-bold">退会・契約変更 のご依頼</h2>
            </div>
            {adminContact ? (
              <>
                <p className="text-sm text-slate-700 mb-3">
                  本サービス は 組織契約型 の ため、 一般 メンバー の 退会 や
                  契約内容 の 変更 は 組織管理者 を 通じて 行います。
                  以下 の 管理者 までご連絡 ください。
                </p>
                <div className="rounded border bg-slate-50 p-3 text-sm space-y-1">
                  <div>
                    <span className="text-slate-500 mr-2">組織:</span>
                    <span className="font-medium">{adminContact.organizationName}</span>
                  </div>
                  {adminContact.adminName && (
                    <div>
                      <span className="text-slate-500 mr-2">管理者:</span>
                      <span className="font-medium">{adminContact.adminName}</span>
                    </div>
                  )}
                  {adminContact.adminEmail && (
                    <div>
                      <span className="text-slate-500 mr-2">メール:</span>
                      <a
                        href={`mailto:${adminContact.adminEmail}`}
                        className="text-blue-600 hover:underline"
                      >
                        {adminContact.adminEmail}
                      </a>
                    </div>
                  )}
                  {adminContact.adminPhone && (
                    <div>
                      <span className="text-slate-500 mr-2">電話:</span>
                      <a
                        href={`tel:${adminContact.adminPhone}`}
                        className="text-blue-600 hover:underline"
                      >
                        {adminContact.adminPhone}
                      </a>
                    </div>
                  )}
                </div>
                {memberLeaveMailto && (
                  <div className="mt-4">
                    <a
                      href={memberLeaveMailto}
                      className="inline-flex items-center gap-2 px-3 py-2 bg-slate-700 text-white rounded hover:bg-slate-800 text-sm"
                    >
                      <Mail className="h-4 w-4" />
                      管理者 に 退会 を メールで 相談
                    </a>
                  </div>
                )}
              </>
            ) : (
              <p className="text-sm text-slate-700">
                組織 の 管理者 情報 を 取得 できません でした。
                事務局 ({SUPPORT_EMAIL}) まで お問い合わせ ください。
              </p>
            )}
          </section>
        )}

        {/* ===== サイトオーナー / 組織管理者 向け: 契約変更 ===== */}
        {(siteOwner || isOrgAdmin) && (
          <section className="bg-white border rounded-lg p-5">
            <div className="flex items-center gap-2 mb-2">
              <Wallet className="h-5 w-5 text-blue-600" />
              <h2 className="font-bold">契約内容の変更</h2>
            </div>
            <p className="text-sm text-slate-700 mb-4">
              ユーザー数 の 増減、 ご利用 製品 (地籍測量 / 土木工事 / モビリティ) の
              追加・解除、 契約 期間 の 変更 など、 プラン に 関する 変更 は
              こちら から ご依頼 ください。
            </p>
            <div className="flex flex-wrap gap-2">
              <a
                href={contractMailto}
                className="inline-flex items-center gap-2 px-3 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 text-sm"
              >
                <Mail className="h-4 w-4" />
                メールで申請
              </a>
              <a
                href={`tel:${SUPPORT_PHONE}`}
                className="inline-flex items-center gap-2 px-3 py-2 border rounded hover:bg-slate-50 text-sm"
              >
                <Phone className="h-4 w-4" />
                {SUPPORT_PHONE}
              </a>
            </div>
          </section>
        )}

        {/* ===== サイトオーナー / 組織管理者 向け: 退会 (組織 の 解約) ===== */}
        {(siteOwner || isOrgAdmin) && (
          <section className="bg-white border rounded-lg p-5">
            <div className="flex items-center gap-2 mb-2">
              <UserX className="h-5 w-5 text-red-600" />
              <h2 className="font-bold">退会 (組織 の 解約)</h2>
            </div>
            <p className="text-sm text-slate-700 mb-2">
              組織 全体 の サービス 解約 を 申請 する 場合 の 窓口 です。
              解約 により 以下 が 削除 されます:
            </p>
            <ul className="text-sm text-slate-700 list-disc pl-5 mb-4 space-y-0.5">
              <li>組織 の 全 メンバー の ログインアカウント</li>
              <li>工区 / 座標 / 図面 / 写真 など 組織 データ 一式</li>
              <li>契約 情報</li>
            </ul>
            <div className="mb-4 p-3 bg-amber-50 border border-amber-200 rounded text-xs text-amber-800">
              ⚠️ 一度 削除 された データ は <strong>復元 できません</strong>。
              必要 な データ は 事前 に エクスポート して おいて ください。
            </div>
            <div className="flex flex-wrap gap-2">
              <a
                href={unsubscribeMailto}
                className="inline-flex items-center gap-2 px-3 py-2 bg-red-600 text-white rounded hover:bg-red-700 text-sm"
              >
                <Mail className="h-4 w-4" />
                退会をメールで申請
              </a>
              <a
                href={`tel:${SUPPORT_PHONE}`}
                className="inline-flex items-center gap-2 px-3 py-2 border rounded hover:bg-slate-50 text-sm"
              >
                <Phone className="h-4 w-4" />
                {SUPPORT_PHONE}
              </a>
            </div>
          </section>
        )}

        <p className="text-xs text-slate-500">
          受付 時間: 平日 9:00〜17:00 (土日祝 除く)。
          メール での ご依頼 は 時間外 でも 受け付けて おります。
        </p>
      </div>
    </div>
  )
}
