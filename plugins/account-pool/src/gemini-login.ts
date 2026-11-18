import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { geminiCredentialsPath } from "./gemini-credentials.js";
import { SUPPORTED_RUNTIME_VERSION } from "./gemini-gateway.js";


export const GEMINI_LOGIN_TIMEOUT_MS = 5 * 60 * 1_000;
const URL_WAIT_MS = 60_000;
const INITIALIZE_WAIT_MS = 60_000;
const KILL_GRACE_MS = 5_000;
const RESULT_TTL_MS = 10 * 60 * 1_000;
const POLL_MS = 100;
const OAUTH_METHOD = "oauth-personal";
const LOGIN_ROOT = "gemini-login";
const SIGN_IN_PAGE = /^https:\/\/accounts\.google\.com\//u;

export const ANTIGRAVITY_AGENT_ID = "antigravity-acp";
export const DEFAULT_CHROME_COMMAND =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export interface CommandSpec {
  command: string;
  args: readonly string[];
}

export type GeminiLoginFailure =
  | "runtime_missing"
  | "runtime_version"
  | "browser_missing"
  | "sign_in_failed"
  | "sign_in_cancelled"
  | "sign_in_timeout"
  | "token_missing"
  | "import_failed";

export class GeminiLoginError extends Error {
  constructor(
    readonly reason: GeminiLoginFailure,
    message: string,
  ) {
    super(message);
    this.name = "GeminiLoginError";
  }
}

export interface GeminiLoginTarget {
  label: string | null;
  priority?: number;
}

export interface GeminiLoginAccount {
  id: string;
  label: string;
}

export interface GeminiLoginOptions {
  dataDir: string;
  resolveRuntime: () => Promise<CommandSpec | null>;
  browser?: CommandSpec;
  importAccount: (
    home: string,
    target: GeminiLoginTarget,
  ) => Promise<GeminiLoginAccount>;
  timeoutMs?: number;
  now?: () => number;
}

export interface GeminiLoginStart {
  sessionId: string;
  authorizeUrl: string;
  expiresAt: number;
}

export type GeminiLoginResult =
  | { status: "complete"; account: GeminiLoginAccount }
  | { status: "error"; reason: GeminiLoginFailure; message: string };

interface Session {
  sessionId: string;
  dir: string;
  runtime: ChildProcess | null;
  browser: ChildProcess | null;
  cancelled: { reason: GeminiLoginFailure; message: string } | null;
  signedIn: boolean;
  importing: boolean;
  wake: () => void;
  result: Promise<GeminiLoginResult>;
  settled: GeminiLoginResult | null;
  settledAt: number | null;
}

const CANCELLED = {
  reason: "sign_in_cancelled",
  message: "Gemini sign-in was cancelled. No account was added.",
} as const;

export function antigravityLaunchFromCustomAgents(
  value: unknown,
): CommandSpec | null {
  let entries: unknown = value;
  if (typeof value === "string") {
    try {
      entries = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!Array.isArray(entries)) return null;
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const agent = entry as Record<string, unknown>;
    if (agent.id !== ANTIGRAVITY_AGENT_ID) continue;
    if (typeof agent.command !== "string" || agent.command === "") return null;
    const args = Array.isArray(agent.args)
      ? agent.args.filter((arg): arg is string => typeof arg === "string")
      : [];
    return { command: agent.command, args };
  }
  return null;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function privateDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { mode: 0o700 });
  await fs.chmod(dir, 0o700);
}

async function exists(file: string): Promise<boolean> {
  return fs.lstat(file).then(
    () => true,
    () => false,
  );
}

function alive(child: ChildProcess | null): child is ChildProcess {
  return child !== null && child.exitCode === null && child.signalCode === null;
}

function exited(child: ChildProcess): Promise<void> {
  if (!alive(child)) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
    }
  }
}

async function stop(child: ChildProcess | null): Promise<void> {
  if (child === null) return;
  if (alive(child)) {
    signalGroup(child, "SIGTERM");
    const done = exited(child);
    const graceful = await Promise.race([
      done.then(() => true),
      delay(KILL_GRACE_MS).then(() => false),
    ]);
    if (!graceful) {
      signalGroup(child, "SIGKILL");
      await done;
    }
  }
  signalGroup(child, "SIGKILL");
}

