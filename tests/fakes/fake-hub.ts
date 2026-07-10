import type { HubConnectOptions, HubFactory, HubProxy } from "../../src/core/hubs/signalr-base";

export class FakeHub implements HubProxy {
  handlers = new Map<string, (...args: unknown[]) => void>();
  invocations: Array<{ method: string; args: unknown[] }> = [];
  onInvoke?: (method: string, args: unknown[]) => unknown | Promise<unknown>;
  url = "";
  opts?: HubConnectOptions;
  connectionId: string | null = "fake-conn-1";
  started = false;
  stopped = false;
  private closeCb?: (err?: Error) => void;

  async start(): Promise<void> {
    this.started = true;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.closeCb?.();
  }

  async invoke<T>(method: string, ...args: unknown[]): Promise<T> {
    this.invocations.push({ method, args });
    return (await this.onInvoke?.(method, args)) as T;
  }

  on(method: string, cb: (...args: unknown[]) => void): void {
    this.handlers.set(method, cb);
  }

  onclose(cb: (err?: Error) => void): void {
    this.closeCb = cb;
  }

  emit(method: string, ...args: unknown[]): void {
    this.handlers.get(method)?.(...args);
  }

  close(err?: Error): void {
    this.closeCb?.(err);
  }

  invoked(method: string): Array<{ method: string; args: unknown[] }> {
    return this.invocations.filter((i) => i.method === method);
  }
}

export function fakeHubFactory(hub: FakeHub): HubFactory {
  return (url, opts) => {
    hub.url = url;
    hub.opts = opts;
    return hub;
  };
}
