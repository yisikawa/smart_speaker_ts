import { wavToFloat32 } from "./pcm";

/**
 * WAV（16bit PCM）から `sliceMs` ごとの RMS を求め、最大値で正規化する（0..1）。
 *
 * Open-LLM-VTuber と同じ方式。クライアントは再生経過時間からこの配列を引くだけで
 * 口パクを駆動できる（AnalyserNode に依存しない）。無音・解析不能なら空配列。
 */
export function buildVolumeEnvelope(wav: Uint8Array, sliceMs = 20): number[] {
  const decoded = wavToFloat32(wav);
  if (!decoded || decoded.samples.length === 0) {
    return [];
  }

  const sliceSamples = Math.max(1, Math.round((decoded.sampleRate * sliceMs) / 1000));
  const volumes: number[] = [];
  for (let offset = 0; offset < decoded.samples.length; offset += sliceSamples) {
    const end = Math.min(offset + sliceSamples, decoded.samples.length);
    let sum = 0;
    for (let i = offset; i < end; i += 1) {
      sum += decoded.samples[i] * decoded.samples[i];
    }
    volumes.push(Math.sqrt(sum / (end - offset)));
  }

  const max = volumes.reduce((acc, value) => Math.max(acc, value), 0);
  if (max === 0) {
    return [];
  }
  return volumes.map((value) => Math.min(1, value / max));
}
