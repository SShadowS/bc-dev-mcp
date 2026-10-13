// Summarize a V8 .alcpuprofile into self-time hotspots. Pure; times are microseconds.
interface V8CallFrame {
  functionName?: string;
  url?: string;
  lineNumber?: number;
}
interface V8Node {
  id: number;
  callFrame?: V8CallFrame;
  declaringApplication?: { appId?: string };
}
interface V8Profile {
  nodes?: V8Node[];
  samples?: number[];
  timeDeltas?: number[];
  startTime?: number;
  endTime?: number;
}

export interface Hotspot {
  function: string;
  url: string;
  line: number;
  selfSamples: number;
  selfMs: number;
  selfPct: number;
  /** Declaring app id, lowercase without dashes (absent on platform/synthetic frames like IdleTime). */
  appId?: string;
}
export interface ProfileSummary {
  durationMs: number;
  sampleCount: number;
  nodeCount: number;
  hotspots: Hotspot[];
}

export function summarizeProfile(profileJson: string, topN = 15): ProfileSummary {
  const p = JSON.parse(profileJson) as V8Profile;
  const nodes = p.nodes ?? [];
  const samples = p.samples ?? [];
  const timeDeltas = p.timeDeltas ?? [];
  const byId = new Map<number, V8Node>(nodes.map((n) => [n.id, n]));

  const selfMicros = new Map<number, number>();
  const selfCount = new Map<number, number>();
  let totalMicros = 0;
  for (let i = 0; i < samples.length; i++) {
    const id = samples[i]!;
    const dt = timeDeltas[i] ?? 0;
    totalMicros += dt;
    selfMicros.set(id, (selfMicros.get(id) ?? 0) + dt);
    selfCount.set(id, (selfCount.get(id) ?? 0) + 1);
  }

  const hotspots: Hotspot[] = [...selfMicros.entries()]
    .map(([id, micros]) => {
      const node = byId.get(id);
      const cf = node?.callFrame ?? {};
      // WIRE: a frame url has no app segment (live Cronus28/29, 2026-10-13); node.declaringApplication.appId is a dashless GUID.
      const appId = node?.declaringApplication?.appId?.replace(/-/g, "").toLowerCase();
      return {
        function: cf.functionName || "(anonymous)",
        url: cf.url ?? "",
        line: typeof cf.lineNumber === "number" ? cf.lineNumber : -1,
        selfSamples: selfCount.get(id) ?? 0,
        selfMs: micros / 1000,
        selfPct: totalMicros > 0 ? (micros / totalMicros) * 100 : 0,
        ...(appId ? { appId } : {}),
      };
    })
    .sort((a, b) => b.selfMs - a.selfMs)
    .slice(0, topN);

  return {
    durationMs: ((p.endTime ?? 0) - (p.startTime ?? 0)) / 1000,
    sampleCount: samples.length,
    nodeCount: nodes.length,
    hotspots,
  };
}
