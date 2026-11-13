import type { ReactNode } from "react";
import {
  GitDiffRendererProvider,
  type GitDiffRenderers,
} from "@bb/shared-ui/git-diff/renderers";
import { DiffHost } from "@/components/code/DiffHost";
import { CopyButton } from "@/components/ui/copy-button";
import { ImageLightbox } from "@/lib/plugin-sdk-lazy-components";

const CORE_GIT_DIFF_RENDERERS: GitDiffRenderers = {
  Diff: DiffHost,
  ImageLightbox,
  CopyButton,
};

export function CoreGitDiffRendererProvider({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <GitDiffRendererProvider renderers={CORE_GIT_DIFF_RENDERERS}>
      {children}
    </GitDiffRendererProvider>
  );
}
