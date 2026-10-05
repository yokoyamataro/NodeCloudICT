# NodeCloud アイコン（1b 測点ターゲット）

色: 背景 #1d2d3d / 線 #f2f2f3 / 中心点 #b5d9fd

## iOS
- ios/AppIcon-1024.png — App Store Connect / Xcode AppIcon（角丸・透過なし、OSが角丸を付ける）

## Android
- android/play-store-512.png — Play Console のアプリアイコン
- android/ic_launcher_foreground.png / ic_launcher_background.png — アダプティブアイコン（432px、セーフゾーン66%）
- android/ic_launcher_monochrome.png — Android 13+ テーマアイコン用

## Web（nodecloud.jp）
- web/favicon.svg, favicon-32.png — <link rel="icon">
- web/apple-touch-icon-180.png
- web/icon-192.png, icon-512.png — manifest.json 用

Next.js: app/ 直下に icon.svg（=favicon.svg）・apple-icon.png（=180）を置くと自動で <head> に入ります。
