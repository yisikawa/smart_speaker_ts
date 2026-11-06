/** DOM ユーティリティ（要素取得・待機） */

/** 必須要素を取得する（無ければ例外。初期化時のID間違いを早期に検出する） */
export function must<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`要素が見つかりません: #${id}`);
  }
  return element as T;
}

/** 指定ミリ秒待つ（ブラウザ用。テストでは window.setTimeout が差し替えられる） */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
