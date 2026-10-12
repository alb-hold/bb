import { createHash, randomBytes } from "node:crypto";

export const TERMINAL_DATA_TICKET_TTL_MS = 15_000;

export interface TerminalDataTicketBinding {
  daemonSessionId: string;
  hostId: string;
}

interface StoredTicket extends TerminalDataTicketBinding {
  expiresAt: number;
}

function digest(ticket: string): string {
  return createHash("sha256").update(ticket).digest("hex");
}

export class TerminalDataTicketStore {
  private readonly tickets = new Map<string, StoredTicket>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = TERMINAL_DATA_TICKET_TTL_MS,
  ) {}

  get size(): number {
    return this.tickets.size;
  }

  issue(binding: TerminalDataTicketBinding): string {
    this.revoke(binding.daemonSessionId);
    const now = this.now();
    for (const [key, stored] of this.tickets) {
      if (stored.expiresAt <= now) {
        this.tickets.delete(key);
      }
    }
    const ticket = randomBytes(32).toString("base64url");
    this.tickets.set(digest(ticket), {
      daemonSessionId: binding.daemonSessionId,
      expiresAt: now + this.ttlMs,
      hostId: binding.hostId,
    });
    return ticket;
  }

  redeem(ticket: string): TerminalDataTicketBinding | null {
    const key = digest(ticket);
    const stored = this.tickets.get(key);
    if (stored === undefined) {
      return null;
    }
    this.tickets.delete(key);
    if (stored.expiresAt <= this.now()) {
      return null;
    }
    return { daemonSessionId: stored.daemonSessionId, hostId: stored.hostId };
  }

  revoke(daemonSessionId: string): void {
    for (const [key, stored] of this.tickets) {
      if (stored.daemonSessionId === daemonSessionId) {
        this.tickets.delete(key);
      }
    }
  }
}
