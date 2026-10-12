// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQueryClientTestHarness } from "@/test/queryClientTestHarness";
import { NativeTerminalPromptBar } from "./NativeTerminalPromptBar";

const send = vi.hoisted(() => vi.fn());
const upload = vi.hoisted(() => vi.fn());

vi.mock("@/lib/sdk", () => ({
  sdk: { threads: { send }, projects: { attachments: { upload } } },
}));

vi.mock("@/lib/attachment-local-previews", () => ({
  registerLocalAttachmentPreview: vi.fn(),
}));

function renderBar() {
  const { wrapper: Wrapper } = createQueryClientTestHarness();
  render(
    <Wrapper>
      <NativeTerminalPromptBar
        projectId="proj-n"
        providerLabel="Native CLI"
        threadId="thr-n"
      />
    </Wrapper>,
  );
  return {
    input: screen.getByLabelText("Message Native CLI") as HTMLTextAreaElement,
    sendButton: screen.getByRole("button", { name: "Send to Native CLI" }),
  };
}

beforeEach(() => {
  send.mockReset();
  send.mockResolvedValue({});
  upload.mockReset();
  upload.mockImplementation(({ clientFile }: { clientFile: File }) =>
    Promise.resolve({
      type: "localImage",
      sourceProjectId: "proj-n",
      path: `stored-${clientFile.name}`,
      name: clientFile.name,
      mimeType: clientFile.type,
      sizeBytes: clientFile.size,
    }),
  );
});

function pasteFiles(target: HTMLElement, files: File[]) {
  fireEvent.paste(target, { clipboardData: { files, getData: () => "" } });
}

afterEach(cleanup);

describe("NativeTerminalPromptBar", () => {
  it("sends the trimmed message on Enter and clears the field", async () => {
    const { input } = renderBar();
    fireEvent.change(input, { target: { value: "  fix the build  " } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(input.value).toBe(""));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({
      threadId: "thr-n",
      input: [{ type: "text", text: "fix the build", mentions: [] }],
      mode: "auto",
    });
  });

  it("keeps Shift+Enter and IME composition as editing keys", () => {
    const { input } = renderBar();
    fireEvent.change(input, { target: { value: "line one" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });

    expect(send).not.toHaveBeenCalled();
    expect(input.value).toBe("line one");
  });

  it("does not send blank input", () => {
    const { input, sendButton } = renderBar();
    fireEvent.change(input, { target: { value: "   " } });

    expect(sendButton).toHaveProperty("disabled", true);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps the message when the send fails", async () => {
    send.mockRejectedValue(new Error("offline"));
    const { input, sendButton } = renderBar();
    fireEvent.change(input, { target: { value: "retry me" } });
    fireEvent.click(sendButton);

    await waitFor(() => expect(sendButton).toHaveProperty("disabled", false));
    expect(send).toHaveBeenCalledTimes(1);
    expect(input.value).toBe("retry me");
  });

  it("uploads a pasted image and sends it as an attachment with the text", async () => {
    const { input, sendButton } = renderBar();
    pasteFiles(input, [new File(["png"], "shot.png", { type: "image/png" })]);

    await screen.findByText("shot.png");
    expect(upload).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "proj-n" }),
    );
    fireEvent.change(input, { target: { value: "what is this?" } });
    fireEvent.click(sendButton);

    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send).toHaveBeenCalledWith({
      threadId: "thr-n",
      input: [
        {
          type: "localImage",
          path: "stored-shot.png",
          sourceProjectId: "proj-n",
        },
        { type: "text", text: "what is this?", mentions: [] },
      ],
      mode: "auto",
    });
    await waitFor(() => expect(screen.queryByText("shot.png")).toBeNull());
  });

  it("sends an image on its own and lets a pasted text through untouched", async () => {
    const { input, sendButton } = renderBar();
    pasteFiles(input, []);
    expect(upload).not.toHaveBeenCalled();
    expect(sendButton).toHaveProperty("disabled", true);

    const picker = screen.getByLabelText(
      "Attach images for Native CLI",
    ) as HTMLInputElement;
    fireEvent.change(picker, {
      target: {
        files: [new File(["jpg"], "photo.jpg", { type: "image/jpeg" })],
      },
    });
    await screen.findByText("photo.jpg");
    fireEvent.click(sendButton);

    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      input: [{ type: "localImage", path: "stored-photo.jpg" }],
    });
  });

  it("reports a failed upload and does not send while uploads are pending", async () => {
    let finishUpload: (() => void) | undefined;
    upload.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          finishUpload = () => reject(new Error("too big"));
        }),
    );
    const { input, sendButton } = renderBar();
    fireEvent.change(input, { target: { value: "hold on" } });
    pasteFiles(input, [new File(["x"], "huge.png", { type: "image/png" })]);

    await screen.findByText("Attaching…");
    expect(sendButton).toHaveProperty("disabled", true);
    finishUpload?.();

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Failed to attach huge.png",
    );
    expect(sendButton).toHaveProperty("disabled", false);
    expect(send).not.toHaveBeenCalled();
  });
});
