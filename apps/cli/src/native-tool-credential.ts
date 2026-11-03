import net from "node:net";

export const NATIVE_TOOL_CREDENTIAL_ENV = "BB_NATIVE_TOOL_CREDENTIAL";

export function takeNativeToolCredentialFromEnv(
  env: NodeJS.ProcessEnv,
): string | null {
  const credential = env[NATIVE_TOOL_CREDENTIAL_ENV];
  delete env[NATIVE_TOOL_CREDENTIAL_ENV];
  return credential === undefined || credential.length === 0
    ? null
    : credential;
}

export async function readNativeToolCredentialFromSocket(
  credentialSocket: string,
): Promise<string> {
  const credential = await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = net.createConnection(credentialSocket);
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("error", reject);
    socket.on("close", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
  const trimmed = credential.trim();
  if (trimmed.length === 0) {
    throw new Error("The native terminal holder has no tool credential");
  }
  return trimmed;
}

export function withSocketCredential(
  fetchFn: typeof fetch,
  credentialSocket: string,
): typeof fetch {
  return async (input, init) => {
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    headers.set(
      "authorization",
      `Bearer ${await readNativeToolCredentialFromSocket(credentialSocket)}`,
    );
    return fetchFn(input, { ...init, headers });
  };
}
