#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { signalrHubFactory } from "../core/hubs/signalr-base";
import { buildServer } from "./server";
import { ServerState } from "./state";

const server = buildServer(new ServerState(), {
  hubFactory: signalrHubFactory,
  fetchFn: fetch,
  env: process.env,
  cwd: process.cwd(),
});

await server.connect(new StdioServerTransport());
