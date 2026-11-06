/**
 * WAV / PCM の Buffer 版アダプタ。
 *
 * 実装は `src/shared/audio/pcm.ts`（Uint8Array / Int16Array）に一本化しており、
 * ここは「Buffer ⇔ Uint8Array の境界変換」だけを行う薄い層。
 * 新しい音声処理は必ず `shared/audio/pcm.ts` 側に追加し、ブラウザと共有すること。
 */
import {
  applyGain as applyGainToSamples,
  bytesToInt16,
  encodeWav as encodeWavFromSamples,
  int16ToBytes,
  isWav as isWavBytes,
  rmsLevel as rmsLevelOfSamples,
  wavDurationMs as wavDurationMsOfBytes,
} from "../../shared/audio/pcm";

/** Buffer を（コピーせずに）Uint8Array として見る */
function toBytes(buffer: Buffer): Uint8Array {
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

/** Uint8Array を（コピーせずに）Buffer として見る */
function toBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** RIFF/WAVE ヘッダ付きかどうか */
export function isWav(buffer: Buffer): boolean {
  return isWavBytes(toBytes(buffer));
}

/** 16bit PCM に WAV ヘッダ（44 バイト）を付与する */
export function encodeWav(pcm: Buffer, sampleRate: number, channels = 1, bitsPerSample = 16): Buffer {
  if (channels !== 1 || bitsPerSample !== 16) {
    throw new Error("encodeWav はモノラル / 16bit のみ対応です（shared/audio/pcm.ts に実装を集約）");
  }
  return toBuffer(encodeWavFromSamples(bytesToInt16(toBytes(pcm)), sampleRate));
}

/** WAV でなければ WAV 化する（二重ヘッダ付与の防止） */
export function ensureWav(audio: Buffer, sampleRate: number): Buffer {
  return isWav(audio) ? audio : encodeWav(audio, sampleRate);
}

/** 16bit PCM の RMS レベル（0..1）。VAD のしきい値判定に使用する */
export function rmsLevel(pcm: Buffer, gain = 1): number {
  return rmsLevelOfSamples(bytesToInt16(toBytes(pcm)), gain);
}

/** PCM をスケーリングした新しい Buffer を返す（ゲイン適用） */
export function applyGain(pcm: Buffer, gain: number): Buffer {
  if (gain === 1) {
    return pcm;
  }
  return toBuffer(int16ToBytes(applyGainToSamples(bytesToInt16(toBytes(pcm)), gain)));
}

/**
 * 音声の長さ（ms）を見積もる。
 * WAV ヘッダがあれば data サイズから算出し、無い場合は 16kHz / 16bit / モノラルとして概算する。
 */
export function wavDurationMs(audio: Buffer, fallbackSampleRate = 16000): number {
  return wavDurationMsOfBytes(toBytes(audio), fallbackSampleRate);
}
