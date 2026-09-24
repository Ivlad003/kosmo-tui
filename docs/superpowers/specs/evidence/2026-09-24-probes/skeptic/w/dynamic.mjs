import "./filter.mjs";
const { DatabaseSync } = await import("node:sqlite");
new DatabaseSync(":memory:"); console.log("dynamic done");
