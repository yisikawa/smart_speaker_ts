import test from "node:test";
import assert from "node:assert/strict";
import { AudioPayloadError, decodeAudioPayload } from "../src/backend/server/audioPayload";
import { bytesToBase64, encodeWav, int16ToBytes } from "../src/shared/audio/pcm";

const WAV = encodeWav(new Int16Array(1600), 16000); // 100ms / 16kHz

test("Base64 の WAV を復号してメタ情報を返す", () => {
  const decoded = decodeAudioPayload(bytesToBase64(WAV));

  assert.equal(decoded.sampleRate, 16000);
  assert.equal(decoded.durationMs, 100);
  assert.equal(decoded.buffer.length, WAV.length);
  assert.equal(decoded.buffer.subarray(0, 4).toString("ascii"), "RIFF");
});

test("空のデータは拒否する", () => {
  assert.throws(() => decodeAudioPayload(""), AudioPayloadError);
  assert.throws(() => decodeAudioPayload(undefined), AudioPayloadError);
});

test("WAV でないデータは拒否する", () => {
  const raw = bytesToBase64(int16ToBytes(new Int16Array(1600)));
  assert.throws(() => decodeAudioPayload(raw), /WAV/);
});

test("サイズ上限を超えるデータは拒否する", () => {
  assert.throws(() => decodeAudioPayload(bytesToBase64(WAV), 10), /大きすぎ/);
});

test("16bit モノラル以外の WAV は拒否する", () => {
  const stereo = new Uint8Array(WAV);
  const view = new DataView(stereo.buffer);
  view.setUint16(22, 2, true); // チャンネル数を 2 に改ざん

  assert.throws(() => decodeAudioPayload(bytesToBase64(stereo)), /16bit モノラル/);
});
