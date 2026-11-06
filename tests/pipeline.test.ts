import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CaptureEndReason, PipelineEvent } from "../src/shared/protocol";
import { ConfigManager } from "../src/backend/config/ConfigManager";
import { AppConfig, DeepPartial } from "../src/backend/config/schema";
import { ConversationHistory } from "../src/backend/conversation/ConversationHistory";
import { ConversationPipeline } from "../src/backend/conversation/ConversationPipeline";
import { PromptBuilder } from "../src/backend/conversation/PromptBuilder";
import {
  AudioIO,
  CaptureOptions,
  CaptureResult,
  LanguageModel,
  SpeechToText,
  TextToSpeech,
} from "../src/backend/core/ports";
import { Logger } from "../src/backend/core/logger";
import type { LlmMessage } from "../src/backend/core/messages";
import { encodeWav } from "../src/backend/services/wav";

Logger.configure({ level: "error" });

interface CaptureSpec {
  hasSpeech: boolean;
  reason: CaptureEndReason;
  triggerSpeech?: boolean;
  /** 受信フレーム数（0 を指定すると「マイクから音声が来ない」状態を再現できる） */
  frames?: number;
  /** 観測ピークレベル（既定 0.2） */
  peakLevel?: number;
}

interface Harness {
  pipeline: ConversationPipeline;
  events: PipelineEvent[];
  history: ConversationHistory;
  captureCalls: () => number;
  playCalls: () => number;
  sttCalls: () => number;
  llmCalls: () => number;
  cleanup: () => void;
}

function setup(options: {
  specs: CaptureSpec[];
  sttTexts?: string[];
  llmOverride?: LanguageModel;
  configPatch?: DeepPartial<AppConfig>;
}): Harness {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "sumika-pipe-"));
  const config = new ConfigManager({ rootDir });
  config.update({
    // サーバー（ffmpeg）録音モードを既定にしたテスト。ブラウザモードは個別に上書きする
    audio: { input_mode: "server", ...(options.configPatch?.audio ?? {}) },
    // 無限に聞き続けないよう、テストでは明示的に停止させる（keep_listening のテストで上書き）
    conversation: {
      barge_in_enabled: false,
      followup_enabled: false,
      keep_listening: false,
      ...(options.configPatch?.conversation ?? {}),
    },
  });

  const events: PipelineEvent[] = [];
  const history = new ConversationHistory(6);
  const promptBuilder = new PromptBuilder({
    config,
    character: {
      get: () => ({
        name: "テスト",
        label: "テスト",
        personality: "テスト用",
        responseRules: "- 簡潔に",
        catchphrases: [],
      }),
    },
  });

  let captureCount = 0;
  let playCount = 0;
  const wav = encodeWav(Buffer.alloc(3200, 1), 16000);
  const audio: AudioIO = {
    listInputDevices: async () => [],
    capture: (captureOptions: CaptureOptions) => {
      const spec = options.specs[Math.min(captureCount, options.specs.length - 1)];
      captureCount += 1;
      if (spec.triggerSpeech) {
        captureOptions.onSpeechStart?.();
      }
      const result: CaptureResult = {
        pcm: Buffer.alloc(3200, 1),
        wav,
        durationMs: 100,
        hasSpeech: spec.hasSpeech,
        reason: spec.reason,
        frames: spec.frames ?? 75,
        peakLevel: spec.peakLevel ?? 0.2,
      };
      return { result: Promise.resolve(result), stop: () => undefined };
    },
    play: () => {
      playCount += 1;
      return { finished: Promise.resolve(), stop: () => undefined };
    },
    dispose: async () => undefined,
  };

  let sttCount = 0;
  const sttTexts = options.sttTexts ?? ["こんにちは"];
  const stt: SpeechToText = {
    isAvailable: async () => true,
    transcribe: async () => {
      const text = sttTexts[Math.min(sttCount, sttTexts.length - 1)];
      sttCount += 1;
      return { text, language: "ja", elapsedMs: 5 };
    },
  };

  let llmCount = 0;
  const llm: LanguageModel =
    options.llmOverride ??
    ({
      isAvailable: async () => true,
      listModels: async () => ["fake"],
      chatStream: async (_messages: unknown, onDelta: (chunk: string) => void) => {
        llmCount += 1;
        onDelta("やあ");
        onDelta("！");
        return "やあ！";
      },
    } as LanguageModel);

  const tts: TextToSpeech = {
    isAvailable: async () => true,
    listSpeakers: async () => [],
    synthesize: async () => wav,
  };

  const pipeline = new ConversationPipeline({
    config,
    history,
    promptBuilder,
    audio,
    stt,
    llm,
    tts,
    logger: new Logger("Test"),
  });
  pipeline.on((event) => events.push(event));

  return {
    pipeline,
    events,
    history,
    captureCalls: () => captureCount,
    playCalls: () => playCount,
    sttCalls: () => sttCount,
    llmCalls: () => llmCount,
    cleanup: () => fs.rmSync(rootDir, { recursive: true, force: true }),
  };
}

