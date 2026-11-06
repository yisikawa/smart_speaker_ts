import test from "node:test";
import assert from "node:assert/strict";
import { BaseSttService, RecognizeResult } from "../src/backend/services/BaseSttService";
import { createTempProject } from "./helpers/project";

/** 任意の結果を返すテスト用 STT */
class FakeStt extends BaseSttService {
  constructor(
    deps: ConstructorParameters<typeof BaseSttService>[0],
    private readonly reply: RecognizeResult,
    private readonly replyLanguage?: string
  ) {
    super(deps);
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  protected override language(): string {
    return this.replyLanguage ?? super.language();
  }

  protected async recognize(): Promise<RecognizeResult> {
    return this.reply;
  }
}

test("BaseSttService は幻聴と判定したテキストを空にする（共通フィルタ）", async () => {
  const project = createTempProject({ prefix: "sumika-stt-" });
  try {
    const service = new FakeStt({ config: project.config }, { text: "ご視聴ありがとうございました。" });
    const result = await service.transcribe(Buffer.alloc(3200));

    assert.equal(result.text, "");
    assert.equal(result.language, "ja");
    assert.equal(typeof result.elapsedMs, "number");
  } finally {
    project.cleanup();
  }
});

test("filter_hallucinations=false なら幻聴でもそのまま返す", async () => {
  const project = createTempProject({
    prefix: "sumika-stt-",
    patch: { stt: { filter_hallucinations: false } },
  });
  try {
    const service = new FakeStt({ config: project.config }, { text: "ご視聴ありがとうございました。" });
    const result = await service.transcribe(Buffer.alloc(3200));

    assert.equal(result.text, "ご視聴ありがとうございました。");
  } finally {
    project.cleanup();
  }
});

test("BaseSttService は中断された signal で AbortError を投げる", async () => {
  const project = createTempProject({ prefix: "sumika-stt-" });
  try {
    const service = new FakeStt({ config: project.config }, { text: "こんにちは" });
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      () => service.transcribe(Buffer.alloc(3200), { signal: controller.signal }),
      (error: Error) => {
        assert.equal(error.name, "AbortError");
        assert.match(error.message, /STT が中断されました/);
        return true;
      }
    );
  } finally {
    project.cleanup();
  }
});

test("言語はサブクラスの上書きが優先される（SenseVoice 等）", async () => {
  const project = createTempProject({ prefix: "sumika-stt-" });
  try {
    const service = new FakeStt({ config: project.config }, { text: "こんにちは", note: "テスト" }, "en");
    const result = await service.transcribe(Buffer.alloc(3200));

    assert.equal(result.text, "こんにちは");
    assert.equal(result.language, "en");
  } finally {
    project.cleanup();
  }
});
