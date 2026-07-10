export { type ToolDefinition, type ToolDeps } from "./shared";
import type { ToolDeps } from "./shared";
import type { ToolDefinition } from "./shared";
import type { ServerState } from "../state";
import { createDebugTools } from "./debug-tools";
import { createProfileTools } from "./profile-tools";
import { createTestTools } from "./test-tools";

export function createTools(state: ServerState, deps: ToolDeps): ToolDefinition[] {
  return [...createTestTools(state, deps), ...createDebugTools(state, deps), ...createProfileTools(state, deps)];
}
