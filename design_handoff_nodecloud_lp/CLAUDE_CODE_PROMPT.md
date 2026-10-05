# Claude Code への指示文（コピーして貼り付け）

design_handoff_nodecloud_lp/ の README.md を読み、nodecloud.jp の公開ページを再実装してください。

1. / （トップ）、/support、/privacy の3ルートを作成。既存 src/features/marketing/LandingPage.tsx は置き換え、旧 /lp は / へ 301。
2. design/*.dc.html をブラウザで開いて見た目・文言・挙動を確認し、既存の React + Tailwind の流儀で再実装。HTMLをそのまま埋め込まない。
3. tokens/industry.css の変数を Tailwind theme に移植（色・フォント・角丸0・影）。
4. assets/ と icons/web/ を public/ と app/ に配置。
5. /api/contact を実装し、email/ のテンプレで自動返信 + 社内通知。
6. ヒーローの自動切替は prefers-reduced-motion で停止。
7. title/description/OGP を設定。
8. 完了後、スマホ幅（375px）とPC幅（1440px）で表示を確認。
未確定事項（README 末尾）は TODO コメントで残してください。
