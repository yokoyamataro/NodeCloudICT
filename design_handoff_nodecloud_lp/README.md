# Handoff: nodecloud.jp LP リニューアル（トップ / サポート / プライバシー）

## Overview
nodecloud.jp の公開サイトを、地籍測量・土木工事の2業務を1ページに統合したLPとして作り直す。
対象リポジトリ: `yokoyamataro/NodeCloudICT`（main）— 既存の `src/features/marketing/LandingPage.tsx` を置き換える。
App Store / Google Play 提出用に、マーケティングURL（/）・サポートURL（/support）・プライバシーポリシーURL（/privacy）を兼ねる。

## About the Design Files
`design/` 内の `*.dc.html` は **HTMLで作ったデザインリファレンス**（見た目と挙動の見本）であり、そのまま本番に載せるコードではない。
既存の Next.js / React + Tailwind 環境の流儀で **再実装** すること。ブラウザで直接開いて確認できる（同梱の support.js と _ds/ が必要）。

## Fidelity
**High-fidelity。** 色・書体・余白・文言は確定。ピクセル単位で再現する。文言は HTML 内のテキストが正（README には要点のみ）。

## ルーティング
| パス | 元ファイル | 備考 |
|---|---|---|
| / | LP Top.dc.html | 旧 /lp は / へ 301 |
| /support | LP Support.dc.html | App Store サポートURL。#faq #devices #contact アンカー |
| /privacy | LP Privacy.dc.html | App Store プライバシーポリシーURL |
いずれもログイン不要で閲覧できること（審査要件）。

## Design Tokens（Industry デザインシステム）
`tokens/industry.css` をそのまま読み込むか、Tailwind theme.extend に移植。

- 地 `--color-bg` #f2f2f3 / 面 `--color-surface` #e9e9ea / 文字 `--color-text` #1d1f20
- 区切り線 `--color-divider` = #1d1f20 16%
- アクセント #5980a6。ランプ 100 #eef6ff / 200 #d6ebff / 300 #b5d9fd / 400 #94bce3 / 500 #749dc4 / 600 #597ea3 / 700 #416180 / 800 #2c455d / 900 #1d2d3d
- ニュートラル 400 #b7b7ba / 700 #5d5d60（補足文）/ 800 #424244（リード文）
- 見出し: Barlow Condensed 600 + Noto Sans JP、letter-spacing -.01em、line-height 1.15
- 本文: Barlow 400 + Noto Sans JP
- 角丸: 0（カード・図版・ボタンすべて角張り）
- 影: sm `0 1px 2px #2b2b2d24` / lg `0 12px 32px #2b2b2d38`
- 本文リンク: #416180、hover #2c455d
- フォーカス: `outline:2px solid #5980a6; outline-offset:2px`

### 共通パターン
- **.blueprint**: 1px 区切り線色の枠 + 四隅に「+」のレジストレーションマーク（`<i class="corner tl|tr|bl|br">`）。カード・図版・主ボタンに付ける。塗りなし。
- **.btn-primary**: アクセント塗り、文字 #f2f2f3、角丸0。hover は accent-600。
- **.kicker**: 11px / letter-spacing .1em / uppercase / アクセント色 / 下8px。
- **.wrap**: max-width 1200px、左右 padding clamp(20px,4vw,56px)。
- **.two**: grid auto-fit minmax(300px,1fr) gap 32px（狭い画面で1列）。
- **.step**: grid 32px 1fr gap 12px。番号は Barlow Condensed 22px accent-700。
- **.duotone**: 写真を鉄青のモノトーンに（開発者写真に使用）。スクショには使わない。
- ボタン・ナビ・セグメントは `white-space:nowrap`。

## Screens

### 1. トップ（/）
上から順に:
1. **ヘッダー**: ロゴ（アイコン26px + 「NodeCloud」Barlow Condensed 600 22px）/ ナビ（機能・業務別・料金・FAQ・サポート・ログイン）/ 主ボタン「デモを予約」。gap 24px、狭い画面では折り返し。
2. **ヒーロー**（2列）: 左にセグメント「地籍測量｜土木工事」→ kicker → h1（clamp(28px,3.4vw,44px)、`<br>`で2行）→ リード文17px/1.7 → CTA（デモを予約する / 機能を見る→）→ ストアボタン2つ（App Store・Google Play「準備中」、opacity .75、押下不可）→ 区切り線の下に「2026.12.31まで無償提供」「自動課金なし」。
   右は PC枠（幅78%, 16:10）とスマホ枠（幅34%, 9:19, 右下に重ね, shadow-lg）。
   - **自動切替**: 6秒ごとに 地籍⇄土木。フェード 0.5s（opacity 0→1, translateY 6px→0）。セグメントをクリックすると自動切替停止しその業務で固定。`prefers-reduced-motion` では自動切替しないこと。
   - 両業務の文言は同じグリッドセルに重ね、非表示側は visibility:hidden（高さが揺れない）。
   - 画像: 地籍 PC=screen-cadastral-drawing.png（下端揃え、幅115%、左-7.5%）/ スマホ=screen-phone-photo.png（cover, 上揃え）。土木 PC=screen-civil-cross.png / スマホ=screen-phone-civil.png（cover, 上揃え）。