function typesOf(events: PipelineEvent[]): string[] {
  return events.map((event) => event.type);
}

test("発話が無ければ LLM を呼ばずに idle へ戻る", async () => {
  const harness = setup({ specs: [{ hasSpeech: false, reason: "no_speech" }] });
  try {
    await harness.pipeline.handleWakeWord("テスト");

    assert.equal(harness.llmCalls(), 0);
    assert.equal(harness.sttCalls(), 0);
    const types = typesOf(harness.events);
    assert.ok(types.includes("recording_started"));
    assert.ok(types.includes("recording_stopped"));
    assert.equal(harness.pipeline.getState(), "idle");

    const states = harness.events
      .filter((event): event is Extract<PipelineEvent, { type: "state" }> => event.type === "state")
      .map((event) => event.state);
    assert.deepEqual(states, ["recording", "idle"]);
  } finally {
    harness.cleanup();
  }
});

test("音声 → STT → LLM → TTS の 1 ターンが完了し、履歴に残る", async () => {
  const harness = setup({ specs: [{ hasSpeech: true, reason: "silence" }] });
  try {
    await harness.pipeline.handleWakeWord("テスト");

    assert.equal(harness.sttCalls(), 1);
    assert.equal(harness.llmCalls(), 1);
    assert.equal(harness.playCalls(), 1);

    const types = typesOf(harness.events);
    for (const expected of [
      "stt_complete",
      "llm_started",
      "llm_delta",
      "llm_complete",
      "tts_started",
      "tts_complete",
      "speaking_started",
      "speaking_finished",
      "turn_complete",
    ]) {
      assert.ok(types.includes(expected), `${expected} が発火していない: ${types.join(",")}`);
    }
    assert.equal(types.filter((type) => type === "llm_delta").length, 2);

    assert.deepEqual(
      harness.history.all().map((message) => [message.role, message.content]),
      [
        ["user", "こんにちは"],
        ["assistant", "やあ！"],
      ]
    );
    assert.equal(harness.pipeline.getState(), "idle");
  } finally {
    harness.cleanup();
  }
});

test("テキスト入力は STT をスキップして応答する", async () => {
  const harness = setup({ specs: [{ hasSpeech: false, reason: "no_speech" }] });
  try {
    await harness.pipeline.submitText("テキストから話しかける");

    assert.equal(harness.sttCalls(), 0);
    assert.equal(harness.llmCalls(), 1);
    assert.equal(harness.history.all()[0]?.content, "テキストから話しかける");
  } finally {
    harness.cleanup();
  }
});

