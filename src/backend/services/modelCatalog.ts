import * as fs from "fs";
import * as path from "path";
import type { SherpaModelOption, SherpaModelTypeName, WhisperModelOption } from "../../shared/protocol";

/**
 * モデル候補の列挙と検証。
 *
 * 対象は渡されたディレクトリ配下だけを読む（設定の真実源は `schema.ts` のまま）。
 * 純粋ロジックなので `node:test` で一時ディレクトリを使って検証できる。
 */

/** セレクトに出す「候補なし」の表示 */
export const NO_MODEL_LABEL = "（モデルが見つかりません）";

/** ディレクトリを読む（存在しなければ空） */
function readDir(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** 設定へ保存する相対パス（TOML なので区切りは `/` に統一する） */
function joinPrefix(prefix: string, name: string): string {
  return `${prefix.replace(/[\\/]+$/, "")}/${name}`;
}

function sizeOf(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

/** models/*.bin（whisper.cpp の ggml モデル）を列挙する */
export function listWhisperModels(modelsDir: string, prefix = "models"): WhisperModelOption[] {
  return readDir(modelsDir)
    .filter((entry) => entry.isFile() && /\.bin$/i.test(entry.name))
    .map((entry) => ({
      path: joinPrefix(prefix, entry.name),
      label: entry.name,
      sizeBytes: sizeOf(path.join(modelsDir, entry.name)),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** tokens.txt を含むサブディレクトリ（sherpa-onnx のモデル一式）を列挙する */
export function listSherpaModels(modelsDir: string, prefix = "models"): SherpaModelOption[] {
  const options: SherpaModelOption[] = [];
  for (const entry of readDir(modelsDir)) {
    if (!entry.isDirectory()) {
      continue;
    }
    const dir = path.join(modelsDir, entry.name);
    if (!fs.existsSync(path.join(dir, "tokens.txt"))) {
      continue;
    }
    options.push({
      dir: joinPrefix(prefix, entry.name),
      label: entry.name,
      suggestedModelType: suggestSherpaModelType(dir),
    });
  }
  return options.sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * ディレクトリ内のファイル構成からモデル種別を推定する。
 *
 * transducer は encoder / decoder / joiner の 3 点セットで判定できる。
 * 単一 `model*.onnx` の場合は SenseVoice（名前に sense を含む）以外を NeMo CTC とみなす
 * （画面で上書きできる）。
 */
export function suggestSherpaModelType(dir: string): SherpaModelTypeName {
  const names = readDir(dir).map((entry) => entry.name);
  const has = (pattern: RegExp): boolean => names.some((name) => pattern.test(name));

  if (has(/^encoder.*\.onnx$/i) && has(/^decoder.*\.onnx$/i) && has(/^joiner.*\.onnx$/i)) {
    return "nemo_transducer";
  }
  if (has(/sense/i) || /sense/i.test(path.basename(dir))) {
    return "sense_voice";
  }
  return "nemo_ctc";
}

/**
 * 導入済みモデルから要求された名前を解決する（`llama3.2` → `llama3.2:1b`）。
 * 見つからなければ null。
 */
export function pickLlmModel(models: string[], requested: string): string | null {
  const target = requested.trim();
  if (!target) {
    return null;
  }
  const exact = models.find((name) => name === target);
  if (exact) {
    return exact;
  }
  const tagged = models.find((name) => name.startsWith(`${target}:`));
  if (tagged) {
    return tagged;
  }
  return models.find((name) => name.startsWith(target)) ?? null;
}

/** モデル未取得のときの案内文（`ollama pull` を促す） */
export function llmModelMissingMessage(models: string[], requested: string): string {
  const available = models.length > 0 ? models.slice(0, 8).join(", ") : "一覧を取得できません";
  return (
    `Ollama にモデル '${requested}' がありません。\`ollama pull ${requested}\` を実行してください` +
    `（導入済み: ${available}）`
  );
}
