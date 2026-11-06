import * as http from "http";
import { ConfigManager } from "../config/ConfigManager";
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
    this.logger = deps.logger ? deps.logger.child("LLM") : new Logger("LLM");
  }

  private endpoint(): URL {
    return new URL(this.deps.config.getLLM().endpoint.replace(/\/$/, ""));
  }

  private requestOptions(method: "GET" | "POST", pathAndQuery: string, body?: string): http.RequestOptions {
    const url = this.endpoint();
    return {
      hostname: url.hostname,
      port: url.port || 80,
      path: pathAndQuery,
      method,
      headers: body
        ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
        : {},
      timeout: this.deps.config.getLLM().response_timeout_seconds * 1000,
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

    return new Promise<string>((resolve, reject) => {
      let settled = false;
      let content = "";
      let remainder = "";
      let timer: NodeJS.Timeout | null = null;

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

      const requestOptions = this.requestOptions("POST", "/api/chat", body);
      if (options.signal) {
        requestOptions.signal = options.signal;
      }

      const req = http.request(requestOptions, (res) => {
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
              fail(new Error("Ollama から応答がありませんでした"));
            }
          }
        });
        res.on("error", (error) => fail(error));
      });

      timer = setTimeout(() => {
        fail(new Error(`LLM がタイムアウトしました（${cfg.response_timeout_seconds} 秒）`));
        req.destroy();
      }, cfg.response_timeout_seconds * 1000);

      req.on("error", (error) => fail(error));
      req.on("timeout", () => {
        fail(new Error(`LLM がタイムアウトしました（${cfg.response_timeout_seconds} 秒）`));
        req.destroy();
      });
      req.write(body);
      req.end();
    });
  }
}
