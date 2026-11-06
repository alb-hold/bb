import type { ReasoningLevel } from "@bb/domain";
import type { KeyboardEventHandler, RefObject } from "react";
import { PopoverContent } from "@bb/shared-ui/popover";
import { defineSplit } from "@/lib/define-split";
import { PickerLoadingRows } from "./PickerLoadingRows";
import type { ModelReasoningPickerProps } from "./model-reasoning-contract";

export type ModelReasoningPickerBodyProps = ModelReasoningPickerProps & {
  initialPreviewProviderId: string | null;
  initialReasoningLevel: ReasoningLevel | null;
  open: boolean;
  setOpen: (open: boolean) => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
  onRealized: () => void;
  keyDownRef: RefObject<KeyboardEventHandler<HTMLElement> | null>;
};

export const ModelReasoningPickerBody =
  defineSplit<ModelReasoningPickerBodyProps>({
    id: "model-reasoning-picker-body",
    tier: "intent",
    mountWhen: (props) => props.open,
    keepMounted: true,
    load: () =>
      import("./ModelReasoningPickerBody").then(
        (module) => module.ModelReasoningPickerBody,
      ),
    loading: (props) => (
      <PopoverContent align={props.align} mobileTitle="Model">
        <PickerLoadingRows
          label="Loading model picker"
          rowDataAttribute="data-model-menu-loading-row"
        />
      </PopoverContent>
    ),
  });