test("ハングルが混入した応答は日本語で 1 回だけ再生成する", async () => {
  const replies = ["음, 당연히 잘 돌아가고 있지! 내가 뭐 도와줄 거 있어?", "うん、ちゃんと動いてるよ！何か手伝おうか？"];
  const sentMessages: LlmMessage[][] = [];
  let calls = 0;
  const llm: LanguageModel = {
    isAvailable: async () => true,
    listModels: async () => ["fake"],
    chatStream: async (messages, onDelta) => {
      const reply = replies[Math.min(calls, replies.length - 1)];
      sentMessages.push(messages);
      calls += 1;
      onDelta(reply);
      return reply;
    },
  };

  const harness = setup({ specs: [{ hasSpeech: false, reason: "no_speech" }], llmOverride: llm });
  try {
    await harness.pipeline.submitText("動作してますか？");

    assert.equal(calls, 2, "ハングル検出で再生成する");
    const retryMessages = sentMessages[1];
    const lastMessage = retryMessages[retryMessages.length - 1];
    assert.equal(lastMessage?.role, "system");
    assert.match(lastMessage?.content ?? "", /日本語だけで書いてください/);

    // 差分は 1 回目の分だけ流し、確定テキストは再生成後の日本語
    const deltas = harness.events
      .filter((event): event is Extract<PipelineEvent, { type: "llm_delta" }> => event.type === "llm_delta")
      .map((event) => event.content);
    assert.deepEqual(deltas, [replies[0]]);

    const complete = harness.events.find(
      (event): event is Extract<PipelineEvent, { type: "llm_complete" }> => event.type === "llm_complete"
    );
    assert.equal(complete?.text, replies[1]);
    assert.equal(harness.history.all().at(-1)?.content, replies[1]);
  } finally {
    harness.cleanup();
  }
});

test("フォローアップが有効なら連続ターンを録音し続ける", async () => {
  const harness = setup({
    specs: [
      { hasSpeech: true, reason: "silence" },
      { hasSpeech: true, reason: "silence" },
    ],
    sttTexts: ["1 回目", "2 回目"],
    configPatch: {
      conversation: { barge_in_enabled: false, followup_enabled: true, max_followup_turns: 1 },
    },
  });
  try {
    await harness.pipeline.handleWakeWord("テスト");

    assert.equal(harness.llmCalls(), 2, "2 ターン応答する");
    assert.equal(harness.sttCalls(), 2);
    assert.ok(typesOf(harness.events).includes("followup_wait"));
    assert.deepEqual(
      harness.history.all().map((message) => message.content),
      ["1 回目", "やあ！", "2 回目", "やあ！"]
    );
  } finally {
    harness.cleanup();
  }
});

test("バージイン発話は再生を中断し、次のターンとして処理される", async () => {
  const harness = setup({
    specs: [
      { hasSpeech: true, reason: "silence" },
      { hasSpeech: true, reason: "silence", triggerSpeech: true },
      { hasSpeech: false, reason: "no_speech" },
    ],
    configPatch: { conversation: { barge_in_enabled: true, followup_enabled: false } },
  });
  try {
    await harness.pipeline.handleWakeWord("テスト");

    assert.equal(harness.llmCalls(), 2);
    assert.ok(typesOf(harness.events).includes("barge_in"));
    assert.equal(harness.pipeline.getState(), "idle");
  } finally {
    harness.cleanup();
  }
});

test("認識結果が空のときは stt_complete を出さずエラー通知する", async () => {
  const harness = setup({
    specs: [{ hasSpeech: true, reason: "silence" }],
    sttTexts: ["   "],
  });
  try {
    await harness.pipeline.handleWakeWord("テスト");

    const types = typesOf(harness.events);
    assert.equal(types.includes("stt_complete"), false, "空の吹き出しを出さない");
    assert.equal(types.includes("error"), true);
    assert.equal(harness.llmCalls(), 0);
    assert.equal(harness.history.length, 0);
    assert.equal(harness.pipeline.getState(), "idle");
  } finally {
    harness.cleanup();
  }
});

test("マイクからフレームが来ない場合はその旨をエラー通知する", async () => {
  const harness = setup({ specs: [{ hasSpeech: false, reason: "no_speech", frames: 0 }] });
  try {
    await harness.pipeline.handleWakeWord("テスト");

    const errorEvent = harness.events.find(
      (event): event is Extract<PipelineEvent, { type: "error" }> => event.type === "error"
    );
    assert.ok(errorEvent, "エラーイベントが発火すること");
    assert.equal(errorEvent?.scope, "audio");
    assert.match(errorEvent.message, /マイクから音声データが取得できませんでした/);
    assert.equal(harness.pipeline.getState(), "idle");
  } finally {
    harness.cleanup();
  }
});

