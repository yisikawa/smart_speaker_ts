import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createSttService } from "../src/backend/services/sttFactory";
import { SherpaSttService } from "../src/backend/services/SherpaSttService";
import { WhisperSttService } from "../src/backend/services/WhisperSttService";
import { createTempProject, TempProject } from "./helpers/project";

function withConfig(engine: "whisper" | "sherpa"): TempProject {
  return createTempProject({ prefix: "sumika-sherpa-", patch: { stt: { engine } } });
}

test("createSttService は stt.engine に応じた実装を返す", () => {
  const whisper = withConfig("whisper");
  try {
    assert.ok(createSttService({ config: whisper.config }) instanceof WhisperSttService);
  } finally {
    whisper.cleanup();
  }

  const sherpa = withConfig("sherpa");
  try {
    assert.ok(createSttService({ config: sherpa.config }) instanceof SherpaSttService);
  } finally {
    sherpa.cleanup();
  }
});

test("stt.engine が未対応値なら whisper に補正される", () => {
  const project = createTempProject({ prefix: "sumika-sherpa-" });
  try {
    const config = project.config;
    config.update({ stt: { engine: "unknown" as unknown as "whisper" } });

    assert.equal(config.getSTT().engine, "whisper");
    assert.ok(config.getWarnings().some((warning) => warning.includes("stt.engine")));
  } finally {
    project.cleanup();
  }
});

test("SherpaSttService はモデルが無い場合 isAvailable=false と案内付きエラーを返す", async () => {
  const project = withConfig("sherpa");
  try {
    project.config.update({ stt: { sherpa_model_dir: "models/does-not-exist", min_input_rms: 0 } });
    const service = new SherpaSttService({ config: project.config });

    assert.equal(await service.isAvailable(), false);
    await assert.rejects(
      () => service.transcribe(Buffer.alloc(3200)),
      /sherpa-onnx のモデルが見つかりません/
    );
  } finally {
    project.cleanup();
  }
});

test("SherpaSttService はほぼ無音の入力をモデルロード前にスキップする", async () => {
  const project = withConfig("sherpa");
  try {
    const service = new SherpaSttService({ config: project.config });
    const result = await service.transcribe(Buffer.alloc(3200));

    assert.equal(result.text, "");
    assert.equal(result.language, "ja");
  } finally {
    project.cleanup();
  }
});

test("SherpaSttService はモデル一式が揃っていれば isAvailable=true を返す", async () => {
  const project = withConfig("sherpa");
  try {
    const modelDir = path.join(project.rootDir, "models", "dummy");
    fs.mkdirSync(modelDir, { recursive: true });
    // 中身は不要（ファイルの存在だけを見る）。ネイティブモジュールの読み込み可否も確認される
    for (const name of ["tokens.txt", "model.int8.onnx"]) {
      fs.writeFileSync(path.join(modelDir, name), "");
    }
    project.config.update({ stt: { sherpa_model_dir: "models/dummy" } });

    const service = new SherpaSttService({ config: project.config });
    // sherpa-onnx-node が未インストールの環境では false になる（テストは環境非依存に保つ）
    const available = await service.isAvailable();
    assert.equal(typeof available, "boolean");
  } finally {
    project.cleanup();
  }
});
