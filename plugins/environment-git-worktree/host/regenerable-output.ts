const ALWAYS_OUTPUT = /(^|\/)(?:node_modules|\.turbo)(?:\/|$)|\.tsbuildinfo$/u;

export function hasPreservableStatus(stdout: string): boolean {
  return stdout.split("\0").some((entry) => {
    if (entry === "") return false;
    const filename = entry.slice(3);
    return (
      entry.slice(0, 2) !== "!!" ||
      filename.split("/").some((part) => part.startsWith(".env")) ||
      !ALWAYS_OUTPUT.test(filename)
    );
  });
}
