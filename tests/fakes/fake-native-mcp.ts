import type {
  NativeMcpCallResponse,
  NativeMcpGateway,
  NativeMcpListResponse,
  NativeMcpTarget,
} from "../../src/core/native-mcp";

export class FakeNativeMcpGateway implements NativeMcpGateway {
  listCalls: Array<{ target: NativeMcpTarget; cursor?: string }> = [];
  toolCalls: Array<{ target: NativeMcpTarget; name: string; args: Record<string, unknown> }> = [];
  onList?: (target: NativeMcpTarget, cursor?: string) => Promise<NativeMcpListResponse> | NativeMcpListResponse;
  onCall?: (
    target: NativeMcpTarget,
    name: string,
    args: Record<string, unknown>,
  ) => Promise<NativeMcpCallResponse> | NativeMcpCallResponse;

  async listTools(target: NativeMcpTarget, cursor?: string): Promise<NativeMcpListResponse> {
    this.listCalls.push({ target, ...(cursor === undefined ? {} : { cursor }) });
    return this.onList
      ? await this.onList(target, cursor)
      : {
          server: { name: "Business Central", version: "28.0" },
          catalog: { tools: [] },
        };
  }

  async callTool(
    target: NativeMcpTarget,
    name: string,
    args: Record<string, unknown>,
  ): Promise<NativeMcpCallResponse> {
    this.toolCalls.push({ target, name, args });
    return this.onCall
      ? await this.onCall(target, name, args)
      : {
          server: { name: "Business Central", version: "28.0" },
          result: { content: [] },
        };
  }
}
