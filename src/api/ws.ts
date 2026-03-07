import WebSocket from "ws";
import { Logger } from "../utils/logger.js";

type EventCallback = (channel: string, data: unknown) => void;

export class SummitWsClient {
  private url: string;
  private logger: Logger;
  private ws: WebSocket | null = null;
  private callbacks: EventCallback[] = [];
  private reconnectMs = 5_000;

  constructor(url: string, logger: Logger) {
    this.url = url;
    this.logger = logger;
  }

  onEvent(cb: EventCallback) {
    this.callbacks.push(cb);
  }

  start() {
    this.connect();
  }

  private connect() {
    this.logger.info(`WS connecting to ${this.url}`);
    this.ws = new WebSocket(this.url);

    this.ws.on("open", () => {
      this.logger.info("WS connected");
      this.ws?.send(JSON.stringify({ type: "subscribe", channel: "summit" }));
    });

    this.ws.on("message", (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString());
        const channel = msg.type || msg.channel || "unknown";
        for (const cb of this.callbacks) {
          cb(channel, msg);
        }
      } catch {
        // ignore non-JSON
      }
    });

    this.ws.on("close", () => {
      this.logger.info("WS closed, reconnecting...");
      setTimeout(() => this.connect(), this.reconnectMs);
    });

    this.ws.on("error", (err) => {
      this.logger.debug("WS error", { error: String(err) });
    });
  }
}
