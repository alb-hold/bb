import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveAppServerLaunch } from "./bridge.js";
import { trackTestProcess } from "./test-processes.js";
import { parseModelCatalog } from "../models.js";

const POOL_TOKEN = "pool-token-for-no-local-auth-test";
const modelCatalogBody = readFileSync(
  new URL("./pool-model-catalog.fixture.json", import.meta.url),
  "utf8",
);

interface RecordedRequest {
  method: string;
  url: string;
  authorization: string | undefined;
  poolToken: string | undefined;
}

const codexAvailable =
  spawnSync("codex", ["--version"], { stdio: "ignore" }).status === 0;

function jwt(payload: Record<string, unknown>): string {
  const part = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none", typ: "JWT" })}.${part(payload)}.sig`;
}

function expiredChatgptAuthFile(): string {
  const claims = {
    exp: 1,
    email: "host@example.test",
    "https://api.openai.com/auth": {
      chatgpt_plan_type: "pro",
      chatgpt_account_id: "acct-host",
      chatgpt_user_id: "user-host",
    },
  };
  return JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      id_token: jwt(claims),
      access_token: jwt(claims),
      refresh_token: "host-refresh-token",
      account_id: "acct-host",
    },
    last_refresh: "2020-01-01T00:00:00Z",
  });
}

const processCleanups: Array<() => Promise<void>> = [];

let codexHome: string;
let server: Server;
let requests: RecordedRequest[];
let baseUrl: string;

function handle(request: IncomingMessage, response: ServerResponse): void {
  request.resume();
  request.on("end", () => {
    const url = request.url ?? "";
    requests.push({
      method: request.method ?? "",
      url,
      authorization: request.headers.authorization,
      poolToken: request.headers["x-bb-account-pool-token"] as
        | string
        | undefined,
    });
    if (url.startsWith("/pool/v1/models")) {
      response.setHeader("content-type", "application/json");
      response.end(modelCatalogBody);
      return;
    }
    if (url.startsWith("/pool/v1/responses")) {
      response.setHeader("content-type", "text/event-stream");
      const send = (event: string, data: unknown) =>
        response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      send("response.created", {
        type: "response.created",
        response: { id: "resp-1" },
      });
      send("response.output_item.done", {
        type: "response.output_item.done",
        item: {
          type: "message",
          role: "assistant",
          id: "msg-1",
          content: [{ type: "output_text", text: "pool-reply-ok" }],
        },
      });
      send("response.completed", {
        type: "response.completed",
        response: {
          id: "resp-1",
          usage: {
            input_tokens: 1,
            input_tokens_details: null,
            output_tokens: 1,
            output_tokens_details: null,
            total_tokens: 2,
          },
        },
      });
      response.end();
      return;
    }
    response.statusCode = url.startsWith("/oauth/token") ? 401 : 404;
    response.end("{}");
  });
}

beforeEach(async () => {
  codexHome = mkdtempSync(path.join(os.tmpdir(), "bb-pool-no-local-auth-"));
  requests = [];
  server = createServer(handle);
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  while (processCleanups.length > 0) await processCleanups.pop()?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(codexHome, { recursive: true, force: true });
});

function runPooledTurn(): Promise<{ status: number | null; output: string }> {
  const env = {
    ...process.env,
    CODEX_HOME: codexHome,
    CODEX_OPENAI_BASE_URL: `${baseUrl}/pool/v1`,
    CODEX_POOL_AUTH_TOKEN: POOL_TOKEN,
    CODEX_REFRESH_TOKEN_URL_OVERRIDE: `${baseUrl}/oauth/token`,
  };
  const launch = resolveAppServerLaunch(env);
  return new Promise((resolve, reject) => {
    const child = spawn(
      launch.command,
      [
        "exec",
        "--skip-git-repo-check",
        ...launch.args.slice(1),
        "-m",
        "pool-test-model",
        "go",
      ],
      {
        env,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    processCleanups.push(trackTestProcess(child));
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.on("error", reject);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, output });
    });
  });
}

