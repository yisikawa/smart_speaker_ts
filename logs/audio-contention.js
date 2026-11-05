// 一時的な録音検証（直列化・孤児プロセス防止・フレーム数）※実行後に削除
const path = require("path");
const { execSync } = require("child_process");
const { ConfigManager } = require("../dist/backend/config/ConfigManager");
const { AudioService } = require("../dist/backend/services/AudioService");
const { Logger } = require("../dist/backend/core/logger");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ffmpegCount = () => {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq ffmpeg.exe" /NH', { encoding: "utf8" });
    return (out.match(/ffmpeg\.exe/g) ?? []).length;
  } catch {
    return -1;
  }
};

(async () => {
  Logger.configure({ level: "info", file: null });
  const rootDir = path.resolve(__dirname, "..");
  const config = new ConfigManager({ rootDir });
  const audio = new AudioService({ config, logger: new Logger("Check") });

  console.log("=== 1) 通常の連続録音（各 1.2 秒）===");
  for (let i = 1; i <= 2; i++) {
    const h = audio.capture({ maxDurationMs: 1200, startTimeoutMs: 1200 });
    const r = await h.result;
    console.log(`#${i} reason=${r.reason} frames=${r.frames} peak=${r.peakLevel}`);
  }

  console.log("=== 2) 即停止 → すぐ次の録音（孤児プロセス防止の確認）===");
  for (let i = 1; i <= 3; i++) {
    const a = audio.capture({ maxDurationMs: 5000 });
    a.stop("aborted");
    const ra = await a.result;
    const b = audio.capture({ maxDurationMs: 1200, startTimeoutMs: 1200 });
    const rb = await b.result;
    console.log(
      `#${i} aborted(frames=${ra.frames}, reason=${ra.reason}) -> next(frames=${rb.frames}, reason=${rb.reason}, peak=${rb.peakLevel}) / ffmpeg=${ffmpegCount()}`
    );
  }

  console.log("=== 3) 同時に 2 つ要求（ロックで直列化されるか）===");
  const a = audio.capture({ maxDurationMs: 600 });
  const b = audio.capture({ maxDurationMs: 1200, startTimeoutMs: 1200 });
  const [ra, rb] = await Promise.all([a.result, b.result]);
  console.log(`A frames=${ra.frames} reason=${ra.reason} / B frames=${rb.frames} reason=${rb.reason}`);

  await audio.dispose();
  await sleep(500);
  console.log(`終了後の ffmpeg 数: ${ffmpegCount()}`);
})().catch((error) => {
  console.error("[check] 失敗:", error.message);
  process.exit(1);
});
