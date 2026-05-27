// プライバシーポリシー（公開・認証不要）。/privacy
// ※ ドラフト雛形。実運用前に専門家のレビューを推奨。
import { Link } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'

const OPERATOR = '有限会社横山測量設計事務所'
const SERVICE = 'NodeCloud'
const EFFECTIVE_DATE = '2026年5月27日'
const CONTACT = 'yokoyama1980@gmail.com'

const SECTIONS: { title: string; body: string }[] = [
  {
    title: '1. 事業者情報',
    body:
      `事業者名: ${OPERATOR}\n` +
      `本ポリシーは、当社が提供する「${SERVICE}」（以下「本サービス」）における個人情報の取扱いについて定めます。`,
  },
  {
    title: '2. 取得する情報',
    body:
      `当社は、本サービスの提供にあたり次の情報を取得します。\n` +
      `（1）申込・アカウント情報: 会社名・事務所名、業種、住所、郵便番号、担当者名、メールアドレス、電話番号等\n` +
      `（2）利用者が本サービスに入力・登録・アップロードするデータ（座標、図面、写真、測量成果、地番・地権者情報等。以下「利用者データ」）\n` +
      `（3）利用状況に関する情報: アクセスログ、IPアドレス、端末・ブラウザ情報、Cookie 等の技術的情報`,
  },
  {
    title: '3. 利用目的',
    body:
      `当社は、取得した情報を次の目的で利用します。\n` +
      `（1）本サービスの提供・運営・本人確認・契約管理\n` +
      `（2）お問い合わせ・申し込みへの対応、連絡\n` +
      `（3）本サービスの保守、不具合対応、品質・機能の改善\n` +
      `（4）利用状況の分析（個人を特定できない統計情報への加工を含む）\n` +
      `（5）法令に基づく対応`,
  },
  {
    title: '4. 利用者データ（お客様が扱う個人情報）の取扱い',
    body:
      `利用者データに含まれる個人情報（地権者情報等）について、その管理者は利用者であり、当社はその取扱いを受託する立場で、本サービスの提供に必要な範囲で処理します。利用者は、利用者データに含まれる個人情報を、個人情報の保護に関する法律その他の法令に従い適法に取得・利用・管理する責任を負います。`,
  },
  {
    title: '5. 第三者提供',
    body:
      `当社は、次の場合を除き、取得した個人情報を本人の同意なく第三者に提供しません。\n` +
      `（1）法令に基づく場合\n` +
      `（2）人の生命・身体・財産の保護に必要で、本人の同意取得が困難な場合\n` +
      `（3）次条に定める業務委託に伴い提供する場合`,
  },
  {
    title: '6. 業務委託・外部サービスの利用',
    body:
      `当社は、本サービスの提供のため、以下のクラウド事業者に情報の保存・処理を委託します。委託先には適切な監督を行います。\n` +
      `（1）データベース・ストレージ・認証基盤（Supabase。東京リージョンに保存）\n` +
      `（2）アプリケーションのホスティング（Vercel。東京リージョンで処理）\n` +
      `いずれも日本国内（東京リージョン）でデータを保存・処理します。`,
  },
  {
    title: '7. 安全管理措置',
    body:
      `当社は、個人情報の漏えい、滅失または毀損の防止その他の安全管理のために、アクセス制御（権限管理）、通信の暗号化、アクセス権限を持つ者の限定等、合理的な安全管理措置を講じます。`,
  },
  {
    title: '8. 保有期間',
    body:
      `当社は、利用目的の達成に必要な期間、または法令で定められた期間、個人情報を保有し、不要となった場合は適切な方法で消去します。利用契約終了後の利用者データの取扱い・消去については、別途利用者の指示または当社の定めによります。`,
  },
  {
    title: '9. 開示・訂正・利用停止等の請求',
    body:
      `本人は、当社が保有する自己の個人情報について、開示、訂正、追加、削除、利用停止等を請求できます。請求は下記のお問い合わせ窓口までご連絡ください。本人確認のうえ、法令に従い対応します。なお、利用者データに含まれる第三者（地権者等）の個人情報に関する請求については、原則として管理者である利用者が対応するものとします。`,
  },
  {
    title: '10. Cookie 等の利用',
    body:
      `本サービスは、ログイン状態の保持や利用状況の把握のために Cookie 等の技術を使用することがあります。ブラウザの設定により Cookie を無効化できますが、その場合本サービスの一部が利用できないことがあります。`,
  },
  {
    title: '11. お問い合わせ窓口',
    body: `本ポリシーに関するお問い合わせは、次の窓口までご連絡ください。\n${OPERATOR}　${CONTACT}`,
  },
  {
    title: '12. 改定',
    body:
      `当社は、本ポリシーを必要に応じて変更することがあります。変更後の内容は本サービス上に掲示した時点から効力を生じます。`,
  },
]

export function PrivacyPage() {
  return (
    <div className="min-h-screen bg-slate-50">
      <div className="bg-white border-b">
        <div className="max-w-3xl mx-auto px-4 py-3 flex items-center gap-3">
          <Link to="/lp" className="text-slate-500 hover:text-slate-800" title="紹介ページ">
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <h1 className="font-bold">プライバシーポリシー</h1>
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-4 py-8">
        <div className="bg-white border rounded-lg p-6 sm:p-8">
          <p className="text-sm text-slate-600 mb-6">
            {OPERATOR}（以下「当社」）は、「{SERVICE}」における個人情報を以下のとおり取り扱います。
          </p>

          <div className="space-y-6">
            {SECTIONS.map((s) => (
              <section key={s.title}>
                <h2 className="font-bold text-slate-800 mb-1">{s.title}</h2>
                <p className="text-sm text-slate-700 whitespace-pre-line leading-relaxed">{s.body}</p>
              </section>
            ))}
          </div>

          <div className="mt-8 pt-4 border-t text-sm text-slate-500">
            <div>制定日: {EFFECTIVE_DATE}</div>
            <div>{OPERATOR}</div>
          </div>
        </div>

        <div className="text-center mt-6">
          <Link to="/terms" className="text-blue-600 hover:underline text-sm">
            利用規約を見る
          </Link>
        </div>
      </div>
    </div>
  )
}
