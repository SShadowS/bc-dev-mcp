// Entry for `bun run compile` only (dist/index.js uses src/mcp/index.ts directly).
//
// @microsoft/signalr loads its Node-only modules with a runtime require it hides from
// bundlers (HttpConnection: ws, eventsource; FetchHttpClient: tough-cookie, fetch-cookie),
// so `bun build --compile` never embeds them and every hub tool fails in the exe with
// "Cannot find module 'eventsource'". signalr calls `__non_webpack_require__` instead when
// `__webpack_require__` is a function, so hand it these statically imported (embedded)
// modules. All are CommonJS: a default import is what require() returns.
import eventsource from "eventsource";
import toughCookie from "tough-cookie";
import fetchCookie from "fetch-cookie";
import ws from "ws";

const embedded: Record<string, unknown> = { eventsource, "tough-cookie": toughCookie, "fetch-cookie": fetchCookie, ws };
const g = globalThis as Record<string, unknown>;
g["__webpack_require__"] = () => undefined;
g["__non_webpack_require__"] = (name: string) => {
  if (name in embedded) return embedded[name];
  throw new Error(`Cannot find module '${name}' (not embedded in the compiled executable)`);
};

await import("../src/mcp/index");
