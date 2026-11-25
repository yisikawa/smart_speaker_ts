import type { SherpaModelTypeName } from "../protocol";

/**
 * sherpa-onnx のモデル種別（ApiRouter / sanitize と schema の型を一致させる唯一の一覧）。
 * `Record` で網羅するため、型に種別を足してここへ足し忘れると **コンパイルエラー**になる
 * （`satisfies` は余剰しか検出しない）。
 */
const SHERPA_MODEL_TYPE_FLAGS: Record<SherpaModelTypeName, true> = {
  nemo_transducer: true,
  nemo_ctc: true,
  sense_voice: true,
  zipformer_transducer: true,
};

export const SHERPA_MODEL_TYPES: readonly SherpaModelTypeName[] = Object.keys(
  SHERPA_MODEL_TYPE_FLAGS
) as SherpaModelTypeName[];

/** 未知の文字列を sherpa のモデル種別へ絞り込む */
export function isSherpaModelType(value: unknown): value is SherpaModelTypeName {
  return typeof value === "string" && (SHERPA_MODEL_TYPES as readonly string[]).includes(value);
}
