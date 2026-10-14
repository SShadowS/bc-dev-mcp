/**
 * Minimal HTTP/1.0 GET client for on-prem Automation API reads.
 *
 * WIRE: on Cronus28 (BC28.4, port 7048, Server: Microsoft-HTTPAPI/2.0) larger HTTP/1.1 chunked
 * responses never send their tail; each stalled request holds one of ~5 per-user API slots until
 * the service tier restarts. The same requests over HTTP/1.0 return the complete body
 * (2026-10-04). Node/Bun fetch is HTTP/1.1-only, hence this client.
 *
 * Scope: one GET per connection, Content-Length or close-delimited body, bounded size, abortable.
 * Never returns a truncated body as success. Never logs.
 */
import { connect as netConnect, isIP, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { BcDevError } from "./agent-errors";

export interface Http10Response {
  status: number;
  body: string;
}

export type Http10Get = (url: string, headers: Record<string, string>, signal: AbortSignal) => Promise<Http10Response>;

export const MAX_HTTP10_RESPONSE_BYTES = 64 * 1024 * 1024;

function protocol(message: string): BcDevError {
  return new BcDevError("PROTOCOL_ERROR", message, "protocol");
}

function parseResponse(raw: Buffer): Http10Response {
  const split = raw.indexOf("\r\n\r\n");
  if (split < 0) throw protocol("Business Central closed the connection before sending complete response headers");
  const lines = raw.subarray(0, split).toString("latin1").split("\r\n");
  const status = /^HTTP\/1\.[01] (\d{3})/.exec(lines[0] ?? "");
  if (!status) throw protocol("Business Central sent a malformed HTTP status line");
  const headers = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(":");
    if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  if (headers.get("transfer-encoding")?.toLowerCase().includes("chunked")) {
    throw protocol("Business Central sent a chunked response to an HTTP/1.0 request");
  }
  const body = raw.subarray(split + 4);
  const length = headers.get("content-length");
  if (length !== undefined && Number(length) !== body.length) {
    throw protocol(`Business Central response was truncated (${body.length} of ${length} bytes)`);
  }
  return { status: Number(status[1]), body: body.toString("utf8") };
}

export function createHttp10Get(maxBytes: number = MAX_HTTP10_RESPONSE_BYTES): Http10Get {
  return (url, headers, signal) =>
    new Promise<Http10Response>((resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      for (const [name, value] of Object.entries(headers)) {
        if (/[\r\n]/.test(name) || /[\r\n]/.test(value)) {
          reject(new BcDevError("INVALID_ARGUMENT", `HTTP header ${name.replace(/[\r\n]/g, "")} contains a line break`, "validation"));
          return;
        }
      }
      const target = new URL(url);
      const secure = target.protocol === "https:";
      if (!secure && target.protocol !== "http:") {
        reject(protocol(`Unsupported URL protocol ${target.protocol}`));
        return;
      }
      const port = Number(target.port || (secure ? 443 : 80));
      const request = [
        `GET ${target.pathname}${target.search} HTTP/1.0`,
        `Host: ${target.host}`,
        ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
        "",
        "",
      ].join("\r\n");

      // TLS keeps certificate verification on (rejectUnauthorized defaults to true) and sends SNI.
      // URL keeps IPv6 literals bracketed; sockets want them bare. SNI is for DNS names only (DEP0123).
      const host = target.hostname.replace(/^\[|\]$/g, "");
      const socket: Socket = secure
        ? tlsConnect({ host, port, ...(isIP(host) === 0 ? { servername: host } : {}) })
        : netConnect({ host, port });
      const chunks: Buffer[] = [];
      let received = 0;
      let settled = false;

      const finish = (error: unknown, value?: Http10Response): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        socket.destroy();
        if (error !== null) reject(error);
        else resolve(value!);
      };
      const onAbort = (): void => finish(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });

      socket.once(secure ? "secureConnect" : "connect", () => socket.write(request));
      socket.on("data", (chunk: Buffer) => {
        received += chunk.length;
        if (received > maxBytes) {
          finish(protocol(`Business Central response exceeded ${maxBytes} bytes`));
          return;
        }
        chunks.push(chunk);
        // Resolve as soon as a declared Content-Length is satisfied; don't wait for the socket to end.
        const raw = Buffer.concat(chunks);
        const split = raw.indexOf("\r\n\r\n");
        if (split < 0) return;
        const declared = /^content-length:[ \t]*(\d+)[ \t]*$/im.exec(raw.subarray(0, split).toString("latin1"));
        if (declared && raw.length - split - 4 >= Number(declared[1])) {
          try {
            finish(null, parseResponse(raw));
          } catch (error) {
            finish(error);
          }
        }
      });
      socket.on("error", (error) => finish(error));
      socket.on("end", () => {
        try {
          finish(null, parseResponse(Buffer.concat(chunks)));
        } catch (error) {
          finish(error);
        }
      });
    });
}

