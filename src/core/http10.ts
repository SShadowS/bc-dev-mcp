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
import { connect as netConnect, type Socket } from "node:net";
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
      const socket: Socket = secure
        ? tlsConnect({ host: target.hostname, port, servername: target.hostname })
        : netConnect({ host: target.hostname, port });
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
