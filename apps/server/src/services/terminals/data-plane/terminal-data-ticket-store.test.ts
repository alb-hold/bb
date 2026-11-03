import { describe, expect, it } from "vitest";
import { TerminalDataTicketStore } from "./terminal-data-ticket-store.js";

const BINDING = { daemonSessionId: "session_1", hostId: "host_1" };

describe("terminal data ticket store", () => {
  it("redeems a ticket once, for the session and host it was issued to", () => {
    const store = new TerminalDataTicketStore();
    const ticket = store.issue(BINDING);

    expect(ticket.length).toBeGreaterThanOrEqual(43);
    expect(store.redeem(`${ticket}x`)).toBeNull();
    expect(store.redeem(ticket)).toEqual(BINDING);
    expect(store.redeem(ticket)).toBeNull();
    expect(store.size).toBe(0);
  });

  it("refuses an expired ticket and forgets it", () => {
    let now = 1_000;
    const store = new TerminalDataTicketStore(() => now, 15_000);
    const ticket = store.issue(BINDING);

    now += 15_000;

    expect(store.redeem(ticket)).toBeNull();
    expect(store.size).toBe(0);
  });

  it("keeps one live ticket per daemon session and drops expired ones on issue", () => {
    let now = 1_000;
    const store = new TerminalDataTicketStore(() => now, 15_000);
    const first = store.issue(BINDING);
    const other = store.issue({ daemonSessionId: "session_2", hostId: "host_2" });
    const second = store.issue(BINDING);

    expect(first).not.toBe(second);
    expect(store.redeem(first)).toBeNull();
    expect(store.size).toBe(2);

    now += 20_000;
    const third = store.issue({ daemonSessionId: "session_3", hostId: "host_3" });

    expect(store.size).toBe(1);
    expect(store.redeem(other)).toBeNull();
    expect(store.redeem(second)).toBeNull();
    expect(store.redeem(third)).toEqual({
      daemonSessionId: "session_3",
      hostId: "host_3",
    });
  });

  it("revokes a session's ticket", () => {
    const store = new TerminalDataTicketStore();
    const ticket = store.issue(BINDING);

    store.revoke("session_1");

    expect(store.redeem(ticket)).toBeNull();
  });
});
