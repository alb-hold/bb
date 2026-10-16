import { appendFileSync } from "node:fs";

appendFileSync(
  process.env.BB_SHUTDOWN_MARKER,
  `${process.env.BB_CHILD_NAME}:ready
`,
);
process.on("SIGTERM", () => {
  if (process.env.BB_IGNORE_SIGTERM === "true") return;

  setTimeout(() => {
    appendFileSync(
      process.env.BB_SHUTDOWN_MARKER,
      `${process.env.BB_CHILD_NAME}:stopped
`,
    );
    process.exit(0);
  }, Number(process.env.BB_CHILD_STOP_DELAY_MS));
});
setInterval(() => undefined, 1_000);
