import { type DragEvent, type ReactNode, useEffect, useMemo, useState } from 'react';
import {
  useKanbanStore,
  type KanbanCard,
  type KanbanEntry,
} from '../../stores/kanbanStore';
import './KanbanWorkspace.css';
import { KanbanCalendarView } from './KanbanCalendarView';

type DragPayload =
  | { type: 'entry'; entryId: string }
  | { type: 'subtask'; entryId: string; subtaskId: string }
  | { type: 'card'; cardId: string };

type DetailSelection =
  | { kind: 'entry'; entryId: string }
  | { kind: 'entrySubtask'; entryId: string; subtaskId: string }
  | { kind: 'card'; cardId: string }
  | { kind: 'cardSubtask'; cardId: string; subtaskId: string };

function setDragPayload(event: DragEvent<HTMLElement>, payload: DragPayload) {
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('application/deep-canvas-feature', JSON.stringify(payload));
}

function getDragPayload(event: DragEvent<HTMLElement>): DragPayload | null {
  const raw = event.dataTransfer.getData('application/deep-canvas-feature');
  if (!raw) return null;

  try {
    return JSON.parse(raw) as DragPayload;
  } catch {
    return null;
  }
}

function formatCountLabel(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function KanbanWorkspace({ onExit }: { onExit: () => void }) {
  const entries = useKanbanStore((state) => state.entries);
  const columns = useKanbanStore((state) => state.columns);
  const cards = useKanbanStore((state) => state.cards);
  const boards = useKanbanStore((state) => state.boards);
  const activeBoardId = useKanbanStore((state) => state.activeBoardId);
  const hydrate = useKanbanStore((state) => state.hydrate);
  const createBoard = useKanbanStore((state) => state.createBoard);
  const selectBoard = useKanbanStore((state) => state.selectBoard);
  const saveBoard = useKanbanStore((state) => state.saveBoard);
  const duplicateBoard = useKanbanStore((state) => state.duplicateBoard);
  const deleteBoard = useKanbanStore((state) => state.deleteBoard);
  const addEntry = useKanbanStore((state) => state.addEntry);
  const updateEntry = useKanbanStore((state) => state.updateEntry);
  const deleteEntry = useKanbanStore((state) => state.deleteEntry);
  const addEntrySubtask = useKanbanStore((state) => state.addEntrySubtask);
  const updateEntrySubtask = useKanbanStore((state) => state.updateEntrySubtask);
  const deleteEntrySubtask = useKanbanStore((state) => state.deleteEntrySubtask);
  const addColumn = useKanbanStore((state) => state.addColumn);
  const updateColumn = useKanbanStore((state) => state.updateColumn);
  const deleteColumn = useKanbanStore((state) => state.deleteColumn);
  const addManualCard = useKanbanStore((state) => state.addManualCard);
  const addCardFromEntry = useKanbanStore((state) => state.addCardFromEntry);
  const addCardFromSubtask = useKanbanStore((state) => state.addCardFromSubtask);
  const updateCard = useKanbanStore((state) => state.updateCard);
  const updateCardSubtask = useKanbanStore((state) => state.updateCardSubtask);
  const addCardSubtask = useKanbanStore((state) => state.addCardSubtask);
  const deleteCardSubtask = useKanbanStore((state) => state.deleteCardSubtask);
  const moveCard = useKanbanStore((state) => state.moveCard);
  const deleteCard = useKanbanStore((state) => state.deleteCard);

  const [entryTitle, setEntryTitle] = useState('');
  const [entryNotes, setEntryNotes] = useState('');
  const [subtaskDraft, setSubtaskDraft] = useState('');
  const [draftSubtasks, setDraftSubtasks] = useState<string[]>([]);
  const [columnDraft, setColumnDraft] = useState('');
  const [quickSubtaskDrafts, setQuickSubtaskDrafts] = useState<Record<string, string>>({});
  const [dropColumnId, setDropColumnId] = useState<string | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [detailSelection, setDetailSelection] = useState<DetailSelection | null>(null);
  const [workspaceView, setWorkspaceView] = useState<'board' | 'calendar'>('board');
  const activeBoard = boards.find((board) => board.id === activeBoardId) ?? boards[0];
  const [boardNameDraft, setBoardNameDraft] = useState(activeBoard?.name ?? 'Delivery Flow');
  const [boardSaveStatus, setBoardSaveStatus] = useState('');

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  useEffect(() => {
    setBoardNameDraft(activeBoard?.name ?? 'Delivery Flow');
    setBoardSaveStatus('');
  }, [activeBoardId, activeBoard?.name]);

  const columnCards = useMemo(() => {
    return columns.reduce<Record<string, KanbanCard[]>>((accumulator, column) => {
      accumulator[column.id] = cards.filter((card) => card.columnId === column.id);
      return accumulator;
    }, {});
  }, [cards, columns]);

  const boardCardCount = cards.length;
  const intakeCount = entries.length;
  const totalSubentryCount = entries.reduce((total, entry) => total + entry.subtasks.length, 0);

  const handleCreateEntry = () => {
    if (!entryTitle.trim()) return;
    addEntry({ title: entryTitle, notes: entryNotes, subtasks: draftSubtasks });
    setEntryTitle('');
    setEntryNotes('');
    setSubtaskDraft('');
    setDraftSubtasks([]);
    setComposerOpen(false);
  };

  const handleAddDraftSubtask = () => {
    const clean = subtaskDraft.trim();
    if (!clean) return;
    setDraftSubtasks((current) => [...current, clean]);
    setSubtaskDraft('');
  };

  const handleAddQuickSubtask = (entryId: string) => {
    const draft = quickSubtaskDrafts[entryId] ?? '';
    addEntrySubtask(entryId, draft);
    setQuickSubtaskDrafts((current) => ({ ...current, [entryId]: '' }));
  };

  const handleColumnDrop = (columnId: string, event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDropColumnId(null);
    const payload = getDragPayload(event);
    if (!payload) return;

    if (payload.type === 'card') {
      moveCard(payload.cardId, columnId);
      return;
    }

    if (payload.type === 'entry') {
      addCardFromEntry(payload.entryId, columnId);
      return;
    }

    addCardFromSubtask(payload.entryId, payload.subtaskId, columnId);
  };

  return (
    <div className="feature-kanban__workspace animate-rise">
      <div className="feature-kanban__saved-boards" aria-label="Saved Kanban boards">
        <label className="feature-kanban__board-picker-label">
          <span>Saved boards</span>
          <select value={activeBoardId} onChange={(event) => selectBoard(event.target.value)}>
            {boards.map((board) => <option key={board.id} value={board.id}>{board.name}</option>)}
          </select>
        </label>
        <input
          className="feature-kanban__input feature-kanban__input--board-name"
          value={boardNameDraft}
          onChange={(event) => setBoardNameDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && boardNameDraft.trim()) {
              saveBoard(boardNameDraft);
              setBoardSaveStatus('Saved');
            }
          }}
          aria-label="Board name"
          placeholder="Board name"
        />
        <button type="button" className="feature-kanban__primary-button" onClick={() => {
          if (!boardNameDraft.trim()) return;
          saveBoard(boardNameDraft);
          setBoardSaveStatus('Saved');
        }}>Save board</button>
        <button type="button" className="feature-kanban__ghost-button" onClick={() => {
          const name = window.prompt('Name your new board', `Board ${boards.length + 1}`)?.trim();
          if (name) createBoard(name);
        }}>New board</button>
        <button type="button" className="feature-kanban__ghost-button" onClick={() => duplicateBoard(activeBoardId)}>Duplicate</button>
        <button type="button" className="feature-kanban__danger-button" disabled={boards.length <= 1} onClick={() => {
          if (boards.length > 1 && window.confirm(`Delete “${activeBoard?.name ?? 'this board'}”?`)) deleteBoard(activeBoardId);
        }}>Delete</button>
        {boardSaveStatus ? <span className="feature-kanban__save-status">{boardSaveStatus}</span> : null}
      </div>
      <div className="feature-kanban__view-tabs" role="tablist" aria-label="Kanban views">
        <button type="button" role="tab" aria-selected={workspaceView === 'board'} className={workspaceView === 'board' ? 'is-active' : ''} onClick={() => setWorkspaceView('board')}>Kanban</button>
        <button type="button" role="tab" aria-selected={workspaceView === 'calendar'} className={workspaceView === 'calendar' ? 'is-active' : ''} onClick={() => setWorkspaceView('calendar')}>Calendar</button>
      </div>
      {workspaceView === 'calendar' ? <KanbanCalendarView onExit={onExit} /> : (
      <div className="feature-kanban">
      <section className="feature-kanban__intake" aria-label="Task intake">
        <div className="feature-kanban__panel feature-kanban__panel--composer">
          <div className="feature-kanban__panel-header">
            <div>
              <div className="feature-kanban__eyebrow">Task Intake</div>
              <h2 className="feature-kanban__panel-title">Build Tasks</h2>
            </div>
            <div className="feature-kanban__stat-pill">{formatCountLabel(intakeCount, 'task', 'tasks')}</div>
          </div>

          <button
            type="button"
            className="feature-kanban__primary-button feature-kanban__primary-button--full"
            onClick={() => setComposerOpen((current) => !current)}
          >
            {composerOpen ? 'Close task form' : 'Create task'}
          </button>

          {composerOpen ? (
            <div className="feature-kanban__composer">
              <input
                value={entryTitle}
                onChange={(event) => setEntryTitle(event.target.value)}
                className="feature-kanban__input feature-kanban__input--title"
                placeholder="Main task title"
              />
              <textarea
                value={entryNotes}
                onChange={(event) => setEntryNotes(event.target.value)}
                className="feature-kanban__textarea"
                placeholder="Notes, context, owner, due date, or acceptance details"
                rows={3}
              />

              <div className="feature-kanban__inline-form">
                <input
                  value={subtaskDraft}
                  onChange={(event) => setSubtaskDraft(event.target.value)}
                  className="feature-kanban__input"
                  placeholder="Subtask"
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      handleAddDraftSubtask();
                    }
                  }}
                />
                <button type="button" className="feature-kanban__ghost-button" onClick={handleAddDraftSubtask}>
                  Add
                </button>
              </div>

              {draftSubtasks.length > 0 ? (
                <div className="feature-kanban__draft-list">
                  {draftSubtasks.map((item, index) => (
                    <button
                      key={`${item}-${index}`}
                      type="button"
                      className="feature-kanban__draft-row"
                      onClick={() => setDraftSubtasks((current) => current.filter((_, currentIndex) => currentIndex !== index))}
                      title="Remove subtask"
                    >
                      <span>{item}</span>
                      <span aria-hidden="true">x</span>
                    </button>
                  ))}
                </div>
              ) : null}

              <button type="button" className="feature-kanban__primary-button feature-kanban__primary-button--full" onClick={handleCreateEntry}>
                Save task
              </button>
            </div>
          ) : null}
        </div>

        <div className="feature-kanban__panel feature-kanban__panel--queue">
          <div className="feature-kanban__panel-header">
            <div>
              <div className="feature-kanban__eyebrow">Queue</div>
              <h3 className="feature-kanban__panel-title">Ready for Board</h3>
            </div>
            <div className="feature-kanban__stat-pill">{formatCountLabel(totalSubentryCount, 'subtask', 'subtasks')}</div>
          </div>

          <div className="feature-kanban__task-list">
            {entries.length === 0 ? (
              <div className="feature-kanban__empty-state">Create a task, then use + or drag it into a column.</div>
            ) : (
              entries.map((entry) => (
                <div key={entry.id} className="feature-kanban__task-group">
                  <div
                    className="feature-kanban__task-row feature-kanban__task-row--main"
                    draggable
                    onDragStart={(event) => setDragPayload(event, { type: 'entry', entryId: entry.id })}
                  >
                    <button
                      type="button"
                      className="feature-kanban__task-text feature-kanban__task-text--main"
                      onClick={() => setDetailSelection({ kind: 'entry', entryId: entry.id })}
                      title="Open task details"
                    >
                      {entry.title || 'Untitled task'}
                    </button>
                    <span className="feature-kanban__muted-count">{entry.subtasks.length}</span>
                    <button type="button" className="feature-kanban__icon-button" onClick={() => addCardFromEntry(entry.id)} title="Add task to board">
                      +
                    </button>
                    <button type="button" className="feature-kanban__icon-button feature-kanban__icon-button--danger" onClick={() => deleteEntry(entry.id)} title="Delete task">
                      x
                    </button>
                  </div>

                  {entry.subtasks.map((subtask) => (
                    <div
                      key={subtask.id}
                      className="feature-kanban__task-row feature-kanban__task-row--subtask"
                      draggable
                      onDragStart={(event) => setDragPayload(event, { type: 'subtask', entryId: entry.id, subtaskId: subtask.id })}
                    >
                      <button
                        type="button"
                        className="feature-kanban__task-text feature-kanban__task-text--subtask"
                        onClick={() => setDetailSelection({ kind: 'entrySubtask', entryId: entry.id, subtaskId: subtask.id })}
                        title="Open subtask details"
                      >
                        {subtask.title || 'Untitled subtask'}
                      </button>
                      <button type="button" className="feature-kanban__icon-button" onClick={() => addCardFromSubtask(entry.id, subtask.id)} title="Add subtask to board">
                        +
                      </button>
                      <button type="button" className="feature-kanban__icon-button feature-kanban__icon-button--danger" onClick={() => deleteEntrySubtask(entry.id, subtask.id)} title="Delete subtask">
                        x
                      </button>
                    </div>
                  ))}

                  <div className="feature-kanban__quick-subtask">
                    <input
                      value={quickSubtaskDrafts[entry.id] ?? ''}
                      onChange={(event) => setQuickSubtaskDrafts((current) => ({ ...current, [entry.id]: event.target.value }))}
                      className="feature-kanban__input feature-kanban__input--quick"
                      placeholder="Add subtask"
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          handleAddQuickSubtask(entry.id);
                        }
                      }}
                    />
                    <button type="button" className="feature-kanban__ghost-button feature-kanban__ghost-button--tight" onClick={() => handleAddQuickSubtask(entry.id)}>
                      Add
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </section>

      <section className="feature-kanban__board-shell" aria-label="Kanban board">
        <div className="feature-kanban__board-toolbar">
          <div className="feature-kanban__board-heading">
            <div className="feature-kanban__eyebrow">Kanban Board</div>
            <h2 className="feature-kanban__panel-title feature-kanban__panel-title--board">{activeBoard?.name ?? 'Delivery Flow'}</h2>
          </div>
          <div className="feature-kanban__board-stats">
            <div className="feature-kanban__stat-pill">{formatCountLabel(boardCardCount, 'card', 'cards')}</div>
            <input
              value={columnDraft}
              onChange={(event) => setColumnDraft(event.target.value)}
              className="feature-kanban__input feature-kanban__input--toolbar"
              placeholder="New column"
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  addColumn(columnDraft);
                  setColumnDraft('');
                }
              }}
            />
            <button
              type="button"
              className="feature-kanban__primary-button feature-kanban__primary-button--toolbar"
              onClick={() => {
                addColumn(columnDraft);
                setColumnDraft('');
              }}
            >
              Add column
            </button>
            <button type="button" className="feature-workspace__back feature-workspace__back--inline" onClick={onExit}>
              Back to chat
            </button>
          </div>
        </div>

        <div className="feature-kanban__board-grid">
          {columns.map((column) => (
            <section
              key={column.id}
              className={`feature-kanban__column ${dropColumnId === column.id ? 'is-drop-target' : ''}`}
              onDragOver={(event) => {
                event.preventDefault();
                setDropColumnId(column.id);
              }}
              onDragLeave={() => {
                setDropColumnId((current) => (current === column.id ? null : current));
              }}
              onDrop={(event) => handleColumnDrop(column.id, event)}
            >
              <div className="feature-kanban__column-header">
                <input
                  value={column.title}
                  onChange={(event) => updateColumn(column.id, event.target.value)}
                  className="feature-kanban__column-title"
                  aria-label="Column title"
                  title="Column title"
                  placeholder="Column title"
                />
                <span className="feature-kanban__column-count">{columnCards[column.id]?.length ?? 0}</span>
                <button type="button" className="feature-kanban__icon-button" onClick={() => addManualCard(column.id)} title="Add card">
                  +
                </button>
                <button
                  type="button"
                  className="feature-kanban__icon-button feature-kanban__icon-button--danger"
                  onClick={() => deleteColumn(column.id)}
                  disabled={columns.length <= 1}
                  title={columns.length <= 1 ? 'Keep at least one column' : 'Delete column'}
                >
                  x
                </button>
              </div>

              <div className="feature-kanban__card-list">
                {(columnCards[column.id] ?? []).map((card) => (
                  <article
                    key={card.id}
                    className="feature-kanban__board-card"
                    draggable
                    onDragStart={(event) => setDragPayload(event, { type: 'card', cardId: card.id })}
                  >
                    <button
                      type="button"
                      className="feature-kanban__card-main"
                      onClick={() => setDetailSelection({ kind: 'card', cardId: card.id })}
                      title="Open card details"
                    >
                      <span className="feature-kanban__card-title">{card.title || 'Untitled card'}</span>
                      {card.parentTitle ? <span className="feature-kanban__card-parent">From {card.parentTitle}</span> : null}
                    </button>
                    <div className="feature-kanban__card-actions">
                      {card.subtasks.length > 0 ? <span className="feature-kanban__muted-count">{card.subtasks.length}</span> : null}
                      <button type="button" className="feature-kanban__icon-button feature-kanban__icon-button--danger" onClick={() => deleteCard(card.id)} title="Delete card">
                        x
                      </button>
                    </div>

                    {card.subtasks.length > 0 ? (
                      <div className="feature-kanban__card-subtasks">
                        {card.subtasks.slice(0, 3).map((subtask) => (
                          <button
                            key={subtask.id}
                            type="button"
                            className="feature-kanban__card-subtask"
                            onClick={() => setDetailSelection({ kind: 'cardSubtask', cardId: card.id, subtaskId: subtask.id })}
                          >
                            {subtask.title || 'Untitled checklist item'}
                          </button>
                        ))}
                        {card.subtasks.length > 3 ? <span className="feature-kanban__more-count">+{card.subtasks.length - 3} more</span> : null}
                      </div>
                    ) : null}
                  </article>
                ))}

                {(columnCards[column.id] ?? []).length === 0 ? (
                  <div className="feature-kanban__drop-zone">Drop tasks here or use + to create a card.</div>
                ) : null}
              </div>
            </section>
          ))}
        </div>
      </section>

      {detailSelection ? (
        <KanbanDetailModal
          selection={detailSelection}
          entries={entries}
          cards={cards}
          onClose={() => setDetailSelection(null)}
          updateEntry={updateEntry}
          deleteEntry={deleteEntry}
          addEntrySubtask={addEntrySubtask}
          updateEntrySubtask={updateEntrySubtask}
          deleteEntrySubtask={deleteEntrySubtask}
          addCardFromEntry={addCardFromEntry}
          addCardFromSubtask={addCardFromSubtask}
          updateCard={updateCard}
          deleteCard={deleteCard}
          addCardSubtask={addCardSubtask}
          updateCardSubtask={updateCardSubtask}
          deleteCardSubtask={deleteCardSubtask}
        />
      ) : null}
      </div>
      )}
    </div>
  );
}

