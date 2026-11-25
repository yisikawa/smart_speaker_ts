/** 画面表示用のエラー文言（Error 以外も文字列化する） */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
