// nodecloud.jp サポート (/support).
// App Store の サポート URL。 #faq / #devices / #contact の アンカー を 持つ。
//
// デザイン ソース: design_handoff_nodecloud_lp/design/LP Support.dc.html
//
// TODO(未確定):
//   - 電話番号 (ダミー: 0152-23-1311 を 掲載)
//   - 受付番号 の 採番 ロジック (サーバ 側 /api/contact で 発行)
//   - 送信先 メール アドレス

import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { BlueprintCorners, MarketingLayout, type NavItem } from './MarketingLayout'

const NAV: NavItem[] = [
  { kind: 'route', to: '/#workflow', label: '機能' },
  { kind: 'route', to: '/#pricing', label: '料金' },
  { kind: 'anchor', href: '#faq', label: 'FAQ' },
  { kind: 'anchor', href: '#devices', label: '対応機器' },
  { kind: 'anchor', href: '#contact', label: 'お問い合わせ' },
]

interface ContactForm {
  topic: string
  name: string
  company: string
  email: string
  phone: string
  message: string
  /** ハニポット (ボット 対策)。 ユーザ に は 見せ ず、 入力 が あったら 弾く */
  website: string
}

const EMPTY: ContactForm = {
  topic: 'オンラインデモを予約したい',
  name: '',
  company: '',
  email: '',
  phone: '',
  message: '',
  website: '',
}

