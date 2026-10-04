// 全国 47 都道府県コード → 表示名 (総務省 全国地方公共団体コードの 2 桁 prefecture code)。
// parcel_map_datasets.prefecture_code / touki.or.jp の 都道府県 select value と同じ。

/** コード (「01」等) を 持たない 単純 な 名前 配列。 select の option や
 *  組織台帳 / 申込 フォーム の 都道府県 選択 で 使う。 */
export const PREFECTURE_NAME_LIST: readonly string[] = [
  '北海道',
  '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県',
  '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県',
  '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県',
  '岐阜県', '静岡県', '愛知県', '三重県',
  '滋賀県', '京都府', '大阪府', '兵庫県', '奈良県', '和歌山県',
  '鳥取県', '島根県', '岡山県', '広島県', '山口県',
  '徳島県', '香川県', '愛媛県', '高知県',
  '福岡県', '佐賀県', '長崎県', '熊本県', '大分県', '宮崎県', '鹿児島県',
  '沖縄県',
]

export interface ZipLookupResult {
  prefecture: string
  rest: string
}

/**
 * 郵便番号 (7 桁) から 都道府県 と 「区郡市町村以下」 を 引く (zipcloud 無料 API)。
 * 失敗時 は null を 返す ので 呼び出し元 で 手入力 を 促す。
 */
export async function lookupPostalCode(zip: string): Promise<ZipLookupResult | null> {
  const digits = zip.replace(/[^0-9]/g, '')
  if (digits.length !== 7) return null
  try {
    const res = await fetch(`https://zipcloud.ibsnet.co.jp/api/search?zipcode=${digits}`)
    const json = (await res.json()) as {
      results?: Array<{ address1: string; address2: string; address3: string }> | null
    }
    const r = json?.results?.[0]
    if (!r) return null
    return {
      prefecture: r.address1,
      rest: `${r.address2}${r.address3}`,
    }
  } catch {
    return null
  }
}

export const PREFECTURE_NAMES: Record<string, string> = {
  '01': '北海道', '02': '青森県', '03': '岩手県', '04': '宮城県', '05': '秋田県',
  '06': '山形県', '07': '福島県', '08': '茨城県', '09': '栃木県', '10': '群馬県',
  '11': '埼玉県', '12': '千葉県', '13': '東京都', '14': '神奈川県', '15': '新潟県',
  '16': '富山県', '17': '石川県', '18': '福井県', '19': '山梨県', '20': '長野県',
  '21': '岐阜県', '22': '静岡県', '23': '愛知県', '24': '三重県', '25': '滋賀県',
  '26': '京都府', '27': '大阪府', '28': '兵庫県', '29': '奈良県', '30': '和歌山県',
  '31': '鳥取県', '32': '島根県', '33': '岡山県', '34': '広島県', '35': '山口県',
  '36': '徳島県', '37': '香川県', '38': '愛媛県', '39': '高知県', '40': '福岡県',
  '41': '佐賀県', '42': '長崎県', '43': '熊本県', '44': '大分県', '45': '宮崎県',
  '46': '鹿児島県', '47': '沖縄県',
}

/** 都道府県コード (2 桁文字列) → 表示名。不明時は null */
export function prefectureNameByCode(code: string | null | undefined): string | null {
  if (!code) return null
  return PREFECTURE_NAMES[code] ?? null
}

/** 「北海道斜里町 R7地図」のような dataset name から都道府県プレフィクスを剥がし、
 *  郡町村部分だけを返す。「R7地図」等のサフィックスもトリム。
 *  不明時は null を返す (呼び出し側で fallback してもらう)。 */
export function extractMunicipalityFromDatasetName(
  name: string | null | undefined,
  prefectureCode: string | null | undefined,
): string | null {
  if (!name) return null
  let s = name.trim()
  const prefName = prefectureNameByCode(prefectureCode)
  if (prefName && s.startsWith(prefName)) {
    s = s.slice(prefName.length).trim()
  } else {
    // prefectureCode が無い場合も念のため全 47 名で先頭マッチを試す
    for (const p of Object.values(PREFECTURE_NAMES)) {
      if (s.startsWith(p)) {
        s = s.slice(p.length).trim()
        break
      }
    }
  }
  // 都道府県と市町村の間に入りがちなセパレータを剥がす。
  // Unicode の文字/数字が現れるまで先頭の記号類を全部除去 (\p{L}\p{N} 以外)
  s = s.replace(/^[^\p{L}\p{N}]+/u, '').trim()
  // 末尾の「R6地図」「R7地図」「2024地図」等の年次サフィックスを剥がす
  s = s.replace(/\s*R\d+\s*地図$/, '').trim()
  s = s.replace(/\s*\d{4}\s*地図$/, '').trim()
  s = s.replace(/\s*地図$/, '').trim()
  return s.length > 0 ? s : null
}
