import { create } from 'zustand';
import { mirrorFeatureState } from '../services/piMirror';
import { webRequest } from '../services/webClient';

const STORAGE_KEY = 'deep_canvas_kanban_v1';
let localMutationRevision = 0;

export interface KanbanSubtask {
  id: string;
  title: string;
}

export interface KanbanEntry {
  id: string;
  title: string;
  notes: string;
  subtasks: KanbanSubtask[];
  createdAt: string;
  updatedAt: string;
}

export interface KanbanColumn {
  id: string;
  title: string;
}

export interface KanbanCard {
  id: string;
  title: string;
  notes: string;
  columnId: string;
  subtasks: KanbanSubtask[];
  parentTitle: string | null;
  createdAt: string;
  updatedAt: string;
}

export type CalendarItemKind = 'task' | 'event';

export interface KanbanCalendarItem {
  id: string;
  title: string;
  notes: string;
  kind: CalendarItemKind;
  date: string;
  startTime: string;
  endTime: string;
  allDay: boolean;
  location: string;
  googleEventId: string | null;
  googleHtmlLink: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface KanbanBoard {
  id: string;
  name: string;
  entries: KanbanEntry[];
  columns: KanbanColumn[];
  cards: KanbanCard[];
  createdAt: string;
  updatedAt: string;
}

interface KanbanSnapshot {
  activeBoardId: string;
  boards: KanbanBoard[];
  entries: KanbanEntry[];
  columns: KanbanColumn[];
  cards: KanbanCard[];
  calendarItems: KanbanCalendarItem[];
}

export interface CreateCalendarItemInput {
  title: string;
  notes?: string;
  kind?: CalendarItemKind;
  date: string;
  startTime?: string;
  endTime?: string;
  allDay?: boolean;
  location?: string;
  googleEventId?: string | null;
  googleHtmlLink?: string | null;
}

interface CreateEntryInput {
  title: string;
  notes?: string;
  subtasks?: string[];
}

interface KanbanState extends KanbanSnapshot {
  hydrate: () => Promise<void>;
  createBoard: (name: string) => void;
  selectBoard: (boardId: string) => void;
  saveBoard: (name?: string) => void;
  duplicateBoard: (boardId: string) => void;
  deleteBoard: (boardId: string) => void;
  addEntry: (input: CreateEntryInput) => void;
  updateEntry: (entryId: string, updates: Partial<Pick<KanbanEntry, 'title' | 'notes'>>) => void;
  deleteEntry: (entryId: string) => void;
  addEntrySubtask: (entryId: string, title: string) => void;
  updateEntrySubtask: (entryId: string, subtaskId: string, title: string) => void;
  deleteEntrySubtask: (entryId: string, subtaskId: string) => void;
  addColumn: (title: string) => void;
  updateColumn: (columnId: string, title: string) => void;
  deleteColumn: (columnId: string) => void;
  addManualCard: (columnId?: string) => void;
  addCardFromEntry: (entryId: string, columnId?: string) => void;
  addCardFromSubtask: (entryId: string, subtaskId: string, columnId?: string) => void;
  updateCard: (cardId: string, updates: Partial<Pick<KanbanCard, 'title' | 'notes'>>) => void;
  updateCardSubtask: (cardId: string, subtaskId: string, title: string) => void;
  addCardSubtask: (cardId: string, title: string) => void;
  deleteCardSubtask: (cardId: string, subtaskId: string) => void;
  moveCard: (cardId: string, columnId: string) => void;
  deleteCard: (cardId: string) => void;
  addCalendarItem: (input: CreateCalendarItemInput) => KanbanCalendarItem | null;
  updateCalendarItem: (itemId: string, updates: Partial<Omit<KanbanCalendarItem, 'id' | 'createdAt'>>) => void;
  deleteCalendarItem: (itemId: string) => void;
  mergeGoogleCalendarItems: (items: KanbanCalendarItem[]) => void;
  resetBoard: () => void;
}

interface PiStateResponse {
  feature?: string;
  data?: unknown;
}

const DEFAULT_COLUMNS: KanbanColumn[] = [
  { id: 'todo', title: 'To Do' },
  { id: 'in-progress', title: 'In Progress' },
  { id: 'review', title: 'Review' },
  { id: 'done', title: 'Done' },
];

function makeId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function timestamp(): string {
  return new Date().toISOString();
}

function createDefaultSnapshot(): KanbanSnapshot {
  const now = timestamp();
  const board: KanbanBoard = {
    id: makeId('board'),
    name: 'Delivery Flow',
    entries: [],
    columns: DEFAULT_COLUMNS.map((column) => ({ ...column })),
    cards: [],
    createdAt: now,
    updatedAt: now,
  };
  return {
    activeBoardId: board.id,
    boards: [board],
    entries: board.entries,
    columns: board.columns,
    cards: board.cards,
    calendarItems: [],
  };
}

function normalizeSnapshot(value: unknown): KanbanSnapshot {
  const fallback = createDefaultSnapshot();
  if (!value || typeof value !== 'object') return fallback;
  const parsed = value as Partial<KanbanSnapshot>;
  const legacyEntries = Array.isArray(parsed.entries) ? parsed.entries : [];
  const legacyColumns = Array.isArray(parsed.columns) && parsed.columns.length > 0 ? parsed.columns : DEFAULT_COLUMNS;
  const legacyCards = Array.isArray(parsed.cards) ? parsed.cards : [];
  const now = timestamp();
  const parsedBoards = Array.isArray(parsed.boards) ? parsed.boards : [];
  const boards: KanbanBoard[] = parsedBoards.length > 0
    ? parsedBoards.map((raw, index) => {
        const board = (raw && typeof raw === 'object' ? raw : {}) as Partial<KanbanBoard>;
        return {
          id: String(board.id || makeId('board')),
          name: String(board.name || `Board ${index + 1}`),
          entries: Array.isArray(board.entries) ? board.entries : [],
          columns: Array.isArray(board.columns) && board.columns.length > 0 ? board.columns : DEFAULT_COLUMNS.map((column) => ({ ...column })),
          cards: Array.isArray(board.cards) ? board.cards : [],
          createdAt: String(board.createdAt || now),
          updatedAt: String(board.updatedAt || now),
        };
      })
    : [{
        id: makeId('board'),
        name: 'Delivery Flow',
        entries: legacyEntries,
        columns: legacyColumns,
        cards: legacyCards,
        createdAt: now,
        updatedAt: now,
      }];
  const activeBoardId = boards.some((board) => board.id === parsed.activeBoardId)
    ? String(parsed.activeBoardId)
    : boards[0].id;
  const activeBoard = boards.find((board) => board.id === activeBoardId) ?? boards[0];
  return {
    activeBoardId,
    boards,
    entries: activeBoard.entries,
    columns: activeBoard.columns,
    cards: activeBoard.cards,
    calendarItems: Array.isArray(parsed.calendarItems) ? parsed.calendarItems : fallback.calendarItems,
  };
}

function loadSnapshot(): KanbanSnapshot {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return createDefaultSnapshot();
    return normalizeSnapshot(JSON.parse(raw));
  } catch {
    return createDefaultSnapshot();
  }
}

