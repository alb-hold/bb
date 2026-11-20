import { usePromptVoice } from "@/components/promptbox/usePromptVoice";
import {
  FollowUpPromptVoiceContext,
  type FollowUpPromptVoiceSplitProps,
} from "./FollowUpPromptVoiceSplit";

export function FollowUpPromptVoice({
  children,
  draft,
  promptBoxRef,
  recordingKey,
}: FollowUpPromptVoiceSplitProps) {
  const voice = usePromptVoice(promptBoxRef, draft, recordingKey);
  return (
    <FollowUpPromptVoiceContext.Provider value={voice}>
      {children}
    </FollowUpPromptVoiceContext.Provider>
  );
}