export const MAX_HTTP10_HEADER_BYTES = 64 * 1024;

/**
 * fetch over HTTP/1.0 for BC's on-prem MCP endpoint.
 * WIRE: port 7048 never completes HTTP/1.1 responses; MCP POSTs answer SSE without Content-Length and close,
 * `notifications/initialized` answers 202 Content-Length 0, the GET SSE stream stays open with no events,
 * DELETE answers 200 (live Cronus29 2026-10-14). Resolves at headers; the body streams until length/close.
 *
 * One request per connection; redirects are returned, not followed; chunked and 101 are rejected.
 * Network failures before headers reject with `TypeError("fetch failed", { cause })` like fetch does.
 */
export function createHttp10Fetch(opts: { maxBodyBytes?: number; maxHeaderBytes?: number } = {}): typeof fetch {
  const maxBody = opts.maxBodyBytes ?? MAX_HTTP10_RESPONSE_BYTES;
  const maxHeader = opts.maxHeaderBytes ?? MAX_HTTP10_HEADER_BYTES;
  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init.method ?? "GET").toUpperCase();
    const signal = init.signal ?? undefined;
    if (signal?.aborted) throw signal.reason;
    // `new Headers` would itself throw a bare TypeError on CR/LF; check the raw pairs so the error is structured.
    const pairs: [string, string][] =
      init.headers instanceof Headers
        ? [...init.headers]
        : Array.isArray(init.headers)
          ? (init.headers as [string, string][])
          : Object.entries(init.headers ?? {});
    for (const [name, value] of pairs) {
      if (/[\r\n]/.test(name) || /[\r\n]/.test(value)) {
        throw new BcDevError("INVALID_ARGUMENT", `HTTP header ${name.replace(/[\r\n]/g, "")} contains a line break`, "validation");
      }
    }
    const headers = new Headers(pairs);
    const body =
      init.body == null
        ? undefined
        : typeof init.body === "string"
          ? Buffer.from(init.body)
          : Buffer.from(await new Response(init.body).arrayBuffer());
    if (signal?.aborted) throw signal.reason;
    const secure = url.protocol === "https:";
    if (!secure && url.protocol !== "http:") throw new TypeError(`Unsupported URL protocol ${url.protocol}`);
    const port = Number(url.port || (secure ? 443 : 80));
    const lines = [`${method} ${url.pathname}${url.search} HTTP/1.0`, `Host: ${url.host}`, "Connection: close"];
    for (const [name, value] of headers) {
      if (name !== "host" && name !== "connection" && name !== "content-length") lines.push(`${name}: ${value}`);
    }
    if (body !== undefined || method === "POST" || method === "PUT" || method === "PATCH") {
      lines.push(`Content-Length: ${body?.length ?? 0}`);
    }
    const head = Buffer.from(lines.join("\r\n") + "\r\n\r\n", "latin1");

    const host = url.hostname.replace(/^\[|\]$/g, "");
    const socket: Socket = secure
      ? tlsConnect({ host, port, ...(isIP(host) === 0 ? { servername: host } : {}) })
      : netConnect({ host, port });

    return await new Promise<Response>((resolve, reject) => {
      let headerBuf: Buffer = Buffer.alloc(0);
      let resolved = false;
      let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
      let remaining: number | null = null;
      let bodyBytes = 0;
      let headerBytes = 0; // bytes of 1xx blocks already skipped; they count toward maxHeader
      const fail = (error: unknown): void => {
        signal?.removeEventListener("abort", onAbort);
        socket.destroy();
        if (!resolved) {
          resolved = true;
          reject(error);
          return;
        }
        try {
          controller?.error(error);
        } catch {
          // stream already closed or cancelled
        }
      };
      const onAbort = (): void => fail(signal!.reason);
      signal?.addEventListener("abort", onAbort, { once: true });
      const finishBody = (): void => {
        signal?.removeEventListener("abort", onAbort);
        socket.destroy();
        try {
          controller?.close();
        } catch {
          // stream already closed or cancelled
        }
      };
      const pushBody = (chunk: Buffer): void => {
        if (chunk.length === 0 || controller === null) return;
        const take = remaining === null ? chunk : chunk.subarray(0, remaining);
        bodyBytes += take.length;
        if (bodyBytes > maxBody) return fail(protocol(`Business Central response exceeded ${maxBody} bytes`));
        controller.enqueue(new Uint8Array(take));
        if (controller.desiredSize !== null && controller.desiredSize <= 0) socket.pause();
        if (remaining !== null) {
          remaining -= take.length;
          if (remaining === 0) finishBody();
        }
      };
      const onHeaders = (raw: Buffer): void => {
        let buf = raw;
        for (;;) {
          const split = buf.indexOf("\r\n\r\n");
          if (split < 0) {
            headerBuf = buf;
            if (headerBytes + buf.length > maxHeader) fail(protocol(`Business Central response headers exceeded ${maxHeader} bytes`));
            return;
          }
          if (headerBytes + split > maxHeader) return fail(protocol(`Business Central response headers exceeded ${maxHeader} bytes`));
          const headLines = buf.subarray(0, split).toString("latin1").split("\r\n");
          const m = /^HTTP\/1\.[01] (\d{3})(?: (.*))?$/.exec(headLines[0] ?? "");
          if (!m) return fail(protocol("Business Central sent a malformed HTTP status line"));
          const status = Number(m[1]);
          const rest = buf.subarray(split + 4);
          if (status === 101) return fail(protocol("Business Central asked to switch protocols"));
          if (status < 200) {
            headerBytes += split + 4;
            buf = rest; // interim 1xx (100 Continue): skip
            continue;
          }
          const h = new Headers();
          for (const line of headLines.slice(1)) {
            const c = line.indexOf(":");
            if (c > 0) h.append(line.slice(0, c).trim(), line.slice(c + 1).trim());
          }
          if (h.get("transfer-encoding")?.toLowerCase().includes("chunked")) {
            return fail(protocol("Business Central sent a chunked response to an HTTP/1.0 request"));
          }
          const declared = h.get("content-length");
          remaining = declared === null ? null : Number(declared);
          if (remaining !== null && !(Number.isSafeInteger(remaining) && remaining >= 0)) {
            return fail(protocol(`Business Central sent an invalid Content-Length ${declared}`));
          }
          resolved = true;
          const meta = { status, statusText: m[2] ?? "", headers: h };
          if (status === 204 || status === 205 || status === 304 || method === "HEAD") {
            finishBody();
            resolve(new Response(null, meta));
            return;
          }
          const stream = new ReadableStream<Uint8Array>({
            start: (c) => {
              controller = c;
            },
            pull: () => {
              socket.resume();
            },
            cancel: () => {
              signal?.removeEventListener("abort", onAbort);
              socket.destroy();
            },
          });
          resolve(new Response(stream, meta));
          if (remaining === 0) finishBody();
          else pushBody(rest);
          return;
        }
      };
      socket.once(secure ? "secureConnect" : "connect", () => {
        socket.write(head);
        if (body) socket.write(body);
      });
      socket.on("data", (chunk: Buffer) => {
        if (!resolved) onHeaders(Buffer.concat([headerBuf, chunk]));
        else pushBody(chunk);
      });
      socket.on("error", (error) => fail(resolved ? error : new TypeError("fetch failed", { cause: error })));
      socket.on("end", () => {
        if (!resolved) return fail(protocol("Business Central closed the connection before sending complete response headers"));
        if (remaining !== null && remaining > 0) {
          return fail(protocol(`Business Central response was truncated (${remaining} bytes missing)`));
        }
        finishBody();
      });
    });
  }) as typeof fetch;
}