function persistSnapshot(snapshot: KanbanSnapshot): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // ignore storage failures
  }
}

function commitSnapshot(
  set: (partial: KanbanSnapshot | Partial<KanbanState> | ((state: KanbanState) => KanbanSnapshot)) => void,
  snapshotOrUpdater: Partial<KanbanSnapshot> | ((state: KanbanState) => Partial<KanbanSnapshot>)
) {
  localMutationRevision += 1;
  set((state) => {
    const patch =
      typeof snapshotOrUpdater === 'function'
        ? snapshotOrUpdater(state)
        : snapshotOrUpdater;
    const nextSnapshot: KanbanSnapshot = {
      activeBoardId: state.activeBoardId,
      boards: state.boards,
      entries: patch.entries ?? state.entries,
      columns: patch.columns ?? state.columns,
      cards: patch.cards ?? state.cards,
      calendarItems: patch.calendarItems ?? state.calendarItems,
    };
    nextSnapshot.boards = state.boards.map((board) => board.id === state.activeBoardId
      ? {
          ...board,
          entries: nextSnapshot.entries,
          columns: nextSnapshot.columns,
          cards: nextSnapshot.cards,
          updatedAt: timestamp(),
        }
      : board);

    persistSnapshot(nextSnapshot);
    return nextSnapshot;
  });
}

