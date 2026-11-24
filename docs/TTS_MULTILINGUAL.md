# 日英モードとマルチリンガル発声（B 案 → RVC 検証）

このドキュメントは「日本語モード / 英語モード」の切替と、**同一声質で日英を読み上げる**ための
実装・検証手順をまとめたものです。設計の全体像は `docs/REDESIGN.md` を参照してください。

- ねらい: **B 案（単一の多言語 TTS で声質を揃える）を先に成立させ、成功後に RVC（C 案）を検証する**
- 現状: **B 案は成立（2026-11 実測）**。GPT-SoVITS を ja/en 共通のエンジンにし、同じ参照音声で
  RTF 0.45（ja）/ 0.49（en）、ja↔en の話者類似度 1.000 を確認済み（§2-B / §3）
- 参照実装: `D:\LLMProjects\RVCMultilingual`（Gemini 翻訳 → Google Cloud TTS → RVC）。そのままではなく、
  「参照音声で声質を寄せる」考え方と RVC パラメータだけを流用します

---

## 0. エンジン比較（無料・ライセンス・「同じ声」の可否）

一次情報（各リポジトリの LICENSE / モデルカード）と**この PC での実測**にもとづく比較です。

| エンジン | ライセンス（商用） | 日本語 | 参照音声で同一話者 | 実測 RTF（RTX 3060 12GB） | 判定 |
|---|---|---|---|---|---|
| **GPT-SoVITS（api_v2）** | **MIT（可）** | ◎ | ◎（3〜10 秒・cross-lingual） | **0.45 / 0.49** | **採用** |
| Qwen3-TTS 0.6B Base | Apache-2.0（可） | ○ | ◎（3 秒・10 言語） | 3.45 / 3.53 | 速度不足で不採用（§2-C） |
| Kokoro-82M | Apache-2.0（可。**日本語ボイスの扱いは未確定**） | ○ | **× クローン不可**（声は固定） | 0.02 級 | B 案の「単一話者」を作れない |
| Chatterbox Multilingual | MIT（可） | ○ | ○ | 未計測 | **2026-08 に retired**。全音声に PerTh 透かし |
| IndexTTS-2.5 | bilibili Model Use License（商用は要問い合わせ） | ◎（ja WER 6.57） | ○ | 0.21（RTX 4090） | ライセンス確認が前提 |
| Fish Speech S2 | Fish Audio Research License（**研究用**） | ○ | ○ | — | 商用不可 |
| XTTS-v2 | CPML（**商用不可**） | ○ | ○ | — | 商用不可 |

- RTF = 合成時間 ÷ 音声長。**0.5 未満なら先読み 1 文で隠せる**（§3 の判定表）
- 「参照音声で同一話者」＝ 1 本の参照音声から ja / en を**同じ声**で読み上げられるか。
  Kokoro は話者埋め込みが固定で参照音声を受け付けないため、B 案の要件を満たせません
- 無料で商用可・日本語・クローン可の条件を満たすのは **GPT-SoVITS（MIT）** と
  Qwen3-TTS / Chatterbox（Apache-2.0 / MIT）です。このうち**速度が実用域（RTF < 0.5）なのは GPT-SoVITS**

### GPT-SoVITS は有料か（2026-11 に一次情報で確認）

**無料です。コードもモデルも商用利用できます。** 内訳:

| 構成要素 | ライセンス | 商用 | 根拠 |
|---|---|---|---|
| コード（`RVC-Boss/GPT-SoVITS`） | **MIT** | 可 | リポジトリの `LICENSE` |
| 事前学習モデル 4.3GB（`XXXXRT/GPT-SoVITS-Pretrained`） | **MIT** | 可 | モデルカードに `License: mit` |
| 公式の重み（`lj1995/GPT-SoVITS`） | **MIT** | 可 | モデルカードに `License: mit` |
| 日本語 G2P（`pyopenjtalk` 0.4.1） | MIT（Expat） | 可 | `METADATA` の License 欄 |
| Open JTalk 辞書（`open_jtalk_dic_utf_8-1.11`） | 修正 BSD（NAIST） | 可 | 同梱の `COPYING` |

