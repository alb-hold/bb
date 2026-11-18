import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const control = process.argv[2];
const config = JSON.parse(fs.readFileSync(path.join(control, "config.json"), "utf8"));
fs.writeFileSync(
  path.join(control, "env.json"),
  JSON.stringify({
    names: Object.keys(process.env).sort(),
    cwd: process.cwd(),
    home: process.env.HOME,
    geminiHome: process.env.GEMINI_HOME,
    fileStorage: process.env.AGY_ACP_FORCE_FILE_STORAGE,
    pid: process.pid,
  }),
);
fs.writeFileSync(path.join(control, "runtime.pid"), String(process.pid));

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

function settingsAuthType() {
  try {
    return JSON.parse(
      fs.readFileSync(
        path.join(process.env.GEMINI_HOME, "antigravity-acp", "settings.json"),
        "utf8",
      ),
    ).auth?.type;
  } catch {
    return undefined;
  }
}

function authenticate(id) {
  if (settingsAuthType() !== "oauth-personal") {
    send({ id, error: { code: -32000, message: "settings.json is not oauth-personal" } });
    return;
  }
  if (config.browserMode !== "none")
    spawnSync(process.env.BROWSER, [config.url ?? "https://accounts.google.com/o/oauth2/v2/auth?fake=1"], {
      stdio: "ignore",
    });
  const timer = setInterval(() => {
    if (fs.existsSync(path.join(control, "approve"))) {
      clearInterval(timer);
      if (config.token !== false) {
        const file = path.join(process.env.GEMINI_HOME, "antigravity-acp", "acp_token.json");
        fs.writeFileSync(file, JSON.stringify(config.token ?? { fake: "token" }), { mode: 0o600 });
      }
      send({ id, result: {} });
    } else if (fs.existsSync(path.join(control, "deny"))) {
      clearInterval(timer);
      send({ id, error: { code: -32000, message: "secret-looking runtime text" } });
    }
  }, 25);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf("\n");
    if (line === "") continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      if (config.version === null) continue;
      send({
        id: message.id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: "antigravity-acp", version: config.version },
          authMethods: [
            ...(config.offerOAuth === false ? [] : [{ id: "oauth-personal", name: "Log in with Google" }]),
            { id: "gemini-api-key", name: "Gemini API key" },
          ],
        },
      });
    } else if (message.method === "authenticate") {
      authenticate(message.id);
    } else if (message.id !== undefined) {
      send({ id: message.id, error: { code: -32601, message: "Method not found" } });
    }
  }
});
process.stdin.on("end", () => process.exit(0));
if (config.lingerOnTerm)
  process.on("SIGTERM", () => {
    fs.writeFileSync(path.join(control, "terminating"), "");
    setTimeout(() => process.exit(0), 1_500);
  });