function getPrimaryColumnId(columns: KanbanColumn[]): string {
  return columns[0]?.id ?? 'todo';
}

const initialSnapshot = loadSnapshot();

export const useKanbanStore = create<KanbanState>((set) => ({
  ...initialSnapshot,

  hydrate: async () => {
    const revisionAtStart = localMutationRevision;
    try {
      const response = await webRequest<PiStateResponse>('pi.state.get', { feature: 'kanban' });
      const remote = response?.data;
      if (!remote || typeof remote !== 'object' || Array.isArray(remote)) return;
      const snapshot = normalizeSnapshot(remote);

      // A user can create a task while the startup request is in flight. Never
      // replace that newer local change with the older response that comes back.
      if (localMutationRevision !== revisionAtStart) return;

      const current = useKanbanStore.getState();
      const localHasWork = current.entries.length > 0 || current.cards.length > 0;
      const remoteHasWork = snapshot.entries.length > 0 || snapshot.cards.length > 0 || snapshot.calendarItems.length > 0;
      if (localHasWork && !remoteHasWork) {
        mirrorFeatureState('kanban', {
          columns: current.columns,
          cards: current.cards,
          entries: current.entries,
          calendarItems: current.calendarItems,
        });
        return;
      }

      persistSnapshot(snapshot);
      set(snapshot);
    } catch {
      // Local browser state remains usable if the backend mirror is unavailable.
    }
  },

  addEntry: (input) => {
    const now = timestamp();
    const title = input.title.trim();
    if (!title) return;

    const nextEntry: KanbanEntry = {
      id: makeId('entry'),
      title,
      notes: input.notes?.trim() ?? '',
      subtasks: (input.subtasks ?? [])
        .map((subtask) => subtask.trim())
        .filter(Boolean)
        .map((subtaskTitle) => ({ id: makeId('subtask'), title: subtaskTitle })),
      createdAt: now,
      updatedAt: now,
    };

    commitSnapshot(set, (state) => ({
      entries: [nextEntry, ...state.entries],
      columns: state.columns,
      cards: state.cards,
    }));
  },

  updateEntry: (entryId, updates) => {
    commitSnapshot(set, (state) => ({
      entries: state.entries.map((entry) =>
        entry.id === entryId
          ? {
              ...entry,
              ...updates,
              title: updates.title !== undefined ? updates.title : entry.title,
              notes: updates.notes !== undefined ? updates.notes : entry.notes,
              updatedAt: timestamp(),
            }
          : entry
      ),
      columns: state.columns,
      cards: state.cards,
    }));
  },

  deleteEntry: (entryId) => {
    commitSnapshot(set, (state) => ({
      entries: state.entries.filter((entry) => entry.id !== entryId),
      columns: state.columns,
      cards: state.cards,
    }));
  },

  addEntrySubtask: (entryId, title) => {
    const cleanTitle = title.trim();
    if (!cleanTitle) return;

    commitSnapshot(set, (state) => ({
      entries: state.entries.map((entry) =>
        entry.id === entryId
          ? {
              ...entry,
              subtasks: [...entry.subtasks, { id: makeId('subtask'), title: cleanTitle }],
              updatedAt: timestamp(),
            }
          : entry
      ),
      columns: state.columns,
      cards: state.cards,
    }));
  },

  updateEntrySubtask: (entryId, subtaskId, title) => {
    commitSnapshot(set, (state) => ({
      entries: state.entries.map((entry) =>
        entry.id === entryId
          ? {
              ...entry,
              subtasks: entry.subtasks.map((subtask) =>
                subtask.id === subtaskId ? { ...subtask, title } : subtask
              ),
              updatedAt: timestamp(),
            }
          : entry
      ),
      columns: state.columns,
      cards: state.cards,
    }));
  },

  deleteEntrySubtask: (entryId, subtaskId) => {
    commitSnapshot(set, (state) => ({
      entries: state.entries.map((entry) =>
        entry.id === entryId
          ? {
              ...entry,
              subtasks: entry.subtasks.filter((subtask) => subtask.id !== subtaskId),
              updatedAt: timestamp(),
            }
          : entry
      ),
      columns: state.columns,
      cards: state.cards,
    }));
  },

  addColumn: (title) => {
    const cleanTitle = title.trim();
    if (!cleanTitle) return;

    commitSnapshot(set, (state) => ({
      entries: state.entries,
      columns: [...state.columns, { id: makeId('column'), title: cleanTitle }],
      cards: state.cards,
    }));
  },

  updateColumn: (columnId, title) => {
    commitSnapshot(set, (state) => ({
      entries: state.entries,
      columns: state.columns.map((column) =>
        column.id === columnId ? { ...column, title } : column
      ),
      cards: state.cards,
    }));
  },

  deleteColumn: (columnId) => {
    commitSnapshot(set, (state) => {
      if (state.columns.length <= 1) {
        return state;
      }

      const nextColumns = state.columns.filter((column) => column.id !== columnId);
      const fallbackColumnId = getPrimaryColumnId(nextColumns);

      return {
        entries: state.entries,
        columns: nextColumns,
        cards: state.cards.map((card) =>
          card.columnId === columnId ? { ...card, columnId: fallbackColumnId, updatedAt: timestamp() } : card
        ),
      };
    });
  },

  addManualCard: (columnId) => {
    commitSnapshot(set, (state) => {
      const targetColumnId = columnId ?? getPrimaryColumnId(state.columns);
      const now = timestamp();
      return {
        entries: state.entries,
        columns: state.columns,
        cards: [
          ...state.cards,
          {
            id: makeId('card'),
            title: 'New Task',
            notes: '',
            columnId: targetColumnId,
            subtasks: [],
            parentTitle: null,
            createdAt: now,
            updatedAt: now,
          },
        ],
      };
    });
  },

  addCardFromEntry: (entryId, columnId) => {
    commitSnapshot(set, (state) => {
      const entry = state.entries.find((item) => item.id === entryId);
      if (!entry) return state;

      const now = timestamp();

      return {
        entries: state.entries,
        columns: state.columns,
        cards: [
          ...state.cards,
          {
            id: makeId('card'),
            title: entry.title,
            notes: entry.notes,
            columnId: columnId ?? getPrimaryColumnId(state.columns),
            subtasks: entry.subtasks.map((subtask) => ({ ...subtask })),
            parentTitle: null,
            createdAt: now,
            updatedAt: now,
          },
        ],
      };
    });
  },

  addCardFromSubtask: (entryId, subtaskId, columnId) => {
    commitSnapshot(set, (state) => {
      const entry = state.entries.find((item) => item.id === entryId);
      const subtask = entry?.subtasks.find((item) => item.id === subtaskId);
      if (!entry || !subtask) return state;

      const now = timestamp();
      return {
        entries: state.entries,
        columns: state.columns,
        cards: [
          ...state.cards,
          {
            id: makeId('card'),
            title: subtask.title,
            notes: '',
            columnId: columnId ?? getPrimaryColumnId(state.columns),
            subtasks: [],
            parentTitle: entry.title,
            createdAt: now,
            updatedAt: now,
          },
        ],
      };
    });
  },

  updateCard: (cardId, updates) => {
    commitSnapshot(set, (state) => ({
      entries: state.entries,
      columns: state.columns,
      cards: state.cards.map((card) =>
        card.id === cardId
          ? {
              ...card,
              ...updates,
              updatedAt: timestamp(),
            }
          : card
      ),
    }));
  },

  updateCardSubtask: (cardId, subtaskId, title) => {
    commitSnapshot(set, (state) => ({
      entries: state.entries,
      columns: state.columns,
      cards: state.cards.map((card) =>
        card.id === cardId
          ? {
              ...card,
              subtasks: card.subtasks.map((subtask) =>
                subtask.id === subtaskId ? { ...subtask, title } : subtask
              ),
              updatedAt: timestamp(),
            }
          : card
      ),
    }));
  },

  addCardSubtask: (cardId, title) => {
    const cleanTitle = title.trim();
    if (!cleanTitle) return;

    commitSnapshot(set, (state) => ({
      entries: state.entries,
      columns: state.columns,
      cards: state.cards.map((card) =>
        card.id === cardId
          ? {
              ...card,
              subtasks: [...card.subtasks, { id: makeId('subtask'), title: cleanTitle }],
              updatedAt: timestamp(),
            }
          : card
      ),
    }));
  },

  deleteCardSubtask: (cardId, subtaskId) => {
    commitSnapshot(set, (state) => ({
      entries: state.entries,
      columns: state.columns,
      cards: state.cards.map((card) =>
        card.id === cardId
          ? {
              ...card,
              subtasks: card.subtasks.filter((subtask) => subtask.id !== subtaskId),
              updatedAt: timestamp(),
            }
          : card
      ),
    }));
  },

  moveCard: (cardId, columnId) => {
    commitSnapshot(set, (state) => ({
      entries: state.entries,
      columns: state.columns,
      cards: state.cards.map((card) =>
        card.id === cardId
          ? { ...card, columnId, updatedAt: timestamp() }
          : card
      ),
    }));
  },

  deleteCard: (cardId) => {
    commitSnapshot(set, (state) => ({
      entries: state.entries,
      columns: state.columns,
      cards: state.cards.filter((card) => card.id !== cardId),
    }));
  },

  createBoard: (name) => {
    const cleanName = name.trim();
    if (!cleanName) return;
    const now = timestamp();
    const board: KanbanBoard = {
      id: makeId('board'),
      name: cleanName,
      entries: [],
      columns: DEFAULT_COLUMNS.map((column) => ({ ...column })),
      cards: [],
      createdAt: now,
      updatedAt: now,
    };
    const state = useKanbanStore.getState();
    const next = normalizeSnapshot({
      activeBoardId: board.id,
      boards: [...state.boards, board],
      calendarItems: state.calendarItems,
    });
    localMutationRevision += 1;
    persistSnapshot(next);
    set(next);
  },

  selectBoard: (boardId) => {
    const state = useKanbanStore.getState();
    const board = state.boards.find((candidate) => candidate.id === boardId);
    if (!board || board.id === state.activeBoardId) return;
    const next = { ...state, activeBoardId: board.id, entries: board.entries, columns: board.columns, cards: board.cards };
    localMutationRevision += 1;
    persistSnapshot(next);
    set(next);
  },

  saveBoard: (name) => {
    const state = useKanbanStore.getState();
    const cleanName = name?.trim();
    const now = timestamp();
    const boards = state.boards.map((board) => board.id === state.activeBoardId
      ? { ...board, name: cleanName || board.name, entries: state.entries, columns: state.columns, cards: state.cards, updatedAt: now }
      : board);
    const next = { ...state, boards };
    localMutationRevision += 1;
    persistSnapshot(next);
    set(next);
  },

  duplicateBoard: (boardId) => {
    const state = useKanbanStore.getState();
    const source = state.boards.find((board) => board.id === boardId);
    if (!source) return;
    const now = timestamp();
    const board: KanbanBoard = {
      ...source,
      id: makeId('board'),
      name: `${source.name} Copy`,
      entries: source.entries.map((entry) => ({ ...entry, subtasks: entry.subtasks.map((subtask) => ({ ...subtask })) })),
      columns: source.columns.map((column) => ({ ...column })),
      cards: source.cards.map((card) => ({ ...card, subtasks: card.subtasks.map((subtask) => ({ ...subtask })) })),
      createdAt: now,
      updatedAt: now,
    };
    const next = { ...state, activeBoardId: board.id, boards: [...state.boards, board], entries: board.entries, columns: board.columns, cards: board.cards };
    localMutationRevision += 1;
    persistSnapshot(next);
    set(next);
  },

  deleteBoard: (boardId) => {
    const state = useKanbanStore.getState();
    if (state.boards.length <= 1) return;
    const boards = state.boards.filter((board) => board.id !== boardId);
    const activeBoard = boardId === state.activeBoardId
      ? boards[0]
      : boards.find((board) => board.id === state.activeBoardId) ?? boards[0];
    const next = { ...state, boards, activeBoardId: activeBoard.id, entries: activeBoard.entries, columns: activeBoard.columns, cards: activeBoard.cards };
    localMutationRevision += 1;
    persistSnapshot(next);
    set(next);
  },

  addCalendarItem: (input) => {
    const title = input.title.trim();
    const date = input.date.trim();
    if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    const now = timestamp();
    const item: KanbanCalendarItem = {
      id: makeId('calendar'),
      title,
      notes: input.notes?.trim() ?? '',
      kind: input.kind === 'event' ? 'event' : 'task',
      date,
      startTime: input.startTime?.trim() ?? '',
      endTime: input.endTime?.trim() ?? '',
      allDay: input.allDay ?? true,
      location: input.location?.trim() ?? '',
      googleEventId: input.googleEventId ?? null,
      googleHtmlLink: input.googleHtmlLink ?? null,
      createdAt: now,
      updatedAt: now,
    };
    commitSnapshot(set, (state) => ({ calendarItems: [...state.calendarItems, item] }));
    return item;
  },

  updateCalendarItem: (itemId, updates) => {
    commitSnapshot(set, (state) => ({
      calendarItems: state.calendarItems.map((item) => item.id === itemId
        ? { ...item, ...updates, title: updates.title?.trim() ?? item.title, updatedAt: timestamp() }
        : item),
    }));
  },

  deleteCalendarItem: (itemId) => {
    commitSnapshot(set, (state) => ({ calendarItems: state.calendarItems.filter((item) => item.id !== itemId) }));
  },

  mergeGoogleCalendarItems: (items) => {
    commitSnapshot(set, (state) => {
      const incomingIds = new Set(items.map((item) => item.googleEventId).filter(Boolean));
      return {
        calendarItems: [
          ...state.calendarItems.filter((item) => !item.googleEventId || !incomingIds.has(item.googleEventId)),
          ...items,
        ],
      };
    });
  },

  resetBoard: () => {
    commitSnapshot(set, { entries: [], columns: DEFAULT_COLUMNS.map((column) => ({ ...column })), cards: [] });
  },
}));

// Silent PI-agent mirror: pushes the Kanban snapshot to the backend so
// the main chat agent stays aware of the board. No UI, no buttons.
useKanbanStore.subscribe((state) => {
  mirrorFeatureState('kanban', {
    activeBoardId: state.activeBoardId,
    boards: state.boards,
    columns: state.columns,
    cards: state.cards,
    entries: state.entries,
    calendarItems: state.calendarItems,
  });
});

