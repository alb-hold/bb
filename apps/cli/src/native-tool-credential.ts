import {
  chmodSync,
  mkdirSync,
  renameSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const CREDENTIAL_FILE_NAME = "credential";

export function nativeToolCredentialDir(socketPath: string): string {
  return socketPath.replace(/\.sock$/u, ".tools");
}

export function nativeToolCredentialFile(socketPath: string): string {
  return path.join(nativeToolCredentialDir(socketPath), CREDENTIAL_FILE_NAME);
}

export function writeNativeToolCredentialFile(
  socketPath: string,
  credential: string,
): string {
  const dir = nativeToolCredentialDir(socketPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const file = nativeToolCredentialFile(socketPath);
  const staging = `${file}.${process.pid}.tmp`;
  rmSync(staging, { force: true });
  writeFileSync(staging, credential, { flag: "wx", mode: 0o600 });
  renameSync(staging, file);
  return file;
}

export const NATIVE_TOOL_CREDENTIAL_ENV = "BB_NATIVE_TOOL_CREDENTIAL";

export function takeNativeToolCredentialFromEnv(
  env: NodeJS.ProcessEnv,
  socketPath: string,
): void {
  const credential = env[NATIVE_TOOL_CREDENTIAL_ENV];
  delete env[NATIVE_TOOL_CREDENTIAL_ENV];
  if (credential === undefined || credential.length === 0) return;
  writeNativeToolCredentialFile(socketPath, credential);
}

export function removeNativeToolCredentialFile(socketPath: string): void {
  rmSync(nativeToolCredentialDir(socketPath), { recursive: true, force: true });
}

export function readNativeToolCredentialFile(file: string): string {
  const credential = readFileSync(file, "utf8").trim();
  if (credential.length === 0) {
    throw new Error("The native tool credential file is empty");
  }
  return credential;
}

export function withFileCredential(
  fetchFn: typeof fetch,
  credentialFile: string,
): typeof fetch {
  return (input, init) => {
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    headers.set(
      "authorization",
      `Bearer ${readNativeToolCredentialFile(credentialFile)}`,
    );
    return fetchFn(input, { ...init, headers });
  };
}
