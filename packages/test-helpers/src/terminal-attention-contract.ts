export interface TerminalAttentionContractSession {
  attentionAt: number;
  id: string;
  seq: number;
  title: string;
}

export interface TerminalAttentionContractCase {
  clearId: string | null;
  name: string;
  nextId: string | null;
  sessions: readonly TerminalAttentionContractSession[];
  unreadIds: readonly string[];
  unreadIdsAfterClear: readonly string[];
}

export const TERMINAL_ATTENTION_CONTRACT_CASES: readonly TerminalAttentionContractCase[] = [
  {
    name: "empty attention",
    sessions: [],
    unreadIds: [],
    nextId: null,
    clearId: null,
    unreadIdsAfterClear: [],
  },
  {
    name: "oldest uncleared attention",
    sessions: [
      { id: "term-newest", title: "Newest", attentionAt: 20, seq: 2 },
      { id: "term-oldest", title: "Oldest", attentionAt: 10, seq: 1 },
    ],
    unreadIds: ["term-oldest", "term-newest"],
    nextId: "term-oldest",
    clearId: "term-oldest",
    unreadIdsAfterClear: ["term-newest"],
  },
];
