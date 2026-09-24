const stable = require("/Users/kosmodev/Documents/pet_project/kosmo-callflow/node_modules/@opentelemetry/semantic-conventions/build/src/stable_attributes.js");
const inc = require("/Users/kosmodev/Documents/pet_project/kosmo-callflow/node_modules/@opentelemetry/semantic-conventions/build/src/experimental_attributes.js");
const KEY = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;
const KIND = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/;
const names = (m) => Object.entries(m).filter(([k, v]) => k.startsWith("ATTR_") && typeof v === "string").map(([, v]) => v);
for (const [label, list] of [["stable", names(stable)], ["incubating", names(inc)]]) {
  const bad = list.filter((n) => !KEY.test(n));
  const maxLen = Math.max(...list.map((n) => Buffer.byteLength(n)));
  console.log(label, "attrs:", list.length, "fail KEY:", bad.length, bad.slice(0, 8), "max key bytes:", maxLen);
}
const kinds = ["function","http.server","http.client","express.middleware","express.router","express.handler","express.error-handler",
  "nest.middleware","nest.guard","nest.interceptor","nest.pipe","nest.handler","nest.filter",
  "react.render","react.effect","react.commit","next.middleware","next.route-handler","next.server-action","next.render"];
console.log("kinds fail KIND:", kinds.filter((k) => !KIND.test(k)));
const mask = /password|passwd|token|secret|authorization|cookie|api[-_]?key|session/i;
console.log("stable keys hit by mask regex:", names(stable).filter((n) => mask.test(n)));
console.log("proposed keys hit by mask:", ["http.request.method","http.route","http.response.status_code","react.strict_mode.duplicate","next.request.type","next.action.id","nest.binding","express.handoff","express.mount_path","error.type","nest.di_scope"].filter((n)=>mask.test(n)));
