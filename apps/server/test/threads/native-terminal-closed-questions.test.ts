import { afterEach, describe, expect, it } from "vitest";
import {
  isClosedNativeQuestion,
  MAX_CLOSED_NATIVE_QUESTIONS,
  rememberClosedNativeQuestions,
} from "../../src/services/threads/native-terminal-questions.js";
import {
  createTestAppHarness,
  type TestAppHarness,
} from "../helpers/test-app.js";

const harnesses: TestAppHarness[] = [];

afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.cleanup();
});

describe("the closed native question memory", () => {
  it("remembers a bounded number of closed questions per thread and forgets the oldest first", async () => {
    const harness = await createTestAppHarness();
    harnesses.push(harness);
    const deps = harness.deps;
    rememberClosedNativeQuestions(
      deps,
      "thr_bound",
      Array.from(
        { length: MAX_CLOSED_NATIVE_QUESTIONS + 1 },
        (_, index) => `question-${index}`,
      ),
    );
    expect(isClosedNativeQuestion(deps, "thr_bound", "question-0")).toBe(false);
    expect(isClosedNativeQuestion(deps, "thr_bound", "question-1")).toBe(true);
    expect(
      isClosedNativeQuestion(
        deps,
        "thr_bound",
        `question-${MAX_CLOSED_NATIVE_QUESTIONS}`,
      ),
    ).toBe(true);
    expect(isClosedNativeQuestion(deps, "thr_other", "question-1")).toBe(false);
  });
});
