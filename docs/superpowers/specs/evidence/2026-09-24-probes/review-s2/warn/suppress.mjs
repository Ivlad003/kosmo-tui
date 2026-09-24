const orig = process.emitWarning;
process.emitWarning = function (w, ...rest) { const t = typeof w === "string" ? rest[0]?.type ?? rest[0] : w?.name; if (t === "ExperimentalWarning" && String(w?.message ?? w).includes("SQLite")) return; return orig.call(this, w, ...rest); };