describe.skipIf(!codexAvailable)("pooled Codex without a local login", () => {
  it("completes a turn with an empty CODEX_HOME and never creates auth.json", async () => {
    const turn = await runPooledTurn();
    expect(turn.output).toContain("pool-reply-ok");
    expect(turn.status).toBe(0);
    const responses = requests.filter((request) =>
      request.url.startsWith("/pool/v1/responses"),
    );
    expect(responses).toHaveLength(1);
    for (const request of requests) {
      expect(request.poolToken).toBe(POOL_TOKEN);
    }
    expect(requests.some((request) => request.url.startsWith("/oauth"))).toBe(
      false,
    );
    expect(existsSync(path.join(codexHome, "auth.json"))).toBe(false);
  }, 90_000);

  it("leaves the host's own ChatGPT login untouched and never refreshes it", async () => {
    const authFile = path.join(codexHome, "auth.json");
    writeFileSync(authFile, expiredChatgptAuthFile());
    const before = createHash("sha256")
      .update(readFileSync(authFile))
      .digest("hex");
    const turn = await runPooledTurn();
    expect(turn.output).toContain("pool-reply-ok");
    expect(turn.status).toBe(0);
    expect(requests.some((request) => request.url.startsWith("/oauth"))).toBe(
      false,
    );
    for (const request of requests) {
      expect(request.authorization).not.toContain("host-refresh-token");
      expect(request.poolToken).toBe(POOL_TOKEN);
    }
    const after = createHash("sha256")
      .update(readFileSync(authFile))
      .digest("hex");
    expect(after).toBe(before);
  }, 90_000);

  it("lists the pool's model catalog through app-server model/list with an empty CODEX_HOME", async () => {
    const env = {
      ...process.env,
      CODEX_HOME: codexHome,
      CODEX_OPENAI_BASE_URL: `${baseUrl}/pool/v1`,
      CODEX_POOL_AUTH_TOKEN: POOL_TOKEN,
    };
    const launch = resolveAppServerLaunch(env);
    const result = await new Promise<unknown>((resolve, reject) => {
      const child = spawn(launch.command, launch.args, {
        env,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "ignore"],
      });
      processCleanups.push(trackTestProcess(child));
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("model/list timed out"));
      }, 60_000);
      let buffered = "";
      const send = (message: unknown) =>
        child.stdin.write(`${JSON.stringify(message)}\n`);
      child.on("error", reject);
      child.stdout.on("data", (chunk: Buffer) => {
        buffered += chunk.toString();
        for (;;) {
          const newline = buffered.indexOf("\n");
          if (newline < 0) return;
          const line = buffered.slice(0, newline);
          buffered = buffered.slice(newline + 1);
          const message = JSON.parse(line) as { id?: number; result?: unknown };
          if (message.id === 1) {
            send({ method: "initialized" });
            send({ id: 2, method: "model/list", params: {} });
          }
          if (message.id === 2) {
            clearTimeout(timer);
            child.kill("SIGKILL");
            resolve(message.result);
          }
        }
      });
      send({
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "bb", version: "1.0.0", title: null },
          capabilities: { experimentalApi: true },
        },
      });
    });
    const catalog = parseModelCatalog(result);
    const ids = catalog.models.map((model) => model.model);
    console.log(
      `POOL MODEL LIST count=${ids.length} ids=${JSON.stringify(ids)} catalogRequests=${JSON.stringify(
        requests
          .filter((request) => request.url.startsWith("/pool/v1/models"))
          .map((request) => ({
            url: request.url,
            bearer: request.authorization === `Bearer ${POOL_TOKEN}`,
            poolHeader: request.poolToken === POOL_TOKEN,
          })),
      )}`,
    );
    expect(ids).toEqual(expect.arrayContaining(["pool-catalog-probe"]));
    const catalogRequests = requests.filter((request) =>
      request.url.startsWith("/pool/v1/models"),
    );
    expect(catalogRequests.length).toBeGreaterThan(0);
    for (const request of catalogRequests) {
      expect(request.authorization).toBe(`Bearer ${POOL_TOKEN}`);
      expect(request.poolToken).toBe(POOL_TOKEN);
    }
    expect(existsSync(path.join(codexHome, "auth.json"))).toBe(false);
  }, 90_000);
});
