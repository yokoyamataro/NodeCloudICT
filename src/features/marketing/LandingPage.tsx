// nodecloud.jp トップ (/).
// 地籍測量 と 土木工事 の 2 業務 を 1 ページ に 統合。 App Store の マーケティング URL。
//
// 構成 (デザイン ソース: design_handoff_nodecloud_lp/design/LP Top.dc.html):
//   1. ヘッダ (共通)
//   2. ヒーロー (自動切替 6s、 セグメント クリック で 固定、 reduced-motion で 停止)
//   3. Workflow (内業 / 現場)
//   4. Solutions (地籍 / 土木 の 機能 詳細、 セグメント で 切替)
//   5. Pricing (2×2)
//   6. Company
//   7. FAQ
//   8. デモ帯
//   9. フッタ (共通)
//
// TODO(未確定 事項):
//   - 料金 の 税表記 (¥3,300〜/月 は 税込 と 明記)
//   - App Store / Google Play の 公開 URL。 公開 まで 「準備中」 で 押下不可 の まま
//   - 電話番号・受付時間・所在地 の 掲載 は サポート ページ 側 に 寄せる 想定

import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { BlueprintCorners, MarketingLayout, type NavItem } from './MarketingLayout'

const HERO_INTERVAL_MS = 6000

type BizTab = 'cad' | 'civ'

const HERO = {
  cad: {
    kicker: '土地家屋調査士・測量設計会社のために',
    title: ['最新データを全員で共有', 'オフィスでも現場でも'],
    body: '数千筆の境界点設置や地権者との立会——NodeCloudは一筆地測量から地図作成作業まで、データ交換やチーム間の整合性チェックに要する時間とストレスから解放します。',
    pc: '/marketing/screen-cadastral-drawing.png',
    pcAlt: 'NodeCloudの地積測量図作成画面：求積表と図面、P21・TIF出力',
    pcStyle: { bottom: 0, left: '-7.5%', width: '115%', height: 'auto' },
    phone: '/marketing/screen-phone-photo.png',
    phoneAlt: 'NodeCloudアプリの測点画面：地図上の境界点と点情報・遠景近景写真',
  },
  civ: {
    kicker: '農業土木の施工業者・設計コンサルのために',
    title: ['CAD図面からLandXMLまで', '三次元施工データを自動で'],
    body: '道路・河川・農業土木の図面を読み込み、RTKで起工測量。\n丁張・トンボの設置からICT施工のためのLandXML作成まで対応。\n最新の図面・工事測量データを元請業者・協力業者と共有することで、生産性向上を実現します。',
    pc: '/marketing/screen-civil-cross.png',
    pcAlt: 'NodeCloudの施工計画画面：測点表・平面図・横断図と丁張計算',
    pcStyle: {
      inset: 0,
      width: '100%',
      height: '100%',
      objectFit: 'cover' as const,
      objectPosition: 'center top',
    },
    phone: '/marketing/screen-phone-civil.png',
    phoneAlt: 'NodeCloudアプリのRTK誘導画面：線形上の測点と横断ビュー',
  },
} as const

const NAV: NavItem[] = [
  { kind: 'anchor', href: '#workflow', label: '機能' },
  { kind: 'anchor', href: '#solutions', label: '業務別' },
  { kind: 'anchor', href: '#pricing', label: '料金' },
  { kind: 'anchor', href: '#faq', label: 'FAQ' },
  { kind: 'route', to: '/support', label: 'サポート' },
]

