// Preloaded with `node --import` into a spawned kosmo-tui: records every attempt to
// open a listening or bound socket, synchronously, to the file named by
// KOSMO_TUI_LISTEN_SPY. The first line proves the spy was installed.
import { appendFileSync } from "node:fs";
import dgram from "node:dgram";
import http from "node:http";
import https from "node:https";
import net from "node:net";

const out = process.env.KOSMO_TUI_LISTEN_SPY;
const note = (what) => appendFileSync(out, `${what}\n`);
note(`installed ${process.pid}`);

const wrap = (owner, name, label) => {
  const original = owner[name];
  owner[name] = function (...args) {
    note(label);
    return original.apply(this, args);
  };
};
wrap(net.Server.prototype, "listen", "net.Server.listen");
wrap(dgram.Socket.prototype, "bind", "dgram.Socket.bind");
wrap(http, "createServer", "http.createServer");
wrap(https, "createServer", "https.createServer");
wrap(net, "createServer", "net.createServer");