- **かかる費用は GPU の電気代だけ**。クラウド API・サブスク・従量課金はありません（すべて localhost 完結）
- MIT の義務は「著作権表示とライセンス文の同梱」。**再配布したり製品に組み込む場合**に必要で、
  ローカルで自分が使うだけなら実質不要です
- **参照音声そのものの権利は別問題**。GPT-SoVITS が無料でも、声（VOICEVOX 音源・実在の人物など）の
  使用許諾は別途必要です（§2-B の注意書きを参照）

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

[tts]                           # 日本語の既定（後方互換のため残す）
engine = "voicevox"
endpoint = "http://127.0.0.1:50021"
speaker_id = 2

[tts.ja]                        # 日本語の上書き（未指定キーは [tts] 直下）
# B 案（日英で同じ声）にするときは、ここを [tts.en] と同じ設定にする
# engine = "gpt_sovits"
# endpoint = "http://127.0.0.1:9880"
# reference_wav = "assets/voices/ref.wav"
# reference_text = "参照音声の書き起こし"
# prompt_lang = "ja"

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

### B 案（日英で同じ声）にする設定例

`[tts.ja]` と `[tts.en]` に**同じエンジン・同じ参照音声**を書くと、どちらのモードでも同じ TTS で読み上げます。

```toml
[tts.ja]
engine = "gpt_sovits"
endpoint = "http://127.0.0.1:9880"
reference_wav = "assets/voices/ref.wav"
reference_text = "参照音声の書き起こし"
prompt_lang = "ja"          # 参照音声の言語

[tts.en]
engine = "gpt_sovits"
endpoint = "http://127.0.0.1:9880"
reference_wav = "assets/voices/ref.wav"   # ja と同じ参照音声 → 同じ声
reference_text = "参照音声の書き起こし"
prompt_lang = "ja"
```

- 何も書かなければ **ja は VOICEVOX**（従来どおり）、en のみ新エンジンという併用になる
- 「B 案 = 日英を 1 エンジンに統一」は上記のように `[tts.ja]` を設定して実現する
- 画面の TTS 🟢/🔴 は**現在のモードのエンジン**を見る（ja なら `[tts.ja]`、en なら `[tts.en]`）

`llm.character_file_en`（既定 `config/characters/sakura.en.toml`）を設定すると、
英語モードの人格・口癖を別ファイルにできます（無ければ日本語の定義を共有）。

---

## 2. 英語 TTS の用意（3 択）

### 2-A. Kokoro-82M（軽い・速い・Apache-2.0）— 英語だけ別エンジンでよい場合の候補

- OpenAI 互換 `/v1/audio/speech` を出すサーバーを立てる（例: Kokoro-FastAPI, port 8880）
- **B 案には使えない**: Kokoro は参照音声によるクローンができず、ja（`jf_alpha`）と
  en（`af_heart`）は**別の話者**になる。「日英で同じ声」が必要なら 2-B を使う
- 日本語ボイス（`voices/jf_*.pt`）の**ライセンスは未確定**（hexgrad/kokoro#397 が未回答）。
  商用配布を考えるなら、日本語は VOICEVOX のままにするのが安全

```toml
[tts.en]
engine = "openai_speech"
endpoint = "http://127.0.0.1:8880"
model = "kokoro"
voice = "af_heart"
```

### 2-B. GPT-SoVITS（MIT・Windows 実績・参照音声で日英同一声質）— **採用（実測済み）**

**実測（2026-11 / RTX 3060 12GB）**: ja RTF 0.45 / en RTF 0.49、ja↔en の MFCC 類似度 1.000
（参照音声との類似度も ja 0.998 / en 0.997）、VRAM 約 3.9GB（Ollama 等と同居）。
§4 の受け入れ条件（RTF < 0.5・同じ声）を満たします。

