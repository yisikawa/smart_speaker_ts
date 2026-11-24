#!/usr/bin/env node
/**
 * B 案（同一声質のマルチリンガル TTS）の実測スパイク。
 *
 * 起動中の TTS サーバーへ実際に文を投げ、**合成時間・音声長・RTF・VRAM** を測る。
 * モデルのロードは含めない（アプリと同じ「常駐前提」の数字を取るため）。
 *
 * 使い方（TTS サーバーを起動した状態で）:
 *   node scripts/spike-tts.js                 # ja と en を 3 回ずつ
 *   node scripts/spike-tts.js --lang en --runs 5
 *   node scripts/spike-tts.js --text "Hello. How are you today?"
 *
 * 前提:
 *   - ja: VOICEVOX（config の [tts] endpoint / speaker_id）
 *   - en: config の [tts.en]（openai_speech または gpt_sovits）
 *   - 出力 WAV は logs/tts-spike/ に保存（gitignore 済み）
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { parse: parseToml } = require("toml");

const ROOT = path.resolve(__dirname, "..");
const CONFIG_PATH = path.join(ROOT, "config", "settings.toml");
const DEFAULT_PATH = path.join(ROOT, "config", "settings.default.toml");
const OUT_DIR = path.join(ROOT, "logs", "tts-spike");

const SAMPLES = {
  ja: "こんにちは。今日はいい天気ですね。何か面白い話はありますか？",
  en: "Hello there. It's a lovely day today. Do you have any fun stories to share?",
};

function parseArgs(argv) {
  const args = { lang: "both", runs: 3, text: null };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === "--lang" && value) {
      args.lang = value;
      i += 1;
    } else if (key === "--runs" && value) {
      args.runs = Math.max(1, Number(value) || 3);
      i += 1;
    } else if (key === "--text" && value) {
      args.text = value;
      i += 1;
    }
  }
  return args;
}

function loadConfig() {
  const file = fs.existsSync(CONFIG_PATH) ? CONFIG_PATH : DEFAULT_PATH;
  if (!fs.existsSync(file)) {
    throw new Error(`設定ファイルが見つかりません: ${file}`);
  }
  return { config: parseToml(fs.readFileSync(file, "utf-8")), file };
}

/** 起動中のエンジンが使っている VRAM（MiB）。読めなければ null */
function vramUsedMiB() {
  try {
    const out = execFileSync("nvidia-smi", ["--query-gpu=memory.used", "--format=csv,noheader,nounits"], {
      encoding: "utf-8",
      timeout: 5000,
      windowsHide: true,
    }).trim();
    const value = Number(out.split(/\r?\n/)[0]);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/** WAV ヘッダから長さ（ms）を求める */
function wavDurationMs(buffer) {
  if (buffer.length < 44 || buffer.toString("ascii", 0, 4) !== "RIFF") {
    return null;
  }
  const sampleRate = buffer.readUInt32LE(24);
  const bitsPerSample = buffer.readUInt16LE(34);
  const channels = buffer.readUInt16LE(22);
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === "data") {
      const bytesPerFrame = Math.max(1, (bitsPerSample / 8) * channels);
      return Math.round((size / bytesPerFrame / sampleRate) * 1000);
    }
    offset += 8 + size + (size % 2);
  }
  return null;
}

async function timed(fn) {
  const started = process.hrtime.bigint();
  const result = await fn();
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  return { result, elapsedMs };
}

