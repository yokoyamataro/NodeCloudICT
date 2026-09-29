#!/bin/sh
# Xcode Cloud の post-clone フック。
#
# Capacitor は node_modules の 中 に プラグイン (今回 は @capacitor/geolocation)
# を 持って いて、 ios-ict/App/CapApp-SPM/Package.swift が それ を 相対パス で
# 参照 する。 Xcode Cloud は 単に git clone しか して 呉れ ない ので node_modules
# が 存在 せず パッケージ 解決 に 失敗 する。 ここ で 依存 を 揃える。
#
# ついで に 「capacitor.config.ios.ts を capacitor.config.ts に 差し替えて
# build + cap sync ios」 まで やる (npm run ios:sync と 同等 の 中身)。
# ローカル 開発 と 同じ 手順 に なる ので、 端末 側 と 挙動 が ズレ ない。

set -e

echo "=== ci_post_clone.sh (NodeCloudICT / ios-ict) ==="

# Xcode Cloud は $CI_PRIMARY_REPOSITORY_PATH に 一次 リポジトリ を 展開 する。
# ios-ict/App/CapApp-SPM/Package.swift は そこ を 起点 に 3 階層 上 に 遡って
# node_modules を 見に 行く ので、 リポジトリ ルート に cd する。
cd "$CI_PRIMARY_REPOSITORY_PATH"

echo "--- Install Node (via Homebrew) ---"
# Xcode Cloud の macOS ランナー に は brew が 入って いる。 node は 都度 入れる。
# バージョン は package.json の engines か lockfile が 決めて いる もの に 合わせる。
brew install node

echo "Node: $(node --version) / npm: $(npm --version)"

echo "--- npm ci ---"
# CI では lockfile 尊重 の ci を 使う。 audit / fund の 通信 は 切って 高速化。
npm ci --no-audit --no-fund

echo "--- Prepare Capacitor iOS config ---"
# ローカル の ios:sync と 同じ 手順。 android 用 に 戻す 処理 は CI では 要らない。
cp capacitor.config.ios.ts capacitor.config.ts

echo "--- Build web (dist/) ---"
# server.url で リモート 読み込み 運用 だが、 cap sync 時 に dist を 参照
# する のと、 App Store 審査 対策 の ipa 内 バンドル 用 に ビルド は 走らせる。
npm run build

echo "--- cap sync ios ---"
npx cap sync ios

echo "--- Patch capacitor.config.json (add DroggerLocationPlugin) ---"
# ローカル ios:sync と 同じ パッチ。 cap sync 後 に packageClassList へ 追加。
node -e "const f='ios-ict/App/App/capacitor.config.json';const fs=require('fs');const j=JSON.parse(fs.readFileSync(f));if(!j.packageClassList.includes('DroggerLocationPlugin'))j.packageClassList.push('DroggerLocationPlugin');fs.writeFileSync(f,JSON.stringify(j,null,2));console.log('packageClassList:', j.packageClassList);"

echo "=== ci_post_clone.sh done ==="
