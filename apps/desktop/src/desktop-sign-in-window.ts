import { randomUUID } from "node:crypto";
import type {
  BbDesktopSignInWindowRequest,
  BbDesktopSignInWindowResult,
} from "@bb/desktop-contract";

const SIGN_IN_PROTOCOLS = new Set(["http:", "https:"]);

export interface DesktopSignInNavigationEvent {
  preventDefault(): void;
}

export interface DesktopSignInWindow {
  readonly partition: string;
  loadURL(url: string): void;
  close(): void;
  isDestroyed(): boolean;
  onNavigate(
    listener: (event: DesktopSignInNavigationEvent, url: string) => void,
  ): void;
  onOpenWindow(listener: (url: string) => void): void;
  onClosed(listener: () => void): void;
}

interface DesktopSignInWindowControllerArgs<Parent> {
  createWindow(partition: string, parent: Parent): DesktopSignInWindow;
}

interface OpenSignInWindowArgs<Parent> {
  parent: Parent;
  owner: number;
  request: BbDesktopSignInWindowRequest;
}

export function resolveSignInUrl(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  return SIGN_IN_PROTOCOLS.has(url.protocol) ? url.href : null;
}

export function createSignInPartition(): string {
  return `bb-sign-in-${randomUUID()}`;
}

function windowKey(owner: number, id: string): string {
  return `${owner}:${id}`;
}

interface ActiveSignInWindow {
  owner: number;
  window: DesktopSignInWindow;
  settle(result: BbDesktopSignInWindowResult): void;
}

export class DesktopSignInWindowController<Parent> {
  private readonly active = new Map<string, ActiveSignInWindow>();

  constructor(
    private readonly args: DesktopSignInWindowControllerArgs<Parent>,
  ) {}

  open(
    args: OpenSignInWindowArgs<Parent>,
  ): Promise<BbDesktopSignInWindowResult> {
    const url = resolveSignInUrl(args.request.url);
    if (url === null) {
      return Promise.reject(new Error("Sign-in URL must be http or https."));
    }
    const redirectPrefix =
      args.request.redirectUrlPrefix === undefined
        ? null
        : resolveSignInUrl(args.request.redirectUrlPrefix);
    if (
      args.request.redirectUrlPrefix !== undefined &&
      redirectPrefix === null
    ) {
      return Promise.reject(
        new Error("Sign-in redirect prefix must be http or https."),
      );
    }
    const key = windowKey(args.owner, args.request.id);
    this.close(args.request.id, args.owner);
    const window = this.args.createWindow(createSignInPartition(), args.parent);
    return new Promise((resolve) => {
      let settled = false;
      const entry: ActiveSignInWindow = {
        owner: args.owner,
        window,
        settle: (result) => {
          if (settled) {
            return;
          }
          settled = true;
          if (this.active.get(key) === entry) {
            this.active.delete(key);
          }
          resolve(result);
          if (!window.isDestroyed()) {
            window.close();
          }
        },
      };
      this.active.set(key, entry);
      window.onNavigate((event, target) => {
        if (redirectPrefix !== null && target.startsWith(redirectPrefix)) {
          event.preventDefault();
          entry.settle({ reason: "redirect", redirectUrl: target });
          return;
        }
        if (resolveSignInUrl(target) === null) {
          event.preventDefault();
        }
      });
      window.onOpenWindow((target) => {
        if (resolveSignInUrl(target) !== null) {
          window.loadURL(target);
        }
      });
      window.onClosed(() => {
        entry.settle({ reason: "closed" });
      });
      window.loadURL(url);
    });
  }

  close(id: string, owner: number): void {
    this.active.get(windowKey(owner, id))?.settle({ reason: "closed" });
  }

  closeOwnedBy(owner: number): void {
    for (const entry of [...this.active.values()]) {
      if (entry.owner === owner) {
        entry.settle({ reason: "closed" });
      }
    }
  }
}
