/**
 * エラー分類の共通ユーティリティ。
 *
 * かつて中断判定を `/abort/i.test(message)` で行っていたため、Node の接続断
 * （`Error: aborted`）まで「ユーザー操作による中断」と誤判定し、無言で失敗していた。
 * 判定は **AbortSignal の状態**で行い、文字列一致には依存しない。
 */

/** 中断されたか（AbortSignal の状態で判定する） */
export function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

/** 中断を表すエラーを作る（name = AbortError） */
export function abortError(message = "処理が中断されました"): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

/** 例外からメッセージ文字列を取り出す */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 通信レベルのエラーを、原因が分かるメッセージへ変換する。
 *
 * Node は接続が切られると `Error: aborted` を投げる（メッセージに abort を含む）ため、
 * そのまま流すとユーザーには原因が分からない。呼び出し側は対象名（例: "Ollama"）を渡す。
 */
export function describeTransportError(
  error: unknown,
  target: string,
  hint = "接続先の状態（未起動・モデルの読み込み失敗・メモリ不足・再起動など）を確認してください"
): Error {
  const message = errorMessage(error);
  const code = (error as { code?: string }).code ?? "";
  if (/abort|ECONNRESET|EPIPE|socket hang up/i.test(`${message} ${code}`)) {
    return new Error(`${target} との接続が中断されました（${hint}）: ${message}`);
  }
  if (/ECONNREFUSED/i.test(`${message} ${code}`)) {
    return new Error(`${target} に接続できません（${hint}）: ${message}`);
  }
  return error instanceof Error ? error : new Error(message);
}
