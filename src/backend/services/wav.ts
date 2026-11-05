/** WAV / PCM 関連の純粋関数（テスト対象） */

/** RIFF/WAVE ヘッダ付きかどうか */
export function isWav(buffer: Buffer): boolean {
  return (
    buffer.length > 44 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WAVE"
  );
}

/** 16bit PCM に WAV ヘッダ（44 バイト）を付与する */
export function encodeWav(pcm: Buffer, sampleRate: number, channels = 1, bitsPerSample = 16): Buffer {
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(44);

  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");

  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);

  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

/** WAV でなければ WAV 化する（二重ヘッダ付与の防止） */
export function ensureWav(audio: Buffer, sampleRate: number): Buffer {
  return isWav(audio) ? audio : encodeWav(audio, sampleRate);
}

/**
 * 16bit PCM の RMS レベル（0..1）。
 * VAD のしきい値判定に使用する。
 */
export function rmsLevel(pcm: Buffer, gain = 1): number {
  const samples = Math.floor(pcm.length / 2);
  if (samples === 0) {
    return 0;
  }
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const value = pcm.readInt16LE(i * 2) / 32768;
    sum += value * value;
  }
  return Math.min(1, Math.sqrt(sum / samples) * gain);
}

/** PCM をスケーリングした新しい Buffer を返す（ゲイン適用） */
export function applyGain(pcm: Buffer, gain: number): Buffer {
  if (gain === 1) {
    return pcm;
  }
  const out = Buffer.alloc(pcm.length);
  for (let i = 0; i < pcm.length; i += 2) {
    const value = Math.max(-32768, Math.min(32767, Math.round(pcm.readInt16LE(i) * gain)));
    out.writeInt16LE(value, i);
  }
  return out;
}

/**
 * 音声の長さ（ms）を見積もる。
 * WAV ヘッダがあれば byteRate と data サイズから算出し、
 * 無い場合は 16kHz / 16bit / モノラルとして概算する。
 */
export function wavDurationMs(audio: Buffer, fallbackSampleRate = 16000): number {
  if (isWav(audio)) {
    const byteRate = audio.readUInt32LE(28);
    const dataSize = audio.readUInt32LE(40);
    if (byteRate > 0) {
      return Math.round((dataSize / byteRate) * 1000);
    }
  }
  return Math.round((audio.length / 2 / fallbackSampleRate) * 1000);
}

