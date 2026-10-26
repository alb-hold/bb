import { beforeAll } from "vitest";
import {
  cwdScanIoDescendantsOnly,
  hostCwdScanIo,
  useCwdScanIoForTests,
} from "../process-utils/src/cwd-scan.js";

beforeAll(() => {
  useCwdScanIoForTests(cwdScanIoDescendantsOnly(hostCwdScanIo, process.pid));
});