export function LandingPage() {
  const [heroTab, setHeroTab] = useState<BizTab>('cad')
  const [heroPaused, setHeroPaused] = useState(false)
  const [solutionTab, setSolutionTab] = useState<BizTab>('cad')

  useEffect(() => {
    if (heroPaused) return
    // prefers-reduced-motion に 従って 自動切替 を 止める (アクセシビリティ)
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    if (reduce) return
    const id = window.setInterval(() => {
      setHeroTab((t) => (t === 'cad' ? 'civ' : 'cad'))
    }, HERO_INTERVAL_MS)
    return () => window.clearInterval(id)
  }, [heroPaused])

  const pickHero = (b: BizTab) => {
    setHeroTab(b)
    setHeroPaused(true)
  }

  return (
    <MarketingLayout
      navItems={NAV}
      cta={{ href: '#demo', label: 'デモを予約', kind: 'anchor' }}
    >
      {/* ヒーロー */}
      <section
        className="mkt-wrap mkt-two"
        style={{ paddingTop: 48, paddingBottom: 72, alignItems: 'center' }}
      >
        <div>
          <div className="mkt-seg" style={{ marginBottom: 18 }} role="tablist">
            {(['cad', 'civ'] as const).map((b) => (
              <button
                key={b}
                type="button"
                role="tab"
                aria-selected={heroTab === b}
                onClick={() => pickHero(b)}
                className={`mkt-seg-opt ${heroTab === b ? 'on' : ''}`}
                style={{ fontSize: 13, padding: '6px 14px' }}
              >
                {b === 'cad' ? '地籍測量' : '土木工事'}
              </button>
            ))}
          </div>

          {/* 両 業務 の 文言 を 同じ グリッド セル に 重ねる (高さ が 揺れ ない) */}
          <div style={{ display: 'grid' }}>
            {(['cad', 'civ'] as const).map((b) => {
              const h = HERO[b]
              return (
                <div
                  key={b}
                  className="mkt-fade"
                  style={{
                    gridArea: '1/1',
                    visibility: heroTab === b ? 'visible' : 'hidden',
                  }}
                  aria-hidden={heroTab !== b}
                >
                  <div className="mkt-kicker" style={{ fontSize: 12, marginBottom: 14 }}>
                    {h.kicker}
                  </div>
                  <h1 style={{ fontSize: 'clamp(28px, 3.4vw, 44px)', whiteSpace: 'nowrap' }}>
                    {h.title[0]}
                    <br />
                    {h.title[1]}
                  </h1>
                  <p
                    className="mkt-muted"
                    style={{
                      fontSize: 17,
                      lineHeight: 1.7,
                      margin: '22px 0 0',
                      maxWidth: 520,
                      color: 'var(--mkt-neutral-800)',
                      whiteSpace: 'pre-line',
                    }}
                  >
                    {h.body}
                  </p>
                </div>
              )
            })}
          </div>

          {/* CTA */}
          <div style={{ display: 'flex', gap: 12, marginTop: 32, flexWrap: 'wrap' }}>
            <a
              className="btn btn-primary mkt-blueprint"
              href="#demo"
              style={{ padding: '13px 26px', fontSize: 16 }}
            >
              <BlueprintCorners />
              デモを予約する
            </a>
            <a className="btn btn-ghost" href="#workflow" style={{ padding: '13px 16px', fontSize: 16 }}>
              機能を見る →
            </a>
          </div>

          {/* ストア ボタン (準備中: 押下不可) */}
          <div
            style={{
              display: 'flex',
              gap: 12,
              marginTop: 20,
              flexWrap: 'wrap',
              alignItems: 'center',
            }}
          >
            {(
              [
                { store: 'App Store', icon: 'apple' },
                { store: 'Google Play', icon: 'play' },
              ] as const
            ).map((s) => (
              <a
                key={s.store}
                className="btn btn-secondary"
                href="#"
                aria-disabled="true"
                onClick={(e) => e.preventDefault()}
                style={{
                  padding: '8px 14px',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 10,
                  opacity: 0.75,
                  cursor: 'default',
                }}
              >
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  {s.icon === 'apple' ? (
                    <>
                      <path d="M12 20.94c1.5 0 2.75 1.06 4 1.06 3 0 6-8 6-12.22A4.91 4.91 0 0 0 17 5c-2.22 0-4 1.44-5 2-1-.56-2.78-2-5-2a4.9 4.9 0 0 0-5 4.78C2 14 5 22 8 22c1.25 0 2.5-1.06 4-1.06Z" />
                      <path d="M10 2c1 .5 2 2 2 5" />
                    </>
                  ) : (
                    <polygon points="6 3 20 12 6 21 6 3" />
                  )}
                </svg>
                <span style={{ display: 'grid', lineHeight: 1.1, textAlign: 'left' }}>
                  <span style={{ fontSize: 10 }}>{s.store}</span>
                  <span style={{ fontSize: 14 }}>準備中</span>
                </span>
              </a>
            ))}
          </div>

          <div
            className="mkt-muted"
            style={{
              marginTop: 36,
              paddingTop: 20,
              borderTop: '1px solid var(--mkt-divider)',
              display: 'flex',
              gap: 32,
              fontSize: 13,
              flexWrap: 'wrap',
            }}
          >
            <div>
              <b style={{ color: 'var(--mkt-text)' }}>2026.12.31まで</b> 無償提供
            </div>
            <div>
              <b style={{ color: 'var(--mkt-text)' }}>自動課金なし</b>
            </div>
          </div>
        </div>

        {/* 右側: PC + スマホ の モック */}
        <div style={{ position: 'relative', aspectRatio: '1/1', maxHeight: 520 }}>
          <div
            className="mkt-blueprint"
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              width: '78%',
              aspectRatio: '16 / 10',
            }}
          >
            <BlueprintCorners />
            {(['cad', 'civ'] as const).map((b) => {
              const h = HERO[b]
              return (
                <div
                  key={b}
                  style={{
                    position: 'absolute',
                    inset: 0,
                    overflow: 'hidden',
                    background: '#fff',
                    visibility: heroTab === b ? 'visible' : 'hidden',
                  }}
                  aria-hidden={heroTab !== b}
                >
                  <img
                    src={h.pc}
                    alt={h.pcAlt}
                    style={{ position: 'absolute', display: 'block', ...h.pcStyle }}
                  />
                </div>
              )
            })}
          </div>
          <div
            className="mkt-blueprint mkt-elev-lg"
            style={{
              position: 'absolute',
              right: 0,
              bottom: 0,
              width: '34%',
              aspectRatio: '9 / 19',
            }}
          >
            <BlueprintCorners />
            {(['cad', 'civ'] as const).map((b) => {
              const h = HERO[b]
              return (
                <div
                  key={b}
                  style={{
                    position: 'absolute',
                    inset: 0,
                    overflow: 'hidden',
                    visibility: heroTab === b ? 'visible' : 'hidden',
                  }}
                  aria-hidden={heroTab !== b}
                >
                  <img
                    src={h.phone}
                    alt={h.phoneAlt}
                    style={{
                      position: 'absolute',
                      inset: 0,
                      width: '100%',
                      height: '100%',
                      objectFit: 'cover',
                      objectPosition: 'center top',
                      display: 'block',
                    }}
                  />
                </div>
              )
            })}
          </div>
        </div>
      </section>

      {/* Workflow */}
      <section id="workflow" className="mkt-wrap" style={{ paddingTop: 80, paddingBottom: 80 }}>
        <div style={{ textAlign: 'center', marginBottom: 48 }}>
          <div className="mkt-kicker">Workflow</div>
          <h2 style={{ fontSize: 'clamp(30px, 3.5vw, 40px)' }}>
            全員が同じプロジェクトを、PCとスマホで。
          </h2>
        </div>
        <div className="mkt-two">
          <WorkflowCard
            kicker="内業 — PC"
            title="調査・管理・帳票"
            items={[
              { num: '01', title: '座標地番管理', body: '地図XMLから地番情報の取得、地積測量図の座標や登記情報の自動認識（開発中）、立入通知書の作成。' },
              { num: '02', title: '工程管理・作図', body: '立会の日程調整、GISベースでの作図・計算。' },
              { num: '03', title: '帳票・データ出力', body: '93条調査報告書、Excel写真帳、LandXML・SIMAの出力。' },
            ]}
          />
          <WorkflowCard
            kicker="現場 — スマホ"
            title="誘導・記録・撮影"
            items={[
              { num: '04', title: 'RTK精密測位（iPhone / Android対応）', body: 'Droggerを接続し、cm精度で現地調査・測点誘導。' },
              { num: '05', title: '測点情報・写真管理', body: '設置した杭の種類や遠景・近景写真を撮影してその場で登録。' },
              { num: '06', title: 'チーム・協力会社と共有', body: 'メモやチャットが可能。オフライン記録対応。' },
            ]}
          />
        </div>
      </section>

      {/* Solutions */}
      <section id="solutions" style={{ background: 'var(--mkt-surface)', padding: '72px 0' }}>
        <div className="mkt-wrap">
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-end',
              justifyContent: 'space-between',
              gap: 24,
              flexWrap: 'wrap',
              marginBottom: 40,
            }}
          >
            <div>
              <div className="mkt-kicker">Solutions</div>
              <h2 style={{ fontSize: 'clamp(30px, 3.5vw, 40px)' }}>業務別の機能</h2>
              <p className="mkt-muted" style={{ fontSize: 14, margin: '10px 0 0' }}>
                同じ座標基盤の上に、業務別の設計・帳票機能。ひとつの契約で両方使えます。
              </p>
            </div>
            <div className="mkt-seg" role="tablist">
              {(['cad', 'civ'] as const).map((b) => (
                <button
                  key={b}
                  type="button"
                  role="tab"
                  aria-selected={solutionTab === b}
                  onClick={() => setSolutionTab(b)}
                  className={`mkt-seg-opt ${solutionTab === b ? 'on' : ''}`}
                >
                  {b === 'cad' ? '地籍測量' : '土木工事'}
                </button>
              ))}
            </div>
          </div>

          {solutionTab === 'cad' ? <SolutionCad /> : <SolutionCiv />}
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="mkt-wrap" style={{ paddingTop: 80, paddingBottom: 80 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'space-between',
            marginBottom: 36,
            flexWrap: 'wrap',
            gap: 16,
          }}
        >
          <div>
            <div className="mkt-kicker">Pricing</div>
            <h2 style={{ fontSize: 'clamp(30px, 3.5vw, 40px)' }}>料金</h2>
          </div>
          <p className="mkt-muted" style={{ maxWidth: 460, fontSize: 13, margin: 0 }}>
            実証期間中は無償、有償プランへの自動移行はありません。
          </p>
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
            gap: 24,
            alignItems: 'stretch',
          }}
        >
          <PriceCard
            tag="基本料金"
            title="基本プラン"
            unit="1ユーザー"
            price="¥3,300"
            priceUnit=" 〜 /月"
            body="座標地番管理、スマホのRTK現地調査まであらゆる機能を利用可能。地籍測量・土木工事の両業務に対応。"
          />
          <PriceCard
            tag="機器"
            title="Drogger Gパッケージ"
            unit="1台"
            price="¥220,000"
            priceUnit=" （買い切り）"
            body="BLEカスタマイズ済。iPhone・Androidのどちらでもすぐに接続できます。"
          />
          {/* TODO(未確定): 下段 2 つ の 内容 説明 と 税表記 は 仮 */}
          <PriceCard
            tag="地籍測量"
            title="地図作成作業パッケージ"
            unit="1現場あたり"
            price="¥220,000"
            priceUnit=" （1年間限り）"
            body="地籍測量の現場向けパッケージです。"
          />
          <PriceCard
            tag="土木工事"
            title="ICT施工パッケージ"
            unit="1現場あたり"
            price="¥220,000"
            priceUnit=" （1年間限り）"
            body="土木工事の現場向けパッケージです。"
          />
        </div>
      </section>

      {/* Company */}
      <section className="mkt-wrap mkt-two" style={{ paddingBottom: 72, alignItems: 'start' }}>
        <div>
          <div className="mkt-kicker">Company</div>
          <h2 style={{ fontSize: 'clamp(28px, 3vw, 36px)' }}>
            測量士・土地家屋調査士が現場の問題解決のために開発しました
          </h2>
          <p
            style={{
              fontSize: 15,
              lineHeight: 1.7,
              marginTop: 16,
              color: 'var(--mkt-neutral-800)',
            }}
          >
            慢性的な技術者不足、年間の3分の1が積雪期という制約の中で、「チームでの生産性を最大化させる」という課題からAIで開発。
            <br />
            機能開発は一線で活躍する技術者からのフィードバックを最優先に進めています。
          </p>
        </div>
        <div className="mkt-blueprint" style={{ aspectRatio: '4/3' }}>
          <BlueprintCorners />
          <div className="mkt-duotone" style={{ position: 'absolute', inset: 0 }}>
            <img
              src="/marketing/photo-developer-v5.png"
              alt="NodeCloudで地番管理の作業をする開発者"
              style={{
                position: 'absolute',
                inset: 0,
                width: '100%',
                height: '100%',
                objectFit: 'cover',
                objectPosition: 'center',
                display: 'block',
              }}
            />
          </div>
        </div>
        <div
          style={{
            gridColumn: '1 / -1',
            paddingTop: 16,
            borderTop: '1px solid var(--mkt-divider)',
            display: 'grid',
            gridTemplateColumns: 'auto 1fr',
            gap: '8px 20px',
            fontSize: 14,
          }}
        >
          <div className="mkt-muted">開発・運用</div>
          <div>有限会社横山測量設計事務所（北海道）</div>
          <div className="mkt-muted">代表</div>
          <div>
            横山太郎
            <br />
            （測量士・土地家屋調査士・司法書士・行政書士・経営学修士）
          </div>
          <div className="mkt-muted">開発協力</div>
          <div>一般社団法人不動産調査技術研究所</div>
        </div>
      </section>

      {/* FAQ 抜粋 */}
      <section id="faq" className="mkt-wrap" style={{ paddingBottom: 80 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'space-between',
            gap: 16,
            flexWrap: 'wrap',
            marginBottom: 24,
          }}
        >
          <div>
            <div className="mkt-kicker">FAQ</div>
            <h2 style={{ fontSize: 'clamp(28px, 3vw, 36px)' }}>よくある質問</h2>
          </div>
          <Link to="/support#faq" style={{ fontSize: 14 }}>
            すべての質問を見る →
          </Link>
        </div>
        <div className="mkt-two" style={{ gap: '0 48px' }}>
          {[
            {
              q: 'RTK測量機はどの機種が使えますか？',
              a: 'Drogger（株式会社ビズステーション）の各機種をサポートしております。（iPhoneはBluetoothの通信方式をBLE方式に変更する必要があります）',
            },
            {
              q: '既存CADと連携できますか？',
              a: 'SIMA入出力、SXF(p21.sfc)、dxfに表示対応します。LandXMLの出力に対応。',
            },
            {
              q: '地籍測量と土木工事、両方の機能を使えますか？',
              a: 'はい。ひとつの契約で両業務の機能を利用できます。',
            },
            {
              q: '無償期間後は自動で有償になりますか？',
              a: 'なりません。2026年12月31日まで無償、その後の継続は改めてお申し込みいただきます。',
            },
          ].map(({ q, a }) => (
            <div key={q} className="mkt-faq">
              <h4>{q}</h4>
              <p className="mkt-muted">{a}</p>
            </div>
          ))}
        </div>
      </section>

      {/* デモ帯 */}
      <section id="demo" style={{ background: 'var(--mkt-accent-900)', color: 'var(--mkt-bg)', padding: '64px 0' }}>
        <div
          className="mkt-wrap"
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 24,
            flexWrap: 'wrap',
          }}
        >
          <div>
            <h2 style={{ fontSize: 'clamp(28px, 3vw, 36px)', color: 'var(--mkt-bg)' }}>
              御社の画地SIMAやDXF図面で、30分デモ。
            </h2>
            <p style={{ fontSize: 14, color: 'var(--mkt-accent-300)', margin: '10px 0 0' }}>
              その場で取り込み、実際の現場データで操作いただけます。
            </p>
          </div>
          <Link
            className="btn"
            to="/support#contact"
            style={{
              padding: '13px 28px',
              fontSize: 16,
              background: 'var(--mkt-bg)',
              color: 'var(--mkt-accent-900)',
              borderColor: 'var(--mkt-bg)',
            }}
          >
            デモを予約する
          </Link>
        </div>
      </section>
    </MarketingLayout>
  )
}

