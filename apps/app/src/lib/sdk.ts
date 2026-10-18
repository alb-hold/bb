import { createBrowserBbSdk } from "@bb/sdk/browser";
import { fetchWithDeviceHandoffSubmission } from "./api-server";

const BASE_URL =
  typeof window === "undefined" ? "http://localhost" : window.location.origin;

export const sdk = createBrowserBbSdk({
  baseUrl: BASE_URL,
  fetch: fetchWithDeviceHandoffSubmission,
});

export { BbHttpError } from "@bb/sdk/browser";
