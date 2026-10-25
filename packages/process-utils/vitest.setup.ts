import { beforeAll } from "vitest";
import {
  cwdScanIoDescendantsOnly,
  hostCwdScanIo,
  useCwdScanIoForTests,
} from "./src/cwd-scan.js";

beforeAll(() => {
  useCwdScanIoForTests(cwdScanIoDescendantsOnly(hostCwdScanIo, process.pid));
});
