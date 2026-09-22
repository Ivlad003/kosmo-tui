// PTY fixture: the real run(process) composition root with a minimal viewer that
// shows what arrived on data stdin vs. the keyboard port. Uses the built dist/.
//
//   node pty-viewer.mjs -        viewer on `-` (stdin = data, keys from /dev/tty)
//   node pty-viewer.mjs --probe  print whether a keyboard port can be opened
import { execFileSync } from "node:child_process";
import { run } from "../../dist/cli.js";
import { createTerminal } from "../../dist/terminal.js";
import { openKeyboardInput } from "../../dist/terminal-input.js";
import { runTerminalSession } from "../../dist/terminal-session.js";

if (process.argv[2] === "--probe") {
  const result = openKeyboardInput({ platform: process.platform, stdin: process.stdin, stdinCarriesData: true });
  if (result.ok) result.port.close();
  process.stdout.write(result.ok ? "KEYBOARD=ok\n" : `KEYBOARD=refused exit=${result.exitCode} ${result.message}\n`);
  process.exit(0);
}

const code = await run(process, {
  openViewer: async (invocation) => {
    const keyboard = openKeyboardInput({
      platform: process.platform,
      stdin: process.stdin,
      stdinCarriesData: invocation.target.kind === "stdin"
    });
    if (!keyboard.ok) {
      process.stderr.write(`${keyboard.message}\n`);
      return keyboard.exitCode;
    }
    const lines = [];
    const keys = [];
    let eof = false;
    const source = new Promise((resolve) => {
      let buffer = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => {
        buffer += chunk;
        const parts = buffer.split("\n");
        buffer = parts.pop() ?? "";
        lines.push(...parts);
      });
      process.stdin.on("end", () => {
        eof = true;
        resolve();
      });
    });
    try {
      const code = await runTerminalSession({
        terminal: createTerminal(keyboard.port.input, process.stdout),
        render: () => [
          `PID=${process.pid}`,
          `DATA=${JSON.stringify(lines)}`,
          `KEYS=${JSON.stringify(keys)}`,
          `EOF=${eof}`,
          eof ? "READY" : "WAITING"
        ],
        onKey: (key) => keys.push(key),
        source,
        signal: invocation.signal,
        stderr: process.stderr
      });
      // Line discipline right after the session closed, while this process (and the
      // keyboard handle) is still alive: libuv's reset at exit cannot mask a missed restore.
      const stty = execFileSync("sh", ["-c", "stty -a < /dev/tty"], { encoding: "utf8" });
      process.stdout.write(`STTY_AFTER_CLOSE=${stty.replace(/\s+/g, " ")}\n`);
      return code;
    } finally {
      keyboard.port.close();
      process.stdin.destroy();
    }
  }
});
process.stdout.write(`EXIT=${code}\n`);
process.exit(code);
