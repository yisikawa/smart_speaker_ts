# アバターの感情連動モーション設計

- 日付: 2026-11-28
- 状態: 承認済み（実装前）
- 対象: hiyori（`Live2DModels/hiyori_vts/`）とアバター描画

## 1. 背景

hiyori モデルは腕を **PartArmA / PartArmB の 2 セット**持ち、モーションの PartOpacity で
片方を透明にして切り替える。現状は次の理由で 4 本腕になる。

- `hiyori.model3.json` に `Motions` セクションが無い
- アプリはモーションを一度も再生しない（`playMotion` の呼び出しが無い）
- そのため両パーツが既定の不透明度（表示）のままになる

同梱モーションの調査結果:

- `hiyori_m02`（VTube Studio の IdleAnimation、6.5 秒）は **PartArmA = 1 / PartArmB = 0**
- A が残るモーション: m01, m02, m03, m04, m05, m07, m09, m10
- B が残るモーション: m06, m08（今回は使わない）
- このライブラリ（pixi-live2d-display 0.4.0）では `Meta.Loop` は実質無視され、
  モーションは 1 回再生される。終了後はモーションマネージャが Idle を自動で再開する

## 2. ゴール

- hiyori の 4 本腕を解消する
- A が残る 8 本すべてをモデルへ登録する
- LLM の感情タグ（happy / angry / sad / surprised / shy / thinking）に応じて
  対応するモーションを 1 回再生する
- 感情とモーションの対応は `settings.toml` の `[avatar.motions]` で変更できる

## 3. 非ゴール

- 一定間隔のランダム再生、手動メニュー、起動時の挨拶モーション
- B が残る m06 / m08 の登録
- モーションのループ制御（ライブラリの 1 回再生 + Idle 復帰に任せる）
- 新しいモーションの作成・外部からの取得

## 4. モデル側の変更（ローカル・gitignore 対象）

`Live2DModels/hiyori_vts/hiyori.model3.json` の `FileReferences` に追加する。

```json
"Motions": {
  "Idle": [{ "File": "animations/hiyori_m02.motion3.json" }],
  "M01":  [{ "File": "animations/hiyori_m01.motion3.json" }],
  "M03":  [{ "File": "animations/hiyori_m03.motion3.json" }],
  "M04":  [{ "File": "animations/hiyori_m04.motion3.json" }],
  "M05":  [{ "File": "animations/hiyori_m05.motion3.json" }],
  "M07":  [{ "File": "animations/hiyori_m07.motion3.json" }],
  "M09":  [{ "File": "animations/hiyori_m09.motion3.json" }],
  "M10":  [{ "File": "animations/hiyori_m10.motion3.json" }]
}
```

- グループ名は感情に依存しない `Mxx` とし、感情との対応は設定側で持つ
- `Idle` は pixi-live2d-display が自動再生する（既定の idle グループ名が `Idle`）
- `M10` は未使用枠（後から設定で割り当て可能）

## 5. データフロー（感情キーの伝搬）

```
LLM 応答
  → extractEmotion()            { text, expression, emotion }
  → TurnRunner                  emotion を SpeechQueue へ
  → SpeechQueue                 Item / PlaybackMeta に emotion
  → WsPlaybackSink              tts_audio.emotion
  → app.ts                      hello.avatar.motions[emotion] → グループ名
  → StageView.playMotion(group) → model.motion(group)
```

- `expression` は従来どおりモデルの表情名（hiyori は設定が空なので null）
- 感情キーは **モデルの表情名とは独立**に送る（hiyori のように表情を持たないモデルでも動かすため）
- 全文一括（`tts.split_sentences = false`）も `extractEmotion()` を通し、
  感情タグを除去したテキストを TTS に渡す（現状はタグが読まれる潜在バグの修正を兼ねる）

## 6. サーバー側の変更

| ファイル | 変更 |
|---|---|
| `src/shared/avatar/emotion.ts` | `EmotionExtraction` に `emotion: EmotionKey \| null` を追加 |
| `src/backend/conversation/TurnRunner.ts` | streaming / whole-text の両方で emotion を渡す。whole-text はタグ除去 |
| `src/backend/conversation/SpeechQueue.ts` | `Item.emotion` / `meta()` に emotion |
| `src/backend/core/ports.ts` | `PlaybackMeta.emotion?: EmotionKey` |
| `src/shared/protocol.ts` | `tts_audio.emotion?: EmotionKey` |
| `src/backend/server/WsPlaybackSink.ts` | `tts_audio` に emotion を含める |

`ConversationPipeline.speak()`（直接読み上げ）は感情を持たないため対象外。

## 7. クライアント側の変更

- 新規 `src/shared/avatar/motionSelection.ts`
  ```ts
  selectMotionGroup(
    motions: Record<string, string>,
    emotion: EmotionKey | null | undefined,
    current: string | null
  ): string | null
  ```
  - 未設定・空文字・現在と同じグループなら `null`
- `src/frontend/app.ts`
  - `applyHello` で `hello.avatar.motions` を保持
  - `currentMotion` を保持し、`llm_started`（ターン開始）でリセット
  - `tts_audio` で `selectMotionGroup()` を呼び、返ったグループを
    `this.stage.playMotion(group)` で再生（同じグループの連続再生だけを抑制し、
    文の途中で感情が変わった場合は新しいグループを再生する）
  - `currentMotion` のリセットは再生判定用で、前ターンのモーションは自然終了に任せる
- 描画側（`Live2DRenderer` / `AvatarStage`）の API 変更は不要

## 8. 設定

`src/backend/config/schema.ts` の既定値と `config/settings.default.toml`:

```toml
[avatar.motions]
happy = "M05"
angry = "M03"
sad = "M04"
surprised = "M01"
shy = "M07"
thinking = "M09"
```

- ローカルの `config/settings.toml` も同じ内容へ更新する
- 未使用の `greeting` / `nod` は感情キーに置き換える
- `M10` は未使用のまま残す

## 9. テスト

- `tests/emotion.test.ts`: `extractEmotion()` が感情キーを返す（既存の deepEqual を更新）
- `tests/motion-selection.test.ts`: マッピング・空設定・同一グループ抑制
- `tests/speech-queue.test.ts`: `PlaybackMeta.emotion` の伝搬
- `tests/ws-playback-sink.test.ts`: `tts_audio.emotion` の伝搬
- `tests/turn-runner-*.test.ts`: streaming / whole-text の emotion 伝搬とタグ除去
- `npm run verify` を通す

## 10. ドキュメント

- README のアバター節: hiyori の `Motions.Idle` が必要なこと、感情→モーションの設定方法
- `AGENTS.md` 12-12 / 12-13: 感情キーの伝搬とモーション設定の真実源
- `docs/REDESIGN.md` 13 章: `avatar.motions` の意味を追記

## 11. リスク・注意

- `Live2DModels/` と `config/settings.toml` は gitignore 対象。**モデル側の変更はコミットに含まれない**
  （README に再現用の JSON を記載する）
- Idle モーションの読み込みが終わるまでの一瞬、4 本腕が見える可能性がある
- `Motions` のグループ名と `[avatar.motions]` の値がずれるとモーションが出ない（無害だが気づきにくい）
- モーションの 1 回再生はライブラリ内部挙動に依存する。pixi-live2d-display 更新時は再確認する
