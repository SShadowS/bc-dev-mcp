import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { createHttp10Fetch } from "../../src/core/http10";

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

interface Served {
  url: string;
  port: number;
  requests: string[];
  closed: Promise<void>[];
  open: () => number;
}

/** Raw TCP server; onRequest fires once per connection when the head (and Content-Length body) is in. */
function serve(onRequest: (socket: Socket, request: string) => void): Promise<Served> {
  const requests: string[] = [];
  const closed: Promise<void>[] = [];
  let open = 0;
  return new Promise((resolve) => {
    const server = createServer((socket) => {
      open++;
      closed.push(new Promise((r) => socket.on("close", () => { open--; r(); })));
      let data: Buffer = Buffer.alloc(0);
      let handled = false;
      socket.on("data", (chunk: Buffer) => {
        data = Buffer.concat([data, chunk]);
        const split = data.indexOf("\r\n\r\n");
        if (handled || split < 0) return;
        const length = /^content-length: *(\d+)/im.exec(data.subarray(0, split).toString("latin1"));
        if (length && data.length - split - 4 < Number(length[1])) return;
        handled = true;
        const request = data.toString("utf8");
        requests.push(request);
        onRequest(socket, request);
      });
      socket.on("error", () => {});
    });
    servers.push(server);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({ url: `http://127.0.0.1:${port}/BC/mcp/?tenant=default`, port, requests, closed, open: () => open });
    });
  });
}

const withTimeout = <T>(p: Promise<T>, ms = 2000): Promise<T> =>
  Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms))]);

const fetch10 = createHttp10Fetch();