export function SupportPage() {
  const [form, setForm] = useState<ContactForm>(EMPTY)
  const [sent, setSent] = useState<{ ticketId: string } | null>(null)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // ページ 内 アンカー に 対応 (SPA 遷移 で も # に スクロール)
  useEffect(() => {
    const hash = window.location.hash
    if (!hash) return
    const el = document.querySelector(hash)
    if (el instanceof HTMLElement) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }, [])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (sending) return
    setError(null)
    // クライアント バリデーション (サーバ 側 で も 弾く)
    if (!form.name.trim() || !form.email.trim() || !form.message.trim()) {
      setError('お名前・メールアドレス・内容は必須です。')
      return
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) {
      setError('メールアドレスの形式が正しくありません。')
      return
    }
    // honeypot: 普通 の ユーザ は 入力 し ない。 入って いたら ボット 扱い で 握りつぶす。
    if (form.website.trim() !== '') {
      setSent({ ticketId: 'NC-00000000-0000' })
      return
    }
    setSending(true)
    try {
      const res = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          topic: form.topic,
          name: form.name.trim(),
          company: form.company.trim(),
          email: form.email.trim(),
          phone: form.phone.trim(),
          message: form.message.trim(),
        }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j?.error || `送信できませんでした (HTTP ${res.status})`)
      }
      const j = (await res.json()) as { ticketId: string }
      setSent({ ticketId: j.ticketId })
    } catch (err) {
      setError(err instanceof Error ? err.message : '送信中にエラーが発生しました')
    } finally {
      setSending(false)
    }
  }

  const resetForm = () => {
    setForm(EMPTY)
    setSent(null)
  }

  return (
    <MarketingLayout
      tag="サポート"
      navItems={NAV}
      cta={{ href: '#contact', label: 'デモを予約', kind: 'anchor' }}
    >
      {/* タイトル */}
      <section
        className="mkt-wrap"
        style={{
          paddingTop: 48,
          paddingBottom: 56,
          borderBottom: '1px solid var(--mkt-divider)',
        }}
      >
        <div className="mkt-kicker" style={{ fontSize: 12, marginBottom: 14 }}>
          Support
        </div>
        <h1 style={{ fontSize: 'clamp(32px, 4vw, 52px)' }}>サポート</h1>
        <p
          style={{
            fontSize: 16,
            lineHeight: 1.7,
            margin: '16px 0 0',
            maxWidth: 600,
            color: 'var(--mkt-neutral-800)',
          }}
        >
          よくある質問、対応機器・動作環境、お問い合わせ窓口をまとめています。解決しない場合はページ下部のフォームからご連絡ください。
        </p>
      </section>

      <section
        className="mkt-wrap mkt-two"
        style={{
          paddingTop: 64,
          paddingBottom: 80,
          alignItems: 'start',
          gridTemplateColumns: 'minmax(220px, 1fr) minmax(300px, 2.2fr)',
        }}
      >
        {/* 左: 目次 + 電話 カード */}
        <div style={{ position: 'sticky', top: 24 }}>
          <div className="mkt-kicker">Index</div>
          <a className="mkt-sublink" href="#faq">
            よくある質問
          </a>
          <a className="mkt-sublink" href="#devices">
            対応機器・動作環境
          </a>
          <a className="mkt-sublink" href="#contact">
            お問い合わせ
          </a>
          <div className="mkt-blueprint" style={{ padding: 20, marginTop: 32 }}>
            <BlueprintCorners />
            <div className="mkt-kicker">Phone</div>
            {/* TODO(未確定): 実電話番号。 現状 は 事務所 代表 を 流用。 */}
            <div style={{ fontFamily: '"Barlow Condensed", sans-serif', fontSize: 28 }}>
              0152-23-1311
            </div>
            <div className="mkt-muted" style={{ fontSize: 13, marginTop: 6 }}>
              平日 9:00–17:00（有限会社横山測量設計事務所）
            </div>
          </div>
        </div>

        {/* 右: FAQ + 対応機器 + フォーム */}
        <div>
          <div id="faq">
            <div className="mkt-kicker">FAQ</div>
            <h2 style={{ fontSize: 'clamp(28px, 3vw, 36px)', marginBottom: 20 }}>
              よくある質問
            </h2>

            <FaqGroup title="導入・料金">
              <FaqItem
                q="無償期間はいつまでですか？終了後は自動で有償になりますか？"
                a="2026年12月31日まで無償で提供します。終了後に自動で有償プランへ移行することはありません。継続利用は改めてお申し込みいただきます。"
              />
              <FaqItem
                q="料金はいくらですか？"
                a="基本プランは1ユーザー ¥3,300〜/月（税込）。座標地番管理からスマホのRTK現地調査まで全機能を利用できます。"
              />
              <FaqItem
                q="複数人・協力会社と一緒に使えますか？"
                a="プロジェクト単位でメンバーを招待できます。協力会社の担当者も同じプロジェクトを共同編集でき、メモ・チャットで連絡できます。"
              />
            </FaqGroup>

            <FaqGroup title="機器・現地作業">
              <FaqItem
                q="RTK測量機はどの機種が使えますか？"
                a="Drogger（株式会社ビズステーション）の各機種をサポートしております。（iPhoneはBluetoothの通信方式をBLE方式に変更する必要があります）"
              />
              <FaqItem
                q="iPhoneでも使えますか？"
                a={
                  <>
                    iPhone・Android の両方に対応しています。但しiPhone版はBLE通信へのファームウェアの切り替えが必要です。
                    <br />
                    （切替済みのDroggerを販売・提供しております。）
                  </>
                }
              />
              <FaqItem
                q="電波のない現場でも使えますか？"
                a="スマホ側の測点情報・写真はオフラインで記録し、通信復帰時に同期します。"
              />
            </FaqGroup>

            <FaqGroup title="データ・連携">
              <FaqItem
                q="既存CADや測量ソフトと連携できますか？"
                a="SIMA の入出力に対応。SXF（p21 / sfc）・DXF は表示に対応しています。"
              />
              <FaqItem
                q="地図XMLや地積測量図は取り込めますか？"
                a="法務省の地図XMLから座標・地番情報を取得できます。地積測量図・登記情報の自動認識は開発中です。"
              />
              <FaqItem
                q="93条調査報告書・写真帳はどの形式で出力されますか？"
                a="Excel形式で出力します。写真帳は撮影した遠景・近景写真を含めて出力されます。"
              />
            </FaqGroup>
          </div>

          {/* 対応機器 */}
          <div id="devices" style={{ marginTop: 80 }}>
            <div className="mkt-kicker">Devices</div>
            <h2 style={{ fontSize: 'clamp(28px, 3vw, 36px)', marginBottom: 20 }}>
              対応機器・動作環境
            </h2>
            <div className="mkt-blueprint" style={{ marginTop: 24 }}>
              <BlueprintCorners />
              <div className="mkt-spec">
                <div>PC（内業）</div>
                <div>Google Chrome / Microsoft Edge 最新版。Windows・macOS。インストール不要。</div>
                <div>スマホ（現地）</div>
                <div>
                  iPhone（iOS 16以降）／ Android（10以降）。ブラウザまたはアプリで利用。
                  <br />
                  （RTKはアプリのみ対応）
                </div>
                <div>RTK受信機</div>
                <div>
                  Drogger（株式会社ビズステーション）— 対応機種：RWGシリーズ／RZGシリーズ
                  <br />
                  DG-PRO1RWS ／ DG-PRO1RW／（いずれも移動局としての利用）
                  <br />
                  Bluetooth接続（iPhoneはBLE通信のみ対応）
                </div>
                <div>補正情報</div>
                <div>Ntrip 対応の配信サービス（善意の基準局・各社CORSなど）。</div>
                <div>入力形式</div>
                <div>SIMA、法務省地図XML、SXF（p21 / sfc）・DXF（表示）</div>
                <div>出力形式</div>
                <div>SIMA、93条調査報告書（Excel）、写真帳（Excel）</div>
                <div>座標系</div>
                <div>平面直角座標系 I〜XIX系（JGD2024）</div>
              </div>
            </div>
            <p className="mkt-muted" style={{ fontSize: 13, marginTop: 14 }}>
              対応機種・OSバージョンは順次拡大します。記載外の機器はお問い合わせください。
            </p>
          </div>

          {/* お問い合わせ */}
          <div id="contact" style={{ marginTop: 80 }}>
            <div className="mkt-kicker">Contact</div>
            <h2 style={{ fontSize: 'clamp(28px, 3vw, 36px)', marginBottom: 20 }}>
              お問い合わせ
            </h2>
            <p className="mkt-muted" style={{ fontSize: 14, margin: '0 0 24px' }}>
              デモのご希望、機能のご質問、不具合のご報告はこちらから。通常2営業日以内にご返信します。
            </p>

            {sent ? (
              <div
                className="mkt-blueprint"
                style={{ padding: '40px 32px', display: 'grid', gap: 14 }}
              >
                <BlueprintCorners />
                <div className="mkt-kicker" style={{ margin: 0 }}>
                  Received
                </div>
                <h3 style={{ fontSize: 28 }}>お問い合わせを受け付けました</h3>
                <p
                  style={{
                    fontSize: 15,
                    lineHeight: 1.7,
                    margin: 0,
                    color: 'var(--mkt-neutral-800)',
                  }}
                >
                  ご入力のメールアドレスに、受付内容を記載した確認メールをお送りしました。担当者より2営業日以内にご連絡いたします。
                </p>
                <div className="mkt-muted" style={{ fontSize: 13 }}>
                  受付番号{' '}
                  <span
                    style={{
                      fontFamily: 'ui-monospace, Menlo, monospace',
                      color: 'var(--mkt-text)',
                    }}
                  >
                    {sent.ticketId}
                  </span>
                </div>
                <p className="mkt-muted" style={{ fontSize: 13, margin: 0 }}>
                  確認メールが届かない場合は、迷惑メールフォルダをご確認いただくか、お電話でお問い合わせください。
                </p>
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 6 }}>
                  <Link className="btn btn-secondary" to="/">
                    トップへ戻る
                  </Link>
                  <button className="btn btn-ghost" type="button" onClick={resetForm}>
                    別の問い合わせをする
                  </button>
                </div>
              </div>
            ) : (
              <form
                className="mkt-blueprint"
                style={{ padding: 32, display: 'grid', gap: 18 }}
                onSubmit={submit}
              >
                <BlueprintCorners />

                <div className="mkt-field">
                  <label htmlFor="contact-topic">ご用件</label>
                  <select
                    id="contact-topic"
                    className="mkt-input"
                    value={form.topic}
                    onChange={(e) => setForm({ ...form, topic: e.target.value })}
                  >
                    <option>オンラインデモを予約したい</option>
                    <option>機能について質問したい</option>
                    <option>不具合を報告したい</option>
                    <option>その他</option>
                  </select>
                </div>

                <div className="mkt-two" style={{ gap: 18 }}>
                  <div className="mkt-field">
                    <label htmlFor="contact-name">
                      お名前 <span style={{ color: 'var(--mkt-accent)' }}>*</span>
                    </label>
                    <input
                      id="contact-name"
                      className="mkt-input"
                      type="text"
                      placeholder="横山 太郎"
                      value={form.name}
                      onChange={(e) => setForm({ ...form, name: e.target.value })}
                      required
                    />
                  </div>
                  <div className="mkt-field">
                    <label htmlFor="contact-company">会社名・事務所名</label>
                    <input
                      id="contact-company"
                      className="mkt-input"
                      type="text"
                      placeholder="〇〇測量設計事務所"
                      value={form.company}
                      onChange={(e) => setForm({ ...form, company: e.target.value })}
                    />
                  </div>
                </div>

                <div className="mkt-two" style={{ gap: 18 }}>
                  <div className="mkt-field">
                    <label htmlFor="contact-email">
                      メールアドレス <span style={{ color: 'var(--mkt-accent)' }}>*</span>
                    </label>
                    <input
                      id="contact-email"
                      className="mkt-input"
                      type="email"
                      placeholder="you@example.jp"
                      value={form.email}
                      onChange={(e) => setForm({ ...form, email: e.target.value })}
                      required
                    />
                  </div>
                  <div className="mkt-field">
                    <label htmlFor="contact-phone">電話番号（任意）</label>
                    <input
                      id="contact-phone"
                      className="mkt-input"
                      type="tel"
                      placeholder="000-0000-0000"
                      value={form.phone}
                      onChange={(e) => setForm({ ...form, phone: e.target.value })}
                    />
                  </div>
                </div>

                <div className="mkt-field">
                  <label htmlFor="contact-message">
                    内容 <span style={{ color: 'var(--mkt-accent)' }}>*</span>
                  </label>
                  <textarea
                    id="contact-message"
                    className="mkt-input"
                    rows={5}
                    placeholder="ご質問・ご要望・お持ち込みのデータ（SIMAなど）があればご記載ください"
                    value={form.message}
                    onChange={(e) => setForm({ ...form, message: e.target.value })}
                    required
                  />
                </div>

                {/* ハニポット: ユーザ に は 見せ ない。 ボット は 全部 の 入力欄 を 埋め がち */}
                <div
                  aria-hidden="true"
                  style={{ position: 'absolute', left: -9999, width: 1, height: 1, overflow: 'hidden' }}
                >
                  <label htmlFor="contact-website">Website (do not fill)</label>
                  <input
                    id="contact-website"
                    type="text"
                    tabIndex={-1}
                    autoComplete="off"
                    value={form.website}
                    onChange={(e) => setForm({ ...form, website: e.target.value })}
                  />
                </div>

                {error && (
                  <div
                    role="alert"
                    style={{
                      padding: '10px 14px',
                      border: '1px solid var(--mkt-accent-800)',
                      background: 'var(--mkt-accent-100)',
                      color: 'var(--mkt-accent-900)',
                      fontSize: 14,
                    }}
                  >
                    {error}
                  </div>
                )}

                <div
                  style={{
                    display: 'flex',
                    gap: 12,
                    alignItems: 'center',
                    flexWrap: 'wrap',
                  }}
                >
                  <button
                    className="btn btn-primary"
                    type="submit"
                    disabled={sending}
                    style={{ padding: '12px 26px', fontSize: 15 }}
                  >
                    {sending ? '送信中…' : '送信する'}
                  </button>
                  <span className="mkt-muted" style={{ fontSize: 12 }}>
                    送信により <Link to="/privacy">プライバシーポリシー</Link> に同意したものとみなします。
                  </span>
                </div>
              </form>
            )}
          </div>
        </div>
      </section>
    </MarketingLayout>
  )
}

function FaqGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <>
      <div className="mkt-kicker" style={{ marginTop: 36 }}>
        {title}
      </div>
      {children}
    </>
  )
}

function FaqItem({ q, a }: { q: string; a: React.ReactNode }) {
  return (
    <div className="mkt-faq-support">
      <h4>{q}</h4>
      <p className="mkt-muted">{a}</p>
    </div>
  )
}
