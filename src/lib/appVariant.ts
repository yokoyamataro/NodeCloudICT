// アプリのバリアント (メインの ICT / モビリティ専用) を判定するユーティリティ。
//
// - メイン (NodeCloud ICT): 全機能表示。index.html / src/main.tsx から起動
// - モビリティ (NodeCloud Mobility): 運転手向け。mobility.html /
//   src/mobility-main.tsx から起動
//
// 判定は **ビルドのエントリごと** に決まる。エントリが起動直後に
// setAppVariant() を呼び、以降は それを 参照するだけ。
//
// 以前は URL クエリ `?app=mobility` + localStorage 永続化で 実行時に 判定して
// いたが、一度でも そのリンクを 踏んだ 端末が 永久に ドライバー専用モードに
// 固着し、脱出口が `?app=ict` しか 無いという 事故要因になっていた。
// エントリを 分けたことで 実行時判定そのものが 不要になったため 廃止した。

export type AppVariant = 'ict' | 'mobility'

let variant: AppVariant = 'ict'

/**
 * エントリポイントから 1 回だけ呼ぶ。render より前に 実行すること
 * (getActiveSource() など 初期化時に 参照する 箇所があるため)。
 */
export function setAppVariant(v: AppVariant): void {
  variant = v
}

export function getAppVariant(): AppVariant {
  return variant
}

export function isMobilityApp(): boolean {
  return variant === 'mobility'
}
