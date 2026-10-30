// Minimal native Redis client: enough RESP to run a few commands per call.
// Stats talk to Redis about once a minute, so each call opens a short-lived
// connection — no pooling or reconnect logic to get wrong.
// Accepts redis://[[user]:password@]host[:port][/db] and rediss:// for TLS.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface RedisTarget {
  hostname: string;
  port: number;
  tls: boolean;
  username?: string;
  password?: string;
  db?: number;
}

export function parseRedisUrl(raw: string): RedisTarget {
  const url = new URL(raw);
  if (url.protocol !== "redis:" && url.protocol !== "rediss:") {
    throw new Error(`Unsupported Redis URL scheme: ${url.protocol}`);
  }
  const db = url.pathname.replace(/^\//, "");
  return {
    hostname: url.hostname,
    port: Number(url.port || 6379),
    tls: url.protocol === "rediss:",
    username: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    db: db ? Number(db) : undefined,
  };
}

export function encodeCommand(args: (string | number)[]): Uint8Array {
  const parts = [`*${args.length}\r\n`];
  for (const a of args) {
    const s = String(a);
    parts.push(`$${encoder.encode(s).length}\r\n${s}\r\n`);
  }
  return encoder.encode(parts.join(""));
}

export class RedisError extends Error {}

// Incremental RESP2 parser over a byte stream.
export class ReplyReader {
  #buf = new Uint8Array(0);
  #next: () => Promise<Uint8Array | null>;

  constructor(next: () => Promise<Uint8Array | null>) {
    this.#next = next;
  }

  async #fill(): Promise<void> {
    const chunk = await this.#next();
    if (!chunk) throw new Error("Redis connection closed");
    const merged = new Uint8Array(this.#buf.length + chunk.length);
    merged.set(this.#buf);
    merged.set(chunk, this.#buf.length);
    this.#buf = merged;
  }

  async #line(): Promise<string> {
    while (true) {
      const i = this.#buf.findIndex((b, j) => b === 13 && this.#buf[j + 1] === 10);
      if (i >= 0) {
        const line = decoder.decode(this.#buf.subarray(0, i));
        this.#buf = this.#buf.subarray(i + 2);
        return line;
      }
      await this.#fill();
    }
  }

  async #bytes(n: number): Promise<string> {
    while (this.#buf.length < n + 2) await this.#fill();
    const s = decoder.decode(this.#buf.subarray(0, n));
    this.#buf = this.#buf.subarray(n + 2);
    return s;
  }

  // Error replies are returned (not thrown) so a pipeline stays in sync.
  async read(): Promise<unknown> {
    const line = await this.#line();
    const body = line.slice(1);
    switch (line[0]) {
      case "+":
        return body;
      case "-":
        return new RedisError(body);
      case ":":
        return Number(body);
      case "$": {
        const n = Number(body);
        return n < 0 ? null : await this.#bytes(n);
      }
      case "*": {
        const n = Number(body);
        if (n < 0) return null;
        const out = [];
        for (let i = 0; i < n; i++) out.push(await this.read());
        return out;
      }
      default:
        throw new Error(`Bad Redis reply: ${line}`);
    }
  }
}

// Runs one command (after AUTH/SELECT, pipelined) and returns its reply.
export async function redisCommand(
  target: RedisTarget,
  command: (string | number)[],
  timeoutMs = 5000,
): Promise<unknown> {
  const conn = target.tls
    ? await Deno.connectTls({ hostname: target.hostname, port: target.port })
    : await Deno.connect({ hostname: target.hostname, port: target.port });
  const timer = setTimeout(() => conn.close(), timeoutMs);
  try {
    const pipeline: (string | number)[][] = [];
    if (target.password) {
      pipeline.push(
        target.username
          ? ["AUTH", target.username, target.password]
          : ["AUTH", target.password],
      );
    }
    if (target.db) pipeline.push(["SELECT", target.db]);
    pipeline.push(command);
    for (const c of pipeline) await conn.write(encodeCommand(c));
    const reader = new ReplyReader(async () => {
      const buf = new Uint8Array(16 * 1024);
      const n = await conn.read(buf);
      return n === null ? null : buf.subarray(0, n);
    });
    let reply: unknown;
    for (let i = 0; i < pipeline.length; i++) {
      reply = await reader.read();
      if (reply instanceof RedisError) throw reply;
    }
    return reply;
  } finally {
    clearTimeout(timer);
    try {
      conn.close();
    } catch {
      // Already closed by the timeout.
    }
  }
}
