# 音声認識（STT）エンジンの選択肢

現行実装は whisper.cpp（`whisper.cpp/main.exe` + ggml モデル）を子プロセスで呼び出す方式です。
本ドキュメントは **Whisper の幻聴対策**と、**Whisper 以外のローカル認識エンジンの比較**をまとめたものです。

---

## 1. Whisper の幻聴（hallucination）とは

Whisper 系モデルは **無音・雑音・BGM・自分の声の回り込み**に対して、学習データ由来の定型句を
出力することがあります（whisper.cpp でも既知の問題）。

実測ログ（このリポジトリ）:

```
04:40:49 認識: 「ありがとうございました。」
04:41:09 認識: 「ありがとうございました。」
04:41:20 認識: 「皆さん」
```

代表的な日本語の幻聴: `ご視聴ありがとうございました。` / `チャンネル登録お願いします。` / `おやすみなさい` /
`（拍手）` / `字幕はこちら` / 同じ文の繰り返し。

### 1.1 本アプリで実装した対策

| 層 | 対策 | 設定キー |
|----|------|----------|
| デコーダ | 非音声トークン抑制（`-sns`） | `stt.suppress_non_speech` |
| デコーダ | 文脈を引き継がない（`-mc 0`）＝同文の繰り返しを防ぐ | `stt.max_context` |
| デコーダ | 無音判定しきい値（`-nth`） | `stt.no_speech_thold` |
| デコード結果 | 区間ごとの `no_speech_prob` で破棄（`-ojf` の JSON を利用） | `stt.drop_no_speech_prob` |
| デコード結果 | 区間ごとの `avg_logprob` で破棄 | `stt.drop_avg_logprob` |
| 後処理 | 定型句・記号のみ・単純な繰り返しを破棄 | `stt.filter_hallucinations` |
| パイプライン | 自分の読み上げ内容のエコーを破棄 | （自動・`ConversationPipeline`） |
| パイプライン | 同じ認識結果が 3 回連続したら破棄 | （自動） |
| パイプライン | 破棄が 3 回続いたら聞き取りを止める | （自動） |

