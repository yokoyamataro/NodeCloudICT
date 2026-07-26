// 地図描画モードのツールバー (ペン / 消しゴム / 色 / 太さ / 全消し)。
//
// 呼び出し側で mode / color / widthPx の state を持ち、この toolbar は
// UI と callback のみを提供する (pure)。

import { useState } from 'react'
import { Eraser, Pen, Trash2, X } from 'lucide-react'
import type { DrawingMode } from './MapDrawingLayer'

const COLOR_PRESETS = [
  '#ef4444', // 赤
  '#f97316', // オレンジ
  '#eab308', // 黄
  '#22c55e', // 緑
  '#3b82f6', // 青
  '#a855f7', // 紫
  '#111827', // 黒
  '#ffffff', // 白
]

interface Props {
  mode: DrawingMode
  onChangeMode: (mode: DrawingMode) => void
  color: string
  onChangeColor: (color: string) => void
  widthPx: number
  onChangeWidth: (widthPx: number) => void
  strokeCount: number
  onClearAll: () => void
}

export function MapDrawingToolbar({
  mode,
  onChangeMode,
  color,
  onChangeColor,
  widthPx,
  onChangeWidth,
  strokeCount,
  onClearAll,
}: Props) {
  const [colorPickerOpen, setColorPickerOpen] = useState(false)
  return (
    <div className="bg-white border rounded-lg shadow-lg p-2 flex items-center gap-1.5 text-xs">
      {/* ペン */}
      <button
        type="button"
        onClick={() => onChangeMode(mode === 'pen' ? 'off' : 'pen')}
        title="ペン (ドラッグで描画)"
        className={`w-9 h-9 flex items-center justify-center rounded ${
          mode === 'pen'
            ? 'bg-blue-600 text-white'
            : 'text-slate-600 hover:bg-slate-100'
        }`}
      >
        <Pen className="h-4 w-4" />
      </button>
      {/* 消しゴム */}
      <button
        type="button"
        onClick={() => onChangeMode(mode === 'eraser' ? 'off' : 'eraser')}
        title="消しゴム (ストロークをクリックで削除)"
        className={`w-9 h-9 flex items-center justify-center rounded ${
          mode === 'eraser'
            ? 'bg-red-500 text-white'
            : 'text-slate-600 hover:bg-slate-100'
        }`}
      >
        <Eraser className="h-4 w-4" />
      </button>

      <div className="w-px h-6 bg-slate-200 mx-1" />

      {/* 色 (プリセット + カスタム) */}
      <div className="relative">
        <button
          type="button"
          onClick={() => setColorPickerOpen((v) => !v)}
          title="ペンの色"
          className="w-9 h-9 flex items-center justify-center rounded hover:bg-slate-100 border"
          style={{ backgroundColor: color }}
        >
          <span className="sr-only">色を選ぶ</span>
        </button>
        {colorPickerOpen && (
          <div className="absolute top-full left-0 mt-1 z-[3000] bg-white border rounded shadow-lg p-2 flex flex-col gap-1 min-w-[9rem]">
            <div className="grid grid-cols-4 gap-1">
              {COLOR_PRESETS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => {
                    onChangeColor(c)
                    setColorPickerOpen(false)
                  }}
                  className={`w-7 h-7 rounded border ${
                    c === color ? 'ring-2 ring-blue-500' : ''
                  }`}
                  style={{ backgroundColor: c }}
                  title={c}
                />
              ))}
            </div>
            <input
              type="color"
              value={color}
              onChange={(e) => onChangeColor(e.target.value)}
              className="w-full h-8 mt-1"
              title="カスタム色"
            />
          </div>
        )}
      </div>

      {/* 太さスライダ */}
      <div className="flex items-center gap-1 pl-1">
        <span className="text-[10px] text-slate-500">太さ</span>
        <input
          type="range"
          min={1}
          max={20}
          step={1}
          value={widthPx}
          onChange={(e) => onChangeWidth(Number(e.target.value))}
          className="w-16"
          title={`太さ: ${widthPx}px`}
        />
        <span className="text-[10px] font-mono text-slate-600 w-6 text-right">
          {widthPx}
        </span>
      </div>

      <div className="w-px h-6 bg-slate-200 mx-1" />

      {/* 件数 + 全消し */}
      <span className="text-[10px] text-slate-500">{strokeCount} 本</span>
      <button
        type="button"
        onClick={() => {
          if (strokeCount === 0) return
          if (confirm(`すべての描画 (${strokeCount} 本) を削除しますか？`)) {
            onClearAll()
          }
        }}
        disabled={strokeCount === 0}
        title="全消し"
        className="w-9 h-9 flex items-center justify-center rounded text-slate-600 hover:bg-red-50 hover:text-red-600 disabled:opacity-30"
      >
        <Trash2 className="h-4 w-4" />
      </button>

      {/* 閉じる (モード解除) */}
      {mode !== 'off' && (
        <button
          type="button"
          onClick={() => onChangeMode('off')}
          title="描画モードを終了"
          className="w-9 h-9 flex items-center justify-center rounded text-slate-500 hover:bg-slate-100"
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  )
}
