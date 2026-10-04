import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";
import { createHttp10Get } from "../../src/core/http10";

const servers: Server[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

function serve(onRequest: (socket: Socket, request: string) => void): Promise<{ url: string; requests: string[] }> {
  const requests: string[] = [];
  return new Promise((resolve) => {
    const server = createServer((socket) => {
      let data = "";
      socket.on("data", (chunk) => {
        data += chunk.toString("latin1");
        if (data.includes("\r\n\r\n")) {
          requests.push(data);
          onRequest(socket, data);
        }
      });
      socket.on("error", () => {});
    });
    servers.push(server);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      resolve({ url: `http://127.0.0.1:${port}/BC/api/x?tenant=default&$top=1`, requests });
    });
  });
}

const signal = () => new AbortController().signal;

describe("createHttp10Get", () => {
  test("sends an HTTP/1.0 GET with Host and headers, and reads a Content-Length body", async () => {
    const { url, requests } = await serve((socket) => {
      socket.end("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\n\r\n{\"value\":1}");
    });
    const result = await createHttp10Get()(url, { Authorization: "Basic dTpw", Accept: "application/json" }, signal());
    expect(result).toEqual({ status: 200, body: "{\"value\":1}" });
    expect(requests[0]).toStartWith("GET /BC/api/x?tenant=default&$top=1 HTTP/1.0\r\n");
    expect(requests[0]).toContain("\r\nHost: 127.0.0.1:");
    expect(requests[0]).toContain("\r\nAuthorization: Basic dTpw\r\n");
  });

  test("reads a close-delimited body without Content-Length", async () => {
    const { url } = await serve((socket) => socket.end("HTTP/1.0 400 Bad Request\r\n\r\n{\"error\":{}}"));
    expect(await createHttp10Get()(url, {}, signal())).toEqual({ status: 400, body: "{\"error\":{}}" });
  });

  test("a body shorter than Content-Length is PROTOCOL_ERROR, never success", async () => {
    const { url } = await serve((socket) => socket.end("HTTP/1.1 200 OK\r\nContent-Length: 50\r\n\r\n{\"value\":["));
    await expect(createHttp10Get()(url, {}, signal())).rejects.toMatchObject({ code: "PROTOCOL_ERROR", message: expect.stringContaining("truncated") });
  });

  test("a chunked reply is PROTOCOL_ERROR", async () => {
    const { url } = await serve((socket) => socket.end("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n{}\r\n0\r\n\r\n"));
    await expect(createHttp10Get()(url, {}, signal())).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  });

  test("closing before the headers end is PROTOCOL_ERROR", async () => {
    const { url } = await serve((socket) => socket.end("HTTP/1.1 200 OK\r\nContent-"));
    await expect(createHttp10Get()(url, {}, signal())).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  });

  test("a body over the size limit is PROTOCOL_ERROR", async () => {
    const { url } = await serve((socket) => socket.end(`HTTP/1.0 200 OK\r\n\r\n${"x".repeat(200)}`));
    await expect(createHttp10Get(100)(url, {}, signal())).rejects.toMatchObject({ code: "PROTOCOL_ERROR", message: expect.stringContaining("100") });
  });

  test("abort destroys a stalled request", async () => {
    let serverClosed = false;
    const { url } = await serve((socket) => {
      socket.on("close", () => { serverClosed = true; });
      socket.write("HTTP/1.1 200 OK\r\n");
    });
    const controller = new AbortController();
    const pending = createHttp10Get()(url, {}, controller.signal);
    setTimeout(() => controller.abort(new Error("timed out")), 30);
    await expect(pending).rejects.toThrow("timed out");
    // The client destroyed its socket, so the server side sees the connection close.
    for (let i = 0; i < 50 && !serverClosed; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(serverClosed).toBe(true);
  });

  test("an already-aborted signal rejects without connecting", async () => {
    const { url, requests } = await serve((socket) => socket.end("HTTP/1.0 200 OK\r\n\r\n{}"));
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(createHttp10Get()(url, {}, controller.signal)).rejects.toThrow("cancelled");
    expect(requests).toHaveLength(0);
  });

  test("CR/LF in a header value is refused before connecting", async () => {
    const { url, requests } = await serve((socket) => socket.end("HTTP/1.0 200 OK\r\n\r\n{}"));
    await expect(createHttp10Get()(url, { Authorization: "Basic x\r\nEvil: 1" }, signal())).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(requests).toHaveLength(0);
  });

  test("connection refused rejects with a plain network error (not a BcDevError)", async () => {
    const { url } = await serve(() => {});
    const port = new URL(url).port;
    servers.splice(0).forEach((s) => s.close());
    await new Promise((resolve) => setTimeout(resolve, 20));
    const error = await createHttp10Get()(`http://127.0.0.1:${port}/x`, {}, signal()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as { code?: string }).code).not.toBe("PROTOCOL_ERROR");
  });
});
