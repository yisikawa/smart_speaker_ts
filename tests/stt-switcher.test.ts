import test from "node:test";
import assert from "node:assert/strict";
import { ConfigManager } from "../src/backend/config/ConfigManager";
import { SpeechToText, Transcript } from "../src/backend/core/ports";
import { SttSwitcher } from "../src/backend/services/SttSwitcher";
import { createTempDir } from "./helpers/project";

/** テスト用 STT（transcribe は finish() で解決する） */
class FakeStt implements SpeechToText {
  readonly calls: Buffer[] = [];
  private readonly resolvers: ((transcript: Transcript) => void)[] = [];

  async isAvailable(): Promise<boolean> {
    return true;
  }

  transcribe(wav: Buffer): Promise<Transcript> {
    this.calls.push(wav);
    return new Promise<Transcript>((resolve) => this.resolvers.push(resolve));
  }

  finish(text: string): void {
    const resolve = this.resolvers.shift();
    resolve?.({ text, language: "ja", elapsedMs: 1 });
  }
}

function setup(): {
  config: ConfigManager;
  switcher: SttSwitcher;
  created: FakeStt[];
  cleanup: () => void;
} {
  const temp = createTempDir("sumika-stt-switch-");
  const config = new ConfigManager({ rootDir: temp.dir });
  // テストの前提を旧既定（日本語・whisper / f16）に固定する
  config.update({
    conversation: { language: "ja" },
    stt: { engine: "whisper", model_path: "models/ggml-large-v3-turbo.bin" },
  });
  const created: FakeStt[] = [];
  const switcher = new SttSwitcher({
    config,
    create: () => {
      const fake = new FakeStt();
      created.push(fake);
      return fake;
    },
  });
  return { config, switcher, created, cleanup: temp.cleanup };
}

test("SttSwitcher はエンジン／モデルの変更でだけ実装を作り直す", () => {
  const { config, switcher, created, cleanup } = setup();
  try {
    assert.equal(created.length, 1, "生成時に 1 回だけ作る");
    assert.equal(switcher.reconfigure(), false, "設定が同じなら作り直さない");

    // whisper のモデル変更は再生成対象（sherpa は recognizer をキャッシュするため）
    config.update({ stt: { model_path: "models/ggml-large-v3-turbo-q5_0.bin" } });
    assert.equal(switcher.reconfigure(), true);
    assert.equal(created.length, 2);

    // 無関係な設定では作り直さない
    config.update({ audio: { silence_threshold: 0.03 } });
    assert.equal(switcher.reconfigure(), false);
    assert.equal(created.length, 2);
  } finally {
    cleanup();
  }
});

test("SttSwitcher の切替は進行中の認識を壊さない（呼び出し開始時の実装で完遂する）", async () => {
  const { config, switcher, created, cleanup } = setup();
  try {
    const first = created[0];
    const pending = switcher.transcribe(Buffer.from("pcm"));

    config.update({ stt: { engine: "sherpa" } });
    assert.equal(switcher.reconfigure(), true);
    assert.equal(switcher.engine, "sherpa");
    assert.equal(created.length, 2, "新しい実装が作られる");

    first.finish("旧エンジンの結果");
    assert.equal((await pending).text, "旧エンジンの結果", "進行中は旧実装が返す");

    const next = switcher.transcribe(Buffer.from("pcm2"));
    created[1].finish("新エンジンの結果");
    assert.equal((await next).text, "新エンジンの結果", "次の呼び出しは新実装");
  } finally {
    cleanup();
  }
});

test("SttSwitcher.describe は現在のエンジンとモデルを表す", () => {
  const { config, switcher, cleanup } = setup();
  try {
    config.update({
      stt: { engine: "whisper", model_path: "models/ggml-large-v3-turbo-q5_0.bin" },
    });
    assert.match(switcher.describe(), /^whisper\.cpp \/ ggml-large-v3-turbo-q5_0\.bin$/);

    config.update({
      stt: {
        engine: "sherpa",
        sherpa_model_dir: "models/sherpa-onnx-nemo-parakeet-tdt_ctc-0.6b-ja-35000-int8",
        sherpa_model_type: "nemo_ctc",
      },
    });
    assert.match(switcher.describe(), /^sherpa-onnx \/ sherpa-onnx-nemo-parakeet/);
    assert.match(switcher.describe(), /nemo_ctc/);
  } finally {
    cleanup();
  }
});