- `api_v2.py` を起動（既定 port 9880）。`/tts` に `ref_audio_path` を渡す
- 参照音声は **3〜10 秒**（公式は 5 秒程度を推奨）。**日本語の参照音声のまま英語を読ませられる**（cross-lingual）
- **日英で同じ声にするには `[tts.ja]` と `[tts.en]` の両方に同じ設定を書く**（上記「B 案の設定例」）
- 声質を寄せたい相手の音声を使う（**自分の声 / 許諾済みの声**。VOICEVOX 音源の学習は規約を確認）

```toml
[tts.en]
engine = "gpt_sovits"
endpoint = "http://127.0.0.1:9880"
reference_wav = "assets/voices/ref.wav"
reference_text = "参照音声の書き起こし"
prompt_lang = "ja"     # 参照音声の言語
```

#### セットアップ（Windows で通した手順）

```powershell
git clone --depth 1 https://github.com/RVC-Boss/GPT-SoVITS.git D:\LLMProjects\GPT-SoVITS
cd D:\LLMProjects\GPT-SoVITS
python -m venv .venv-gsv --system-site-packages   # torch は既存環境を使う（再 DL を避ける）
.\.venv-gsv\Scripts\python.exe -m pip install -r requirements-min.txt   # 下記 3. の最小構成
# モデル（約 4.3GB）と日本語/英語の G2P 辞書
curl.exe -L -o pretrained_models.zip "https://huggingface.co/XXXXRT/GPT-SoVITS-Pretrained/resolve/main/pretrained_models.zip"
tar -xf pretrained_models.zip -C GPT_SoVITS
curl.exe -L -o open_jtalk_dic_utf_8-1.11.tar.gz "https://huggingface.co/XXXXRT/GPT-SoVITS-Pretrained/resolve/main/open_jtalk_dic_utf_8-1.11.tar.gz"
curl.exe -L -o nltk_data.zip "https://huggingface.co/XXXXRT/GPT-SoVITS-Pretrained/resolve/main/nltk_data.zip"
Expand-Archive nltk_data.zip -DestinationPath .; tar -xzf open_jtalk_dic_utf_8-1.11.tar.gz
# 起動（常駐。アプリより先に起動しておく）
.\.venv-gsv\Scripts\python.exe api_v2.py -a 127.0.0.1 -p 9880 -c GPT_SoVITS/configs/tts_infer.yaml
```

**ハマりどころ（実測）**:

1. `requirements.txt` は **`numpy<2.0`** を要求する → Qwen3-TTS の venv と同居できない。venv を分ける
2. `--system-site-packages` でも **pip が venv に torch を入れてしまい、system の torchaudio と不整合**になる
   （`OSError: Could not load this library: ...libtorchaudio.pyd`）。
   `pip uninstall -y torch torchvision torchaudio` で venv 側を消し、system の torch 2.7.1+cu126 を使わせる
3. 推論だけなら `requirements.txt` の全部は不要。`matplotlib` / `x_transformers` / `jieba_fast` /
   `wordsegment` / `ToJyutping` / `g2pk2` / `ko_pron` は**起動時に import される**ので個別に入れる
4. 参照音声は `assets/voices/` に置く（gitignore 済み）。**権利が確認できる音声のみ**使う

### 2-C. Qwen3-TTS / CosyVoice3（Apache-2.0・多言語クローン）— 声は揃うが速度不足

**実測（2026-11 / RTX 3060 12GB・素の transformers）**: RTF **3.45（ja）/ 3.53（en）**。
声は完璧に揃う（ja↔en の MFCC 類似度 0.999、参照音声とも 0.999）が、5 秒の音声に 18〜20 秒かかり
**会話には使えない**ため不採用。計測は `scripts/spike-qwen-tts.py`（`.venv-tts` + `pip install qwen-tts`）。

- 遅い主因は flash-attn 不在の素の実装（`flash_attn` は Windows に prebuilt wheel が無い）。
  `attn_implementation="sdpa"` にしても 3.75 → 3.45 で焼け石に水
