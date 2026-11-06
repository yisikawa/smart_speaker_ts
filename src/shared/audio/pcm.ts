/**
 * 16bit PCM / WAV のユーティリティ（ブラウザ・Node 共通）。
 * DOM にも Node の Buffer にも依存しないため、フロントとバックエンドの双方から使える。
 */

const BASE64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Int16 PCM の RMS レベル（0..1）。ゲインはレベル計算にのみ掛かる */
export function rmsLevel(samples: Int16Array, gain = 1): number {
  if (samples.length === 0) {
    return 0;
  }
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const value = samples[i] / 32768;
    sum += value * value;
  }
  return Math.min(1, Math.sqrt(sum / samples.length) * gain);
}

/** ゲインを適用した新しい Int16Array を返す（クリップあり） */
export function applyGain(samples: Int16Array, gain: number): Int16Array {
  if (gain === 1) {
    return samples;
  }
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const value = Math.round(samples[i] * gain);
    out[i] = value > 32767 ? 32767 : value < -32768 ? -32768 : value;
  }
  return out;
}

/** Int16Array をリトルエンディアンのバイト列に変換する */
export function int16ToBytes(samples: Int16Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) {
    view.setInt16(i * 2, samples[i], true);
  }
  return bytes;
}

/** リトルエンディアンのバイト列を Int16Array に変換する（2 バイト未満は切り捨て） */
export function bytesToInt16(bytes: Uint8Array): Int16Array {
  const count = Math.floor(bytes.length / 2);
  const samples = new Int16Array(count);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < count; i++) {
    samples[i] = view.getInt16(i * 2, true);
  }
  return samples;
}

/** 複数の Int16Array を連結する */
export function concatInt16(chunks: Int16Array[]): Int16Array {
  let total = 0;
  for (const chunk of chunks) {
    total += chunk.length;
  }
  const out = new Int16Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * 受信サンプルを固定長フレームへ分割する。
 *
 * AudioWorklet は 128 サンプルずつ届くことがあり、VAD の 1 フレーム（例: 16kHz × 20ms = 320）より
 * 小さいことが多い。前回の端数と連結してから分割し、余りを次回へ持ち越す。
 */
export function splitInt16Frames(
  pending: Int16Array,
  incoming: Int16Array,
  frameSamples: number
): { frames: Int16Array[]; remainder: Int16Array } {
  if (frameSamples <= 0) {
    return { frames: [], remainder: new Int16Array(0) };
  }
  const buffer =
    pending.length > 0 ? concatInt16([pending, incoming]) : incoming;
  const frames: Int16Array[] = [];
  let offset = 0;
  while (offset + frameSamples <= buffer.length) {
    frames.push(buffer.slice(offset, offset + frameSamples));
    offset += frameSamples;
  }
  return { frames, remainder: buffer.slice(offset) };
}

/** 線形補間による簡易リサンプリング（発話単位の変換用途） */
export function resample(samples: Int16Array, fromRate: number, toRate: number): Int16Array {
  if (fromRate === toRate || samples.length === 0) {
    return samples;
  }
  const ratio = toRate / fromRate;
  const outLength = Math.max(1, Math.floor(samples.length * ratio));
  const out = new Int16Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const position = i / ratio;
    const index = Math.floor(position);
    const next = Math.min(index + 1, samples.length - 1);
    const fraction = position - index;
    out[i] = Math.round(samples[index] * (1 - fraction) + samples[next] * fraction);
  }
  return out;
}

/** 16bit モノラルの WAV（44 バイトヘッダ付き）を生成する */
export function encodeWav(samples: Int16Array, sampleRate: number): Uint8Array {
  const pcm = int16ToBytes(samples);
  const header = new Uint8Array(44);
  const view = new DataView(header.buffer);

  writeAscii(header, 0, "RIFF");
  view.setUint32(4, 36 + pcm.length, true);
  writeAscii(header, 8, "WAVE");
  writeAscii(header, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // モノラル
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(header, 36, "data");
  view.setUint32(40, pcm.length, true);

  const wav = new Uint8Array(header.length + pcm.length);
  wav.set(header, 0);
  wav.set(pcm, header.length);
  return wav;
}

/** RIFF/WAVE かどうか */
export function isWav(bytes: Uint8Array): boolean {
  return (
    bytes.length > 44 &&
    readAscii(bytes, 0, 4) === "RIFF" &&
    readAscii(bytes, 8, 12) === "WAVE"
  );
}

export interface WavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  dataSize: number;
}

