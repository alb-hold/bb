// @vitest-environment jsdom

import { useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PendingComposerSubmission } from "./PendingComposerSubmission";

afterEach(cleanup);

function setup() {
  const sent = vi.fn();
  function Host() {
    const [text, setText] = useState("early words");
    const [ready, setReady] = useState(false);
    const [scope, setScope] = useState("first");
    const [failed, setFailed] = useState(false);
    return (
      <>
        <PendingComposerSubmission
          text={text}
          resetKey={scope}
          loading={!ready}
          disabled={!ready}
          failed={failed}
          isSubmitting={false}
          pendingUploads={false}
          onSubmit={() => sent(text)}
        >
          {(onBlockedSubmit) => (
            <>
              <button onClick={onBlockedSubmit}>Try send</button>
              <div data-promptbox-editor-scroll="">
                <textarea
                  aria-label="Message"
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                />
              </div>
            </>
          )}
        </PendingComposerSubmission>
        <button onClick={() => setReady(true)}>Resolve options</button>
        <button onClick={() => setScope("second")}>Change scope</button>
        <button onClick={() => setFailed(true)}>Fail model</button>
      </>
    );
  }
  render(<Host />);
  return {
    sent,
    input: screen.getByRole<HTMLTextAreaElement>("textbox", {
      name: "Message",
    }),
  };
}

it.each(["edit", "escape", "scope", "failure"] as const)(
  "cancels queued Enter on %s without sending the retained draft",
  (action) => {
    const { sent, input } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Try send" }));
    expect(screen.getByRole("status").textContent).toContain(
      "will send when ready",
    );
    if (action === "edit")
      fireEvent.change(input, { target: { value: "revised words" } });
    if (action === "escape") fireEvent.keyDown(input, { key: "Escape" });
    if (action === "scope")
      fireEvent.click(screen.getByRole("button", { name: "Change scope" }));
    if (action === "failure")
      fireEvent.click(screen.getByRole("button", { name: "Fail model" }));
    expect(screen.queryByRole("status")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Resolve options" }));
    expect(sent).not.toHaveBeenCalled();
    expect(input.value).toBe(
      action === "edit" ? "revised words" : "early words",
    );
  },
);

it("does not retry a queued submission after it rejects", async () => {
  let rejectSubmit: (() => void) | undefined;
  const sent = vi.fn(
    () =>
      new Promise<void>((_resolve, reject) => {
        rejectSubmit = () => reject(new Error("send failed"));
      }),
  );
  function Host() {
    const [ready, setReady] = useState(false);
    const [isSubmitting, setIsSubmitting] = useState(false);
    return (
      <>
        <PendingComposerSubmission
          text="queued message"
          loading={!ready}
          disabled={!ready}
          failed={false}
          isSubmitting={isSubmitting}
          pendingUploads={false}
          onSubmit={() => {
            setIsSubmitting(true);
            return sent().finally(() => setIsSubmitting(false));
          }}
        >
          {(onBlockedSubmit) => (
            <button onClick={onBlockedSubmit}>Try send</button>
          )}
        </PendingComposerSubmission>
        <button onClick={() => setReady(true)}>Resolve options</button>
        <span>{isSubmitting ? "Submitting" : "Ready"}</span>
      </>
    );
  }

  render(<Host />);
  fireEvent.click(screen.getByRole("button", { name: "Try send" }));
  fireEvent.click(screen.getByRole("button", { name: "Resolve options" }));
  await waitFor(() => {
    expect(sent).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Submitting")).not.toBeNull();
  });

  await act(async () => {
    rejectSubmit?.();
    await Promise.resolve();
  });
  await waitFor(() => expect(screen.getByText("Ready")).not.toBeNull());
  expect(sent).toHaveBeenCalledTimes(1);
});
