const S = "/Users/kosmodev/Documents/pet_project/kosmo-callflow/node_modules/@opentelemetry/semantic-conventions/build/src/";
const stable = require(S + "stable_attributes.js"), inc = require(S + "experimental_attributes.js");
const KEY = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;
const names = (m) => Object.entries(m).filter(([k, v]) => k.startsWith("ATTR_") && typeof v === "string").map(([, v]) => v);
const fns = (m) => Object.entries(m).filter(([k, v]) => k.startsWith("ATTR_") && typeof v === "function").map(([k, f]) => [k, f]);
const templ = [...fns(stable), ...fns(inc)];
console.log("template (function) attrs:", templ.length, templ.slice(0, 12).map(([k]) => k).join(" "));
const samples = [["http.request.header", "content-type"], ["http.request.header", "x-forwarded-for"], ["k8s.pod.label", "app.kubernetes.io/name"], ["rpc.grpc.request.metadata", "x-request-id"]];
for (const [k, f] of templ) { const sample = f("content-type"); if (!KEY.test(sample)) console.log("  FAIL KEY:", k, "->", sample); }
// spec 8.3 (current) word-based masking
const WORDS = new Set(["password","passwd","pwd","secret","token","authorization","cookie","credential","credentials","jwt","bearer"]);
const PAIRS = ["api key","session id","private key","access key","client secret"];
const WHOLE = new Set(["apikey","sessionid","sid","set-cookie"]);
const words = (k) => k.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[-_.\s]+/).filter(Boolean);
const masked = (k) => { if (WHOLE.has(k.toLowerCase())) return true; const w = words(k); if (w.some((x) => WORDS.has(x))) return true; const j = " " + w.join(" ") + " "; return PAIRS.some((p) => j.includes(" " + p + " ")); };
const all = [...names(stable), ...names(inc)];
console.log("OTel ATTR names masked by spec 8.3:", all.filter(masked));
const proposed = ["http.request.method","http.route","http.response.status_code","react.strict_mode.duplicate","next.request.type","next.action.id","nest.binding","nest.di_scope","nest.handler","express.handoff","express.mount_path","express.next_calls","error.type","react.effect.type","react.effect.phase","session.id","http.request.header.authorization","http.request.header.cookie","http.response.header.set-cookie","next.session_state","url.query","url.full"];
for (const k of proposed) console.log(k.padEnd(36), "KEY:", KEY.test(k), " masked:", masked(k));