interface KanbanDetailModalProps {
  selection: DetailSelection;
  entries: KanbanEntry[];
  cards: KanbanCard[];
  onClose: () => void;
  updateEntry: (entryId: string, updates: Partial<Pick<KanbanEntry, 'title' | 'notes'>>) => void;
  deleteEntry: (entryId: string) => void;
  addEntrySubtask: (entryId: string, title: string) => void;
  updateEntrySubtask: (entryId: string, subtaskId: string, title: string) => void;
  deleteEntrySubtask: (entryId: string, subtaskId: string) => void;
  addCardFromEntry: (entryId: string, columnId?: string) => void;
  addCardFromSubtask: (entryId: string, subtaskId: string, columnId?: string) => void;
  updateCard: (cardId: string, updates: Partial<Pick<KanbanCard, 'title' | 'notes'>>) => void;
  deleteCard: (cardId: string) => void;
  addCardSubtask: (cardId: string, title: string) => void;
  updateCardSubtask: (cardId: string, subtaskId: string, title: string) => void;
  deleteCardSubtask: (cardId: string, subtaskId: string) => void;
}

function KanbanDetailModal(props: KanbanDetailModalProps) {
  const [newSubtaskTitle, setNewSubtaskTitle] = useState('');
  const {
    selection,
    entries,
    cards,
    onClose,
    updateEntry,
    deleteEntry,
    addEntrySubtask,
    updateEntrySubtask,
    deleteEntrySubtask,
    addCardFromEntry,
    addCardFromSubtask,
    updateCard,
    deleteCard,
    addCardSubtask,
    updateCardSubtask,
    deleteCardSubtask,
  } = props;

  if (selection.kind === 'entry') {
    const entry = entries.find((item) => item.id === selection.entryId);
    if (!entry) return null;

    return (
      <ModalShell title="Task details" onClose={onClose}>
        <label className="feature-kanban__modal-field">
          <span>Task</span>
          <input value={entry.title} onChange={(event) => updateEntry(entry.id, { title: event.target.value })} className="feature-kanban__input feature-kanban__input--title" />
        </label>
        <label className="feature-kanban__modal-field">
          <span>Notes</span>
          <textarea value={entry.notes} onChange={(event) => updateEntry(entry.id, { notes: event.target.value })} className="feature-kanban__textarea" rows={5} />
        </label>
        <div className="feature-kanban__modal-section">
          <div className="feature-kanban__modal-section-head">
            <span>Subtasks</span>
            <button type="button" className="feature-kanban__ghost-button feature-kanban__ghost-button--tight" onClick={() => addCardFromEntry(entry.id)}>
              Add task to board
            </button>
          </div>
          {entry.subtasks.map((subtask) => (
            <div key={subtask.id} className="feature-kanban__modal-row">
              <input value={subtask.title} onChange={(event) => updateEntrySubtask(entry.id, subtask.id, event.target.value)} className="feature-kanban__input feature-kanban__input--quick" aria-label="Subtask title" title="Subtask title" placeholder="Subtask title" />
              <button type="button" className="feature-kanban__icon-button" onClick={() => addCardFromSubtask(entry.id, subtask.id)} title="Add subtask to board">+</button>
              <button type="button" className="feature-kanban__icon-button feature-kanban__icon-button--danger" onClick={() => deleteEntrySubtask(entry.id, subtask.id)} title="Delete subtask">x</button>
            </div>
          ))}
          <AddItemForm value={newSubtaskTitle} onChange={setNewSubtaskTitle} onAdd={() => {
            addEntrySubtask(entry.id, newSubtaskTitle);
            setNewSubtaskTitle('');
          }} placeholder="New subtask" />
        </div>
        <div className="feature-kanban__modal-actions">
          <button type="button" className="feature-kanban__danger-button" onClick={() => { deleteEntry(entry.id); onClose(); }}>Delete task</button>
        </div>
      </ModalShell>
    );
  }

  if (selection.kind === 'entrySubtask') {
    const entry = entries.find((item) => item.id === selection.entryId);
    const subtask = entry?.subtasks.find((item) => item.id === selection.subtaskId);
    if (!entry || !subtask) return null;

    return (
      <ModalShell title="Subtask details" onClose={onClose}>
        <div className="feature-kanban__modal-kicker">Parent task: {entry.title}</div>
        <label className="feature-kanban__modal-field">
          <span>Subtask</span>
          <input value={subtask.title} onChange={(event) => updateEntrySubtask(entry.id, subtask.id, event.target.value)} className="feature-kanban__input feature-kanban__input--title" />
        </label>
        <label className="feature-kanban__modal-field">
          <span>Parent notes</span>
          <textarea value={entry.notes} onChange={(event) => updateEntry(entry.id, { notes: event.target.value })} className="feature-kanban__textarea" rows={5} />
        </label>
        <div className="feature-kanban__modal-actions">
          <button type="button" className="feature-kanban__primary-button" onClick={() => addCardFromSubtask(entry.id, subtask.id)}>Add to board</button>
          <button type="button" className="feature-kanban__danger-button" onClick={() => { deleteEntrySubtask(entry.id, subtask.id); onClose(); }}>Delete subtask</button>
        </div>
      </ModalShell>
    );
  }

  if (selection.kind === 'card') {
    const card = cards.find((item) => item.id === selection.cardId);
    if (!card) return null;

    return (
      <ModalShell title="Card details" onClose={onClose}>
        {card.parentTitle ? <div className="feature-kanban__modal-kicker">From {card.parentTitle}</div> : null}
        <label className="feature-kanban__modal-field">
          <span>Card</span>
          <input value={card.title} onChange={(event) => updateCard(card.id, { title: event.target.value })} className="feature-kanban__input feature-kanban__input--title" />
        </label>
        <label className="feature-kanban__modal-field">
          <span>Notes</span>
          <textarea value={card.notes} onChange={(event) => updateCard(card.id, { notes: event.target.value })} className="feature-kanban__textarea" rows={5} />
        </label>
        <div className="feature-kanban__modal-section">
          <div className="feature-kanban__modal-section-head"><span>Checklist</span></div>
          {card.subtasks.map((subtask) => (
            <div key={subtask.id} className="feature-kanban__modal-row">
              <input value={subtask.title} onChange={(event) => updateCardSubtask(card.id, subtask.id, event.target.value)} className="feature-kanban__input feature-kanban__input--quick" aria-label="Checklist item" title="Checklist item" placeholder="Checklist item" />
              <button type="button" className="feature-kanban__icon-button feature-kanban__icon-button--danger" onClick={() => deleteCardSubtask(card.id, subtask.id)} title="Delete checklist item">x</button>
            </div>
          ))}
          <AddItemForm value={newSubtaskTitle} onChange={setNewSubtaskTitle} onAdd={() => {
            addCardSubtask(card.id, newSubtaskTitle);
            setNewSubtaskTitle('');
          }} placeholder="New checklist item" />
        </div>
        <div className="feature-kanban__modal-actions">
          <button type="button" className="feature-kanban__danger-button" onClick={() => { deleteCard(card.id); onClose(); }}>Delete card</button>
        </div>
      </ModalShell>
    );
  }

  const card = cards.find((item) => item.id === selection.cardId);
  const subtask = card?.subtasks.find((item) => item.id === selection.subtaskId);
  if (!card || !subtask) return null;

  return (
    <ModalShell title="Checklist item" onClose={onClose}>
      <div className="feature-kanban__modal-kicker">Card: {card.title}</div>
      <label className="feature-kanban__modal-field">
        <span>Item</span>
        <input value={subtask.title} onChange={(event) => updateCardSubtask(card.id, subtask.id, event.target.value)} className="feature-kanban__input feature-kanban__input--title" />
      </label>
      <label className="feature-kanban__modal-field">
        <span>Card notes</span>
        <textarea value={card.notes} onChange={(event) => updateCard(card.id, { notes: event.target.value })} className="feature-kanban__textarea" rows={5} />
      </label>
      <div className="feature-kanban__modal-actions">
        <button type="button" className="feature-kanban__danger-button" onClick={() => { deleteCardSubtask(card.id, subtask.id); onClose(); }}>Delete item</button>
      </div>
    </ModalShell>
  );
}

function ModalShell({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  return (
    <div className="feature-kanban__modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="feature-kanban__modal" role="dialog" aria-modal="true" aria-label={title} onMouseDown={(event) => event.stopPropagation()}>
        <header className="feature-kanban__modal-header">
          <h2>{title}</h2>
          <button type="button" className="feature-kanban__icon-button" onClick={onClose} title="Close">x</button>
        </header>
        {children}
      </section>
    </div>
  );
}

function AddItemForm({ value, onChange, onAdd, placeholder }: { value: string; onChange: (value: string) => void; onAdd: () => void; placeholder: string }) {
  return (
    <div className="feature-kanban__modal-row">
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="feature-kanban__input feature-kanban__input--quick"
        placeholder={placeholder}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            onAdd();
          }
        }}
      />
      <button type="button" className="feature-kanban__ghost-button feature-kanban__ghost-button--tight" onClick={onAdd}>Add</button>
    </div>
  );
}

