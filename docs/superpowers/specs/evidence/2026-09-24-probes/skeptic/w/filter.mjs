const orig = process.emitWarning;
process.emitWarning = function (w, ...a) { const type = typeof a[0] === "string" ? a[0] : a[0]?.type; if ((type === "ExperimentalWarning" || w?.name === "ExperimentalWarning") && /SQLite/.test(String(w?.message ?? w))) return; return orig.call(this, w, ...a); };
