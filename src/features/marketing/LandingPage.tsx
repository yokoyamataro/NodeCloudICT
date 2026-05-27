// 紹介ページ（公開・認証不要）。サービス概要・特長・料金・申し込み導線。
import { Link } from 'react-router-dom'
import {
  MapPin,
  Users,
  Image as ImageIcon,
  Compass,
  GitBranch,
  FileSpreadsheet,
  Check,
  ArrowRight,
} from 'lucide-react'

const FEATURES: { icon: React.ComponentType<{ className?: string }>; title: string; desc: string }[] = [
  {
    icon: Users,
    title: 'チーム編集',
    desc: '社員同士や協力会社と現場単位での共同作業が可能。関係者への限定的な公開も可能。',
  },
  {
    icon: Compass,
    title: '精密誘導・三次元計測',
    desc: 'RTK-GNSS とスマホで測点まで cm 単位で精密誘導。起工測量や出来形測量に対応。',
  },
  {
    icon: MapPin,
    title: '座標・SIMA 入出力',
    desc: '平面直角座標系・ジオイド2024に対応。SIMA取込・出力可能。境界測量の地番SIMデータも扱えます。',
  },
  {
    icon: ImageIcon,
    title: 'オルソ画像背景＆写真帳',
    desc: 'ドローンのオルソ画像を図背景に。遠景・近景写真から写真帳(Excel)を自動作成。',
  },
  {
    icon: GitBranch,
    title: '北海道の農業土木工事に対応',
    desc: '暗渠排水の勾配計算や LandXML 三次元施工データを出力。各種帳票に対応。',
  },
]

export function LandingPage() {
  return (
    <div className="min-h-screen bg-white text-slate-800">
      {/* ヘッダ */}
      <header className="border-b">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="font-bold text-lg">NodeCloud</div>
          <div className="flex items-center gap-3 text-sm">
            <Link to="/login" className="text-slate-600 hover:text-slate-900">ログイン</Link>
            <Link to="/apply" className="px-3 py-1.5 bg-blue-600 text-white rounded hover:bg-blue-700">
              お申し込み
            </Link>
          </div>
        </div>
      </header>

      {/* ヒーロー */}
      <section className="bg-gradient-to-b from-slate-50 to-white">
        <div className="max-w-5xl mx-auto px-4 py-16 text-center">
          <h1 className="text-3xl sm:text-4xl font-bold leading-tight">
            農業土木・地籍測量の DX を、<br className="sm:hidden" />スマホとクラウドで。
          </h1>
          <p className="mt-4 text-slate-600 max-w-2xl mx-auto">
            起工測量の精密誘導から、座標管理・SIMA入出力・写真帳・境界測量まで。
            高価な専用機材やソフトに頼らず、現場のスマホで完結します。
          </p>
          <div className="mt-5 inline-block px-4 py-2 bg-emerald-50 border border-emerald-300 rounded-full text-emerald-800 text-sm font-medium">
            🎁 2026年内は実証実験として<strong>無料</strong>でご利用いただけます
          </div>
          <div className="mt-8 flex items-center justify-center gap-3">
            <Link
              to="/apply"
              className="inline-flex items-center gap-2 px-5 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-medium"
            >
              お申し込み・お問い合わせ
              <ArrowRight className="h-4 w-4" />
            </Link>
            <Link
              to="/login"
              className="inline-flex items-center gap-2 px-5 py-3 border rounded-lg hover:bg-slate-50"
            >
              ログイン
            </Link>
          </div>
        </div>
      </section>

      {/* 特長 */}
      <section className="max-w-5xl mx-auto px-4 py-14">
        <h2 className="text-xl font-bold text-center mb-8">主な機能</h2>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {FEATURES.map((f) => (
            <div key={f.title} className="border rounded-lg p-4">
              <f.icon className="h-6 w-6 text-blue-600" />
              <div className="mt-2 font-semibold">{f.title}</div>
              <div className="mt-1 text-sm text-slate-600">{f.desc}</div>
            </div>
          ))}
        </div>
      </section>

      {/* 料金 */}
      <section className="bg-slate-50 border-y">
        <div className="max-w-5xl mx-auto px-4 py-14">
          <h2 className="text-xl font-bold text-center mb-2">料金</h2>
          <div className="max-w-xl mx-auto mb-4 p-3 bg-emerald-50 border border-emerald-300 rounded-lg text-center text-emerald-800 text-sm">
            <b>2026年内は実証実験として無料</b>でご利用いただけます。<br />
            下記は2027年以降の予定料金（年額・請求書払い・適格請求書対応）です。
          </div>
          <p className="text-center text-sm text-slate-500 mb-8">
            会社単位の基本料金＋ご利用人数。年1回のご請求。
          </p>
          <div className="grid sm:grid-cols-2 gap-4 max-w-2xl mx-auto">
            <div className="bg-white border rounded-lg p-6">
              <div className="text-sm text-slate-500">1名でご利用</div>
              <div className="mt-1 text-3xl font-bold">¥60,000<span className="text-base font-normal text-slate-500">/年</span></div>
              <ul className="mt-4 space-y-1.5 text-sm text-slate-600">
                <li className="flex gap-2"><Check className="h-4 w-4 text-emerald-600" />全機能を利用可能</li>
                <li className="flex gap-2"><Check className="h-4 w-4 text-emerald-600" />スマホ・PC 両対応</li>
              </ul>
            </div>
            <div className="bg-white border-2 border-blue-500 rounded-lg p-6 relative">
              <span className="absolute -top-3 left-4 bg-blue-600 text-white text-xs px-2 py-0.5 rounded">標準</span>
              <div className="text-sm text-slate-500">〜4名でご利用</div>
              <div className="mt-1 text-3xl font-bold">¥90,000<span className="text-base font-normal text-slate-500">/年</span></div>
              <ul className="mt-4 space-y-1.5 text-sm text-slate-600">
                <li className="flex gap-2"><Check className="h-4 w-4 text-emerald-600" />基本料金 ¥50,000＋¥10,000/人</li>
                <li className="flex gap-2"><Check className="h-4 w-4 text-emerald-600" />複数名で同一データを共有</li>
              </ul>
            </div>
          </div>
          <p className="text-center text-xs text-slate-400 mt-4">
            ※ 導入記念価格です。5名以上・境界測量（個人情報対応）プラン等はお問い合わせください。
          </p>
          <div className="text-center mt-8">
            <Link
              to="/apply"
              className="inline-flex items-center gap-2 px-5 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-medium"
            >
              <FileSpreadsheet className="h-4 w-4" />
              お申し込みはこちら
            </Link>
          </div>
        </div>
      </section>

      <footer className="max-w-5xl mx-auto px-4 py-8 text-center text-xs text-slate-400">
        <div className="mb-2 flex items-center justify-center gap-3">
          <Link to="/terms" className="hover:underline">利用規約</Link>
          <Link to="/privacy" className="hover:underline">プライバシーポリシー</Link>
        </div>
        © NodeCloud / 有限会社横山測量設計事務所
      </footer>
    </div>
  )
}