/** WAV ヘッダから音声形式を読む（不正なら null） */
export function readWavInfo(bytes: Uint8Array): WavInfo | null {
  if (!isWav(bytes)) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    channels: view.getUint16(22, true),
    sampleRate: view.getUint32(24, true),
    bitsPerSample: view.getUint16(34, true),
    dataSize: view.getUint32(40, true),
  };
}

/** 音声の長さ（ms） */
export function wavDurationMs(bytes: Uint8Array, fallbackSampleRate = 16000): number {
  const info = readWavInfo(bytes);
  const sampleRate = info?.sampleRate || fallbackSampleRate;
  const dataSize = info?.dataSize ?? bytes.length;
  return Math.round((dataSize / 2 / sampleRate) * 1000);
}

/** バイト列 → Base64（DOM/Node 非依存） */
export function bytesToBase64(bytes: Uint8Array): string {
  let output = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    const triple = (b0 << 16) | ((b1 ?? 0) << 8) | (b2 ?? 0);
    output += BASE64_CHARS[(triple >> 18) & 0x3f];
    output += BASE64_CHARS[(triple >> 12) & 0x3f];
    output += b1 === undefined ? "=" : BASE64_CHARS[(triple >> 6) & 0x3f];
    output += b2 === undefined ? "=" : BASE64_CHARS[triple & 0x3f];
  }
  return output;
}

/** Base64 → バイト列（DOM/Node 非依存） */
export function bytesFromBase64(base64: string): Uint8Array {
  const cleaned = base64.replace(/[^A-Za-z0-9+/=]/g, "");
  const padding = cleaned.endsWith("==") ? 2 : cleaned.endsWith("=") ? 1 : 0;
  const length = Math.max(0, Math.floor((cleaned.length * 3) / 4) - padding);
  const out = new Uint8Array(length);
  let buffer = 0;
  let bits = 0;
  let index = 0;

  for (const char of cleaned) {
    if (char === "=") {
      break;
    }
    buffer = (buffer << 6) | BASE64_CHARS.indexOf(char);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      if (index < out.length) {
        out[index++] = (buffer >> bits) & 0xff;
      }
    }
  }
  return out;
}

/**
 * Int16 PCM を [-1, 1] の Float32 へ変換する（ONNX 推論の入力用）。
 * 変換のみで正規化以外の加工はしない。
 */
export function int16ToFloat32(samples: Int16Array): Float32Array {
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    out[i] = samples[i] / 32768;
  }
  return out;
}

/** WAV の data チャンクを探す（LIST などの付加チャンクを許容する） */
function findDataChunk(bytes: Uint8Array): { offset: number; size: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = readAscii(bytes, offset, offset + 4);
    const size = view.getUint32(offset + 4, true);
    if (id === "data") {
      return { offset: offset + 8, size };
    }
    offset += 8 + size + (size % 2);
  }
  return null;
}

/**
 * WAV をモノラルの Float32 サンプルへ変換する。
 * 16bit PCM 以外・不正なヘッダの場合は null を返す（呼び出し側で PCM 直指定にフォールバック）。
 */
export function wavToFloat32(
  bytes: Uint8Array
): { samples: Float32Array; sampleRate: number } | null {
  const info = readWavInfo(bytes);
  const data = findDataChunk(bytes);
  if (!info || !data || info.bitsPerSample !== 16) {
    return null;
  }
  const end = Math.min(bytes.length, data.offset + data.size);
  const interleaved = bytesToInt16(bytes.subarray(data.offset, end));
  const channels = Math.max(1, info.channels);

  if (channels === 1) {
    return { samples: int16ToFloat32(interleaved), sampleRate: info.sampleRate };
  }

  // ステレオ以上はモノラルへダウンミックスする
  const frames = Math.floor(interleaved.length / channels);
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) {
    let sum = 0;
    for (let c = 0; c < channels; c += 1) {
      sum += interleaved[i * channels + c];
    }
    mono[i] = sum / channels / 32768;
  }
  return { samples: mono, sampleRate: info.sampleRate };
}

function writeAscii(target: Uint8Array, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) {
    target[offset + i] = text.charCodeAt(i);
  }
}

function readAscii(source: Uint8Array, start: number, end: number): string {
  let text = "";
  for (let i = start; i < end && i < source.length; i++) {
    text += String.fromCharCode(source[i]);
  }
  return text;
}
