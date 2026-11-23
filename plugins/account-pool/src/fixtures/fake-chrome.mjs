import fs from "node:fs";
import path from "node:path";

const control = process.argv[2];
const args = process.argv.slice(3);
const profileArg = args.find((arg) => arg.startsWith("--user-data-dir="));
const profile = profileArg?.slice("--user-data-dir=".length);
if (fs.existsSync(path.join(control, "never-open"))) {
  fs.writeFileSync(path.join(control, "stuck-browser.json"), JSON.stringify({ pid: process.pid }));
  setInterval(() => {}, 1_000);
} else {
fs.writeFileSync(
  path.join(control, "browser.json"),
  JSON.stringify({ args, pid: process.pid }),
);
if (profile !== undefined) {
  fs.mkdirSync(path.join(profile, "Default"), { recursive: true });
  fs.writeFileSync(path.join(profile, "Default", "Cookies"), "fake cookie jar");
  fs.symlinkSync(`fake-host-${process.pid}`, path.join(profile, "SingletonLock"));
}
if (fs.existsSync(path.join(control, "close-window"))) process.exit(0);
process.on("SIGTERM", () => {
  if (profile !== undefined)
    fs.writeFileSync(path.join(profile, "Default", "Last Session"), "flushed");
  process.exit(0);
});
setInterval(() => {}, 1_000);
}