3. **Workflow**（#workflow）: 中央見出し + 2カード（内業 PC 01–03 / 現場 スマホ 04–06）。
4. **業務別の機能**（#solutions、背景 surface）: 見出し右にセグメント「地籍測量｜土木工事」。左に kicker・h3・説明・step リスト、右に画像を縦に3枚（各 16:10 の blueprint 枠, gap 24px）。
   - 地籍 01–05 / 画像: screen-cad-coords.png → screen-report-93.png → screen-photo-album.png
   - 土木 01–04 / 画像: screen-civil-cross.png → screen-civil-drain.png → screen-civil-map.png
   - 報告書・写真帳は横幅いっぱい・下は切れてよい（元HTMLの left/width 値を参照）。
5. **料金**（#pricing）: **常に2列×2段**。各カード: tag → h3 22px → 単位 12px → 金額 Barlow Condensed 40px + 単位 → 説明。
   - 左上 基本プラン 1ユーザー ¥3,300〜/月 / 右上 Drogger Gパッケージ 1台 ¥220,000（買い切り）
   - 左下 地図作成作業パッケージ（地籍測量）1現場 ¥220,000（1年間限り）/ 右下 ICT施工パッケージ（土木工事）同額
   - ⚠ 下段2つの説明文は仮。税込/税抜表記が未定。
6. **Company**: 左に見出し・本文、右に開発者写真（4:3, duotone）。その下に全幅で 開発・運用 / 代表 / 開発協力 の2列表。
7. **FAQ**（#faq）: 2列、4問。「すべての質問を見る→」で /support#faq。
8. **デモ帯**（#demo）: 背景 accent-900、白文字、ボタンは地色塗り → /support#contact。
9. **フッター**: © / サポート・利用規約・プライバシーポリシー。

### 2. サポート（/support）
ヘッダー（「サポート」タグ付き）→ タイトル → 2列（左 sticky: 目次 + 電話カード / 右: FAQ 3カテゴリ → 対応機器・動作環境表 → お問い合わせフォーム）。
- 対応機器表: grid 180px 1fr、各セル 12px 16px、上罫線。座標系は JGD2024。
- フォーム項目: ご用件（select）/ お名前 / 会社名 / メール / 電話（任意）/ 内容。送信後はフォームの位置に受付完了カード（受付番号・確認メール送信済み・届かない場合の案内・トップへ戻る / 別の問い合わせ）。

### 3. プライバシーポリシー（/privacy）
本文 max-width 760px、15px/1.85。12条、各条は上罫線 + 番号付き h2（grid 44px 1fr）。
⚠ `.todo` でハイライトした箇所は未確定（制定日、所在地、窓口メール、外部委託先、車両動態の送信条件、保存日数、解析ツール）。**公開前に確定させ、ハイライトを外す。専門家確認推奨。**

## Interactions & State
- トップ: `heroTab: 'cad'|'civ'`, `heroPaused: boolean`, `solutionTab: 'cad'|'civ'`。setInterval 6000ms、unmount で clear。
- サポート: `sent: boolean`。

## お問い合わせ送信（要実装）
- POST /api/contact → 社内受信アドレスへ通知 + 送信者へ自動返信。
- 自動返信テンプレ: `email/auto-reply.html`（HTMLメール、テーブル組み・インラインCSS・ダークモード対応）と `email/auto-reply.txt`（テキスト版）。差し込み変数: {{company}} {{name}} {{ticket_id}} {{topic}} {{received_at}} {{message}} {{phone}} {{address}}。
- 送信元は noreply@nodecloud.jp 等（返信不可と明記済み）。受付番号形式例: NC-YYYYMMDD-NNNN。
- 候補: Resend / SendGrid、または Supabase に保存 + 通知。バリデーション: 名前・メール・内容は必須、メール形式チェック、スパム対策（honeypot or Turnstile）。

## Assets
- `assets/` — 画面スクショ（アプリ実画面）と開発者写真（付箋・名刺を除去済み）。
- `icons/` — アプリアイコン1b（測点ターゲット）一式。web/ の favicon.svg を app/icon.svg、apple-touch-icon-180.png を app/apple-icon.png に。ios/ android/ はストア提出用。
- ヘッダーのロゴアイコンはインラインSVG（元HTML参照）。

## SEO / メタ（未作成・要実装）
- title / description / OGP画像 / canonical（https://nodecloud.jp/）。

## 未確定事項
- 電話番号・受付時間・所在地（サポート、メール、プライバシー）
- 料金: 下段パッケージの内容説明、税表記
- ストアURL（公開後にボタンを有効化）

## Files
- design/LP Top.dc.html, LP Support.dc.html, LP Privacy.dc.html（+ support.js, _ds/ で単体表示可）
- tokens/industry.css
- email/auto-reply.html, auto-reply.txt
- assets/, icons/
