import { bytesFromBase64, isWav, readWavInfo, wavDurationMs } from "../../shared/audio/pcm";

export interface DecodedAudio {
  buffer: Buffer;
  sampleRate: number;
  durationMs: number;
}

/** 受け取った音声ペイロードの不備を表すエラー */
export class AudioPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AudioPayloadError";
  }
}

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024; // 8MB（16kHz/16bit モノラルで約 4 分）

/**
 * ブラウザから送られた Base64 WAV を検証して Buffer に変換する。
 * 不正なデータでパイプラインを動かさないよう、形式・サイズをここで弾く。
 */
export function decodeAudioPayload(data: unknown, maxBytes = DEFAULT_MAX_BYTES): DecodedAudio {
  if (typeof data !== "string" || data.length === 0) {
    throw new AudioPayloadError("音声データが空です");
  }
  // Base64 は元サイズの約 4/3。極端に大きいものはデコード前に弾く
  if (data.length > Math.ceil((maxBytes * 4) / 3) + 8) {
    throw new AudioPayloadError("音声データが大きすぎます");
  }

  const bytes = bytesFromBase64(data);
  if (bytes.length === 0) {
    throw new AudioPayloadError("音声データを復号できませんでした");
  }
  if (bytes.length > maxBytes) {
    throw new AudioPayloadError("音声データが大きすぎます");
  }
  if (!isWav(bytes)) {
    throw new AudioPayloadError("WAV 形式ではありません");
  }

  const info = readWavInfo(bytes);
  if (!info) {
    throw new AudioPayloadError("WAV ヘッダを読み取れませんでした");
  }
  if (info.bitsPerSample !== 16 || info.channels !== 1) {
    throw new AudioPayloadError("16bit モノラルの WAV が必要です");
  }

  return {
    buffer: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    sampleRate: info.sampleRate,
    durationMs: wavDurationMs(bytes),
  };
}