describe("createHttp10Fetch", () => {
  test("1. POST sends HTTP/1.0 head, UTF-8 Content-Length, caller headers; streams an SSE body until close", async () => {
    const sse = 'event: message\ndata: {"a":1}\n\n';
    const s = await serve((socket) =>
      socket.end(`HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nMcp-Session-Id: s1\r\n\r\n${sse}`),
    );
    const body = JSON.stringify({ name: "æ" });
    const res = await fetch10(s.url, { method: "POST", headers: { Authorization: "Basic dTpw", Accept: "text/event-stream" }, body });
    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBe("s1");
    expect(await res.text()).toBe(sse);
    const req = s.requests[0]!;
    expect(req.startsWith("POST /BC/mcp/?tenant=default HTTP/1.0\r\n")).toBe(true);
    expect(req).toContain(`\r\nHost: 127.0.0.1:${s.port}\r\n`);
    expect(req).toContain("\r\nConnection: close\r\n");
    expect(req).toContain(`\r\nContent-Length: ${Buffer.byteLength(body)}\r\n`);
    expect(Buffer.byteLength(body)).toBe(body.length + 1);
    expect(req).toMatch(/\r\nauthorization: Basic dTpw\r\n/i);
    expect(req).toMatch(/\r\naccept: text\/event-stream\r\n/i);
    expect(req.endsWith(`\r\n\r\n${body}`)).toBe(true);
  });

  test("2. bodyless POST sends Content-Length: 0", async () => {
    const s = await serve((socket) => socket.end("HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\n\r\n"));
    const res = await fetch10(s.url, { method: "POST" });
    expect(res.status).toBe(202);
    expect(s.requests[0]).toContain("\r\nContent-Length: 0\r\n");
  });

  test("3. resolves at headers and streams; abort errors the reader and closes the socket", async () => {
    const s = await serve((socket) => socket.write("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\nevent: message\ndata: 1\n\n"));
    const ac = new AbortController();
    const res = await withTimeout(fetch10(s.url, { signal: ac.signal }));
    const reader = res.body!.getReader();
    const first = await withTimeout(reader.read());
    expect(new TextDecoder().decode(first.value)).toBe("event: message\ndata: 1\n\n");
    const next = reader.read();
    ac.abort(new Error("stop"));
    await expect(next).rejects.toThrow("stop");
    await withTimeout(Promise.all(s.closed));
  });

  test("4. Content-Length body completes without waiting for close", async () => {
    const s = await serve((socket) => socket.write("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello"));
    const res = await fetch10(s.url);
    expect(await withTimeout(res.text())).toBe("hello");
    await withTimeout(Promise.all(s.closed));
  });

  test("5. truncated Content-Length body rejects", async () => {
    const s = await serve((socket) => socket.end("HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nhello"));
    const res = await fetch10(s.url);
    await expect(res.text()).rejects.toThrow("truncated");
  });

  test("6. chunked response rejects", async () => {
    const s = await serve((socket) => socket.end("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n"));
    await expect(fetch10(s.url)).rejects.toThrow("chunked");
  });

  test("7. interim 100 Continue is skipped", async () => {
    const s = await serve((socket) => socket.end("HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok"));
    const res = await fetch10(s.url);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  test("8. 101 Switching Protocols rejects", async () => {
    const s = await serve((socket) => socket.end("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n"));
    await expect(fetch10(s.url)).rejects.toThrow("switch protocols");
  });

  test("9. 202 with Content-Length 0 reads as empty text; 204 has a null body", async () => {
    const a = await serve((socket) => socket.end("HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\n\r\n"));
    const r202 = await fetch10(a.url, { method: "POST", body: "{}" });
    expect(r202.status).toBe(202);
    expect(await r202.text()).toBe("");
    const b = await serve((socket) => socket.end("HTTP/1.1 204 No Content\r\n\r\n"));
    const r204 = await fetch10(b.url, { method: "DELETE" });
    expect(r204.status).toBe(204);
    expect(r204.body).toBeNull();
  });

  test("10. redirects are returned, not followed", async () => {
    const s = await serve((socket) => socket.end("HTTP/1.1 302 Found\r\nLocation: /elsewhere\r\nContent-Length: 0\r\n\r\n"));
    const res = await fetch10(s.url);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/elsewhere");
    await new Promise((r) => setTimeout(r, 50));
    expect(s.requests.length).toBe(1);
  });

  test("11. oversized headers reject and destroy the socket", async () => {
    const s = await serve((socket) => socket.write(`HTTP/1.1 200 OK\r\nX-Big: ${"a".repeat(2048)}`));
    await expect(createHttp10Fetch({ maxHeaderBytes: 1024 })(s.url)).rejects.toThrow("headers exceeded");
    await withTimeout(Promise.all(s.closed));
  });

  test("11a. a complete oversized header block rejects", async () => {
    const s = await serve((socket) => socket.end(`HTTP/1.1 200 OK\r\nX-Big: ${"a".repeat(2048)}\r\n\r\nok`));
    await expect(createHttp10Fetch({ maxHeaderBytes: 1024 })(s.url)).rejects.toThrow("headers exceeded");
  });

  test("11b. skipped 1xx blocks count toward the header cap", async () => {
    const cont = `HTTP/1.1 100 Continue\r\nX-Pad: ${"p".repeat(380)}\r\n\r\n`;
    const s = await serve((socket) => socket.end(`${cont}${cont}${cont}HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok`));
    await expect(createHttp10Fetch({ maxHeaderBytes: 1024 })(s.url)).rejects.toThrow("headers exceeded");
  });

  test("11c. one small 100 Continue then 200 still resolves under the cap", async () => {
    const s = await serve((socket) => socket.end("HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok"));
    const res = await createHttp10Fetch({ maxHeaderBytes: 1024 })(s.url);
    expect(await res.text()).toBe("ok");
  });

  test("12. oversized body errors the stream", async () => {
    const s = await serve((socket) => socket.end(`HTTP/1.1 200 OK\r\n\r\n${"x".repeat(64)}`));
    const res = await createHttp10Fetch({ maxBodyBytes: 16 })(s.url);
    await expect(res.text()).rejects.toThrow("exceeded 16 bytes");
  });

  test("13. connection refused rejects with TypeError and ECONNREFUSED cause", async () => {
    const s = await serve(() => {});
    servers.pop()!.close();
    await new Promise((r) => setTimeout(r, 20));
    const error = await fetch10(s.url).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TypeError);
    expect(((error as TypeError).cause as { code?: string }).code).toBe("ECONNREFUSED");
  });

  test("14. an already-aborted signal rejects with its reason", async () => {
    const s = await serve(() => {});
    const reason = new Error("already gone");
    await expect(fetch10(s.url, { signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
    expect(s.requests.length).toBe(0);
  });

  test("15. a header value with a line break rejects before any request is written", async () => {
    const s = await serve(() => {});
    await expect(fetch10(s.url, { headers: [["X-Evil", "a\r\nInjected: 1"]] as unknown as HeadersInit })).rejects.toThrow("line break");
    expect(s.requests.length).toBe(0);
  });
});

describe("createHttp10Fetch with the MCP SDK", () => {
  test("Client over StreamableHTTPClientTransport connects, lists tools and closes every socket", async () => {
    const sse = (message: object) => `event: message\ndata: ${JSON.stringify(message)}\n\n`;
    // WIRE framing as observed live on BC's on-prem MCP endpoint (see src/core/http10.ts createHttp10Fetch).
    const s = await serve((socket, request) => {
      const [line] = request.split("\r\n");
      const body = request.slice(request.indexOf("\r\n\r\n") + 4);
      if (line!.startsWith("GET ")) {
        socket.write("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n");
        return; // stays open, no events
      }
      if (line!.startsWith("DELETE ")) return void socket.end("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n");
      const msg = JSON.parse(body) as { id?: number; method: string; params?: { protocolVersion?: string } };
      if (msg.id === undefined) return void socket.end("HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\n\r\n");
      const result =
        msg.method === "initialize"
          ? { protocolVersion: msg.params!.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake-bc", version: "1" } }
          : { tools: [{ name: "fake_tool", inputSchema: { type: "object" } }] };
      socket.end(
        `HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nMcp-Session-Id: s1\r\n\r\n${sse({ jsonrpc: "2.0", id: msg.id, result })}`,
      );
    });
    const client = new Client({ name: "test", version: "0" });
    const transport = new StreamableHTTPClientTransport(new URL(s.url), { fetch: createHttp10Fetch() });
    await withTimeout(client.connect(transport));
    const tools = await withTimeout(client.listTools());
    expect(tools.tools.map((t) => t.name)).toEqual(["fake_tool"]);
    // The SDK opens its standalone GET SSE stream in the background after `initialized`.
    await withTimeout(
      (async () => {
        while (!s.requests.some((r) => r.startsWith("GET "))) await new Promise((r) => setTimeout(r, 10));
      })(),
    );
    await withTimeout(transport.terminateSession());
    expect(s.requests.some((r) => r.startsWith("DELETE "))).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(s.open()).toBe(1); // only the GET stream is left; close() must end it
    await withTimeout(client.close());
    await withTimeout(Promise.all(s.closed));
    expect(s.open()).toBe(0);
  });
});
