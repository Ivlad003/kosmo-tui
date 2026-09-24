// Throwaway: does a main-context helper on globalThis reach a breakpoint condition inside a vm context
// (the shape of Next dev edge middleware, which runs via edge-runtime vm.runInContext)?
const inspector = require("node:inspector"); const vm = require("node:vm");
const s = new inspector.Session(); s.connect();
const post = (m, p) => new Promise((res, rej) => s.post(m, p, (e, r) => e ? rej(e) : res(r)));
const events = []; const scripts = {};
s.on("Runtime.exceptionThrown", ({ params }) => events.push("exceptionThrown: " + (params.exceptionDetails.exception?.description || params.exceptionDetails.text).split("\n")[0]));
s.on("Runtime.executionContextCreated", ({ params }) => events.push("contextCreated id=" + params.context.id + " name=" + params.context.name));
s.on("Debugger.scriptParsed", ({ params }) => { if (params.url.includes("edge-mw")) scripts[params.url] = params; });
(async () => {
  await post("Runtime.enable"); await post("Debugger.enable");
  Object.defineProperty(globalThis, Symbol.for("kosmo-tui"), { value: (tag) => { events.push("helper called: " + tag); return false; }, enumerable: false });
  const ctx = vm.createContext({});
  vm.runInContext("function middleware(req){ const x = req + 1;\n return x; }", ctx, { filename: "edge-mw.js" });
  const main = new vm.Script("function mainFn(req){ const x = req + 1;\n return x; }", { filename: "main-edge-mw-main.js" }); main.runInThisContext();
  for (const url of Object.keys(scripts)) {
    const sc = scripts[url];
    await post("Debugger.setBreakpoint", { location: { scriptId: sc.scriptId, lineNumber: 1, columnNumber: 1 }, condition: '(globalThis[Symbol.for("kosmo-tui")]("' + url + '"), false)' });
    events.push("bp set in " + url + " ctx=" + sc.executionContextId);
  }
  vm.runInContext("middleware(1)", ctx); mainFn(1);
  await new Promise((r) => setTimeout(r, 50));
  s.disconnect(); console.log(events.join("\n"));
})();
