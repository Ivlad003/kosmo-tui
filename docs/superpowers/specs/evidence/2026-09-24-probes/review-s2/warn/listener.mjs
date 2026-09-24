process.removeAllListeners("warning");
process.on("warning", (w) => { if (w.name !== "ExperimentalWarning") process.stderr.write(String(w) + "\n"); });
const { DatabaseSync } = await import("node:sqlite");
new DatabaseSync(":memory:"); console.log("listener+dynamic done");