class AcpClient {
  private nextId = 1;
  private buffer = "";
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: AcpError) => void }
  >();
  private closed = false;

  constructor(private readonly child: ChildProcess) {
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.receive(chunk));
    child.on("exit", () => this.close());
    child.stdin?.on("error", () => this.close());
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new AcpError("closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  private write(message: unknown): void {
    if (this.closed) return;
    this.child.stdin?.write(`${JSON.stringify(message)}\n`);
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line !== "") this.handle(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  private handle(line: string): void {
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null) return;
      message = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    const id = message.id;
    if (typeof message.method === "string") {
      if (id !== undefined && id !== null)
        this.write({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: "Method not found" },
        });
      return;
    }
    if (typeof id !== "number") return;
    const waiter = this.pending.get(id);
    if (waiter === undefined) return;
    this.pending.delete(id);
    const error = message.error;
    if (error !== undefined && error !== null) {
      const code =
        typeof error === "object" &&
        typeof (error as { code?: unknown }).code === "number"
          ? (error as { code: number }).code
          : null;
      waiter.reject(new AcpError("error", code));
      return;
    }
    waiter.resolve(message.result);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.pending.values())
      waiter.reject(new AcpError("closed"));
    this.pending.clear();
  }
}

class AcpError extends Error {
  constructor(
    readonly kind: "closed" | "error",
    readonly code: number | null = null,
  ) {
    super(kind === "closed" ? "The runtime exited." : `ACP error ${code ?? "?"}`);
  }
}

function runtimeVersion(result: unknown): string | null {
  if (typeof result !== "object" || result === null) return null;
  const info = (result as { agentInfo?: unknown }).agentInfo;
  if (typeof info !== "object" || info === null) return null;
  const version = (info as { version?: unknown }).version;
  return typeof version === "string" ? version : null;
}

function offersOAuth(result: unknown): boolean {
  if (typeof result !== "object" || result === null) return false;
  const methods = (result as { authMethods?: unknown }).authMethods;
  return (
    Array.isArray(methods) &&
    methods.some(
      (method) =>
        typeof method === "object" &&
        method !== null &&
        (method as { id?: unknown }).id === OAUTH_METHOD,
    )
  );
}

export class GeminiLogin {
  private readonly sessions = new Map<string, Session>();
  private readonly root: string;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly browser: CommandSpec;
  private disposed = false;
  private readonly shutdown = new AbortController();
  private starting: Promise<GeminiLoginStart> | null = null;

