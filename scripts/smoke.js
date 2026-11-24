/**
 * 起動中サーバーに対する簡易スモークテスト。
 * 使い方: サーバーを起動した状態で `node scripts/smoke.js`
 * 環境変数 SMOKE_BASE で接続先を変更できる（既定: http://127.0.0.1:3000）
 */
const WebSocket = require("ws");

const BASE = process.env.SMOKE_BASE ?? "http://127.0.0.1:3000";
const isHttps = BASE.startsWith("https:");
/** 自己署名（mkcert）でも通す。`NODE_EXTRA_CA_CERTS` を渡せば検証もできる */
const transport = isHttps ? require("https") : require("http");
const tlsOptions = isHttps ? { rejectUnauthorized: false } : {};

function getJson(pathname) {
  return new Promise((resolve, reject) => {
    transport
      .get(`${BASE}${pathname}`, tlsOptions, (res) => {
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

function requestJson(method, pathname, body) {
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const url = new URL(`${BASE}${pathname}`);
    const req = transport.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method,
        headers: payload
          ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
          : {},
        ...tlsOptions,
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null });
          } catch (error) {
            reject(new Error(`${pathname} の応答を解析できません: ${raw.slice(0, 200)}`));
          }
        });
      }
    );
    req.on("error", reject);
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

function waitForWebSocket() {
  return new Promise((resolve) => {
    const url = `${BASE.replace(/^http/, "ws")}/ws`;
    const ws = new WebSocket(url, tlsOptions);
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

  // 画面のモデル選択が使う候補一覧（Ollama 停止中でも 200 が返る）
  const models = await getJson("/api/models");
  console.log(
    "[smoke] models:",
    JSON.stringify({
      stt: models.stt?.engine,
      whisper: models.stt?.whisper?.length ?? 0,
      sherpa: models.stt?.sherpa?.length ?? 0,
      llm: models.llm?.model,
      llmModels: models.llm?.models?.length ?? 0,
      ollama: models.llm?.available,
    })
  );

  const history = await getJson("/api/history");
  console.log("[smoke] history messages:", history.messages?.length ?? 0);

  // 設定の往復（PATCH は現在値と同じ値を書き戻すだけで、挙動は変えない）
  // 注意: PATCH は settings.toml を正規化して保存するため、コメントや手書きの構成は失われる。
  //       設定ファイルを編集した直後は**サーバーを再起動してから**実行すること
  //       （古いプロセスが残っていると、そのメモリ上の設定で上書きされ [tts.ja] などが消える）。
  //       設定を触りたくないときは SMOKE_NO_PATCH=1 でスキップできる。
  if (process.env.SMOKE_NO_PATCH === "1") {
    console.log("[smoke] config patch: skip (SMOKE_NO_PATCH=1)");
  } else {
    const patched = await requestJson("PATCH", "/api/config", {
      llm: { temperature: config.llm?.temperature },
    });
    if (patched.status !== 200) {
      throw new Error(`PATCH /api/config が ${patched.status} を返しました`);
    }
    console.log(
      "[smoke] config patch:",
      JSON.stringify({ temperature: patched.body?.llm?.temperature, warnings: patched.body?.warnings?.length ?? 0 })
    );
  }
  const reloaded = await requestJson("POST", "/api/config/reload");
  if (reloaded.status !== 200) {
    throw new Error(`POST /api/config/reload が ${reloaded.status} を返しました`);
  }
  console.log("[smoke] config reload: OK");

  const devices = await getJson("/api/audio-devices");
  console.log("[smoke] audio devices:", devices.devices?.map((d) => d.name).join(", ") || "(なし)");

  const wsMessages = await waitForWebSocket();
  console.log("[smoke] ws messages:", wsMessages.join(", "));

  console.log("[smoke] OK");
})().catch((error) => {
  console.error("[smoke] 失敗:", error.message);
  process.exit(1);
});
