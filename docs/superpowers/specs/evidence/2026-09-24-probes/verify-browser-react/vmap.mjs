const base = "http://127.0.0.1:5299";
const show = async (p) => {
  const t = await (await fetch(base + p)).text();
  const m = t.match(/\/\/# sourceMappingURL=(\S+)\s*$/);
  if (!m) { console.log(p, "-> no map; imports:", [...t.matchAll(/from "([^"]+)"/g)].map((x) => x[1]).slice(0, 8)); return t; }
  let map, kind;
  if (m[1].startsWith("data:")) { kind = "inline"; map = JSON.parse(Buffer.from(m[1].split(",")[1], "base64").toString()); }
  else { kind = "separate " + m[1]; map = await (await fetch(new URL(m[1], base + p))).json(); }
  console.log(p, "->", kind, "| file:", map.file, "| sourceRoot:", map.sourceRoot, "| sources:", map.sources.slice(0, 3), "| sections:", !!map.sections, "| imports:", [...t.matchAll(/from "([^"]+)"/g)].map((x) => x[1]).slice(0, 8));
  return t;
};
const app = await show("/src/App.jsx");
console.log("jsxDEV fileName sample:", (app.match(/fileName: "([^"]+)"/) || [])[1]);
const utilUrl = [...app.matchAll(/from "([^"]+util[^"]*)"/g)].map((x) => x[1])[0];
if (utilUrl) await show(utilUrl);
const reactDom = [...app.matchAll(/from "([^"]+)"/g)].map((x) => x[1]).find((u) => u.includes(".vite/deps/react"));
if (reactDom) await show(reactDom);
