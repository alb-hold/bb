import { defineSplit } from "@/lib/define-split";
import { createContext, type ReactNode, type RefObject } from "react";
import type { PromptBoxHandle, PromptVoiceConfig } from "./ComposerBox";
import type { PromptVoiceDraftTarget } from "./prompt-voice-intent";

export interface FollowUpPromptVoiceSplitProps {
  children: ReactNode;
  draft?: PromptVoiceDraftTarget;
  promptBoxRef: RefObject<PromptBoxHandle | null>;
  recordingKey: string | null;
}

export const FollowUpPromptVoiceContext = createContext<
  PromptVoiceConfig | undefined
>(undefined);

function FollowUpPromptVoiceLoading({
  children,
  retry,
}: FollowUpPromptVoiceSplitProps & { retry?: () => void }) {
  return (
    <FollowUpPromptVoiceContext.Provider value={undefined}>
      {children}
      {retry ? (
        <button type="button" className="sr-only" onClick={retry}>
          Retry voice input loading
        </button>
      ) : null}
    </FollowUpPromptVoiceContext.Provider>
  );
}

export const FollowUpPromptVoiceSplit =
  defineSplit<FollowUpPromptVoiceSplitProps>({
    id: "follow-up-prompt-voice",
    load: () =>
      import("./FollowUpPromptVoice").then(
        (module) => module.FollowUpPromptVoice,
      ),
    loading: FollowUpPromptVoiceLoading,
    error: FollowUpPromptVoiceLoading,
    tier: "intent",
  });