- `dtype=bfloat16` 必須（**fp16 は `CUDA error: device-side assert triggered` で落ちる**）
- 公式の低遅延（97ms）は vLLM-Omni 構成の数字で、**vLLM-Omni は Windows 非対応**。
  将来対応したら再評価する価値あり（品質・声質統一は GPT-SoVITS 以上）
- 0.6B でも VRAM ピーク 2.5GB と軽い。GPU に余裕がある構成（RTX 4070 以上）や CPU 併用なら再検討の余地あり
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

### 実測結果（2026-11 / GPT-SoVITS v2 / RTX 3060 12GB）

`[tts.ja]` と `[tts.en]` を同じ GPT-SoVITS・同じ参照音声にした状態（`--runs 2`）:

```
=== ja ===
  #1 合成 2861ms / 音声 5540ms / RTF 0.52 / 346KB
  #2 合成 2167ms / 音声 5700ms / RTF 0.38 / 356KB
  → p50: 合成 2514ms / RTF 0.45
  → VRAM: 3907MiB（前） / 3865MiB（後）

=== en ===
  #1 合成 2185ms / 音声 4980ms / RTF 0.44 / 311KB
  #2 合成 2748ms / 音声 5140ms / RTF 0.53 / 321KB
  → p50: 合成 2467ms / RTF 0.49
```

- **ja↔en の MFCC コサイン類似度 1.000**（参照音声との類似度も ja 0.998 / en 0.997）
- F0 中央値: 参照 255Hz / ja 275Hz / en 265Hz → 声の高さも揃う
- 初回だけ遅い（ja#1 4.0 秒 / en#1 10.0 秒）。**常駐前提なので warmup 後の数字を見る**のが正しい
- 出力は `logs/tts-spike/{ja,en}-*.wav` に残る（gitignore 済み）。聴いて確認できる

**エンジン単体の計測**（アプリを通さない比較）:

| スクリプト | 対象 | ja RTF | en RTF | ja↔en 類似度 |
|---|---|---|---|---|
| `scripts/spike-gpt-sovits.py` | GPT-SoVITS v2（api_v2） | 0.60 | 0.61 | **1.000** |
| `scripts/spike-qwen-tts.py` | Qwen3-TTS 0.6B Base | 3.45 | 3.53 | 0.999 |

### 1 文目の長さと合成時間（初声の決まり方）

初声 = **「LLM が最初の文（または読点）を出すまで」＋「その文の合成時間」**。GPT-SoVITS の実測:

| 文字数 | 合成時間（p50） | 例 |
|---|---|---|
| 11 字 | 0.75〜1.31 秒 | 「今日はいい天気ですね。」 |
| 14 字 | 0.89 秒（読点止め） | 「今日はとてもいい天気なので、」 |
| 25 字 | 1.37 秒 | |
| 45 字 | 3.36 秒 | |

- 切片（固定オーバーヘッド）は約 0.2 秒、傾きは約 0.07 秒/字
- そのため **`tts.max_sentence_chars = 24`（既定）** にすると、文末が 24 文字を超える場合は
  `SentenceSplitter` が**手前の読点で切る**（14 字前後で確定 → 合成 1 秒未満）
- 文末が 24 文字以内なら従来どおり句点で切る（不自然に細切れにしない）。読点が無い長文は文末で切る

### WS 経由の実測（`speak` コマンド・2026-11 / RTX 3060）

`ws://127.0.0.1:3000/ws?role=display` で接続して `speak` を送った結果:

```
hello services: {"llm":true,"tts":true,"stt":true}
tts_audio #1 "こんにちは。今日はとてもいい天気なので、一緒に散歩しませんか。"
  volumes=281 / sliceMs=20 / durationMs=5620 / base64=479632 bytes
初声 2108ms / 文数 1
```

- **`volumes` が 281 個入る = 口パクが動く**（空配列だと口が動かない）
- `speak` コマンドは**分割せず全文を 1 回で合成**する（31 文字 → 2.1 秒）。
  会話（`submit_text`）では `SentenceSplitter` が効くため 1 文目は最大 24 文字になり、初声が短くなる
