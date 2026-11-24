# 日英モードとマルチリンガル発声（B 案 → RVC 検証）

このドキュメントは「日本語モード / 英語モード」の切替と、**同一声質で日英を読み上げる**ための
実装・検証手順をまとめたものです。設計の全体像は `docs/REDESIGN.md` を参照してください。

- ねらい: **B 案（単一の多言語 TTS で声質を揃える）を先に成立させ、成功後に RVC（C 案）を検証する**
- 現状: 言語モード切替・英語 TTS アダプタ・実測スクリプトまで実装済み
- 参照実装: `D:\LLMProjects\RVCMultilingual`（Gemini 翻訳 → Google Cloud TTS → RVC）。そのままではなく、
  「参照音声で声質を寄せる」考え方と RVC パラメータだけを流用します

---

## 1. 設定（これだけで言語モードが切り替わる）

```toml
[conversation]
language = "ja"                 # ja | en（ヘッダのセレクトでも変更可。次の発話から有効）
reset_history_on_language_change = false

[stt]
engine = "sherpa"               # 日本語は現行のまま
language = "ja"
sherpa_language = "ja"

[stt.en]                        # 英語モードの上書き（未指定キーは [stt] を使う）
engine = "whisper"              # 日本語専用モデル（nemo_ctc）を避ける
language = "en"
sherpa_language = "en"

[tts]                           # 日本語（VOICEVOX）
engine = "voicevox"
endpoint = "http://127.0.0.1:50021"
speaker_id = 2

[tts.en]                        # 英語（B 案のエンジン）
engine = "openai_speech"        # openai_speech | gpt_sovits | voicevox（非推奨）
endpoint = "http://127.0.0.1:8880"
model = "kokoro"
voice = "af_heart"
speed = 1.0
# GPT-SoVITS を使う場合のみ（engine = "gpt_sovits"）
reference_wav = ""
reference_text = ""
prompt_lang = "en"

[tts.voice_conversion]          # 任意（RVC は B の成功後に有効化する）
enabled = false
endpoint = "http://127.0.0.1:9890"
model_path = ""
index_path = ""
```

`llm.character_file_en`（既定 `config/characters/sakura.en.toml`）を設定すると、
英語モードの人格・口癖を別ファイルにできます（無ければ日本語の定義を共有）。

---

## 2. 英語 TTS の用意（3 択）

### 2-A. Kokoro-82M（軽い・速い・Apache-2.0）— まずこれで通す

- OpenAI 互換 `/v1/audio/speech` を出すサーバーを立てる（例: Kokoro-FastAPI, port 8880）
- 日本語も同じモデルで出せる（54 声 / 8 言語）が、**日本語の品質は VOICEVOX が上**なので
  ja は VOICEVOX のままにするのが無難
- 声質は VOICEVOX と一致しない（B 案の「声質を揃える」を満たすには 2-B を使う）

```toml
[tts.en]
engine = "openai_speech"
endpoint = "http://127.0.0.1:8880"
model = "kokoro"
voice = "af_heart"
```

### 2-B. GPT-SoVITS（Windows 実績・参照音声で日英同一声質）— 本命

- `api_v2.py` を起動（既定 port 9880）。`/tts` に `ref_audio_path` を渡す
- 参照音声は **1〜5 秒**。日本語の参照音声のまま英語を読ませられる（cross-lingual）
- 声質を寄せたい相手の音声を使う（**自分の声 / 許諾済みの声**。VOICEVOX 音源の学習は規約を確認）

```toml
[tts.en]
engine = "gpt_sovits"
endpoint = "http://127.0.0.1:9880"
reference_wav = "assets/voices/ref.wav"
reference_text = "参照音声の書き起こし"
prompt_lang = "ja"     # 参照音声の言語
```

### 2-C. Qwen3-TTS / CosyVoice3（Apache-2.0・多言語クローン）

- Qwen3-TTS 0.6B Base は 3 秒の参照音声で 10 言語（ja/en 含む）を同一話者で生成できる
- 推論サーバーが OpenAI 互換 `/v1/audio/speech` を出す場合は `engine = "openai_speech"` のまま
  `endpoint` と `voice`（話者 ID / 参照音声 ID）だけ差し替えられる
