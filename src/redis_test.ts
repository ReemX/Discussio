import { assertEquals, assertRejects } from "@std/assert";
import { encodeCommand, parseRedisUrl, redisCommand, ReplyReader } from "./redis.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

function readerOf(...chunks: string[]): ReplyReader {
  const queue = chunks.map((c) => enc.encode(c));
  return new ReplyReader(() => Promise.resolve(queue.shift() ?? null));
}

Deno.test("parseRedisUrl reads host, port, auth, db and TLS", () => {
  assertEquals(parseRedisUrl("redis://redis.svc:6380/2"), {
    hostname: "redis.svc",
    port: 6380,
    tls: false,
    username: undefined,
    password: undefined,
    db: 2,
  });
  const auth = parseRedisUrl("rediss://user:p%40ss@host");
  assertEquals([auth.username, auth.password, auth.port, auth.tls], ["user", "p@ss", 6379, true]);
  assertEquals(parseRedisUrl("redis://:secret@host").username, undefined);
});

Deno.test("encodeCommand writes RESP arrays with byte lengths", () => {
  assertEquals(dec.decode(encodeCommand(["SET", "k", "é"])), "*3\r\n$3\r\nSET\r\n$1\r\nk\r\n$2\r\né\r\n");
});

Deno.test("ReplyReader parses every reply type across split chunks", async () => {
  const r = readerOf("+OK\r\n:4", "2\r\n$5\r\nhel", "lo\r\n$-1\r\n*2\r\n$1\r\na\r\n:1\r\n-ERR bad\r\n");
  assertEquals(await r.read(), "OK");
  assertEquals(await r.read(), 42);
  assertEquals(await r.read(), "hello");
  assertEquals(await r.read(), null);
  assertEquals(await r.read(), ["a", 1]);
  assertEquals((await r.read() as Error).message, "ERR bad");
});

// A fake Redis that records what it receives and replies per command name.
async function withFakeRedis(
  replies: Record<string, string>,
  fn: (port: number, seen: string[][]) => Promise<void>,
): Promise<void> {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const seen: string[][] = [];
  const serve = (async () => {
    for await (const conn of listener) {
      const reader = new ReplyReader(async () => {
        const buf = new Uint8Array(4096);
        const n = await conn.read(buf);
        return n === null ? null : buf.subarray(0, n);
      });
      try {
        while (true) {
          const cmd = await reader.read() as string[];
          seen.push(cmd);
          await conn.write(enc.encode(replies[cmd[0]] ?? "-ERR unknown\r\n"));
        }
      } catch {
        // Client closed the connection.
      }
      conn.close();
    }
  })();
  try {
    await fn((listener.addr as Deno.NetAddr).port, seen);
  } finally {
    listener.close();
    await serve.catch(() => {});
  }
}

Deno.test("redisCommand authenticates, selects the db and returns the reply", async () => {
  await withFakeRedis(
    { AUTH: "+OK\r\n", SELECT: "+OK\r\n", EVAL: '$9\r\n{"c":[1]}\r\n' },
    async (port, seen) => {
      const target = parseRedisUrl(`redis://:pw@127.0.0.1:${port}/3`);
      assertEquals(await redisCommand(target, ["EVAL", "return 1", 0]), '{"c":[1]}');
      assertEquals(seen, [["AUTH", "pw"], ["SELECT", "3"], ["EVAL", "return 1", "0"]]);
    },
  );
});

Deno.test("redisCommand surfaces auth errors", async () => {
  await withFakeRedis({ AUTH: "-WRONGPASS invalid password\r\n", EVAL: ":1\r\n" }, async (port) => {
    const target = parseRedisUrl(`redis://:bad@127.0.0.1:${port}`);
    await assertRejects(() => redisCommand(target, ["EVAL", "x", 0]), Error, "WRONGPASS");
  });
});
