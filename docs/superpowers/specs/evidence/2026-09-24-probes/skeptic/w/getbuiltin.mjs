import "./filter.mjs";
const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
new DatabaseSync(":memory:"); console.log("getBuiltinModule done");
