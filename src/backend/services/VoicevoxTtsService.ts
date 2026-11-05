import * as http from "http";
import { ConfigManager } from "../config/ConfigManager";
import { Logger } from "../core/logger";
import { TextToSpeech, TtsOptions, TtsSpeaker } from "../core/ports";

interface HttpResult {
  statusCode: number;
  body: Buffer;
}

/**
 * VOICEVOX ENGINE の HTTP API を使う TTS 実装。
 *
 * 旧実装はバイナリ応答を UTF-8 文字列へ変換してから Buffer 化していたため
 * 音声が破損していた。ここでは応答を常に Buffer のまま扱う。
 */
export class VoicevoxTtsService implements TextToSpeech {
  private readonly logger: Logger;

  constructor(private readonly deps: { config: ConfigManager; logger?: Logger }) {
    this.logger = deps.logger ? deps.logger.child("TTS") : new Logger("TTS");
  }

  private request(
    method: "GET" | "POST",
    pathAndQuery: string,
    body?: Buffer,
    signal?: AbortSignal
  ): Promise<HttpResult> {
    const cfg = this.deps.config.getTTS();
    return new Promise((resolve, reject) => {
      const url = new URL(cfg.endpoint.replace(/\/$/, ""));
      const options: http.RequestOptions = {
        hostname: url.hostname,
        port: url.port || 80,
        path: pathAndQuery,
        method,
        headers: body
          ? { "Content-Type": "application/json", "Content-Length": body.length }
          : {},
        timeout: cfg.timeout_seconds * 1000,
      };
      if (signal) {
        options.signal = signal;
      }

      const req = http.request(options, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks) });
        });
      });

      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy(new Error(`VOICEVOX がタイムアウトしました（${cfg.timeout_seconds} 秒）`));
      });
      if (body) {
        req.write(body);
      }
      req.end();
    });
  }

  async isAvailable(): Promise<boolean> {
    try {
      const response = await this.request("GET", "/version");
      return response.statusCode === 200;
    } catch {
      return false;
    }
  }

  async listSpeakers(): Promise<TtsSpeaker[]> {
    const response = await this.request("GET", "/speakers");
    if (response.statusCode !== 200) {
      throw new Error(`話者一覧の取得に失敗しました (status=${response.statusCode})`);
    }
    const speakers = JSON.parse(response.body.toString("utf-8")) as TtsSpeaker[];
    return Array.isArray(speakers) ? speakers : [];
  }

  async synthesize(text: string, options: TtsOptions = {}): Promise<Buffer> {
    const cfg = this.deps.config.getTTS();
    const trimmed = text.trim();
    if (!trimmed) {
      throw new Error("音声合成するテキストが空です");
    }
    const speaker = String(options.speakerId ?? cfg.speaker_id);

    const queryResponse = await this.request(
      "POST",
      `/audio_query?${new URLSearchParams({ text: trimmed, speaker }).toString()}`,
      undefined,
      options.signal
    );
    if (queryResponse.statusCode !== 200) {
      throw new Error(
        `audio_query に失敗しました (status=${queryResponse.statusCode}): ${queryResponse.body
          .toString("utf-8")
          .slice(0, 200)}`
      );
    }

    const audioQuery = JSON.parse(queryResponse.body.toString("utf-8")) as Record<string, unknown>;
    audioQuery.speedScale = cfg.speed;
    audioQuery.pitchScale = cfg.pitch;
    audioQuery.volumeScale = cfg.volume;

    const body = Buffer.from(JSON.stringify(audioQuery), "utf-8");
    const synthesisResponse = await this.request(
      "POST",
      `/synthesis?${new URLSearchParams({ speaker }).toString()}`,
      body,
      options.signal
    );
    if (synthesisResponse.statusCode !== 200) {
      throw new Error(
        `synthesis に失敗しました (status=${synthesisResponse.statusCode}): ${synthesisResponse.body
          .toString("utf-8")
          .slice(0, 200)}`
      );
    }

    this.logger.info(`音声合成完了 (${trimmed.length} 文字, ${synthesisResponse.body.length} bytes)`);
    return synthesisResponse.body;
  }
}
