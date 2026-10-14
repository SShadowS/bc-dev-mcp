/**
 * HTTP client for Business Central snapshot debugging and profiling in UserPassword and Entra
 * modes. The injected authorization provider owns Azure CLI acquisition and in-memory caching;
 * this client asks for a header immediately before each request and never persists or logs it.
 * SECURITY: errors contain only operation/status, never authenticated URLs or headers.
 * WIRE: SaaS uses /v2.0/<environment>/snapshotdebugger and on-prem uses the dedicated snapshot
 * port; affinity cookie behavior is shared. This file does not select auth modes or refresh tokens.
 */
import type { ConnectionConfig } from "../types";
import type { AuthorizationProvider } from "../authorization";
import { redactAuthorization } from "../redaction";
import { snapshotUrl } from "../urls";
import {
  buildDebugAttachBody,
  buildInstrumentationAttachBody,
  type DebugAttachParams,
  buildSamplingAttachBody,
  parseStatus,
  type InstrumentationAttachParams,
  type SamplingAttachParams,
  type SnapshotStatus,
} from "./snapshot-types";

export interface SnapshotMetadata {
  runtimeVersion: string;
  webApiVersion: string;
  webEndpoint?: string;
}
export interface AttachResult {
  attachKind: string;
  affinityCookie: string | null;
}
export interface FinishResult {
  empty: boolean;
  etag: string | null;
  body: Uint8Array;
}

const AFFINITY = "ApplicationGatewayAffinity";

export class SnapshotHttpError extends Error {
  constructor(public readonly operation: string, public readonly status: number, public readonly bodySnippet: string) {
    super(`${operation} HTTP ${status}${bodySnippet ? `: ${bodySnippet}` : ""}`);
    this.name = "SnapshotHttpError";
  }
  // WIRE: a context BC no longer knows answers 404, or 200 with {"Message":"...could not be retrieved..."} (live Cronus29 2026-10-14).
  get lostContext(): boolean {
    return this.status === 404 || /could not be retrieved|may have been removed/i.test(this.bodySnippet);
  }
  // WIRE: attach 400 "A snapshot debugging session has already started on this tenant" (live Cronus29 2026-10-13).
  get heldElsewhere(): boolean {
    return this.status === 409 || /snapshot debugging session has already started/i.test(this.bodySnippet);
  }
}

export class SnapshotClient {
  constructor(
    private fetchFn: typeof fetch,
    private config: ConnectionConfig,
    private snapshotPort: number,
    private authorization: AuthorizationProvider,
  ) {}

  private async headers(affinityCookie: string | null, json: boolean): Promise<Record<string, string>> {
    const h: Record<string, string> = { Authorization: await this.authorization.getAuthorizationHeader() };
    if (json) h["Content-Type"] = "application/json";
    // WIRE: resend the affinity cookie on status/finish (dep-decomp SnapshotDebuggerClient). No-op when absent (single-node).
    if (affinityCookie) h["Cookie"] = `${AFFINITY}=${affinityCookie}`;
    return h;
  }

  private query(debuggingContext: string, affinityCookie: string | null): Record<string, string> {
    const q: Record<string, string> = { debuggingcontext: debuggingContext };
    if (affinityCookie) q["applicationgatewayaffinity"] = affinityCookie;
    return q;
  }

  private async responseError(operation: string, res: Response): Promise<SnapshotHttpError> {
    const diagnostic = redactAuthorization((await res.text()).trim()).slice(0, 300);
    return new SnapshotHttpError(operation, res.status, diagnostic);
  }

  async metadata(): Promise<SnapshotMetadata> {
    const res = await this.fetchFn(snapshotUrl(this.config, "snapshotendpointmetadata", this.snapshotPort), {
      headers: { Authorization: await this.authorization.getAuthorizationHeader() },
    });
    if (!res.ok) throw await this.responseError("snapshot metadata", res);
    return (await res.json()) as SnapshotMetadata;
  }

  async attachSampling(p: SamplingAttachParams): Promise<AttachResult> {
    const url = snapshotUrl(this.config, "attach", this.snapshotPort, { debuggingcontext: p.debuggingContext });
    const res = await this.fetchFn(url, {
      method: "POST",
      headers: await this.headers(null, true),
      body: JSON.stringify(buildSamplingAttachBody(p)),
    });
    if (!res.ok) throw await this.responseError("snapshot attach", res);
    const affinityCookie = this.readAffinityCookie(res);
    const attachKind = (await res.text()).trim().replace(/^"|"$/g, "");
    return { attachKind, affinityCookie };
  }