function WorkflowCard({
  kicker,
  title,
  items,
}: {
  kicker: string
  title: string
  items: { num: string; title: string; body: string }[]
}) {
  return (
    <div className="mkt-blueprint" style={{ padding: 32 }}>
      <BlueprintCorners />
      <div className="mkt-kicker">{kicker}</div>
      <h3 style={{ fontSize: 26 }}>{title}</h3>
      <div style={{ display: 'grid', gap: 18, marginTop: 22 }}>
        {items.map((it) => (
          <div key={it.num} className="mkt-step">
            <div className="mkt-num">{it.num}</div>
            <div>
              <b>{it.title}</b>
              <div className="mkt-muted" style={{ fontSize: 14, marginTop: 4 }}>
                {it.body}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function SolutionCad() {
  return (
    <div className="mkt-two" style={{ alignItems: 'start' }}>
      <div>
        <div className="mkt-kicker">土地家屋調査士・測量設計会社のために</div>
        <h3 style={{ fontSize: 'clamp(26px, 3vw, 34px)' }}>
          境界確認から調査報告書まで、現地とデスクをひとつに。
        </h3>
        <p
          style={{
            fontSize: 15,
            lineHeight: 1.7,
            margin: '16px 0 0',
            color: 'var(--mkt-neutral-800)',
          }}
        >
          法務省地番マップを背景に地番・地権者を管理。現地では境界杭をスマホで撮影、写真は座標に自動で紐づき、93条調査報告書と写真帳をExcelで出力します。
        </p>
        <div style={{ display: 'grid', gap: 16, marginTop: 28 }}>
          <StepRow num="01" title="地番管理（法務省地番マップ）" body="全国の地番マップを背景に所在・地番・地目・地積を管理。地図クリックで表の行へ。" />
          <StepRow num="02" title="登記情報の自動認識・地権者管理" body="登記情報PDFから所在・地番・所有者を抽出（開発中）。申請人／隣接者・立会人を記録。" />
          <StepRow num="03" title="不動産調査報告書を「取込」で作成" body="所有者は地権者台帳から、写真は連携座標から。定型句・履歴取込・報告書番号の自動採番。" />
          <StepRow num="04" title="写真管理を座標に紐づけて一元化" body="境界杭ごとに遠景・近景を撮影。ファイル名の付け直しもフォルダ整理も不要。" />
          <StepRow num="05" title="地積測量図・各階平面図作成" body="地番データや建物の形状から登記図面を作成。TIF・PDF・P21に対応。" />
        </div>
      </div>
      <div style={{ display: 'grid', gap: 24 }}>
        <SolutionScreen
          src="/marketing/screen-cad-coords.png"
          alt="NodeCloudの座標管理画面：点番号・XY座標の一覧と地番マップ上の境界点"
          imgStyle={{
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            objectPosition: 'left top',
          }}
        />
        <SolutionScreen
          src="/marketing/screen-report-93.png"
          alt="NodeCloudで出力した不動産調査報告書（93条ただし書）"
          imgStyle={{ top: '4%', left: '-3.5%', width: '104.2%', height: 'auto' }}
        />
        <SolutionScreen
          src="/marketing/screen-photo-album.png"
          alt="NodeCloudで出力した写真帳（境界点ごとの遠景・近景）"
          imgStyle={{ top: '2%', left: '-2.2%', width: '106%', height: 'auto' }}
        />
      </div>
    </div>
  )
}

function SolutionCiv() {
  return (
    <div className="mkt-two" style={{ alignItems: 'start' }}>
      <div>
        <div className="mkt-kicker">農業土木の施工業者・設計コンサルのために</div>
        <h3 style={{ fontSize: 'clamp(26px, 3vw, 34px)' }}>
          CAD図面からLandXMLまで。三次元施工データを自動で。
        </h3>
        <p
          style={{
            fontSize: 15,
            lineHeight: 1.7,
            margin: '16px 0 0',
            color: 'var(--mkt-neutral-800)',
          }}
        >
          道路・河川・農業土木の図面を読み込み、RTKで起工測量。
          <br />
          丁張・トンボの設置からICT施工のためのLandXML作成まで対応。
          <br />
          最新の図面・工事測量データを元請業者・協力業者と共有することで、生産性向上を実現します。
        </p>
        <div style={{ display: 'grid', gap: 16, marginTop: 28 }}>
          <StepRow num="01" title="道路・河川の施工管理" body="道路・河川等の線形物の施工管理に。単純な排水路から単曲線やクロソイドカーブ、バーチカルカーブなどの複雑な線形データ、丁張計算まで幅広く対応します。" />
          <StepRow num="02" title="暗渠や整地などの農業土木工事" body="複雑な系統の暗渠排水や農地の大規模化に伴う整地工事に対応。水理計算や床掘データのLandXML作成にも対応。" />
          <StepRow num="03" title="RTK精密誘導で起工・出来形測量" body="測点の杭打ちはもちろん、線形データを元に横断測量やLandXMLの表示が可能。起工測量から出来形測量まで幅広く対応します。" />
          <StepRow num="04" title="工区別チャットで情報共有を円滑化" body="複数工区が同時並行する現場でも情報は工区ごとに整理され、コミュニケーションが円滑化。手戻りを防ぎます。" />
        </div>
      </div>
      <div style={{ display: 'grid', gap: 24 }}>
        <SolutionScreen
          src="/marketing/screen-civil-cross.png"
          alt="NodeCloudの施工計画画面：測点表・平面図・横断図と丁張計算"
          imgStyle={{ inset: 0, width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'center top' }}
        />
        <SolutionScreen
          src="/marketing/screen-civil-drain.png"
          alt="NodeCloudの施工計画画面：暗渠排水の系統表と管路マップ"
          imgStyle={{ inset: 0, width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'left top' }}
        />
        <SolutionScreen
          src="/marketing/screen-civil-map.png"
          alt="NodeCloudの工区マップ：工種別に色分けした現場の一覧"
          imgStyle={{ inset: 0, width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'center' }}
        />
      </div>
    </div>
  )
}

function StepRow({ num, title, body }: { num: string; title: string; body: string }) {
  return (
    <div className="mkt-step">
      <div className="mkt-num">{num}</div>
      <div>
        <b>{title}</b>
        <div className="mkt-muted" style={{ fontSize: 14, marginTop: 4 }}>
          {body}
        </div>
      </div>
    </div>
  )
}

function SolutionScreen({
  src,
  alt,
  imgStyle,
}: {
  src: string
  alt: string
  imgStyle: React.CSSProperties
}) {
  return (
    <div className="mkt-blueprint" style={{ aspectRatio: '16 / 10' }}>
      <BlueprintCorners />
      <div
        style={{
          position: 'absolute',
          inset: 0,
          overflow: 'hidden',
          background: '#fff',
        }}
      >
        <img src={src} alt={alt} style={{ position: 'absolute', display: 'block', ...imgStyle }} />
      </div>
    </div>
  )
}

function PriceCard({
  tag,
  title,
  unit,
  price,
  priceUnit,
  body,
}: {
  tag: string
  title: string
  unit: string
  price: string
  priceUnit: string
  body: string
}) {
  return (
    <div className="mkt-blueprint" style={{ display: 'flex', flexDirection: 'column' }}>
      <BlueprintCorners />
      <div
        style={{
          padding: '28px 24px',
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
          height: '100%',
        }}
      >
        <span className="mkt-tag mkt-tag-accent">{tag}</span>
        <h3 style={{ fontSize: 22 }}>{title}</h3>
        <div>
          <div className="mkt-muted" style={{ fontSize: 12 }}>
            {unit}
          </div>
          <div
            style={{
              fontFamily: '"Barlow Condensed", sans-serif',
              fontSize: 40,
              lineHeight: 1.1,
            }}
          >
            {price}
            <span className="mkt-muted" style={{ fontSize: 14, fontWeight: 400 }}>
              {priceUnit}
            </span>
          </div>
        </div>
        <p className="mkt-muted" style={{ fontSize: 14, margin: 0, lineHeight: 1.7 }}>
          {body}
        </p>
      </div>
    </div>
  )
}
