import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
  type ComponentProps,
} from "react";
import {
  readVoiceSupportEnvironment,
  resolveVoiceSupport,
} from "@/hooks/voice-input-support";
import { appToast } from "@/components/ui/app-toast";
import type { PromptBoxHandle, PromptVoiceConfig } from "./ComposerBox";
import type { PromptVoiceDraftTarget } from "./prompt-voice-intent";

type Runtime = (typeof import("./usePromptVoiceRuntime"))["PromptVoiceRuntime"];
let runtime: Runtime | null = null;
let pending: Promise<void> | null = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const getRuntime = () => runtime !== null;

function LoadedPromptVoiceRuntime(props: ComponentProps<Runtime>) {
  const RuntimeComponent = runtime;
  return RuntimeComponent === null ? null : <RuntimeComponent {...props} />;
}

function createDraftTarget(recordingKey: string | null): {
  current: PromptVoiceDraftTarget | undefined;
  recordingKey: string | null;
} {
  const current: PromptVoiceDraftTarget | undefined = undefined;
  return { current, recordingKey };
}

export function preloadPromptVoiceRuntime(): Promise<void> {
  pending ??= import("./usePromptVoiceRuntime")
    .then((module) => {
      runtime = module.PromptVoiceRuntime;
      for (const listener of listeners) listener();
    })
    .catch((error: unknown) => {
      pending = null;
      throw error;
    });
  return pending;
}

export function usePromptVoice(
  promptBoxRef: RefObject<PromptBoxHandle | null>,
  draft: PromptVoiceDraftTarget | undefined,
  recordingKey: string | null,
): PromptVoiceConfig {
  const runtimeReady = useSyncExternalStore(subscribe, getRuntime, getRuntime);
  const target = useMemo(() => createDraftTarget(recordingKey), [recordingKey]);
  target.current = draft;
  const current = useRef<PromptVoiceConfig | null>(null);
  const waiting = useRef<((voice: PromptVoiceConfig | null) => void)[]>([]);
  const mounted = useRef(true);
  const [voice, setVoice] = useState<PromptVoiceConfig | null>(null);
  const publish = useCallback((next: PromptVoiceConfig | null) => {
    current.current = next;
    if (next !== null) {
      setVoice(next);
      for (const resolve of waiting.current.splice(0)) resolve(next);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    const waiters = waiting.current;
    const timer = window.setTimeout(() => {
      void preloadPromptVoiceRuntime().catch(() => undefined);
    }, 1500);
    return () => {
      mounted.current = false;
      window.clearTimeout(timer);
      for (const resolve of waiters.splice(0)) resolve(null);
    };
  }, []);
  const waitForVoice = useCallback(async () => {
    try {
      await preloadPromptVoiceRuntime();
    } catch {
      appToast.error("Voice input couldn't load. Try again.");
      return null;
    }
    if (!mounted.current) return null;
    return (
      current.current ??
      new Promise<PromptVoiceConfig | null>((resolve) => {
        waiting.current.push(resolve);
      })
    );
  }, []);
  const actions = useMemo(
    () => ({
      start: async () => {
        await (current.current ?? (await waitForVoice()))?.start();
      },
      stop: () => {
        if (current.current) current.current.stop();
        else void waitForVoice().then((value) => value?.stop());
      },
      send: () => {
        if (current.current) current.current.send();
        else void waitForVoice().then((value) => value?.send());
      },
      cancel: () => {
        if (current.current) current.current.cancel();
        else void waitForVoice().then((value) => value?.cancel());
      },
      retry: (recording: Parameters<PromptVoiceConfig["retry"]>[0]) => {
        void waitForVoice().then((value) => value?.retry(recording));
      },
      discard: (recording: Parameters<PromptVoiceConfig["discard"]>[0]) => {
        void waitForVoice().then((value) => value?.discard(recording));
      },
      download: (recording: Parameters<PromptVoiceConfig["download"]>[0]) => {
        void waitForVoice().then((value) => value?.download(recording));
      },
    }),
    [waitForVoice],
  );
  const support = resolveVoiceSupport(readVoiceSupportEnvironment());
  return {
    state: voice?.state ?? "idle",
    delivery: voice?.delivery ?? "insert",
    microphoneWarning: voice?.microphoneWarning ?? null,
    isSupported: voice?.isSupported ?? support.isSupported,
    stream: voice?.stream ?? null,
    failedRecordings: voice?.failedRecordings ?? [],
    ...actions,
    runtime:
      !runtimeReady ? null : (
        <LoadedPromptVoiceRuntime
          target={target}
          promptBoxRef={promptBoxRef}
          recordingKey={recordingKey}
          publish={publish}
        />
      ),
  };
}
