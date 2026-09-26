import { WS_MESSAGE_MAX } from "./loopback.js";

export type CdpTransport = {
  send(text: string): void;
  onMessage(handler: (text: string) => void): void;
  onClose(handler: (reason: string) => void): void;
  close(): void;
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export class CdpError extends Error {
  constructor(
    message: string,
    readonly method: string
  ) {
    super(message);
    this.name = "CdpError";
  }
}

export class CdpClient {
  private next = 1;
  private pending = new Map<number, Pending>();
  private listeners = new Map<string, Set<(params: unknown, sessionId?: string) => void>>();
  private closed = false;

  constructor(private readonly transport: CdpTransport) {
    transport.onMessage((text) => this.receive(text));
    transport.onClose((reason) => this.failAll(reason));
  }

  on(method: string, handler: (params: unknown, sessionId?: string) => void): () => void {
    const set = this.listeners.get(method) ?? new Set();
    set.add(handler);
    this.listeners.set(method, set);
    return () => set.delete(handler);
  }

  send<T = unknown>(method: string, params: unknown = {}, sessionId?: string): Promise<T> {
    if (this.closed) return Promise.reject(new CdpError("closed", method));
    const id = this.next;
    this.next += 1;
    const message: Record<string, unknown> = { id, method, params };
    if (sessionId !== undefined) message.sessionId = sessionId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
      try {
        this.transport.send(JSON.stringify(message));
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  close(): void {
    this.closed = true;
    this.transport.close();
    this.failAll("closed");
  }

  private receive(text: string): void {
    if (Buffer.byteLength(text) > WS_MESSAGE_MAX) {
      this.failAll("message-too-large");
      this.close();
      return;
    }
    let message: {
      id?: number;
      method?: string;
      params?: unknown;
      sessionId?: string;
      error?: { message?: string };
      result?: unknown;
    };
    try {
      message = JSON.parse(text) as typeof message;
    } catch {
      return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (pending === undefined) return;
      if (message.error !== undefined) pending.reject(new CdpError(message.error.message ?? "cdp error", "response"));
      else pending.resolve(message.result);
      return;
    }
    if (message.method === undefined) return;
    for (const handler of this.listeners.get(message.method) ?? []) handler(message.params, message.sessionId);
  }

  private failAll(reason: string): void {
    this.closed = true;
    for (const pending of this.pending.values()) pending.reject(new CdpError(reason, "transport"));
    this.pending.clear();
  }
}