- **注意**: 97ms 低遅延は vLLM-Omni 構成の数字。素の transformers 実装では初声が秒単位になることがある。
  RTX 3060 12GB では 0.6B + bf16 を推奨（1.7B は VRAM 8GB 級）
- CosyVoice3 は Windows の依存（pynini 等）で詰まりやすいため Docker / WSL2 前提が無難

---

## 3. 実測スパイク（`npm run spike:tts`）

TTS サーバーを起動した状態で:

```powershell
npm run spike:tts                       # ja と en を 3 回
npm run spike:tts -- --lang en --runs 5 # en だけ 5 回
```

出力例（`logs/tts-spike/en-*.wav` も保存される）:

```
=== en ===
  #1 合成 420ms / 音声 3600ms / RTF 0.12 / 186KB
  → p50: 合成 430ms / RTF 0.12
  → VRAM: 2100MiB（前） / 3600MiB（後）
```

判定の目安:

| RTF | 意味 | 対応 |
|---|---|---|
| < 0.5 | 先読み 1 文で隠せる | そのまま採用 |
| 0.5〜1.0 | 初声が遅くなりやすい | `tts.prefetch_depth=2`、1 文目を短く分割 |
| > 1.0 | 逐次読み上げに不向き | 別エンジン（Kokoro / GPT-SoVITS）を検討 |

あわせて確認する項目:

1. `logs/tts-spike/*.wav` を聴いて **ja と en が同じ声に聴こえるか**（B 案の受け入れ条件）
2. `/api/diagnostics` と `logs/app.log` に TTS の失敗が出ていないか
3. VRAM 合計が 12GB に収まるか（Ollama + whisper + TTS + RVC）。厳しければ `stt.engine` を sherpa(CPU) へ

---

## 4. 受け入れ条件（B 案）

- [ ] ヘッダの `日本語 / English` で切替でき、**次の発話から** STT・プロンプト・TTS が追従する
- [ ] en モードで英語の質問 → 英語の応答 → **英語の音声**（`tts.en` のエンジン）で再生される
- [ ] en モードで日本語・韓国語が混ざった応答は 1 回だけ再生成される（`speech_reset`）
- [ ] 口パクが動く（`tts_audio.volumes` が空でない = 16bit PCM へ正規化できている）
- [ ] 初声 p50 < 1.5 秒 / p95 < 3 秒（en）
- [ ] `npm run verify` が緑

---

## 5. RVC の検証（B の成功後）

B 案で声質が足りない場合のみ、`[tts.voice_conversion]` を有効化して RVC を挟みます。

- ワーカーは **常駐**（参考実装は 1 回ごとに `RVCInference` を生成してモデルをロードするため 1〜3 秒/文損する）
- API: `POST /convert` `{ "wav_base64": "...", "pitch": 0, "index_rate": 0.75 }` → `{ "wav_base64": "..." }`
- 出力は **16bit PCM モノラル**（口パクの前提）。44.1kHz のままで良い（再生側は任意レート対応）
- 固定ファイル名（`rvc_input.wav`）を使わない（同時発話・複数タブで競合する）
- 計測は `npm run spike:tts` と `nvidia-smi` で、変換込みの RTF を測る

---

## 6. 参照（一次情報）

- Qwen3-TTS: https://github.com/QwenLM/Qwen3-TTS / https://huggingface.co/Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice
- CosyVoice3: https://huggingface.co/FunAudioLLM/Fun-CosyVoice3-0.5B-2512
- GPT-SoVITS（api_v2 の `streaming_mode`）: https://github.com/RVC-Boss/GPT-SoVITS/blob/main/api_v2.py
- Kokoro-82M: https://huggingface.co/hexgrad/Kokoro-82M / Kokoro-FastAPI: https://github.com/remsky/Kokoro-FastAPI
- VOICEVOX 利用規約: https://voicevox.hiroshiba.jp/term/ / 音源利用ガイドライン: https://zunko.jp/con_ongen_kiyaku.html
