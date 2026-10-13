#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { signalrHubFactory } from "../core/hubs/signalr-base";
import { createAuthorizationProviderFactory } from "../core/authorization";
import { buildServer } from "./server";
import { ServerState } from "./state";
import { collectGitChanges } from "../core/git-changes";
import { createCallGraphProvider } from "../core/call-graph";
import { createAlSemRiskProvider } from "../core/risk";
import { createAlSemOrderPredictor } from "../core/test-order-static";
import { createAlSemStaticWritersProvider } from "../core/alsem-writes";
import { SdkNativeMcpGateway } from "../core/native-mcp";
import { createHttp10Get } from "../core/http10";

// One ServerState for the process: the debug session, event queue and run lock must survive
// whichever McpServer instance serveStdio builds for the connection's protocol era.
const state = new ServerState();
const deps = {
  hubFactory: signalrHubFactory,
  authorizationFactory: createAuthorizationProviderFactory(),
  fetchFn: fetch,
  http10Get: createHttp10Get(),
  env: process.env,
  cwd: process.cwd(),
  gitChanges: collectGitChanges,
  callGraph: createCallGraphProvider(process.env),
  riskDigest: createAlSemRiskProvider(process.env),
  orderPredictor: createAlSemOrderPredictor(process.env),
  staticWriters: createAlSemStaticWritersProvider(process.env),
  nativeMcpGateway: new SdkNativeMcpGateway(fetch),
};

// serveStdio answers both a 2025-era `initialize` and a 2026-07-28 `server/discover` opening.
serveStdio(() => buildServer(state, deps));
