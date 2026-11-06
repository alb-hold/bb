import {
  prepareSplitImport,
  queueSplitPreload,
  trackCriticalLoad,
} from "./split-prefetch";
import {
  Component,
  Suspense,
  useEffect,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { loadChunkWithRetries } from "./retryable-chunk-import";

export type SplitTier = "preload" | "intent";

type FailureProps = { retry: () => void };

export function SplitLoadFailure({ retry }: FailureProps) {
  return (
    <p role="alert" className="p-3 text-sm text-destructive">
      Could not load.{" "}
      <button type="button" className="underline" onClick={retry}>
        Try again
      </button>
    </p>
  );
}

class SplitErrorBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export function defineSplit<P extends object>({
  id,
  load,
  loading: Loading,
  error: ErrorView = SplitLoadFailure,
  tier,
  mountWhen,
  keepMounted = false,
  unmounted: Unmounted,
}: {
  id: string;
  load: () => Promise<ComponentType<P>>;
  loading: ComponentType<P>;
  error?: ComponentType<P & FailureProps>;
  tier: SplitTier;
  mountWhen?: (props: P) => boolean;
  keepMounted?: boolean;
  unmounted?: ComponentType<P>;
}) {
  let pending: Promise<{ default: ComponentType<P> }> | null = null;
  let loaded: ComponentType<P> | null = null;
  const loadModule = () => {
    pending ??= prepareSplitImport(id)
      .then(() => loadChunkWithRetries(load))
      .then((component) => {
        loaded = component;
        return { default: component };
      })
      .catch((error: unknown) => {
        pending = null;
        throw error;
      });
    return pending;
  };
  const warm = async () => {
    await loadModule().catch(() => undefined);
  };
  const onIntent = () => warm().catch(() => undefined);
  if (tier === "preload") queueSplitPreload(warm);

  type Attempt = { number: number } & (
    | { status: "loading" }
    | { status: "failed" }
    | { status: "ready"; View: ComponentType<P> }
  );
  const createAttempt = (number: number): Attempt =>
    loaded === null
      ? { number, status: "loading" }
      : { number, status: "ready", View: loaded };

  function SplitContent(props: P) {
    const [attempt, setAttempt] = useState(() => createAttempt(0));
    useEffect(() => {
      if (attempt.status !== "loading") return;
      let alive = true;
      void trackCriticalLoad(loadModule()).then(
        ({ default: View }) => {
          if (alive) {
            setAttempt((current) =>
              current === attempt
                ? { number: attempt.number, status: "ready", View }
                : current,
            );
          }
        },
        () => {
          if (alive) {
            setAttempt((current) =>
              current === attempt
                ? { number: attempt.number, status: "failed" }
                : current,
            );
          }
        },
      );
      return () => {
        alive = false;
      };
    }, [attempt]);
    const retry = () => {
      setAttempt((previous) => createAttempt(previous.number + 1));
    };
    return (
      <SplitErrorBoundary
        key={attempt.number}
        fallback={<ErrorView {...props} retry={retry} />}
      >
        {attempt.status === "ready" ? (
          <Suspense fallback={<Loading {...props} />}>
            <attempt.View {...props} />
          </Suspense>
        ) : attempt.status === "failed" ? (
          <ErrorView key="failed" {...props} retry={retry} />
        ) : (
          <Loading key="loading" {...props} />
        )}
      </SplitErrorBoundary>
    );
  }

  function SplitComponent(props: P) {
    const wanted = mountWhen?.(props) ?? true;
    const [mountedBefore, setMountedBefore] = useState(wanted);
    if (wanted && !mountedBefore) setMountedBefore(true);
    if (wanted || (keepMounted && mountedBefore)) {
      return <SplitContent {...props} />;
    }
    return Unmounted ? <Unmounted {...props} /> : null;
  }

  return Object.assign(SplitComponent, {
    displayName: `Split(${id})`,
    id,
    tier,
    preload: warm,
    isLoaded: () => loaded !== null,
    intentProps: {
      onPointerEnter: onIntent,
      onFocus: onIntent,
      onPointerDown: onIntent,
    },
  });
}
