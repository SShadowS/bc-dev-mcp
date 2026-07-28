#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { signalrHubFactory } from "../core/hubs/signalr-base";
import { createAuthorizationProviderFactory } from "../core/authorization";
import { buildServer } from "./server";
import { ServerState } from "./state";
import { collectGitChanges } from "../core/git-changes";
import { SdkNativeMcpGateway } from "../core/native-mcp";

const server = buildServer(new ServerState(), {
  hubFactory: signalrHubFactory,
  authorizationFactory: createAuthorizationProviderFactory(),
  fetchFn: fetch,
  env: process.env,
  cwd: process.cwd(),
  gitChanges: collectGitChanges,
  nativeMcpGateway: new SdkNativeMcpGateway(fetch),
});

await server.connect(new StdioServerTransport());
