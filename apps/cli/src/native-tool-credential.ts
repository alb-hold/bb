import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const CREDENTIAL_FILE_NAME = "credential";

export function nativeToolCredentialDir(socketPath: string): string {
  return socketPath.replace(/\.sock$/u, ".tools");
}

export function writeNativeToolCredentialFile(
  socketPath: string,
  credential: string,
): string {
  const dir = nativeToolCredentialDir(socketPath);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { mode: 0o700 });
  const file = path.join(dir, CREDENTIAL_FILE_NAME);
  writeFileSync(file, credential, { flag: "wx", mode: 0o600 });
  return file;
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

export function withBearerCredential(
  fetchFn: typeof fetch,
  credential: string,
): typeof fetch {
  return (input, init) => {
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    headers.set("authorization", `Bearer ${credential}`);
    return fetchFn(input, { ...init, headers });
  };
}
