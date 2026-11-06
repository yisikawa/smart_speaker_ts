import type { SkipStats } from "../../shared/protocol";
import {
  isEchoOfReply,
  isHallucination,
  isTooShortFragment,
  normalizeTranscript,
} from "../services/transcriptFilter";

/** 破棄理由（`turn_skipped.reason` としてクライアントへ渡す） */
export type SkipReason = "hallucination" | "short" | "echo" | "repeat";

export type GateDecision =
  | { kind: "accept" }
  /** 会話に載せない（`message` はログ用） */
  | { kind: "skip"; reason: SkipReason; message: string };

/** 直前と同じ認識結果を何回まで許容するか（3 回目以降は幻聴・エコーとみなす） */
const REPEAT_LIMIT = 3;
/** エコー判定に使う直近の応答数 */
const RETAINED_REPLIES = 3;

/**
 * 認識結果を会話に載せてよいかの判定（幻聴・短断片・エコー・繰り返し）。
 *
 * 判定を 1 箇所に集約することで、
 * - 「破棄したのに通知しない」経路を作らない（呼び出し側は skip を必ずイベント化する）
 * - エンジンやフローの追加時に判定の適用漏れが起きない
 */
export class SpeechGate {
  /** 直前に受け付けた認識結果（正規化済み） */
  private lastAccepted = "";
  /** 同じ結果が連続した回数 */
  private repeatCount = 0;
  /** 直近に読み上げた応答（新しい順） */
  private readonly recentReplies: string[] = [];
  /** 破棄理由ごとの回数（診断用） */
  private readonly skipCounts: SkipStats = { hallucination: 0, short: 0, echo: 0, repeat: 0 };
  /** 直近に破棄した内容 */
  private lastSkipped: { reason: SkipReason; text: string; at: number } | null = null;

  /** 破棄の内訳（`/api/diagnostics` とログで同じ数字を使う） */
  get stats(): SkipStats {
    return { ...this.skipCounts };
  }

  get lastSkip(): { reason: SkipReason; text: string; at: number } | null {
    return this.lastSkipped;
  }

  /** 読み上げた応答を記憶する（自分の声のエコー判定に使う） */
  rememberReply(reply: string): void {
    if (!reply) {
      return;
    }
    this.recentReplies.unshift(reply);
    if (this.recentReplies.length > RETAINED_REPLIES) {
      this.recentReplies.pop();
    }
  }

  /** 応答が成立したので「同じ発話の連続」カウントをリセットする */
  resetRepeat(): void {
    this.lastAccepted = "";
    this.repeatCount = 0;
  }

  /** 判定する（`skip` のときはログ用のメッセージも返す）。破棄は回数と直近内容を記録する */
  evaluate(text: string): GateDecision {
    const decision = this.judge(text);
    if (decision.kind === "skip") {
      this.skipCounts[decision.reason] += 1;
      this.lastSkipped = { reason: decision.reason, text, at: Date.now() };
    }
    return decision;
  }

  /** 実際の判定（破棄理由を返す） */
  private judge(text: string): GateDecision {
    // 定型句の幻聴（STT 実装に依存しない二重の保険）
    if (isHallucination(text)) {
      return { kind: "skip", reason: "hallucination", message: `幻聴と判定したため破棄します: ${text}` };
    }
    // 意味のない短い断片（環境音・自分の声の拾い）
    if (isTooShortFragment(text)) {
      return { kind: "skip", reason: "short", message: `短すぎる認識結果のため破棄します: ${text}` };
    }
    // 自分の声（スピーカー出力）を拾った場合
    if (isEchoOfReply(text, this.recentReplies)) {
      return { kind: "skip", reason: "echo", message: `自分の発話のエコーと判定したため破棄します: ${text}` };
    }
    // 同じ認識結果が続く場合は幻聴・エコーの可能性が高い（2 回目までは正当な繰り返しとして許容）
    const normalized = normalizeTranscript(text);
    if (normalized === this.lastAccepted) {
      this.repeatCount += 1;
      if (this.repeatCount >= REPEAT_LIMIT) {
        return {
          kind: "skip",
          reason: "repeat",
          message: `同じ認識結果が ${this.repeatCount} 回続いたため破棄します: ${text}`,
        };
      }
    } else {
      this.lastAccepted = normalized;
      this.repeatCount = 1;
    }
    return { kind: "accept" };
  }
}
