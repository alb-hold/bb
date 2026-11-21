import * as sonner from "sonner";
import { createPluginToast } from "./notifications/plugin-toast";

export const pluginToastRuntime = { ...sonner, toast: createPluginToast(sonner.toast) };
