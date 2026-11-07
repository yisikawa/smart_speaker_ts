import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  listSherpaModels,
  listWhisperModels,
  llmModelMissingMessage,
  pickLlmModel,
  suggestSherpaModelType,
} from "../src/backend/services/modelCatalog";
import { createTempDir } from "./helpers/project";

/** models/ の代わりになるディレクトリを作る */
function createModelsDir(): { dir: string; modelsDir: string; cleanup: () => void } {
  const temp = createTempDir("sumika-models-");
  const modelsDir = path.join(temp.dir, "models");
  fs.mkdirSync(modelsDir);

  fs.writeFileSync(path.join(modelsDir, "ggml-large-v3-turbo-q5_0.bin"), Buffer.alloc(1024));
  fs.writeFileSync(path.join(modelsDir, "ggml-large-v3-turbo.bin"), Buffer.alloc(2048));
  fs.writeFileSync(path.join(modelsDir, "notes.txt"), "メモ");

  // NeMo CTC（単一 model.onnx）
  const ctcDir = path.join(modelsDir, "sherpa-ctc");
  fs.mkdirSync(ctcDir);
  fs.writeFileSync(path.join(ctcDir, "tokens.txt"), "a");
  fs.writeFileSync(path.join(ctcDir, "model.int8.onnx"), Buffer.alloc(8));

  // transducer（encoder / decoder / joiner）
  const transducerDir = path.join(modelsDir, "sherpa-transducer");
  fs.mkdirSync(transducerDir);
  fs.writeFileSync(path.join(transducerDir, "tokens.txt"), "a");
  for (const name of ["encoder.onnx", "decoder.onnx", "joiner.onnx"]) {
    fs.writeFileSync(path.join(transducerDir, name), Buffer.alloc(8));
  }

  // tokens.txt が無いディレクトリは候補にしない
  fs.mkdirSync(path.join(modelsDir, "not-a-model"));

  return { dir: temp.dir, modelsDir, cleanup: temp.cleanup };
}

test("listWhisperModels は .bin だけを相対パスで列挙する", () => {
  const { modelsDir, cleanup } = createModelsDir();
  try {
    const models = listWhisperModels(modelsDir);
    assert.deepEqual(
      models.map((model) => model.path),
      ["models/ggml-large-v3-turbo-q5_0.bin", "models/ggml-large-v3-turbo.bin"],
      "名前順で、設定に保存できる相対パスになる"
    );
    assert.equal(models[0].sizeBytes, 1024);
    assert.equal(models[0].label, "ggml-large-v3-turbo-q5_0.bin");
  } finally {
    cleanup();
  }
});

test("listWhisperModels / listSherpaModels は存在しないディレクトリでも空を返す", () => {
  const { dir, cleanup } = createModelsDir();
  try {
    assert.deepEqual(listWhisperModels(path.join(dir, "none")), []);
    assert.deepEqual(listSherpaModels(path.join(dir, "none")), []);
  } finally {
    cleanup();
  }
});

test("listSherpaModels は tokens.txt を持つディレクトリだけを列挙し、種別を推定する", () => {
  const { modelsDir, cleanup } = createModelsDir();
  try {
    const models = listSherpaModels(modelsDir);
    assert.deepEqual(
      models.map((model) => model.dir),
      ["models/sherpa-ctc", "models/sherpa-transducer"]
    );
    assert.equal(models.find((model) => model.label === "sherpa-ctc")?.suggestedModelType, "nemo_ctc");
    assert.equal(
      models.find((model) => model.label === "sherpa-transducer")?.suggestedModelType,
      "nemo_transducer"
    );
  } finally {
    cleanup();
  }
});

test("suggestSherpaModelType は SenseVoice をディレクトリ名から推定し、既定は nemo_ctc", () => {
  const { modelsDir, cleanup } = createModelsDir();
  try {
    const senseDir = path.join(modelsDir, "sherpa-onnx-sense-voice-ja");
    fs.mkdirSync(senseDir);
    assert.equal(suggestSherpaModelType(senseDir), "sense_voice");
    assert.equal(suggestSherpaModelType(path.join(modelsDir, "unknown")), "nemo_ctc");
  } finally {
    cleanup();
  }
});

test("pickLlmModel はタグ付きの名前を解決し、未導入なら null を返す", () => {
  const installed = ["llama3.2:1b", "gemma4:e2b-it-qat"];

  assert.equal(pickLlmModel(installed, "gemma4:e2b-it-qat"), "gemma4:e2b-it-qat", "完全一致を優先");
  assert.equal(pickLlmModel(installed, "llama3.2"), "llama3.2:1b", "タグ省略を補完する");
  assert.equal(pickLlmModel(installed, "missing"), null);
  assert.equal(pickLlmModel(installed, "  "), null);
  assert.equal(pickLlmModel([], "llama3.2"), null);
});

test("llmModelMissingMessage は ollama pull と導入済み一覧を案内する", () => {
  const message = llmModelMissingMessage(["llama3.2:1b"], "gemma4");
  assert.match(message, /ollama pull gemma4/);
  assert.match(message, /llama3\.2:1b/);
});
