import * as http from "http";
import { ConfigManager } from "../config/ConfigManager";
import { describeTransportError } from "../core/errors";
import { Logger } from "../core/logger";
import { LlmMessage } from "../core/messages";
import { ChatOptions, LanguageModel } from "../core/ports";

interface OllamaChatChunk {
  message?: { content?: string };
  done?: boolean;
  error?: string;
}

/**
 * Ollama の /api/chat を利用する LLM 実装。
 *
 * ストリーミングは NDJSON なので、チャンク境界をまたぐ行を取りこぼさないよう
 * 受信バッファに残りを保持してから 1 行ずつ解析する（旧実装のバグを修正）。
 */
export class OllamaLlmService implements LanguageModel {
  private readonly logger: Logger;

  constructor(private readonly deps: { config: ConfigManager; logger?: Logger }) {
    this.logger = deps.logger ?? new Logger("LLM");
  }

  private endpoint(): URL {
    return new URL(this.deps.config.getLLM().endpoint.replace(/\/$/, ""));
  }

  private requestOptions(
    method: "GET" | "POST",
    pathAndQuery: string,
    body?: string,
    timeoutMs?: number
  ): http.RequestOptions {
    const url = this.endpoint();
    return {
      hostname: url.hostname,
      port: url.port || 80,
      path: pathAndQuery,
      method,
      headers: body
        ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
        : {},
      timeout: timeoutMs ?? this.deps.config.getLLM().response_timeout_seconds * 1000,
    };
  }

