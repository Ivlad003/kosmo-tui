const TM = require("/Users/kosmodev/Documents/pet_project/kosmo-callflow/node_modules/@jridgewell/trace-mapping");
const fs = require("fs");
for (const b of ["tsc", "swc"]) {
  const f = process.argv[2] + "/nest-out/" + b + "/cart.controller.js.map";
  const m = new TM.TraceMap(fs.readFileSync(f, "utf8"), "file://" + f);
  const src = m.resolvedSources[0];
  const rows = [];
  for (const L of [13, 14, 16, 17, 18, 22, 23]) {
    const a = TM.generatedPositionFor(m, { source: src, line: L, column: 0, bias: TM.LEAST_UPPER_BOUND });
    const n = TM.generatedPositionFor(m, { source: src, line: L + 1, column: 0, bias: TM.LEAST_UPPER_BOUND });
    const all = TM.allGeneratedPositionsFor(m, { source: src, line: L, column: 0 });
    rows.push(`L${L}: LUB=${a.line}:${a.column} next=${n.line}:${n.column} ${a.line > n.line || (a.line === n.line && a.column > n.column) ? "INVERTED" : ""} allGen(col0)=${JSON.stringify(all.map(x => x.line + ":" + x.column))}`);
  }
  console.log(b, "resolvedSource", src, "\n  " + rows.join("\n  "));
}
