#!/usr/bin/env bash
# NodeCloud Mobility (運転手専用 APK) をビルドするスクリプト。
#
# 使い方:
#   ./scripts/build-mobility-apk.sh          # debug build
#   ./scripts/build-mobility-apk.sh release  # release build (要 keystore)
#
# 前提:
#   - Java 21 が使える (JAVA_HOME 未設定なら Android Studio 同梱 JBR を試す)
#   - リモート URL (nodecloud.jp) が生きている想定 (server.url 経由でロード)

set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
VARIANT_DIR="$ROOT/android-mobility"

BUILD_TYPE="${1:-debug}"
if [[ "$BUILD_TYPE" != "debug" && "$BUILD_TYPE" != "release" ]]; then
  echo "usage: $0 [debug|release]" >&2
  exit 1
fi

# JAVA_HOME を自動検出 (Windows/mac 別)
if [[ -z "${JAVA_HOME:-}" ]]; then
  if [[ -d "/c/Program Files/Android/Android Studio1/jbr" ]]; then
    export JAVA_HOME="/c/Program Files/Android/Android Studio1/jbr"
  elif [[ -d "/c/Program Files/Android/Android Studio/jbr" ]]; then
    export JAVA_HOME="/c/Program Files/Android/Android Studio/jbr"
  elif [[ -d "/Applications/Android Studio.app/Contents/jbr/Contents/Home" ]]; then
    export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
  fi
fi
echo "JAVA_HOME = ${JAVA_HOME:-<unset>}"

echo "==> npm run build"
npm run build

echo "==> dist/ -> android-mobility/app/src/main/assets/public/"
rm -rf "$VARIANT_DIR/app/src/main/assets/public"
cp -R dist "$VARIANT_DIR/app/src/main/assets/public"

# capacitor.config.json は git 管理下で mobility 用に固定されているので上書きしない

echo "==> gradlew assemble$( [[ $BUILD_TYPE == release ]] && echo Release || echo Debug )"
cd "$VARIANT_DIR"
if [[ "$BUILD_TYPE" == "release" ]]; then
  ./gradlew assembleRelease --console=plain --no-daemon
  echo "APK: $VARIANT_DIR/app/build/outputs/apk/release/app-release-unsigned.apk"
else
  ./gradlew assembleDebug --console=plain --no-daemon
  echo "APK: $VARIANT_DIR/app/build/outputs/apk/debug/app-debug.apk"
fi
