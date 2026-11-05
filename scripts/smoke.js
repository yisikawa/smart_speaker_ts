/**
 * 起動中サーバーに対する簡易スモークテスト。
 * 使い方: サーバーを起動した状態で `node scripts/smoke.js`
 * 環境変数 SMOKE_BASE で接続先を変更できる（既定: http://127.0.0.1:3000）
 */
const http = require("http");
const WebSocket = require("ws");

const BASE = process.env.SMOKE_BASE ?? "http://127.0.0.1:3000";

function getJson(pathname) {
  return new Promise((resolve, reject) => {
    http
      .get(`${BASE}${pathname}`, (res) => {
        let raw = "";
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(raw));
          } catch (error) {
            reject(new Error(`${pathname} の応答を解析できません: ${raw.slice(0, 200)}`));
          }
        });
      })
      .on("error", reject);
  });
}

function waitForWebSocket() {
  return new Promise((resolve) => {
    const url = `${BASE.replace(/^http/, "ws")}/ws`;
    const ws = new WebSocket(url);
    const seen = [];
    const timer = setTimeout(() => {
      ws.terminate();
      resolve(seen);
    }, 5000);

    ws.on("message", (data) => {
      const message = JSON.parse(data.toString());
      seen.push(message.type);
      if (message.type === "hello") {
        ws.send(JSON.stringify({ type: "get_state" }));
        ws.send(JSON.stringify({ type: "ping" }));
      }
      if (message.type === "pong") {
        clearTimeout(timer);
        ws.close();
        resolve(seen);
      }
    });
    ws.on("error", () => {
      clearTimeout(timer);
      resolve(seen);
    });
  });
}

(async () => {
  const health = await getJson("/api/health");
  console.log("[smoke] health:", JSON.stringify(health));

  const state = await getJson("/api/state");
  console.log("[smoke] state:", JSON.stringify(state));

  const config = await getJson("/api/config");
  console.log(
    "[smoke] config:",
    JSON.stringify({ llm: config.llm?.model, tts: config.tts?.speaker_id, auto_start: config.conversation?.auto_start })
  );

  const history = await getJson("/api/history");
  console.log("[smoke] history messages:", history.messages?.length ?? 0);

  const devices = await getJson("/api/audio-devices");
  console.log("[smoke] audio devices:", devices.devices?.map((d) => d.name).join(", ") || "(なし)");

  const wsMessages = await waitForWebSocket();
  console.log("[smoke] ws messages:", wsMessages.join(", "));

  console.log("[smoke] OK");
})().catch((error) => {
  console.error("[smoke] 失敗:", error.message);
  process.exit(1);
});
