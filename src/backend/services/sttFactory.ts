import { ConfigManager } from "../config/ConfigManager";
import { Logger } from "../core/logger";
import { SpeechToText } from "../core/ports";
import { SherpaSttService } from "./SherpaSttService";
import { WhisperSttService } from "./WhisperSttService";

/**
 * 設定 `stt.engine` に応じた STT 実装を返す（Composition Root 用のファクトリ）。
 *
 * - `whisper`: whisper.cpp を子プロセスで呼ぶ（既定）
 * - `sherpa`:  sherpa-onnx（ONNX Runtime / 非自己回帰モデル）をプロセス内で実行
 */
export function createSttService(deps: { config: ConfigManager; logger?: Logger }): SpeechToText {
  const engine = deps.config.getSTT().engine;
  if (engine === "sherpa") {
    return new SherpaSttService(deps);
  }
  return new WhisperSttService(deps);
}
