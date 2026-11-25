import type { SherpaModelTypeName } from "../protocol";

/**
 * sherpa-onnx のモデル種別（ApiRouter の検証と schema の型を一致させる唯一の一覧）。
 * 型に追加したらここへ足す（`satisfies` で過不足をコンパイル時に検出する）。
 */
export const SHERPA_MODEL_TYPES = [
  "nemo_transducer",
  "nemo_ctc",
  "sense_voice",
  "zipformer_transducer",
] as const satisfies readonly SherpaModelTypeName[];

/** 未知の文字列を sherpa のモデル種別へ絞り込む */
export function isSherpaModelType(value: unknown): value is SherpaModelTypeName {
  return typeof value === "string" && (SHERPA_MODEL_TYPES as readonly string[]).includes(value);
}
