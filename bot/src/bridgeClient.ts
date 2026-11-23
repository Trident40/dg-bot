import crypto from "crypto";
import http from "http";
import https from "https";

export interface BridgeResponse<T = any> {
  ok: boolean;
  offline?: boolean;
  message?: string;
  error?: string;
  data?: T;
  [key: string]: any;
}

export class ArcaneBridgeClient {
  private readonly baseUrl: URL;
  private readonly secret: string;
  private isOnline = false;
  private sseReq: http.ClientRequest | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(baseUrl: string, secret: string) {
    this.baseUrl = new URL(baseUrl);
    this.secret = secret;
  }

  get online(): boolean {
    return this.isOnline;
  }

  private signHeaders(method: string, reqPath: string, rawBody: string): Record<string, string> {
    const timestamp = String(Date.now());
    const signature = crypto
      .createHmac("sha256", this.secret)
      .update(`${timestamp}.${method.toUpperCase()}.${reqPath}.${rawBody}`)
      .digest("hex");

    return {
      "X-DG-Timestamp": timestamp,
      "X-DG-Signature": signature,
      "Content-Type": "application/json",
    };
  }

  async request<T = any>(method: "GET" | "POST", reqPath: string, body?: unknown): Promise<BridgeResponse<T>> {
    const rawBody = body !== undefined ? JSON.stringify(body) : "";
    const url = new URL(reqPath, this.baseUrl);
    const headers = this.signHeaders(method, url.pathname, rawBody);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(url.toString(), {
        method,
        headers,
        body: method === "POST" ? rawBody : undefined,
        signal: controller.signal,
      });
      this.isOnline = res.ok || res.status < 500;
      const text = await res.text();
      try {
        return JSON.parse(text) as BridgeResponse<T>;
      } catch {
        return {
          ok: res.ok,
          error: res.ok ? undefined : `Bridge returned HTTP ${res.status}`,
        };
      }
    } catch {
      this.isOnline = false;
      return { ok: false, offline: true, error: "ArcaneMP bridge unreachable." };
    } finally {
      clearTimeout(timeout);
    }
  }

  startEventStream(onEvent: (eventName: string, data: any) => void): void {
    this.stopped = false;
    const connect = () => {
      if (this.stopped) return;
      const url = new URL("/events", this.baseUrl);
      const headers = this.signHeaders("GET", url.pathname, "");
      const transport = url.protocol === "https:" ? https : http;

      const req = transport.request(
        {
          hostname: url.hostname,
          port: url.port || (url.protocol === "https:" ? 443 : 80),
          path: url.pathname,
          method: "GET",
          headers,
        },
        (res) => {
          if (res.statusCode !== 200) {
            this.isOnline = false;
            res.resume();
            scheduleReconnect();
            return;
          }
          this.isOnline = true;
          let buffer = "";
          res.setEncoding("utf8");
          res.on("data", (chunk: string) => {
            buffer += chunk.replace(/\r\n/g, "\n");
            const frames = buffer.split("\n\n");
            buffer = frames.pop() || "";
            for (const frame of frames) {
              let eventName = "message";
              let dataLine = "";
              for (const line of frame.split("\n")) {
                if (line.startsWith("event:")) eventName = line.slice(6).trim();
                else if (line.startsWith("data:")) dataLine += line.slice(5).trim();
              }
              if (dataLine) {
                try {
                  onEvent(eventName, JSON.parse(dataLine));
                } catch {}
              }
            }
          });
          res.on("end", () => {
            this.isOnline = false;
            scheduleReconnect();
          });
          res.on("error", () => {
            this.isOnline = false;
            scheduleReconnect();
          });
        }
      );

      req.on("error", () => {
        this.isOnline = false;
        scheduleReconnect();
      });
      req.end();
      this.sseReq = req;
    };

    const scheduleReconnect = () => {
      if (this.stopped || this.reconnectTimer) return;
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        connect();
      }, 5000);
    };

    connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.sseReq?.destroy();
  }
}