async function synthesizeVoicevox(config, text) {
  const tts = config.tts || {};
  const base = String(tts.endpoint || "http://127.0.0.1:50021").replace(/\/+$/, "");
  const speaker = String(tts.speaker_id ?? 2);
  const query = await fetch(`${base}/audio_query?${new URLSearchParams({ text, speaker })}`, {
    method: "POST",
    signal: AbortSignal.timeout(30000),
  });
  if (!query.ok) {
    throw new Error(`audio_query が ${query.status} を返しました`);
  }
  const body = await query.json();
  body.speedScale = tts.speed ?? 1.0;
  const synthesis = await fetch(`${base}/synthesis?${new URLSearchParams({ speaker })}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  if (!synthesis.ok) {
    throw new Error(`synthesis が ${synthesis.status} を返しました`);
  }
  return Buffer.from(await synthesis.arrayBuffer());
}

async function synthesizeOpenAi(profile, text) {
  const base = String(profile.endpoint || "http://127.0.0.1:8880").replace(/\/+$/, "");
  const response = await fetch(`${base}/v1/audio/speech`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: profile.model || "kokoro",
      input: text,
      voice: profile.voice || "af_heart",
      response_format: "wav",
      speed: profile.speed ?? 1.0,
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) {
    throw new Error(`/v1/audio/speech が ${response.status} を返しました`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function synthesizeGptSovits(profile, text, lang) {
  const base = String(profile.endpoint || "http://127.0.0.1:9880").replace(/\/+$/, "");
  if (!profile.reference_wav) {
    throw new Error("tts.en.reference_wav が未設定です（GPT-SoVITS には参照音声が必要）");
  }
  const reference = path.isAbsolute(profile.reference_wav)
    ? profile.reference_wav
    : path.join(ROOT, profile.reference_wav);
  const response = await fetch(`${base}/tts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      text_lang: lang,
      ref_audio_path: reference,
      prompt_text: profile.reference_text || "",
      prompt_lang: profile.prompt_lang || "en",
      text_split_method: "cut5",
      media_type: "wav",
      streaming_mode: false,
      speed_factor: profile.speed ?? 1.0,
    }),
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok) {
    throw new Error(`GPT-SoVITS /tts が ${response.status} を返しました`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function synthesize(config, lang, text) {
  if (lang === "ja") {
    return synthesizeVoicevox(config, text);
  }
  const profile = (config.tts && config.tts.en) || {};
  const engine = profile.engine || "openai_speech";
  if (engine === "gpt_sovits") {
    return synthesizeGptSovits(profile, text, "en");
  }
  if (engine === "voicevox") {
    return synthesizeVoicevox(config, text);
  }
  return synthesizeOpenAi(profile, text);
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

async function runLang(config, lang, runs, textOverride) {
  const text = textOverride || SAMPLES[lang];
  const rows = [];
  const vramBefore = vramUsedMiB();

  for (let i = 0; i < runs; i += 1) {
    try {
      const { result: wav, elapsedMs } = await timed(() => synthesize(config, lang, text));
      const durationMs = wavDurationMs(wav);
      const rtf = durationMs ? elapsedMs / durationMs : null;
      rows.push({ elapsedMs, durationMs, rtf, bytes: wav.length });
      fs.mkdirSync(OUT_DIR, { recursive: true });
      fs.writeFileSync(path.join(OUT_DIR, `${lang}-${i + 1}.wav`), wav);
    } catch (error) {
      rows.push({ error: error instanceof Error ? error.message : String(error) });
    }
  }
  const vramAfter = vramUsedMiB();

  const ok = rows.filter((row) => !row.error);
  console.log(`\n=== ${lang} ===`);
  for (const [index, row] of rows.entries()) {
    if (row.error) {
      console.log(`  #${index + 1} 失敗: ${row.error}`);
      continue;
    }
    console.log(
      `  #${index + 1} 合成 ${row.elapsedMs.toFixed(0)}ms / 音声 ${row.durationMs ?? "?"}ms / RTF ${
        row.rtf === null ? "?" : row.rtf.toFixed(2)
      } / ${(row.bytes / 1024).toFixed(0)}KB`
    );
  }
  if (ok.length > 0) {
    console.log(
      `  → p50: 合成 ${median(ok.map((r) => r.elapsedMs)).toFixed(0)}ms / RTF ${median(
        ok.map((r) => r.rtf ?? 0)
      ).toFixed(2)}`
    );
  }
  if (vramBefore !== null && vramAfter !== null) {
    console.log(`  → VRAM: ${vramBefore}MiB（前） / ${vramAfter}MiB（後）`);
  } else {
    console.log("  → VRAM: nvidia-smi を読めませんでした");
  }
  console.log(`  → 出力: ${path.relative(ROOT, OUT_DIR)}${path.sep}${lang}-*.wav`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { config, file } = loadConfig();
  console.log(`設定: ${path.relative(ROOT, file)}`);
  console.log(
    `現在のモード: ${config.conversation && config.conversation.language ? config.conversation.language : "ja"}`
  );
  const targets = args.lang === "both" ? ["ja", "en"] : [args.lang];
  for (const lang of targets) {
    if (lang !== "ja" && lang !== "en") {
      console.log(`未対応の言語です: ${lang}`);
      continue;
    }
    await runLang(config, lang, args.runs, args.text);
  }
  console.log(
    "\n判定の目安: RTF < 0.5 なら先読み 1 文で隠せる / 0.5〜1.0 なら 2 文先読みか短い文へ分割 / > 1.0 なら別エンジンを検討"
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