  constructor(private readonly options: GeminiLoginOptions) {
    this.root = path.join(options.dataDir, LOGIN_ROOT);
    this.timeoutMs = options.timeoutMs ?? GEMINI_LOGIN_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
    this.browser = options.browser ?? {
      command: DEFAULT_CHROME_COMMAND,
      args: [],
    };
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  pending(): string | null {
    for (const session of this.sessions.values())
      if (session.settled === null) return session.sessionId;
    return null;
  }

  async start(
    target: GeminiLoginTarget,
    signal?: AbortSignal,
  ): Promise<GeminiLoginStart> {
    this.live();
    if (signal?.aborted) throw new GeminiLoginError(CANCELLED.reason, CANCELLED.message);
    this.expireResults();
    const running = this.pending();
    if (running !== null) {
      throw new Error(
        `A Gemini sign-in is already running (session ${running}). Finish it, or wait for it with \`bb pool account login-poll --session ${running}\`, before starting another.`,
      );
    }
    if (this.starting !== null)
      throw new Error("A Gemini sign-in is already starting; wait for it before starting another.");
    const abort =
      signal === undefined
        ? this.shutdown.signal
        : AbortSignal.any([signal, this.shutdown.signal]);
    const starting = this.startOne(target, abort);
    this.starting = starting;
    try {
      return await starting;
    } finally {
      if (this.starting === starting) this.starting = null;
    }
  }

  private live(abort?: AbortSignal): void {
    if (this.disposed)
      throw new GeminiLoginError(
        "sign_in_cancelled",
        "Gemini sign-in is shutting down. No account was added.",
      );
    if (abort?.aborted) throw new GeminiLoginError(CANCELLED.reason, CANCELLED.message);
  }

  private unlessCancelled(session: Session): void {
    if (session.cancelled !== null)
      throw new GeminiLoginError(session.cancelled.reason, session.cancelled.message);
  }

  private async unlessAborted<T>(work: Promise<T>, abort: AbortSignal): Promise<T> {
    let onAbort = () => {};
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new GeminiLoginError(CANCELLED.reason, CANCELLED.message));
      if (abort.aborted) onAbort();
      else abort.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([work, aborted]);
    } finally {
      abort.removeEventListener("abort", onAbort);
    }
  }

  private async startOne(
    target: GeminiLoginTarget,
    abort: AbortSignal,
  ): Promise<GeminiLoginStart> {
    const runtime = await this.unlessAborted(this.checkedRuntime(), abort);
    this.live(abort);
    await this.unlessAborted(this.sweep(), abort);
    this.live(abort);
    await fs.mkdir(this.options.dataDir, { recursive: true, mode: 0o700 });
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    await fs.chmod(this.root, 0o700);
    this.live(abort);
    const sessionId = randomUUID();
    const dir = path.join(this.root, sessionId);
    await privateDir(dir);
    let wake = () => {};
    const session: Session = {
      sessionId,
      dir,
      runtime: null,
      browser: null,
      cancelled: null,
      signedIn: false,
      importing: false,
      wake: () => wake(),
      result: Promise.resolve({ status: "error", ...CANCELLED }),
      settled: null,
      settledAt: null,
    };
    const woken = new Promise<void>((resolve) => {
      wake = resolve;
    });
    this.sessions.set(sessionId, session);
    const deadline = this.now() + this.timeoutMs;
    let authenticated: Promise<unknown>;
    let authorizeUrl: string;
    const onAbort = () => this.cancel(sessionId);
    abort.addEventListener("abort", onAbort, { once: true });
    try {
      if (abort.aborted) onAbort();
      ({ authenticated, authorizeUrl } = await this.open(
        session,
        runtime,
        woken,
      ));
      if (session.cancelled !== null) throw new GeminiLoginError(CANCELLED.reason, CANCELLED.message);
    } catch (error) {
      await this.cleanup(session);
      this.sessions.delete(sessionId);
      throw error;
    } finally {
      abort.removeEventListener("abort", onAbort);
    }
    session.result = this.finish(session, target, authenticated, woken, deadline);
    void session.result.then((result) => {
      session.settled = result;
      session.settledAt = this.now();
    });
    return { sessionId, authorizeUrl, expiresAt: deadline };
  }

  async wait(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<GeminiLoginResult> {
    const session = this.sessions.get(sessionId);
    if (session === undefined)
      return {
        status: "error",
        reason: "sign_in_failed",
        message: "Gemini sign-in session not found or expired.",
      };
    const onAbort = () => this.cancel(sessionId);
    if (signal?.aborted) onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      return await session.result;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  cancel(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined || session.settled !== null || session.importing)
      return;
    session.cancelled ??= CANCELLED;
    session.wake();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.shutdown.abort();
    for (const session of this.sessions.values()) this.cancel(session.sessionId);
    await this.starting?.catch(() => {});
    const left = [...this.sessions.values()];
    for (const session of left) this.cancel(session.sessionId);
    await Promise.all(left.map((session) => session.result.catch(() => {})));
    this.sessions.clear();
  }

  private async checkedRuntime(): Promise<CommandSpec> {
    const runtime = await this.options.resolveRuntime().catch(() => null);
    if (runtime === null)
      throw new GeminiLoginError(
        "runtime_missing",
        `No antigravity-acp agent is configured. Add the "${ANTIGRAVITY_AGENT_ID}" entry to provider-acp's customAgents setting, pointing at the antigravity-acp ${SUPPORTED_RUNTIME_VERSION} runtime.`,
      );
    if (!path.isAbsolute(runtime.command))
      throw new GeminiLoginError(
        "runtime_missing",
        `The "${ANTIGRAVITY_AGENT_ID}" agent's command is not an absolute path: ${runtime.command}`,
      );
    try {
      await fs.access(runtime.command, fsConstants.X_OK);
    } catch {
      throw new GeminiLoginError(
        "runtime_missing",
        `The antigravity-acp runtime is missing or not executable: ${runtime.command}`,
      );
    }
    return runtime;
  }

  private async open(
    session: Session,
    runtime: CommandSpec,
    woken: Promise<void>,
  ): Promise<{ authenticated: Promise<unknown>; authorizeUrl: string }> {
    const home = path.join(session.dir, "home");
    const runtimeDir = path.join(home, "antigravity-acp");
    await privateDir(home);
    await privateDir(runtimeDir);
    await fs.writeFile(
      path.join(runtimeDir, "settings.json"),
      `${JSON.stringify({ auth: { type: OAUTH_METHOD } })}\n`,
      { mode: 0o600, flag: "wx" },
    );
    const urlFile = path.join(session.dir, "authorize-url");
    const launcher = path.join(session.dir, "open-browser");
    if (launcher.includes(path.delimiter))
      throw new Error(`The sign-in folder path cannot contain "${path.delimiter}".`);
    await fs.writeFile(
      launcher,
      `#!/bin/sh\nprintf '%s\\n' "$1" > ${shellQuote(`${urlFile}.tmp`)} && /bin/mv ${shellQuote(`${urlFile}.tmp`)} ${shellQuote(urlFile)}\n`,
      { mode: 0o700, flag: "wx" },
    );
    this.live();
    this.unlessCancelled(session);
    const child = spawn(runtime.command, [...runtime.args], {
      cwd: session.dir,
      detached: true,
      stdio: ["pipe", "pipe", "ignore"],
      env: {
        HOME: home,
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        GEMINI_HOME: home,
        AGY_ACP_FORCE_FILE_STORAGE: "1",
        BROWSER: launcher,
        ...(process.env.TMPDIR === undefined ? {} : { TMPDIR: process.env.TMPDIR }),
      },
    });
    session.runtime = child;
    child.on("error", () => {});
    const acp = new AcpClient(child);
    const spawned = await new Promise<boolean>((resolve) => {
      child.once("spawn", () => resolve(true));
      child.once("error", () => resolve(false));
    });
    if (!spawned)
      throw new GeminiLoginError(
        "runtime_missing",
        `The antigravity-acp runtime could not be started: ${runtime.command}`,
      );
    const initialized = await this.bounded(
      acp.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
      }),
      INITIALIZE_WAIT_MS,
      woken,
    ).catch(() => undefined);
    if (session.cancelled !== null)
      throw new GeminiLoginError(session.cancelled.reason, session.cancelled.message);
    if (initialized === undefined)
      throw new GeminiLoginError(
        "runtime_version",
        `The antigravity-acp runtime did not answer ACP initialize, so its version is unknown; bb needs ${SUPPORTED_RUNTIME_VERSION}.`,
      );
    const version = runtimeVersion(initialized);
    if (version !== SUPPORTED_RUNTIME_VERSION)
      throw new GeminiLoginError(
        "runtime_version",
        `The configured antigravity-acp runtime is version ${version ?? "unknown"}; Gemini sign-in needs ${SUPPORTED_RUNTIME_VERSION}.`,
      );
    if (!offersOAuth(initialized))
      throw new GeminiLoginError(
        "runtime_version",
        `The antigravity-acp runtime does not offer the "${OAUTH_METHOD}" sign-in.`,
      );
    const authenticated = acp.request("authenticate", { methodId: OAUTH_METHOD });
    authenticated.catch(() => {});
    const authorizeUrl = await this.awaitUrl(urlFile, authenticated, woken, session);
    try {
      await fs.rm(urlFile, { force: true });
    } catch {
    }
    await this.openBrowser(session, authorizeUrl);
    return { authenticated, authorizeUrl };
  }

  private async awaitUrl(
    urlFile: string,
    authenticated: Promise<unknown>,
    woken: Promise<void>,
    session: Session,
  ): Promise<string> {
    let ended = false;
    void authenticated.then(
      () => {
        ended = true;
      },
      () => {
        ended = true;
      },
    );
    let interrupted = false;
    void woken.then(() => {
      interrupted = true;
    });
    const until = this.now() + URL_WAIT_MS;
    while (this.now() < until) {
      if (interrupted && session.cancelled !== null)
        throw new GeminiLoginError(session.cancelled.reason, session.cancelled.message);
      const raw = await fs.readFile(urlFile, "utf8").catch(() => null);
      if (raw !== null) {
        const url = raw.trim();
        if (!SIGN_IN_PAGE.test(url))
          throw new GeminiLoginError(
            "sign_in_failed",
            "The antigravity-acp runtime asked to open a page that is not Google's sign-in page, so bb did not open it.",
          );
        return url;
      }
      if (ended)
        throw new GeminiLoginError(
          "sign_in_failed",
          "The antigravity-acp runtime ended the sign-in before opening Google's sign-in page.",
        );
      await delay(POLL_MS);
    }
    throw new GeminiLoginError(
      "sign_in_timeout",
      "The antigravity-acp runtime did not open Google's sign-in page within a minute.",
    );
  }

  private async openBrowser(session: Session, url: string): Promise<void> {
    const profile = path.join(session.dir, "chrome-profile");
    await privateDir(profile);
    this.live();
    if (session.cancelled !== null)
      throw new GeminiLoginError(session.cancelled.reason, session.cancelled.message);
    const child = spawn(
      this.browser.command,
      [
        ...this.browser.args,
        `--user-data-dir=${profile}`,
        "--use-mock-keychain",
        "--no-first-run",
        "--no-default-browser-check",
        "--new-window",
        url,
      ],
      { detached: true, stdio: "ignore", env: { ...process.env } },
    );
    session.browser = child;
    child.on("error", () => {});
    const spawned = new Promise<boolean>((resolve) => {
      child.once("spawn", () => resolve(true));
      child.once("error", () => resolve(false));
    });
    child.once("exit", () => {
      if (
        session.settled === null &&
        session.cancelled === null &&
        !session.signedIn
      ) {
        session.cancelled = {
          reason: "sign_in_cancelled",
          message:
            "The Chrome sign-in window was closed before sign-in finished. No account was added.",
        };
        session.wake();
      }
    });
    if (!(await spawned))
      throw new GeminiLoginError(
        "browser_missing",
        `Google Chrome was not found at ${this.browser.command}, so bb cannot open a dedicated sign-in window.`,
      );
  }

  private async finish(
    session: Session,
    target: GeminiLoginTarget,
    authenticated: Promise<unknown>,
    woken: Promise<void>,
    deadline: number,
  ): Promise<GeminiLoginResult> {
    try {
      const remaining = Math.max(0, deadline - this.now());
      const outcome = await Promise.race([
        authenticated.then(
          () => "ok" as const,
          (error: unknown) =>
            error instanceof AcpError && error.kind === "error"
              ? ("denied" as const)
              : ("closed" as const),
        ),
        delay(remaining).then(() => "timeout" as const),
        woken.then(() => "woken" as const),
      ]);
      if (session.cancelled !== null) return { status: "error", ...session.cancelled };
      if (outcome === "timeout")
        return {
          status: "error",
          reason: "sign_in_timeout",
          message: `Gemini sign-in did not finish within ${Math.round(this.timeoutMs / 60_000)} minutes. No account was added.`,
        };
      if (outcome !== "ok")
        return {
          status: "error",
          reason: "sign_in_failed",
          message:
            outcome === "denied"
              ? "Google sign-in did not complete (it was declined or failed). No account was added."
              : "The antigravity-acp runtime exited before sign-in finished. No account was added.",
        };
      session.signedIn = true;
      const home = path.join(session.dir, "home");
      if (!(await exists(geminiCredentialsPath(home))))
        return {
          status: "error",
          reason: "token_missing",
          message:
            "Google sign-in finished, but the antigravity-acp runtime wrote no acp_token.json to the sign-in folder. No account was added.",
        };
      const lateCancel = session.cancelled as Session["cancelled"];
      if (lateCancel !== null) return { status: "error", ...lateCancel };
      if (this.now() >= deadline)
        return {
          status: "error",
          reason: "sign_in_timeout",
          message: `Gemini sign-in did not finish within ${Math.round(this.timeoutMs / 60_000)} minutes. No account was added.`,
        };
      await stop(session.runtime);
      const stopCancel = session.cancelled as Session["cancelled"];
      if (stopCancel !== null) return { status: "error", ...stopCancel };
      session.importing = true;
      try {
        const account = await this.options.importAccount(home, target);
        return { status: "complete", account };
      } catch (error) {
        return {
          status: "error",
          reason: "import_failed",
          message: `Google sign-in finished, but bb could not add the account: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    } finally {
      await this.cleanup(session);
    }
  }

  private async cleanup(session: Session): Promise<void> {
    await Promise.all([stop(session.runtime), stop(session.browser)]);
    await fs.rm(session.dir, { recursive: true, force: true, maxRetries: 5 });
  }

  private async sweep(): Promise<void> {
    const entries = await fs.readdir(this.root).catch(() => [] as string[]);
    await Promise.all(
      entries
        .filter((entry) => !this.sessions.has(entry))
        .map((entry) =>
          fs.rm(path.join(this.root, entry), {
            recursive: true,
            force: true,
            maxRetries: 5,
          }),
        ),
    );
  }

  private expireResults(): void {
    const now = this.now();
    for (const [id, session] of this.sessions)
      if (session.settledAt !== null && now - session.settledAt > RESULT_TTL_MS)
        this.sessions.delete(id);
  }

  private bounded<T>(
    work: Promise<T>,
    ms: number,
    woken: Promise<void>,
  ): Promise<T | undefined> {
    return Promise.race([
      work,
      delay(ms).then(() => undefined),
      woken.then(() => undefined),
    ]);
  }
}
