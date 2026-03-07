import { appendFileSync, mkdirSync } from "fs";
import { dirname } from "path";

export class Logger {
  private prefix: string;
  private eventsFile: string | null;

  constructor(prefix: string, eventsFile?: string) {
    this.prefix = prefix;
    this.eventsFile = eventsFile ?? null;
    if (this.eventsFile) {
      mkdirSync(dirname(this.eventsFile), { recursive: true });
    }
  }

  info(msg: string, data?: Record<string, unknown>) {
    const line = `[${new Date().toISOString()}] [INFO] [${this.prefix}] ${msg}`;
    console.log(data ? `${line} ${JSON.stringify(data)}` : line);
  }

  warn(msg: string, data?: Record<string, unknown>) {
    const line = `[${new Date().toISOString()}] [WARN] [${this.prefix}] ${msg}`;
    console.log(data ? `${line} ${JSON.stringify(data)}` : line);
  }

  error(msg: string, data?: Record<string, unknown>) {
    const line = `[${new Date().toISOString()}] [ERROR] [${this.prefix}] ${msg}`;
    console.error(data ? `${line} ${JSON.stringify(data)}` : line);
  }

  debug(msg: string, data?: Record<string, unknown>) {
    const line = `[${new Date().toISOString()}] [DEBUG] [${this.prefix}] ${msg}`;
    console.log(data ? `${line} ${JSON.stringify(data)}` : line);
  }

  event(category: string, data: Record<string, unknown>) {
    if (!this.eventsFile) return;
    const entry = { ts: Date.now(), category, ...data };
    try {
      appendFileSync(this.eventsFile, JSON.stringify(entry) + "\n");
    } catch (err) {
      this.error(`Failed to write event: ${err}`);
    }
  }
}