test("マイクの入力レベルがほぼ 0 の場合はミュート等を案内する", async () => {
  const harness = setup({
    specs: [{ hasSpeech: false, reason: "no_speech", frames: 75, peakLevel: 0.001 }],
  });
  try {
    await harness.pipeline.handleWakeWord("テスト");

    const errorEvent = harness.events.find(
      (event): event is Extract<PipelineEvent, { type: "error" }> => event.type === "error"
    );
    assert.ok(errorEvent, "エラーイベントが発火すること");
    assert.equal(errorEvent?.scope, "audio");
    assert.match(errorEvent.message, /入力レベルがほぼ 0/);
    assert.equal(harness.pipeline.getState(), "idle");
  } finally {
    harness.cleanup();
  }
});

test("ブラウザから送られた音声はサーバー録音せずに 1 ターン処理する", async () => {
  const harness = setup({ specs: [{ hasSpeech: false, reason: "no_speech" }] });
  try {
    const wav = encodeWav(Buffer.alloc(3200, 1), 16000);
    await harness.pipeline.submitAudio(wav);

    assert.equal(harness.captureCalls(), 0, "サーバー側の録音は行わない");
    assert.equal(harness.sttCalls(), 1);
    assert.equal(harness.llmCalls(), 1);
    assert.equal(harness.playCalls(), 1);
    assert.equal(harness.history.all()[0]?.content, "こんにちは");
    assert.ok(typesOf(harness.events).includes("turn_complete"));
    assert.equal(harness.pipeline.getState(), "idle");
  } finally {
    harness.cleanup();
  }
});

test("ブラウザ入力モードではサーバー側の録音を開始しない", async () => {
  const harness = setup({
    specs: [{ hasSpeech: true, reason: "silence" }],
    configPatch: { audio: { input_mode: "browser" } },
  });
  try {
    await harness.pipeline.handleWakeWord("テスト");

    assert.equal(harness.captureCalls(), 0);
    const errorEvent = harness.events.find(
      (event): event is Extract<PipelineEvent, { type: "error" }> => event.type === "error"
    );
    assert.ok(errorEvent);
    assert.match(errorEvent.message, /ブラウザのマイク/);
  } finally {
    harness.cleanup();
  }
});

test("keep_listening=true なら回数の上限を超えても聞き取りを続ける", async () => {
  const harness = setup({
    specs: [
      { hasSpeech: true, reason: "silence" },
      { hasSpeech: true, reason: "silence" },
      { hasSpeech: false, reason: "no_speech" },
    ],
    sttTexts: ["1 回目", "2 回目"],
    configPatch: {
      conversation: {
        barge_in_enabled: false,
        followup_enabled: true,
        max_followup_turns: 0,
        keep_listening: true,
      },
    },
  });
  try {
    await harness.pipeline.handleWakeWord("テスト");

    assert.equal(harness.llmCalls(), 2, "上限 0 でも継続して 2 ターン応答する");
    assert.equal(harness.sttCalls(), 2);
    assert.equal(harness.pipeline.getState(), "idle");
  } finally {
    harness.cleanup();
  }
});

test("stop() で進行中の LLM 呼び出しが中断され idle に戻る", async () => {
  const hangingLlm: LanguageModel = {
    isAvailable: async () => true,
    listModels: async () => [],
    chatStream: (_messages, _onDelta, chatOptions) =>
      new Promise<string>((_resolve, reject) => {
        chatOptions?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      }),
  };

  const harness = setup({
    specs: [{ hasSpeech: false, reason: "no_speech" }],
    llmOverride: hangingLlm,
  });
  try {
    const pending = harness.pipeline.submitText("中断して");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(harness.pipeline.getState(), "thinking");

    harness.pipeline.stop();
    await pending;

    assert.equal(harness.pipeline.getState(), "idle");
    assert.equal(
      harness.events.some((event) => event.type === "error"),
      false
    );
  } finally {
    harness.cleanup();
  }
});
