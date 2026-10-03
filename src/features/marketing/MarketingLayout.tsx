// マーケティング ページ (/ · /support · /privacy) 共通 の ラッパー。
// - ページ 全体 に .marketing-root スコープ を 掛けて トークン を 効かせる
// - ヘッダ (ロゴ + ナビ) と フッタ (© + ページ リンク) を まとめる
// - ページ 個別 の ナビ 項目 は props で 差し替え可能

import { useEffect, type ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'
import './marketing.css'

/**
 * 業務アプリ (src/index.css) で html,body に overflow:hidden; height:100%;
 * (さらに overscroll-behavior:none) が かかって いる の で、 ホイール で
 * ページ全体 を スクロール できない。 マーケティング 画面 の 間 だけ
 * body 要素 に クラス を 付けて overflow / height / overscroll を 開放 する。
 *
 * CSS 側 で !important + 高 詳細度 (body.mkt-scroll-release) で 既存 の
 * 「html,body」 ルール を 確実 に 上書き する。 unmount 時 に クラス を
 * 剥がせば アプリ 用 の 設定 に 戻る。
 */
export function useReleasePageScroll() {
  useEffect(() => {
    const html = document.documentElement
    const body = document.body
    html.classList.add('mkt-scroll-release')
    body.classList.add('mkt-scroll-release')
    return () => {
      html.classList.remove('mkt-scroll-release')
      body.classList.remove('mkt-scroll-release')
    }
  }, [])
}

/** ヘッダ左端の NodeCloud ロゴ (アイコン 26px + ワードマーク)。 */
function BrandLogo() {
  return (
    <Link
      to="/"
      style={{
        fontFamily: '"Barlow Condensed", sans-serif',
        fontWeight: 600,
        fontSize: 22,
        letterSpacing: '0.02em',
        textDecoration: 'none',
        color: 'var(--mkt-text)',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 10,
      }}
    >
      <svg
        width="26"
        height="26"
        viewBox="0 0 100 100"
        aria-hidden="true"
        style={{ display: 'block', borderRadius: '22%' }}
      >
        <rect width="100" height="100" style={{ fill: 'var(--mkt-accent-900)' }} />
        <g style={{ fill: 'none', stroke: 'var(--mkt-bg)', strokeWidth: 5 }}>
          <circle cx="50" cy="50" r="24" />
          <path d="M50 13V33M50 67V87M13 50H33M67 50H87" />
        </g>
        <circle cx="50" cy="50" r="7" style={{ fill: 'var(--mkt-accent-300)' }} />
      </svg>
      NodeCloud
    </Link>
  )
}

/** ヘッダ 内 の アンカー / ルート リンク。 現在 ページ の アンカー は #foo を 使う。 */
export type NavItem =
  | { kind: 'anchor'; href: string; label: string }
  | { kind: 'route'; to: string; label: string }

interface Props {
  /** ヘッダー ロゴ の 右 に 出す タグ (「サポート」「プライバシーポリシー」など)。 */
  tag?: string
  navItems: NavItem[]
  /** ヘッダ 右端 の 主 CTA。 省略時 は 出さない。 */
  cta?: { href: string; label: string; kind?: 'anchor' | 'route' }
  children: ReactNode
}

export function MarketingLayout({ tag, navItems, cta, children }: Props) {
  const loc = useLocation()
  useReleasePageScroll()

  const renderNav = (item: NavItem) => {
    if (item.kind === 'route') {
      return (
        <Link key={item.label} className="mkt-navlink" to={item.to}>
          {item.label}
        </Link>
      )
    }
    return (
      <a key={item.label} className="mkt-navlink" href={item.href}>
        {item.label}
      </a>
    )
  }

  return (
    <div className="marketing-root">
      <header
        className="mkt-wrap"
        style={{
          display: 'flex',
          alignItems: 'center',
          columnGap: 'clamp(12px, 2vw, 24px)',
          rowGap: 10,
          paddingTop: 18,
          paddingBottom: 18,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ marginRight: tag ? 0 : 'auto' }}>
          <BrandLogo />
        </div>
        {tag && (
          <span className="mkt-tag mkt-tag-neutral" style={{ marginRight: 'auto' }}>
            {tag}
          </span>
        )}
        {navItems.map(renderNav)}
        {/* ログイン は アプリ の /login (認証ページ) へ */}
        <Link className="mkt-navlink" to="/login">
          ログイン
        </Link>
        {cta &&
          (cta.kind === 'route' ? (
            <Link className="btn btn-primary" to={cta.href} style={{ padding: '9px 18px' }}>
              {cta.label}
            </Link>
          ) : (
            <a className="btn btn-primary" href={cta.href} style={{ padding: '9px 18px' }}>
              {cta.label}
            </a>
          ))}
      </header>

      {children}

      <footer
        className="mkt-wrap mkt-muted"
        style={{
          paddingTop: 28,
          paddingBottom: 28,
          borderTop: '1px solid var(--mkt-divider)',
          display: 'flex',
          justifyContent: 'space-between',
          fontSize: 12,
          flexWrap: 'wrap',
          gap: 12,
        }}
      >
        <div>© NodeCloud / 有限会社横山測量設計事務所</div>
        <div style={{ display: 'flex', gap: 20 }}>
          {loc.pathname !== '/' && (
            <Link to="/" style={{ color: 'var(--mkt-neutral-700)' }}>
              トップ
            </Link>
          )}
          {loc.pathname !== '/support' && (
            <Link to="/support" style={{ color: 'var(--mkt-neutral-700)' }}>
              サポート
            </Link>
          )}
          {/* TODO: 利用規約 ページ は 未作成 */}
          <a href="#" style={{ color: 'var(--mkt-neutral-700)' }}>
            利用規約
          </a>
          {loc.pathname !== '/privacy' && (
            <Link to="/privacy" style={{ color: 'var(--mkt-neutral-700)' }}>
              プライバシーポリシー
            </Link>
          )}
        </div>
      </footer>
    </div>
  )
}

/** blueprint の 四隅 マーク をまとめて 出す ヘルパー。 */
export function BlueprintCorners() {
  return (
    <>
      <i className="corner tl" />
      <i className="corner tr" />
      <i className="corner bl" />
      <i className="corner br" />
    </>
  )
}
