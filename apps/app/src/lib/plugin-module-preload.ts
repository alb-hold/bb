const preloadedModules = new Map<string, Promise<boolean>>();

export function preloadPluginModule(
  path: string,
  priority: "auto" | "low" = "auto",
): Promise<boolean> {
  const url = new URL(path, document.baseURI).href;
  const pending = preloadedModules.get(url);
  if (pending !== undefined) return pending;
  const result = new Promise<boolean>((resolve) => {
    const link = document.createElement("link");
    link.rel = "modulepreload";
    link.crossOrigin = "";
    link.fetchPriority = priority;
    link.href = path;
    const finish = (loaded: boolean) => {
      link.onload = null;
      link.onerror = null;
      link.remove();
      resolve(loaded);
    };
    link.onload = () => finish(true);
    link.onerror = () => finish(false);
    if (link.relList.supports("modulepreload")) {
      document.head.appendChild(link);
    } else {
      void fetch(url, { cache: "force-cache", priority })
        .then(async (response) => {
          if (response.ok) await response.arrayBuffer();
          finish(response.ok);
        })
        .catch(() => finish(false));
    }
  });
  preloadedModules.set(url, result);
  void result.then((loaded) => {
    if (!loaded) preloadedModules.delete(url);
  });
  return result;
}

export function prefetchPluginModule(url: string): void {
  void preloadPluginModule(url);
}
