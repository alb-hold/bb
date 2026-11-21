import type {
  ExperimentalThreadContextSegmentRegistration,
  PluginAppDefinition,
} from "@get-bb/plugin-sdk";
import {
  requireNonEmptyString,
  requireOptionalOrder,
  requireSlotId,
  requireUniqueId,
} from "./composer-customization-validation.js";

export function createThreadContextSegmentCollector() {
  const threadContextSegments: ExperimentalThreadContextSegmentRegistration[] = [];
  const segmentIds = new Set<string>();
  const slots: Pick<
    Parameters<PluginAppDefinition["setup"]>[0]["slots"],
    "experimental_threadContextSegment"
  > = {
    experimental_threadContextSegment(registration) {
      const kind = "slots.experimental_threadContextSegment";
      const id = requireSlotId(kind, registration?.id);
      requireUniqueId(kind, segmentIds, id);
      const optionalComponent = (field: "action" | "details") => {
        const value = registration[field];
        if (value === undefined) return {};
        if (typeof value !== "function") {
          throw new Error(
            `${kind}: "${field}" must be a React component function`,
          );
        }
        return { [field]: value };
      };
      if (typeof registration.summary !== "function") {
        throw new Error(
          `${kind}: "summary" must be a React component function`,
        );
      }
      if (
        registration.useVisible !== undefined &&
        typeof registration.useVisible !== "function"
      ) {
        throw new Error(`${kind}: "useVisible" must be a function`);
      }
      threadContextSegments.push({
        id,
        title: requireNonEmptyString(kind, "title", registration.title),
        group: requireNonEmptyString(kind, "group", registration.group),
        ...requireOptionalOrder(kind, registration.order),
        summary: registration.summary,
        ...optionalComponent("action"),
        ...optionalComponent("details"),
        ...(registration.useVisible !== undefined
          ? { useVisible: registration.useVisible }
          : {}),
      });
    },
  };
  return { slots, threadContextSegments };
}
