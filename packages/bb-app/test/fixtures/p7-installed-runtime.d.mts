export function createP7InstalledRuntime(): {
  binPath: string;
  cleanup(): void;
  packageRoot: string;
};
