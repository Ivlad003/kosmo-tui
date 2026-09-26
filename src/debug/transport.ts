import { loopbackWebSocketUrl, WS_MESSAGE_MAX } from "./loopback.js";
import type { CdpTransport } from "./cdp.js";

const CONNECT_TIMEOUT_MS = 5000;

export function openWebSocket(ip: string, port: number, reported: string): Promise<CdpTransport> {
  const url = loopbackWebSocketUrl(ip, port, reported);
  if (url === null) return Promise.reject(new Error("refusing non-loopback debugger url"));
  const ws = new WebSocket(url);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("websocket connect timeout"));
    }, CONNECT_TIMEOUT_MS);
    const fail = (error: unknown): void => {
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    ws.addEventListener("error", () => fail(new Error("websocket error")), { once: true });
    ws.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        resolve(socketTransport(ws));
      },
      { once: true }
    );
  });
}

function socketTransport(ws: WebSocket): CdpTransport {
  const messages = new Set<(text: string) => void>();
  const closes = new Set<(reason: string) => void>();
  ws.addEventListener("message", (event) => {
    const text = typeof event.data === "string" ? event.data : Buffer.from(event.data as ArrayBuffer).toString("utf8");
    if (Buffer.byteLength(text) > WS_MESSAGE_MAX) {
      for (const close of closes) close("message-too-large");
      ws.close();
      return;
    }
    for (const handler of messages) handler(text);
  });
  let closed = false;
  ws.addEventListener("close", () => {
    if (closed) return;
    closed = true;
    for (const close of closes) close("closed");
  });
  // Errors after open (reset by peer) surface as close; without a listener they would be unhandled.
  ws.addEventListener("error", () => undefined);
  return {
    send(text) {
      if (ws.readyState !== WebSocket.OPEN) throw new Error("websocket not open");
      ws.send(text);
    },
    onMessage(handler) {
      messages.add(handler);
    },
    onClose(handler) {
      closes.add(handler);
    },
    close() {
      ws.close();
    }
  };
}

export function pipeTransport(input: NodeJS.ReadableStream, output: NodeJS.WritableStream): CdpTransport {
  const messages = new Set<(text: string) => void>();
  const closes = new Set<(reason: string) => void>();
  let buffer = Buffer.alloc(0);
  let ended = false;
  const end = (reason: string): void => {
    if (ended) return;
    ended = true;
    for (const close of closes) close(reason);
  };
  input.on("data", (chunk: Buffer) => {
    if (ended) return;
    buffer = Buffer.concat([buffer, chunk]);
    let nul = buffer.indexOf(0);
    while (nul >= 0) {
      const text = buffer.subarray(0, nul).toString("utf8");
      buffer = buffer.subarray(nul + 1);
      if (Buffer.byteLength(text) > WS_MESSAGE_MAX) {
        end("message-too-large");
        output.end();
        return;
      }
      for (const handler of messages) handler(text);
      nul = buffer.indexOf(0);
    }
    // A frame without its terminator that already exceeds the limit is dropped with the connection.
    if (buffer.length > WS_MESSAGE_MAX) {
      buffer = Buffer.alloc(0);
      end("message-too-large");
      output.end();
    }
  });
  input.on("end", () => end("eof"));
  input.on("error", () => end("error"));
  output.on("error", () => end("error"));
  return {
    send(text) {
      if (ended) throw new Error("pipe closed");
      output.write(`${text}\0`);
    },
    onMessage(handler) {
      messages.add(handler);
    },
    onClose(handler) {
      closes.add(handler);
    },
    close() {
      output.end();
    }
  };
}
