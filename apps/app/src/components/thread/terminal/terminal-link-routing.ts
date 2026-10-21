import { isLoopbackHostname } from "@/lib/loopback-hostname";

export function isTerminalLinkForThreadBrowser(
  url: string,
  environmentHostnames: readonly string[] = [],
  canOpenInAppBrowser: boolean,
): boolean {
  if (!canOpenInAppBrowser) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/u, "");
    return (
      isLoopbackHostname(hostname) ||
      environmentHostnames.some(
        (environmentHostname) =>
          environmentHostname.toLowerCase().replace(/\.$/u, "") === hostname,
      )
    );
  } catch {
    return false;
  }
}
