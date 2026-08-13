// polylabel の 最小型宣言。npm パッケージが d.ts を同梱していないため。
declare module 'polylabel' {
  /** ポリゴンの「pole of inaccessibility」= 内部で最も外周から遠い点を返す。
   *  入力: [外周, ホール1, ホール2, ...] の順の リング配列。各リングは [lng, lat] 配列。
   *  出力: [lng, lat]  */
  const polylabel: (
    polygon: number[][][],
    precision?: number,
    debug?: boolean,
  ) => [number, number]
  export default polylabel
}
