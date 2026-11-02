import { useEffect, useMemo, useState } from 'react';
import { webRequest } from '../../services/webClient';
import {
  useKanbanStore,
  type CalendarItemKind,
  type KanbanCalendarItem,
} from '../../stores/kanbanStore';

interface GoogleCalendarState {
  configured: boolean;
  connected: boolean;
  email?: string;
}

interface CalendarDraft {
  id: string;
  title: string;
  notes: string;
  kind: CalendarItemKind;
  date: string;
  startTime: string;
  endTime: string;
  allDay: boolean;
  location: string;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function dateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function emptyDraft(date = dateKey(new Date())): CalendarDraft {
  return { id: '', title: '', notes: '', kind: 'task', date, startTime: '09:00', endTime: '10:00', allDay: true, location: '' };
}

function draftFromItem(item: KanbanCalendarItem): CalendarDraft {
  return {
    id: item.id,
    title: item.title,
    notes: item.notes,
    kind: item.kind,
    date: item.date,
    startTime: item.startTime || '09:00',
    endTime: item.endTime || '10:00',
    allDay: item.allDay,
    location: item.location,
  };
}

export function KanbanCalendarView({ onExit }: { onExit: () => void }) {
  const items = useKanbanStore((state) => state.calendarItems);
  const addItem = useKanbanStore((state) => state.addCalendarItem);
  const updateItem = useKanbanStore((state) => state.updateCalendarItem);
  const deleteItem = useKanbanStore((state) => state.deleteCalendarItem);
  const mergeGoogleItems = useKanbanStore((state) => state.mergeGoogleCalendarItems);
  const [month, setMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const [draft, setDraft] = useState<CalendarDraft | null>(null);
  const [google, setGoogle] = useState<GoogleCalendarState>({ configured: false, connected: false });
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState('');

  const loadGoogleState = async () => {
    try {
      const state = await webRequest<GoogleCalendarState>('calendar.google.state', {}, { timeoutMs: 12000 });
      setGoogle(state);
    } catch {
      setGoogle({ configured: false, connected: false });
    }
  };

  useEffect(() => { void loadGoogleState(); }, []);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.data?.type !== 'deepcanvas:google-calendar') return;
      setMessage(event.data.ok ? 'Google Calendar connected.' : (event.data.message || 'Google Calendar connection failed.'));
      void loadGoogleState();
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  const days = useMemo(() => {
    const start = new Date(month.getFullYear(), month.getMonth(), 1);
    start.setDate(start.getDate() - start.getDay());
    return Array.from({ length: 42 }, (_, index) => {
      const date = new Date(start);
      date.setDate(start.getDate() + index);
      return date;
    });
  }, [month]);

  const itemsByDate = useMemo(() => items.reduce<Record<string, KanbanCalendarItem[]>>((map, item) => {
    (map[item.date] ||= []).push(item);
    return map;
  }, {}), [items]);

  const connectGoogle = async () => {
    setMessage('');
    try {
      const response = await webRequest<{ authorizationUrl: string }>('calendar.google.connect', {}, { timeoutMs: 12000 });
      window.open(response.authorizationUrl, 'deepcanvas-google-calendar', 'popup=yes,width=640,height=760');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not start Google Calendar connection.');
    }
  };

  const syncGoogle = async () => {
    setSyncing(true);
    setMessage('');
    try {
      const timeMin = new Date(month.getFullYear(), month.getMonth() - 1, 1).toISOString();
      const timeMax = new Date(month.getFullYear(), month.getMonth() + 2, 1).toISOString();
      const response = await webRequest<{ items: KanbanCalendarItem[] }>('calendar.google.events', { timeMin, timeMax }, { timeoutMs: 30000 });
      mergeGoogleItems(response.items || []);
      setMessage(`Synced ${(response.items || []).length} Google Calendar events.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Google Calendar sync failed.');
    } finally {
      setSyncing(false);
    }
  };

  const saveDraft = async () => {
    if (!draft?.title.trim() || !draft.date) return;
    if (draft.id) {
      updateItem(draft.id, { ...draft, title: draft.title.trim() });
    } else {
      const created = addItem(draft);
      if (created && google.connected) {
        try {
          const googleEvent = await webRequest<{ googleEventId: string; googleHtmlLink: string }>('calendar.google.create', { ...draft, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }, { timeoutMs: 30000 });
          updateItem(created.id, googleEvent);
          setMessage('Saved in Deep Canvas and Google Calendar.');
        } catch (error) {
          setMessage(error instanceof Error ? `Saved in Deep Canvas. Google sync failed: ${error.message}` : 'Saved in Deep Canvas, but Google sync failed.');
        }
      }
    }
    setDraft(null);
  };

  return (
    <section className="feature-kanban__calendar-shell">
      <div className="feature-kanban__calendar-toolbar">
        <div>
          <div className="feature-kanban__eyebrow">Calendar</div>
          <h2 className="feature-kanban__panel-title feature-kanban__panel-title--board">
            {month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
          </h2>
        </div>
        <div className="feature-kanban__calendar-actions">
          <button className="feature-kanban__ghost-button" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}>Previous</button>
          <button className="feature-kanban__ghost-button" onClick={() => setMonth(new Date(new Date().getFullYear(), new Date().getMonth(), 1))}>Today</button>
          <button className="feature-kanban__ghost-button" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}>Next</button>
          {google.connected ? (
            <button className="feature-kanban__primary-button" disabled={syncing} onClick={() => void syncGoogle()}>{syncing ? 'Syncing...' : `Sync Google${google.email ? ` (${google.email})` : ''}`}</button>
          ) : (
            <button className="feature-kanban__primary-button" disabled={!google.configured} onClick={() => void connectGoogle()}>{google.configured ? 'Connect Google Calendar' : 'Google setup required'}</button>
          )}
          <button className="feature-workspace__back feature-workspace__back--inline" onClick={onExit}>Back to chat</button>
        </div>
      </div>

      {message ? <div className="feature-kanban__calendar-message">{message}</div> : null}
      {!google.configured ? <div className="feature-kanban__calendar-message">Built-in calendar is ready. Google connection requires server credentials before the first connection.</div> : null}

      <div className="feature-kanban__calendar-weekdays">
        {WEEKDAYS.map((day) => <div key={day}>{day}</div>)}
      </div>
      <div className="feature-kanban__calendar-grid">
        {days.map((day) => {
          const key = dateKey(day);
          const dayItems = itemsByDate[key] || [];
          const outside = day.getMonth() !== month.getMonth();
          const today = key === dateKey(new Date());
          return (
            <div key={key} className={`feature-kanban__calendar-day${outside ? ' is-outside' : ''}${today ? ' is-today' : ''}`}>
              <button className="feature-kanban__calendar-date" onClick={() => setDraft(emptyDraft(key))} title="Add task or event">{day.getDate()} <span>+</span></button>
              <div className="feature-kanban__calendar-items">
                {dayItems.slice(0, 5).map((item) => (
                  <button key={item.id} className={`feature-kanban__calendar-item is-${item.kind}${item.googleEventId ? ' is-google' : ''}`} onClick={() => setDraft(draftFromItem(item))}>
                    {!item.allDay && item.startTime ? <span>{item.startTime}</span> : null}{item.title}
                  </button>
                ))}
                {dayItems.length > 5 ? <span className="feature-kanban__calendar-more">+{dayItems.length - 5} more</span> : null}
              </div>
            </div>
          );
        })}
      </div>

      {draft ? (
        <div className="feature-kanban__modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setDraft(null); }}>
          <div className="feature-kanban__modal">
            <div className="feature-kanban__modal-header"><div className="feature-kanban__modal-kicker">{draft.id ? 'Edit calendar item' : 'New calendar item'}</div><h2>{draft.title || 'Untitled'}</h2></div>
            <label className="feature-kanban__modal-field"><span>Type</span><select className="feature-kanban__input" value={draft.kind} onChange={(event) => setDraft({ ...draft, kind: event.target.value as CalendarItemKind })}><option value="task">Task</option><option value="event">Event</option></select></label>
            <label className="feature-kanban__modal-field"><span>Title</span><input autoFocus className="feature-kanban__input" value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /></label>
            <label className="feature-kanban__modal-field"><span>Date</span><input type="date" className="feature-kanban__input" value={draft.date} onChange={(event) => setDraft({ ...draft, date: event.target.value })} /></label>
            <label className="feature-kanban__calendar-check"><input type="checkbox" checked={draft.allDay} onChange={(event) => setDraft({ ...draft, allDay: event.target.checked })} /> All day</label>
            {!draft.allDay ? <div className="feature-kanban__modal-row"><label className="feature-kanban__modal-field"><span>Starts</span><input type="time" className="feature-kanban__input" value={draft.startTime} onChange={(event) => setDraft({ ...draft, startTime: event.target.value })} /></label><label className="feature-kanban__modal-field"><span>Ends</span><input type="time" className="feature-kanban__input" value={draft.endTime} onChange={(event) => setDraft({ ...draft, endTime: event.target.value })} /></label></div> : null}
            <label className="feature-kanban__modal-field"><span>Location</span><input className="feature-kanban__input" value={draft.location} onChange={(event) => setDraft({ ...draft, location: event.target.value })} /></label>
            <label className="feature-kanban__modal-field"><span>Notes</span><textarea className="feature-kanban__textarea" rows={4} value={draft.notes} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} /></label>
            <div className="feature-kanban__modal-actions">
              {draft.id ? <button className="feature-kanban__danger-button" onClick={() => { deleteItem(draft.id); setDraft(null); }}>Delete</button> : null}
              <button className="feature-kanban__ghost-button" onClick={() => setDraft(null)}>Cancel</button>
              <button className="feature-kanban__primary-button" onClick={() => void saveDraft()}>Save</button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

