const prev = process.listeners("warning"); process.removeAllListeners("warning");
process.on("warning", (w) => { if (w.name === "ExperimentalWarning" && /SQLite/.test(w.message)) return; for (const l of prev) l(w); });
