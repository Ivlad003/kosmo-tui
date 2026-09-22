// Child-process review writer for the concurrency tests. Uses the built dist/.
//
//   node review-writer.mjs <projectRoot> <mode> <label> [count]
//
//   mode "new":    <count> sessions with -n, one todo each, closed right away
//   mode "resume": one session that resumes if it can, adds one todo, prints the
//                  result and keeps its lock until stdin ends
//
// Every result is printed as one JSON line on stdout.
import { openReviewSession, resolveReviewCapability } from "../../dist/review.js";

const [root, mode, label, countText] = process.argv.slice(2);
const capability = await resolveReviewCapability({ readOnly: false, oneShot: false, projectRoot: root, cwd: root });
const base = {
  capability,
  sourceRef: { projectId: "shop", datasetId: "imported:shop", sourceRevision: "rev-42" },
  sourceLabel: "export ./trace-export.json",
  dialect: "lisp",
  traceTextVersion: 2
};

if (mode === "new") {
  for (let index = 0; index < Number(countText ?? "1"); index += 1) {
    const session = await openReviewSession({ ...base, noResume: true });
    const result = await session.addTodo(`${label}-${index}`);
    await session.close();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
} else {
  const session = await openReviewSession(base);
  const result = await session.addTodo(label);
  process.stdout.write(`${JSON.stringify({ ...result, resumedFrom: session.resumedFrom })}\n`);
  process.stdin.resume();
  await new Promise((resolve) => process.stdin.on("end", resolve));
  await session.close();
}
