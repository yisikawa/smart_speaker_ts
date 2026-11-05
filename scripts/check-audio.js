/**
 * マイク入力の診断ツール。
 * 使い方: npm run check-audio
 *
 * 3 秒間録音してフレーム数・ピークレベル（dBFS）を表示し、
 * 「ミュート」「入力レベル 0」「デバイス未検出」などを切り分ける。
 */
const path = require("path");
const { ConfigManager } = require("../dist/backend/config/ConfigManager");
const { AudioService } = require("../dist/backend/services/AudioService");
const { Logger } = require("../dist/backend/core/logger");

const RECORD_MS = Number(process.env.CHECK_AUDIO_MS ?? 3000);

(async () => {
  Logger.configure({ level: "warn", file: null });
  const rootDir = path.resolve(__dirname, "..");
  const config = new ConfigManager({ rootDir });
  const audio = new AudioService({ config });

  const devices = await audio.listInputDevices();
  console.log(`[check] 入力デバイス: ${devices.map((d) => d.name).join(", ") || "(なし)"}`);
  console.log(`[check] 設定: input_device="${config.getAudio().input_device}" sample_rate=${config.getAudio().sample_rate}`);
  console.log(`[check] ${RECORD_MS}ms 録音してレベルを測定します。マイクに向かって話してください…`);

  const handle = audio.capture({ maxDurationMs: RECORD_MS, startTimeoutMs: RECORD_MS });
  const result = await handle.result;
  await audio.dispose();

  const peak = result.peakLevel ?? 0;
  const dbfs = peak > 0 ? `${(20 * Math.log10(peak)).toFixed(1)} dBFS` : "-∞ dBFS";
  console.log(`[check] frames=${result.frames} peak=${peak} (${dbfs}) reason=${result.reason}`);

  const threshold = config.getAudio().silence_threshold;
  if (result.frames === 0) {
    console.log("[判定] 音声データが取得できません（ffmpeg のデバイス名・権限を確認してください）");
    process.exitCode = 1;
  } else if (peak < threshold * 0.5) {
    console.log(
      "[判定] 入力レベルがほぼ 0 です。マイクがミュートされているか、Windows の入力レベルが 0 の可能性があります。"
    );
    console.log("       確認: 設定 > システム > サウンド > 入力 / キーボードのマイクミュートキー / Realtek オーディオ設定");
    process.exitCode = 1;
  } else if (peak < threshold) {
    console.log(
      `[判定] 入力レベルが小さいです（VAD しきい値 ${threshold} 未満）。マイクに近づくか、audio.input_gain を上げてください。`
    );
    process.exitCode = 1;
  } else {
    console.log("[判定] OK（十分なレベルが入力されています）");
  }

  if (!result.hasSpeech && result.reason === "max_duration") {
    console.log("[補足] 3 秒間で発話区間は検出されませんでした（レベルが低いと発話判定されません）");
  }
})().catch((error) => {
  console.error("[check] 失敗:", error.message);
  process.exit(1);
});
