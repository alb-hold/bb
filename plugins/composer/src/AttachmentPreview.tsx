import { useEffect } from "react";
import {
  experimental_ImageLightbox as ImageLightbox,
  experimental_useComposerRenderer as useComposerRenderer,
  type ComposerAttachment,
  type ExperimentalComposerPendingUpload as PendingAttachmentUpload,
} from "@get-bb/plugin-sdk/app";
import {
  isImageAttachment,
  isVideoAttachment,
  wrappedIndex,
} from "./attachments";
import { ComposerAttachmentPreview } from "@/components/ui/composer-attachment-preview";

interface AttachmentPreviewProps {
  attachments: readonly ComposerAttachment[];
  pendingUploads?: readonly PendingAttachmentUpload[];
  compact?: boolean;
  attachmentProjectId?: string;
  expandedImageIndex: number | null;
  onExpandedImageIndexChange: (index: number | null) => void;
  onRemoveAttachment?: (path: string) => void;
}

export function AttachmentPreview({
  attachments,
  pendingUploads,
  compact,
  attachmentProjectId,
  expandedImageIndex,
  onExpandedImageIndexChange,
  onRemoveAttachment,
}: AttachmentPreviewProps) {
  const renderer = useComposerRenderer();
  const images = attachments.filter(
    (item) => isImageAttachment(item) || isVideoAttachment(item),
  );
  const items = images.map((item) => ({
    src: renderer.attachmentSrc(
      item.path,
      item.sourceProjectId ?? attachmentProjectId,
    ),
    alt: item.name,
    mediaType: isVideoAttachment(item)
      ? ("video" as const)
      : ("image" as const),
  }));
  const current =
    expandedImageIndex === null ? null : (items[expandedImageIndex] ?? null);
  useEffect(() => {
    if (expandedImageIndex !== null && expandedImageIndex >= items.length)
      onExpandedImageIndexChange(null);
  }, [expandedImageIndex, items.length, onExpandedImageIndexChange]);
  return (
    <>
      <ComposerAttachmentPreview
        attachments={attachments}
        pendingUploads={pendingUploads}
        compact={compact}
        attachmentProjectId={attachmentProjectId}
        onRemoveAttachment={onRemoveAttachment}
        onOpenImage={onExpandedImageIndexChange}
        attachmentSrc={renderer.attachmentSrc}
        resolveMentionLink={renderer.input.resolveMentionLink}
      />
      <ImageLightbox
        imageSrc={current?.src ?? null}
        imageAlt={current?.alt ?? "Attached image"}
        title="Attached media preview"
        mediaType={current?.mediaType}
        hasMultipleImages={items.length > 1}
        onPrevious={() =>
          onExpandedImageIndexChange(
            expandedImageIndex === null
              ? null
              : wrappedIndex({
                  currentIndex: expandedImageIndex,
                  direction: "previous",
                  itemCount: items.length,
                }),
          )
        }
        onNext={() =>
          onExpandedImageIndexChange(
            expandedImageIndex === null
              ? null
              : wrappedIndex({
                  currentIndex: expandedImageIndex,
                  direction: "next",
                  itemCount: items.length,
                }),
          )
        }
        onClose={() => onExpandedImageIndexChange(null)}
      />
    </>
  );
}
