// 一時的な 通信断 の 再試行。
//
// supabase-js は Postgres の エラー を 例外に せず { error } で 返す。
// 例外に なる のは fetch 自体が 失敗した とき —— 「TypeError: Failed to fetch」
// (Safari は「Load failed」) —— つまり 回線の 瞬断 / 接続の 切断 / プロキシ の
// 気まぐれ など。 大きい 工区 は 1000 行ずつ 何回も 取りに 行く ので、
// 途中の 1 回が こけただけ で 全部 やり直し に なって いた。 数回 待って 試す。

/** 回線由来 (= もう一度 やれば 通るかも しれない) の エラーか */
export function isTransientNetworkError(e: unknown): boolean {
  const msg =
    e instanceof Error
      ? e.message
      : e && typeof e === 'object'
        ? String((e as { message?: unknown }).message ?? '')
        : String(e)
  return /failed to fetch|load failed|networkerror|network error|err_network|err_connection|socket hang up|fetch failed/i.test(
    msg,
  )
}

/**
 * fn を 最大 tries 回 試す。 回線由来 の 失敗 だけ 再試行し、
 * それ以外 (権限 / 不正な クエリ) は すぐ 投げ直す。
 */
export async function withRetry<T>(
  // supabase-js の クエリビルダ は Promise では なく thenable なので PromiseLike
  fn: () => PromiseLike<T>,
  tries = 3,
  baseDelayMs = 400,
): Promise<T> {
  let last: unknown
  for (let i = 0; i < tries; i += 1) {
    try {
      return await fn()
    } catch (e) {
      last = e
      if (!isTransientNetworkError(e) || i === tries - 1) throw e
      await new Promise((r) => setTimeout(r, baseDelayMs * (i + 1)))
    }
  }
  throw last
}