- `tts_audio` は **primary client（`role=display`）にだけ**送られる。`role` を付けない接続では
  音声が届かない（`services.tts` の確認だけなら不要）

### 日英が混在した文はどうなるか（2026-11 実測）

| 対象 | 結果 |
|---|---|
| **発声（ja モード）** | **音声は出る**が、英語部分は**カタカナ発音**になる。`clean_text` が全文を `text.japanese`（pyopenjtalk）へ渡すため（混在文 31 字で 9.2 秒の音声を 1.6 秒で生成） |
| **発声（en モード）** | 言語ガードが日本語を検出して**再生成**する（`containsDisallowedScript`）。`text_lang=en` では日本語を読めない |
| **発声（`text_lang=auto`）** | 単一言語なら正常（日本語 0.86s / 英語 1.2s）。**混在文では壊れる**（30 秒かけて音声 1 秒分しか出ない） |
| **聞き取り** | **不可**。whisper は 1 言語でデコードするため、混在音声は片方しか取れない |

聞き取りの実測（「今日はいい天気ですね。 / I love TypeScript very much. / 一緒に勉強しましょう。」）:

```
-l auto (ja と判定 p=0.998) → 今日はいい天気ですね。一緒に勉強しましょう。   ← 英語が欠落
-l ja                       → 同上                                       ← 英語が欠落
-l en                       → I love TypeScript very much.               ← 日本語が欠落
```

**運用の指針**:

- 日本語モードで英語の固有名詞（`TypeScript` など）が混ざるのは**実用範囲**（言語ガードも ja は英語を許可する）。
  ただし読みはカタカナ寄りになる
- 英語モードでは英語のみ。日本語を混ぜると再生成される
- 混在した**音声入力**は片方の言語モードに寄せる必要がある（VAD で分割して言語判定を繰り返す実装をしない限り不可）

### 英語モードの人格（`config/characters/sakura.en.toml`）

既定の英語モードは **「日本にいる英語教師」ペルソナ**です（`llm.character_file_en`）。日本語モード
（`sakura.toml`）とは独立していて、言語モードの切替に追従します。

- 短く簡単な語彙（音声で聞き取りやすい）・2〜4 文
- 誤りは**1 回だけ**優しく直す（`A small tip: we say "I went" instead of "I goed."`）
- 励まし ＋ 簡単な質問で会話を続ける・長い文法講義はしない
- **日本語は混ぜない**（言語ガードが CJK を検出して再生成するため）

実機の応答例（`I goed to Kyoto last week.` を送った場合）:

```
That sounds like a wonderful trip! [happy] Did you have a nice time in Kyoto?
A small tip: we say "I went" instead of "I goed." What was your favorite thing you did there?
```

人格を変えるときは TOML の `personality` / `response_rules` / `catchphrases` を書き換え、
`POST /api/config/reload` か再起動で反映します（`catchphrases` は英語モードでは `"..."` で表示されます）。

判定の目安:

| RTF | 意味 | 対応 |
|---|---|---|
| < 0.5 | 先読み 1 文で隠せる | そのまま採用 |
| 0.5〜1.0 | 初声が遅くなりやすい | `tts.prefetch_depth=2`、1 文目を短く分割 |
| > 1.0 | 逐次読み上げに不向き | 別エンジン（Kokoro / Qwen3-TTS など）を検討 |

あわせて確認する項目:

1. `logs/tts-spike/*.wav` を聴いて **ja と en が同じ声に聴こえるか**（B 案の受け入れ条件）
2. `/api/diagnostics` と `logs/app.log` に TTS の失敗が出ていないか
3. VRAM 合計が 12GB に収まるか（Ollama + whisper + TTS + RVC）。厳しければ `stt.engine` を sherpa(CPU) へ

---

## 4. 受け入れ条件（B 案）

2026-11 の実測で確認できたものに [x] を付けた。アプリを起動して人が確かめる項目は未チェック。

