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
import { snapshotUrl } from "../urls";
import {
  buildInstrumentationAttachBody,
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

  async metadata(): Promise<SnapshotMetadata> {
    const res = await this.fetchFn(snapshotUrl(this.config, "snapshotendpointmetadata", this.snapshotPort), {
      headers: { Authorization: await this.authorization.getAuthorizationHeader() },
    });
    if (!res.ok) throw new Error(`snapshot metadata HTTP ${res.status}`);
    return (await res.json()) as SnapshotMetadata;
  }

  async attachSampling(p: SamplingAttachParams): Promise<AttachResult> {
    const url = snapshotUrl(this.config, "attach", this.snapshotPort, { debuggingcontext: p.debuggingContext });
    const res = await this.fetchFn(url, {
      method: "POST",
      headers: await this.headers(null, true),
      body: JSON.stringify(buildSamplingAttachBody(p)),
    });
    if (!res.ok) throw new Error(`snapshot attach HTTP ${res.status}`);
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
    if (!res.ok) throw new Error(`snapshot attach HTTP ${res.status}`);
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
    if (!res.ok) throw new Error(`snapshot status HTTP ${res.status}`);
    return parseStatus(await res.text());
  }

  async finish(debuggingContext: string, affinityCookie: string | null): Promise<FinishResult> {
    const url = snapshotUrl(this.config, "finish", this.snapshotPort, this.query(debuggingContext, affinityCookie));
    const res = await this.fetchFn(url, {
      method: "POST",
      headers: await this.headers(affinityCookie, true),
      body: JSON.stringify({ DebuggingContext: debuggingContext }),
    });
    if (!res.ok) throw new Error(`snapshot finish HTTP ${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    const etag = res.headers.get("etag")?.trim().replace(/^"|"$/g, "") ?? null;
    return { empty: buf.length === 0, etag, body: buf };
  }
}
