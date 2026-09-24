const base = "http://127.0.0.1:5299";
for (const p of ["/src/plain.ts", "/src/plainjs.js", "/src/main.jsx"]) {
  const t = await (await fetch(base + p)).text();
  const m = t.match(/\/\/# sourceMappingURL=(\S+)\s*$/);
  if (!m) { console.log(p, "no map"); continue; }
  const map = JSON.parse(Buffer.from(m[1].split(",")[1], "base64").toString());
  console.log(p, "| file:", map.file, "| sources:", map.sources, "| sourcesContent?", !!map.sourcesContent);
}