- [x] **ja / en が同じ声**（ja↔en の MFCC 類似度 1.000・F0 も近い。§3）
- [x] **RTF < 0.5**（ja 0.45 / en 0.49。先読み 1 文で隠せる）
- [x] **初声の土台**（`max_sentence_chars = 24` で 1 文目が最大 24 文字 → 合成 1.3 秒前後。§3 の実測表）
- [x] **口パクの前提**（`TtsRouter` が GPT-SoVITS の WAV を 16bit PCM モノラルへ正規化することを
      `tests/tts-adapters.test.ts` で担保。`volumes` が空にならない）
- [x] **アプリからの疎通**（`GET /api/health` の `services.tts = true`、`tts.ja.engine = gpt_sovits`）
- [x] ヘッダの `日本語 / English` で切替でき、**次の発話から** STT・プロンプト・TTS が追従する
      （`tests/app-server.test.ts`: PATCH → `language` 通知 + `character.reload()` 後の名前が配られる）
- [x] en モードで英語の質問 → 英語の応答 → **英語の音声**（`tts.en` のエンジン）で再生される
      （実機: 英語の 2 ターンを `submit_audio` で検証し `tts_audio` が返ることを確認）
- [x] en モードで日本語・韓国語が混ざった応答は 1 回だけ再生成される（`speech_reset`）
      （`tests/turn-runner-streaming.test.ts`: ja はハングル、en は CJK の検出を検証）
- [ ] 実画面での口パク（`tts_audio.volumes` を受けて Live2D / 立ち絵が動く）— 人が目視で確認する
- [ ] 実アプリでの初声（LLM が最初の読点を出すまでの時間 + 合成 1.3 秒）— マイク入力での体感確認が必要
- [x] `npm run verify` が緑（240 tests / 0 fail）

---

## 5. RVC（声質変換・実装済み）

B 案で声質が足りない場合に、`[tts.voice_conversion]` で RVC を挟めます。**既定は有効**で、
モデル未設定・ワーカー未起動なら自動でスキップします。

- 実装: `VoiceConversionService` + 常駐ワーカー `scripts/rvc_worker.py`（FastAPI。起動は
  `scripts\start-rvc-worker.bat`）。`TtsRouter.synthesize()` が**正規化の後**（文単位）に挟む
- 変換条件（`index_rate` / `pitch` / `f0_method` / `protect` / `model_path` / `index_path`）は
  **すべて設定から渡す**（ワーカーに既定値を埋めない）。範囲は `sanitize.ts` の
  `clampVoiceConversion()` が守る（`index_rate` 0..1 / `protect` 0..0.5 / `pitch` -24..24）
- API: `POST /convert` `{ wav_base64, index_rate, pitch, f0_method, protect, model, index }`
  → `{ wav_base64 }` / `GET /health` の `warm` でウォームアップ済みを判定 / `POST /model` で切替
- 出力は **40kHz**（RVC ネイティブ）。`normalizeWav` で 16kHz/16bit/mono に戻す
- 失敗時は**元の WAV を返す**（無音にしない）
- 実測（RTX 3060 / `imadaMio` / 1 秒音声・ウォームアップ済み）: `index_rate=0` で **234–257ms**、
  `0.75` で **535ms**（初回のみ index のロードで +650ms）。既定は **0**
- 詳細は [RVC_PLAN.md](RVC_PLAN.md)

---

## 6. 参照（一次情報）

- Qwen3-TTS: https://github.com/QwenLM/Qwen3-TTS / https://huggingface.co/Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice
- CosyVoice3: https://huggingface.co/FunAudioLLM/Fun-CosyVoice3-0.5B-2512
- GPT-SoVITS（api_v2 の `streaming_mode`）: https://github.com/RVC-Boss/GPT-SoVITS/blob/main/api_v2.py
- Kokoro-82M: https://huggingface.co/hexgrad/Kokoro-82M / Kokoro-FastAPI: https://github.com/remsky/Kokoro-FastAPI
- VOICEVOX 利用規約: https://voicevox.hiroshiba.jp/term/ / 音源利用ガイドライン: https://zunko.jp/con_ongen_kiyaku.html
