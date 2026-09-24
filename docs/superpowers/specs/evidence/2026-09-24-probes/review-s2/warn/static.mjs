import "./suppress.mjs";
import { DatabaseSync } from "node:sqlite";
new DatabaseSync(":memory:"); console.log("static-import done");