  private getJson(pathAndQuery: string, timeoutMs: number): Promise<any> {
    return new Promise((resolve, reject) => {
      const options = this.requestOptions("GET", pathAndQuery);
      options.timeout = timeoutMs;
      const req = http.request(options, (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          raw += chunk;
        });
        res.on("end", () => {
          if (res.statusCode !== undefined && res.statusCode >= 400) {
            reject(new Error(`Ollama が ${res.statusCode} を返しました: ${raw.slice(0, 200)}`));
            return;
          }
          try {
            resolve(JSON.parse(raw));
          } catch {
            reject(new Error(`Ollama の応答を解析できません: ${raw.slice(0, 200)}`));
          }
        });
      });
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy(new Error("Ollama への接続がタイムアウトしました"));
      });
      req.end();
    });
  }

  /** ボディ付きの JSON リクエスト（`/api/generate` のモデル読み込みに使う） */
  private postJson(pathAndQuery: string, body: string, timeoutMs: number): Promise<any> {
    return new Promise((resolve, reject) => {
      const req = http.request(this.requestOptions("POST", pathAndQuery, body, timeoutMs), (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          raw += chunk;
        });
        res.on("end", () => {
          if (res.statusCode !== undefined && res.statusCode >= 400) {
            reject(new Error(`Ollama が ${res.statusCode} を返しました: ${raw.slice(0, 200)}`));
            return;
          }
          try {
            resolve(raw ? JSON.parse(raw) : {});
          } catch {
            reject(new Error(`Ollama の応答を解析できません: ${raw.slice(0, 200)}`));
          }
        });
      });
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy(new Error("Ollama への接続がタイムアウトしました"));
      });
      req.write(body);
      req.end();
    });
  }

  /**
   * 4xx/5xx の応答本文から、原因と対処が分かるエラーを組み立てる。
   *
   * 404 はほぼ「モデル未取得」で、Ollama は `{"error":"model 'xxx' not found"}` を返す。
   * そのまま流すと原因が分かりにくいため、`ollama pull` を促す文言を添える。
   */
  private describeHttpError(statusCode: number | undefined, raw: string, model: string): Error {
    const body = raw.slice(0, 300);
    if (statusCode === 404 && /not found/i.test(raw)) {
      return new Error(
        `Ollama にモデル '${model}' がありません（404）。\`ollama pull ${model}\` を実行するか、` +
          `config/settings.toml の llm.model を導入済みのモデルに変更してください: ${body}`
      );
    }
    return new Error(`Ollama が ${statusCode} を返しました: ${body}`);
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.getJson("/api/tags", 5000);
      return true;
    } catch {
      return false;
    }
  }

  async listModels(): Promise<string[]> {
    const response = await this.getJson("/api/tags", 5000);
    const models = Array.isArray(response?.models) ? response.models : [];
    return models.map((model: { name?: string }) => model.name ?? "").filter(Boolean);
  }

  async hasModel(model?: string): Promise<boolean> {
    const target = model ?? this.deps.config.getLLM().model;
    const models = await this.listModels();
    return models.some((name) => name === target || name.startsWith(`${target}:`) || name.startsWith(target));
  }

  /**
   * モデルを事前に読み込む（切替直後の初回発話がタイムアウトしないように）。
   *
   * Ollama の `/api/generate` に空プロンプトを投げると、生成はせず読み込みだけで
   * `done_reason: "load"` が返る。この処理を切り替え時に済ませておくと、
   * 最初の発話からすぐ応答が始まる。戻り値は所要ミリ秒。
   */
  async prepare(model?: string): Promise<number> {
    const cfg = this.deps.config.getLLM();
    const target = model ?? cfg.model;
    const started = Date.now();
    const body = JSON.stringify({
      model: target,
      prompt: "",
      stream: false,
      keep_alive: "10m",
    });
    await this.postJson("/api/generate", body, cfg.model_load_timeout_seconds * 1000);
    const elapsedMs = Date.now() - started;
    this.logger.info(`モデルを事前読み込みしました: ${target} (${elapsedMs}ms)`);
    return elapsedMs;
  }

  chatStream(
    messages: LlmMessage[],
    onDelta: (chunk: string) => void,
    options: ChatOptions = {}
  ): Promise<string> {
    const cfg = this.deps.config.getLLM();
    const start = Date.now();
    const payload: Record<string, unknown> = {
      model: cfg.model,
      messages,
      stream: true,
      think: false,
      options: {
        temperature: options.temperature ?? cfg.temperature,
        num_predict: cfg.max_tokens,
      },
    };
    if (options.tools && options.tools.length > 0) {
      payload.tools = options.tools;
    }

    const body = JSON.stringify(payload);

    const responseTimeoutMs = cfg.response_timeout_seconds * 1000;
    const loadTimeoutMs = Math.max(responseTimeoutMs, cfg.model_load_timeout_seconds * 1000);
    /** モデル読み込み中は何も届かないため、最初のチャンクまでは長めに待つ */
    const loadTimeoutMessage =
      `LLM がタイムアウトしました（${Math.round(loadTimeoutMs / 1000)} 秒）。` +
      `モデルの読み込みに時間がかかっている可能性があります（VRAM 不足・ディスク速度）。` +
      `より小さいモデルを選ぶか、llm.model_load_timeout_seconds を増やしてください`;

    return new Promise<string>((resolve, reject) => {
      let settled = false;
      let content = "";
      let remainder = "";
      let timer: NodeJS.Timeout | null = null;
      let request: http.ClientRequest | null = null;
      /** まだ 1 文字も受信していない（＝モデルの読み込み中かもしれない） */
      let waitingForFirstChunk = true;

      const clearTimer = (): void => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      };

      const fail = (error: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimer();
        reject(error);
      };

      const succeed = (text: string): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimer();
        this.logger.info(`応答完了 (${Date.now() - start}ms, ${text.length} 文字)`);
        resolve(text);
      };

      const armTimer = (ms: number, message: string): void => {
        clearTimer();
        timer = setTimeout(() => {
          fail(new Error(message));
          request?.destroy();
        }, ms);
      };

      /** 最初のデータが届いたら「応答中」のタイムアウトへ切り替える */
      const onFirstChunk = (): void => {
        if (!waitingForFirstChunk) {
          return;
        }
        waitingForFirstChunk = false;
        request?.setTimeout(responseTimeoutMs);
        armTimer(responseTimeoutMs, `LLM の応答が止まりました（${cfg.response_timeout_seconds} 秒）`);
        this.logger.info(`最初のチャンクを受信しました (${Date.now() - start}ms)`);
      };

      const handleLine = (line: string): void => {
        const trimmed = line.trim();
        if (!trimmed) {
          return;
        }
        let chunk: OllamaChatChunk;
        try {
          chunk = JSON.parse(trimmed) as OllamaChatChunk;
        } catch {
          this.logger.warn(`解析できないストリーム行をスキップしました: ${trimmed.slice(0, 120)}`);
          return;
        }
        if (chunk.error) {
          fail(new Error(`Ollama エラー: ${chunk.error}`));
          return;
        }
        const delta = chunk.message?.content;
        if (delta) {
          content += delta;
          onDelta(delta);
        }
        if (chunk.done) {
          succeed(content);
        }
      };

      const requestOptions = this.requestOptions("POST", "/api/chat", body, loadTimeoutMs);
      if (options.signal) {
        requestOptions.signal = options.signal;
      }

      request = http.request(requestOptions, (res) => {
        if (res.statusCode !== 200) {
          let raw = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            raw += chunk;
          });
          res.on("end", () => {
            fail(this.describeHttpError(res.statusCode, raw, cfg.model));
          });
          return;
        }

        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          onFirstChunk();
          remainder += chunk;
          let index = remainder.indexOf("\n");
          while (index >= 0) {
            const line = remainder.slice(0, index);
            remainder = remainder.slice(index + 1);
            handleLine(line);
            index = remainder.indexOf("\n");
          }
        });
        res.on("end", () => {
          if (remainder.trim()) {
            handleLine(remainder);
            remainder = "";
          }
          if (!settled) {
            if (content) {
              succeed(content);
            } else {
              fail(new Error(waitingForFirstChunk ? loadTimeoutMessage : "Ollama から応答がありませんでした"));
            }
          }
        });
        res.on("error", (error) => fail(error));
      });

      armTimer(loadTimeoutMs, loadTimeoutMessage);

      request.on("error", (error) =>
        fail(
          describeTransportError(
            error,
            "Ollama",
            "モデルの読み込み失敗・VRAM 不足・ollama の再起動などが考えられます"
          )
        )
      );
      request.on("timeout", () => {
        fail(
          new Error(
            waitingForFirstChunk
              ? loadTimeoutMessage
              : `LLM がタイムアウトしました（${cfg.response_timeout_seconds} 秒）`
          )
        );
        request?.destroy();
      });
      request.write(body);
      request.end();
    });
  }
}
