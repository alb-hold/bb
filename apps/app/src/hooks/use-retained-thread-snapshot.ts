import { useState } from "react";

interface UseRetainedThreadSnapshotArgs<TSnapshot> {
  snapshot: TSnapshot | undefined;
  threadId: string;
}

export function useRetainedThreadSnapshot<TSnapshot>({
  snapshot,
  threadId,
}: UseRetainedThreadSnapshotArgs<TSnapshot>): TSnapshot | undefined {
  const [retainedSnapshot, setRetainedSnapshot] = useState<{
    snapshot: TSnapshot | undefined;
    threadId: string;
  }>({ snapshot, threadId });

  if (retainedSnapshot.threadId !== threadId) {
    setRetainedSnapshot({ snapshot, threadId });
  } else if (
    snapshot !== undefined &&
    snapshot !== retainedSnapshot.snapshot
  ) {
    setRetainedSnapshot({ snapshot, threadId });
  }

  return snapshot ?? retainedSnapshot.snapshot;
}