  async attachDebug(p: DebugAttachParams): Promise<AttachResult> {
    const url = snapshotUrl(this.config, "attach", this.snapshotPort, { debuggingcontext: p.debuggingContext });
    const res = await this.fetchFn(url, {
      method: "POST",
      headers: await this.headers(null, true),
      body: JSON.stringify(buildDebugAttachBody(p)),
    });
    if (!res.ok) throw await this.responseError("snapshot attach", res);
    const affinityCookie = this.readAffinityCookie(res);
    const attachKind = (await res.text()).trim().replace(/^"|"$/g, "");
    return { attachKind, affinityCookie };
  }

  async attachInstrumentation(p: InstrumentationAttachParams): Promise<AttachResult> {
    const url = snapshotUrl(this.config, "attach", this.snapshotPort, { debuggingcontext: p.debuggingContext });
    const res = await this.fetchFn(url, {
      method: "POST",
      headers: await this.headers(null, true),
      body: JSON.stringify(buildInstrumentationAttachBody(p)),
    });
    if (!res.ok) throw await this.responseError("snapshot attach", res);
    const affinityCookie = this.readAffinityCookie(res);
    const attachKind = (await res.text()).trim().replace(/^"|"$/g, "");
    return { attachKind, affinityCookie };
  }

  // WIRE: single-node dev containers never send Set-Cookie; only multi-node (App Gateway) deployments do — null is the expected common case.
  // Shared by attachSampling and attachInstrumentation (both POST snapshotdebugger/attach and get the same affinity cookie back).
  private readAffinityCookie(res: Response): string | null {
    const setCookie = res.headers.get("set-cookie") ?? res.headers.getSetCookie?.()[0] ?? null;
    const m = setCookie?.match(new RegExp(`${AFFINITY}=([^;]+)`));
    return m ? m[1]! : null;
  }

  async status(debuggingContext: string, affinityCookie: string | null): Promise<SnapshotStatus> {
    const url = snapshotUrl(this.config, "status", this.snapshotPort, this.query(debuggingContext, affinityCookie));
    const res = await this.fetchFn(url, {
      method: "POST",
      headers: await this.headers(affinityCookie, true),
      body: JSON.stringify({ DebuggingContext: debuggingContext }),
    });
    if (!res.ok) throw await this.responseError("snapshot status", res);
    const text = await res.text();
    // WIRE: a context BC no longer knows can answer 200 with {"Message":"..."} instead of a status value.
    try {
      const j: unknown = JSON.parse(text);
      if (j && typeof j === "object" && typeof (j as { Message?: unknown }).Message === "string") {
        throw new SnapshotHttpError("snapshot status", 200, redactAuthorization((j as { Message: string }).Message).slice(0, 300));
      }
    } catch (e) {
      if (e instanceof SnapshotHttpError) throw e;
    }
    return parseStatus(text);
  }

  async finish(debuggingContext: string, affinityCookie: string | null, maxBytes?: number): Promise<FinishResult> {
    const url = snapshotUrl(this.config, "finish", this.snapshotPort, this.query(debuggingContext, affinityCookie));
    const res = await this.fetchFn(url, {
      method: "POST",
      headers: await this.headers(affinityCookie, true),
      body: JSON.stringify({ DebuggingContext: debuggingContext }),
    });
    if (!res.ok) throw await this.responseError("snapshot finish", res);
    const tooBig = () => new SnapshotHttpError("snapshot finish", res.status, `response exceeds the ${maxBytes}-byte limit`);
    const declared = Number(res.headers.get("content-length"));
    if (maxBytes !== undefined && declared > maxBytes) throw tooBig();
    let buf: Uint8Array;
    if (maxBytes === undefined || !res.body) {
      buf = new Uint8Array(await res.arrayBuffer());
    } else {
      const chunks: Uint8Array[] = [];
      let total = 0;
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > maxBytes) {
          await reader.cancel();
          throw tooBig();
        }
        chunks.push(value);
      }
      buf = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) { buf.set(c, off); off += c.length; }
    }
    const etag = res.headers.get("etag")?.trim().replace(/^"|"$/g, "") ?? null;
    // WIRE: a capture that never bound a session finishes 200 with a 0-byte body and no ETag (scripts/e2e.md, live BC28 2026-10-13).
    return { empty: buf.length === 0, etag, body: buf };
  }
}
