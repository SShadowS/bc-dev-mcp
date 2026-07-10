import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { SnapshotClient } from "../../core/snapshot/snapshot-client";
import { summarizeProfile } from "../../core/snapshot/profile-summary";
import { extractEntry, listEntryNames } from "../../core/snapshot/zip";
import { convertMdcZip, resolveConverter, type ConverterEnv, type SpawnRunner } from "../../core/snapshot/converter";
import { DEFAULT_SNAPSHOT_PORT } from "../../core/urls";
import type { ServerState } from "../state";
import { connectionShape, resolve, type ToolDefinition, type ToolDeps } from "./shared";

const hotspotSchema = z.object({
  function: z.string(),
  url: z.string(),
  line: z.number(),
  selfSamples: z.number(),
  selfMs: z.number(),
  selfPct: z.number(),
});

const AL_PERF_HINT =
  "For deep analysis (anti-patterns, AI insights), pass this .alcpuprofile to al-perf (github.com/SShadowS/al-perf).";

function requireProfile(state: ServerState) {
  if (!state.profile) throw new Error("No active profile — call bcdev_profile_start first");
  return state.profile;
}

export function createProfileTools(
  state: ServerState,
  deps: ToolDeps,
  converterOverride?: { resolveEnv: () => ConverterEnv | null; run: SpawnRunner },
): ToolDefinition[] {
  const resolveEnv = converterOverride?.resolveEnv ?? (() => resolveConverter({ env: deps.env }));
  const runConvert = converterOverride?.run;

  return [
    {
      name: "bcdev_profile_status",
      title: "Profiling endpoint status",
      description: "Preflight the BC snapshot-debugger endpoint (CPU profiling — sampling and instrumentation). Reports reachability and whether sample profiling is supported. Snapshot endpoint is a separate port from the dev endpoint.",
      annotations: { readOnlyHint: true, openWorldHint: true },
      schema: {
        ...connectionShape,
        snapshotPort: z.number().optional().describe("Snapshot-debugger port (default 7083; separate from the dev port)"),
      },
      outputSchema: z.looseObject({
        reachable: z.boolean(),
        snapshotApiVersion: z.string().optional(),
        sampleProfilingSupported: z.boolean(),
        webEndpoint: z.string().optional(),
      }),
      handler: async (params) => {
        const { config } = resolve(params, deps);
        const port = (params["snapshotPort"] as number | undefined) ?? DEFAULT_SNAPSHOT_PORT;
        try {
          const md = await new SnapshotClient(deps.fetchFn, config, port).metadata();
          const major = Number(md.webApiVersion.split(".")[0] ?? 0);
          return { reachable: true, snapshotApiVersion: md.webApiVersion, sampleProfilingSupported: major >= 3, webEndpoint: md.webEndpoint };
        } catch (err) {
          return { reachable: false, sampleProfilingSupported: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
    },
    {
      name: "bcdev_profile_start",
      title: "Start CPU profile",
      description: "Arm a CPU profiler on the BC server (kind: 'sampling' default, or 'instrumentation'). Binds the NEXT matching session. After this, TRIGGER the session to profile (open a page / run a report via a browser or a WebSocket client like business-central-mcp), then bcdev_profile_poll until Started, then bcdev_profile_finish. One capture at a time.",
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      schema: {
        ...connectionShape,
        snapshotPort: z.number().optional().describe("Snapshot-debugger port (default 7083)"),
        clientType: z.enum(["WebServiceClient", "WebClient", "Background", "ClientService"]).optional().describe("Session type to bind (default WebClient — the type a browser/bc-mcp session creates)"),
        userId: z.string().optional().describe("Bind the next session for this specific user"),
        samplingIntervalMs: z.union([z.literal(50), z.literal(100), z.literal(150)]).optional().describe("Sampling interval in ms; one of 50/100/150 (default 100)"),
        sessionId: z.number().optional().describe("Specific NST session id, or -1 for next matching (default -1)"),
        kind: z
          .enum(["sampling", "instrumentation"])
          .optional()
          .describe(
            "Profile kind: 'sampling' (statistical, default, dependency-free) or 'instrumentation' (deterministic every-call; needs bc-mdc-converter to convert, else raw .mdc is saved)",
          ),
      },
      outputSchema: z.object({ debuggingContext: z.string(), attachKind: z.string(), hint: z.string(), converterAvailable: z.boolean().optional() }),
      handler: async (params) => {
        if (state.profile) throw new Error("Profile capture already active — call bcdev_profile_finish first");
        const { config } = resolve(params, deps);
        const snapshotPort = (params["snapshotPort"] as number | undefined) ?? DEFAULT_SNAPSHOT_PORT;
        const kind = (params["kind"] as "sampling" | "instrumentation" | undefined) ?? "sampling";
        const debuggingContext = randomUUID();
        // claim the slot before awaiting — blocks concurrent start (mirrors debug-tools.ts)
        state.profile = { debuggingContext, affinityCookie: null, attachKind: "", snapshotPort, config, startedAt: new Date().toISOString(), kind };
        const client = new SnapshotClient(deps.fetchFn, config, snapshotPort);
        try {
          const clientType = (params["clientType"] as never) ?? "WebClient";
          const userId = params["userId"] as string | undefined;
          const sessionId = (params["sessionId"] as number | undefined) ?? -1;
          const attach =
            kind === "instrumentation"
              ? await client.attachInstrumentation({ debuggingContext, clientType, userId, sessionId })
              : await client.attachSampling({
                  debuggingContext,
                  clientType,
                  userId,
                  samplingIntervalMs: (params["samplingIntervalMs"] as 50 | 100 | 150 | undefined) ?? 100,
                  sessionId,
                });
          state.profile.affinityCookie = attach.affinityCookie;
          state.profile.attachKind = attach.attachKind;
          if (kind === "instrumentation") {
            const converterAvailable = resolveEnv() !== null;
            return {
              debuggingContext,
              attachKind: attach.attachKind,
              converterAvailable,
              hint:
                "Instrumentation records every call — keep exercising the session, poll to Started, exercise a bit more, then finish. " +
                (converterAvailable ? "" : "WARNING: converter not found (set BC_MDC_CONVERTER or put bc-mdc-converter on PATH — github.com/SShadowS/bc-mdc-converter); finish will save the raw .mdc snapshot for you to open in VS Code."),
            };
          }
          return {
            debuggingContext,
            attachKind: attach.attachKind,
            hint: "Sampler armed. Now trigger the session to profile (WebClient action via a browser or business-central-mcp), then call bcdev_profile_poll until Started, then bcdev_profile_finish.",
          };
        } catch (err) {
          state.profile = null; // roll back the claimed slot on attach failure
          throw err;
        }
      },
    },
    {
      name: "bcdev_profile_poll",
      title: "Poll profile status",
      description: "Poll the active profile capture. `ready` is true once status is Started (the session was recorded and can be finished). Still Initialized is a normal result — call again after triggering the session.",
      annotations: { readOnlyHint: true, openWorldHint: true },
      schema: {},
      outputSchema: z.object({ status: z.enum(["Failed", "Initialized", "Started", "Finished"]), ready: z.boolean() }),
      handler: async () => {
        const p = requireProfile(state);
        const status = await new SnapshotClient(deps.fetchFn, p.config, p.snapshotPort).status(p.debuggingContext, p.affinityCookie);
        return { status, ready: status === "Started" };
      },
    },
    {
      name: "bcdev_profile_finish",
      title: "Finish CPU profile",
      description: "Finish the active capture, extract the .alcpuprofile, write it to disk, and return a ranked AL self-time hotspot summary. If nothing was recorded, reports captured:false.",
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      schema: {
        outPath: z.string().optional().describe("Where to write the .alcpuprofile (default: <cwd>/<ctx>.alcpuprofile)"),
      },
      outputSchema: z.looseObject({
        captured: z.boolean(),
        profilePath: z.string().optional(),
        kind: z.string().optional(),
        zipPath: z.string().optional(),
        summary: z.object({
          durationMs: z.number(),
          sampleCount: z.number(),
          nodeCount: z.number(),
          hotspots: z.array(hotspotSchema),
        }).optional(),
        hint: z.string().optional(),
        nextSteps: z.array(z.string()).optional(),
      }),
      handler: async (params) => {
        const p = requireProfile(state);
        const client = new SnapshotClient(deps.fetchFn, p.config, p.snapshotPort);
        try {
          const fin = await client.finish(p.debuggingContext, p.affinityCookie);
          if (fin.empty) {
            return {
              captured: false,
              hint:
                p.kind === "instrumentation"
                  ? "Nothing recorded — drive the session (Full verbosity) past Started before finish."
                  : "Nothing recorded — was a WebClient session actually triggered between start and finish?",
            };
          }
          if (p.kind === "sampling") {
            if (fin.etag !== "Sampling") {
              return { captured: false, kind: "recording", hint: `Got a ${fin.etag ?? "recording"} archive, not a sampling profile. Snapshot recording (.mdc) replay is a VS Code concern.` };
            }
            const member = `${p.debuggingContext}.alcpuprofile`;
            const profileBytes = extractEntry(fin.body, member);
            if (!profileBytes) {
              return { captured: false, hint: `finish returned a zip without the expected ${member} member.` };
            }
            const outPath = (params["outPath"] as string | undefined) ?? join(deps.cwd, member);
            writeFileSync(outPath, profileBytes);
            const summary = summarizeProfile(profileBytes.toString("utf8"));
            return { captured: true, profilePath: outPath, kind: "sampling", summary, nextSteps: [AL_PERF_HINT] };
          }
          // instrumentation: body is a .zip of .mdc
          const names = listEntryNames(fin.body);
          if (!names.some((n) => n.endsWith(".mdc"))) {
            return { captured: false, hint: "finish returned no .mdc members — not an instrumentation recording." };
          }
          const outDir = params["outPath"] ? dirname(params["outPath"] as string) : deps.cwd;
          const zipPath = join(outDir, `${p.debuggingContext}.snapshot.zip`);
          writeFileSync(zipPath, Buffer.from(fin.body));
          const env = resolveEnv();
          if (!env) {
            return {
              captured: true,
              kind: "instrumentation-raw",
              zipPath,
              hint: "Raw .mdc snapshot saved. Convert with bc-mdc-converter (set BC_MDC_CONVERTER or put it on PATH — github.com/SShadowS/bc-mdc-converter), or open it in VS Code (AL: Open snapshot -> generate profile).",
              nextSteps: [AL_PERF_HINT],
            };
          }
          const outPath = (params["outPath"] as string | undefined) ?? join(deps.cwd, `${p.debuggingContext}.alcpuprofile`);
          const conv = await convertMdcZip(env, zipPath, outPath, runConvert);
          if (!conv.ok) {
            return {
              captured: true,
              kind: "instrumentation-raw",
              zipPath,
              hint: `Raw .mdc snapshot saved; conversion failed (${conv.error}). Open the .zip in VS Code, or check the bc-mdc-converter binary.`,
              nextSteps: [AL_PERF_HINT],
            };
          }
          const summary = summarizeProfile(readFileSync(outPath, "utf8"));
          return {
            captured: true,
            kind: "instrumentation",
            profilePath: outPath,
            zipPath,
            summary,
            nextSteps: [AL_PERF_HINT, "Instrumentation self-time is deterministic call-time, not statistical."],
          };
        } finally {
          state.profile = null;
        }
      },
    },
  ];
}
