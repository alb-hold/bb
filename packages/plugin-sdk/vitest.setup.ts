import { beforeAll } from "vitest";
import {
  cwdScanIoDescendantsOnly,
  hostCwdScanIo,
  hostHoldScanIo,
  useCwdScanIoForTests,
  useHoldScanIoForTests,
} from "../process-utils/src/cwd-scan.js";

beforeAll(() => {
  useCwdScanIoForTests(cwdScanIoDescendantsOnly(hostCwdScanIo, process.pid));
  useHoldScanIoForTests(cwdScanIoDescendantsOnly(hostHoldScanIo, process.pid));
});
