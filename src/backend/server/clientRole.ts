/** クライアントの役割。display は音声を鳴らす担当（OBS / デスクトップ窓） */
export type ClientRole = "display" | "control";

export interface ClientIdentity {
  id: string;
  role: ClientRole;
}

/** `?role=display` を読む（既定は control） */
export function parseClientRole(url: string | undefined | null): ClientRole {
  if (!url) {
    return "control";
  }
  const index = url.indexOf("?");
  if (index < 0) {
    return "control";
  }
  const params = new URLSearchParams(url.slice(index + 1));
  return params.get("role") === "display" ? "display" : "control";
}

/** primary（音声を鳴らすクライアント）を選ぶ。display 優先、無ければ先頭 */
export function pickPrimaryClientId(clients: ClientIdentity[]): string | null {
  return clients.find((client) => client.role === "display")?.id ?? clients[0]?.id ?? null;
}