whisper.cpp 公式の README でも、非音声入力への幻聴対策として
「言語の固定 / `--suppress-nst` / `--no-fallback` / デコーダ失敗しきい値（`-et`, `-lpt`）/ VAD /
`--suppress-regex`」が挙げられています（[PR #4099](https://github.com/ggml-org/whisper.cpp/pull/4099)）。

さらに抑えたい場合の調整:

- `audio.silence_threshold` を `0.03`〜`0.05` に上げる（VAD が雑音を発話と誤検知しにくくなる）
- `stt.no_speech_thold` を `0.7`、`stt.drop_no_speech_prob` を `0.6` に下げる（＝厳しくする）
- スピーカー出力をマイクが拾う環境ではヘッドホンを使う、または `conversation.barge_in_enabled = false`

実測（このリポジトリの環境 / large-v3-turbo q5_0 / CUDA）:

| 入力 | 対策前 | 対策後 |
|------|--------|--------|
| 無音 1 秒 | `ご視聴ありがとうございました。` | `（空）` |
| 微小ノイズ 1 秒 | 不定（`はい` 等） | `（空）`（VAD で到達しない） |
| VOICEVOX の日本語音声 | 正常 | 正常（`今日はいい天気ですね。散歩にでも行きましょう。`） |

---

## 2. Whisper 以外の選択肢

前提: **完全ローカル / Windows / Node.js（TypeScript）/ GTX 1650 4GB / 日本語**。

| エンジン | 日本語 | 方式 | 幻聴 | 速度 | Windows/Node からの利用 | ライセンス |
|----------|--------|------|------|------|--------------------------|-----------|
| **whisper.cpp（既定）** | ○ | 自己回帰デコーダ | **あり**（対策必須） | 3.5 秒/発話（CUDA, q5_0） | 子プロセス（現行） | MIT（モデルは別） |
| **sherpa-onnx + NVIDIA Parakeet TDT-CTC 0.6B JA（実装済み）** | ◎ | CTC/transducer（非自己回帰） | **なし** | 高速（CPU で 0.2〜0.4 秒/発話、GPU 不要） | `sherpa-onnx-node`（Node 16+、Windows x64 は DLL 自動解決） | Apache-2.0（sherpa-onnx）/ モデルは CC-BY-4.0 |
| **sherpa-onnx + SenseVoice（zh/en/ja/ko/yue）** | ○ | CTC（非自己回帰） | **なし** | 高速（int8, 数十 MB） | 同上 | Apache-2.0（モデルは FunAudioLLM） |
| **ReazonSpeech v2.1**（NeMo / k2 / ESPnet） | ◎ | Conformer/Transducer | なし | 高速（wav2vec2-base 系は特に速い） | Python 前提（Node バインディングなし） | Apache-2.0 |
| **Vosk** | △（日本語モデルは旧世代） | Kaldi（ストリーミング） | なし | 軽量 | `vosk` npm（ネイティブ） | Apache-2.0 |
| **kotoba-whisper v2.0 / faster-whisper** | ○ | Whisper（自己回帰） | あり | 中 | Python 前提 | Apache-2.0 |
| **Cohere Transcribe** | ◎（最高精度） | - | - | 遅い（GPU 必須級） | API/独自 | 要確認 |

参考ベンチマーク（FLEURS ja 650 件, CER と実行時間）: Cohere Transcribe **CER 0.0447 / 188.5 s**、
NVIDIA Parakeet TDT-CTC 0.6B JA **tier 2 最速 / 70.7 s / p95 184 ms**、
ReazonSpeech wav2vec2-base **CER 0.1496 / 13.7 s**、Gemma 4 E2B **CER 0.1230 / 1034.9 s**
（[kuro-shiba/ASR_ja_comparison](https://github.com/kuro-shiba/ASR_ja_comparison)）。

### 2.1 推奨: sherpa-onnx + Parakeet 0.6B JA（幻聴ゼロ・高速・GPU 不要）

> **本リポジトリでは実装済み**（`stt.engine = "sherpa"`）。
> 手順は README の「認識エンジンの切り替え」、実装は
> `src/backend/services/SherpaSttService.ts` / `sttFactory.ts` を参照。

- **非自己回帰（CTC/TDT）なので「無音に定型句を出す」現象が構造的に起きない**
- モデルは `sherpa-onnx-nemo-parakeet-tdt_ctc-0.6b-ja-35000-int8`（日本語 / int8 / 625MB）
- `sherpa-onnx-node` は `npm install` だけで Windows x64 の DLL も入る（CMake・Python 不要）
- ただし**非ストリーミング**なので、現行と同じ「VAD で区切ってから 1 発話ずつ認識」で使う
  （Silero VAD も同リリースに同梱）

**実測（この PC / GTX 1650 Max-Q / VOICEVOX の日本語音声）**

| エンジン | 1 発話の認識時間 | 精度 | 備考 |
|---|---|---|---|
| sherpa-onnx（Parakeet 0.6B JA, int8, CPU） | **222〜420ms**（初回 3.0 秒はモデルロード） | `今日はいい天気ですね、散歩にでも行きましょう` 正しく認識 | GPU 未使用（VRAM 0MB） |
| whisper.cpp（large-v3-turbo q5_0, CUDA） | 1.5〜3.5 秒 | 同等 | VRAM 約 550MB |

実装は既存の `SpeechToText` インターフェース（`transcribe(wav, { signal })`）に合わせてあるため、
`stt.engine` を切り替えるだけで UI・パイプライン・幻聴フィルタ（`transcriptFilter.ts`）はそのまま動きます。

実装（`src/backend/services/SherpaSttService.ts` の要点）:

```ts
// ネイティブモジュールは遅延読み込み（未インストールでも起動に影響しない）
const sherpa = require("sherpa-onnx-node");

const recognizer = new sherpa.OfflineRecognizer({
  featConfig: { sampleRate: 16000, featureDim: 80 },
  modelConfig: {
    tokens: "models/<model>/tokens.txt",
    model: "models/<model>/model.int8.onnx", // ← nemo_ctc は単一ファイル
    modelType: "nemo_ctc",
    numThreads: 4,
    provider: "cpu",
  },
});

// WAV(PCM16LE) → Float32 [-1,1]（16kHz 以外は内部でリサンプリング）
const stream = recognizer.createStream();
stream.acceptWaveform({ sampleRate: 16000, samples: wavToFloat32(wav).samples });
recognizer.decode(stream);
const text = recognizer.getResult(stream).text;
```

現行インターフェース（`src/backend/core/ports.ts` の `SpeechToText`）は
`transcribe(wav, { signal })` だけなので、**設定 `stt.engine`（whisper / sherpa）で切り替える**形にしてあり、
UI・パイプライン・幻聴フィルタ（`transcriptFilter.ts`）はそのまま流用しています。

### 2.2 ストリーミング（発話途中の逐次表示）にしたい場合

sherpa-onnx の **日本語ストリーミング Zipformer は現時点で提供されていません**
（streaming モデルは中国語・英語・韓国語など）。日本語で「逐次表示」をしたい場合は、

- Parakeet / SenseVoice を Silero VAD で区切り、区間ごとに確定（現実的）
- または Whisper のまま（自己回帰なので途中結果は出せるが幻聴リスクが残る）

のどちらかになります。

### 2.3 判断の目安

| 状況 | 選択 |
|------|------|
| 今のまま（幻聴は対策済みで十分） | whisper.cpp 継続。`stt.*` のしきい値で調整 |
| 幻聴をゼロにしたい / GPU を LLM に空けたい | **sherpa-onnx + Parakeet 0.6B JA** へ移行 |
| 多言語（英語混じり）も拾いたい | sherpa-onnx + SenseVoice（ja/en/zh/ko/yue） |
| Python 資産がある / 最高精度重視 | ReazonSpeech v2.1（NeMo）をサイドカーで |
