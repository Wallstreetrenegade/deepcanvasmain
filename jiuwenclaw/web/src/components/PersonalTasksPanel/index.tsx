import { useCallback, useEffect, useRef, useState } from 'react';
import { Bell, Check, File, Image, NotebookPen, Paperclip, Plus, Trash2 } from 'lucide-react';
import { webRequest } from '../../services/webClient';
import './PersonalTasksPanel.css';

type PersonalItemKind = 'task' | 'note';

type PersonalAttachment = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  thumbnailDataUrl?: string;
};

type PersonalItem = {
  id: string;
  kind: PersonalItemKind;
  title: string;
  body: string;
  dueAt: string;
  completed: boolean;
  attachments: PersonalAttachment[];
  createdAt: string;
  updatedAt: string;
};

const SETTINGS_KEY = 'personal_workspace_v1';
const MAX_FILE_BYTES = 25 * 1024 * 1024;

function uid() {
  return `personal_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Could not read file.'));
    reader.readAsDataURL(file);
  });
}

async function makeThumbnail(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) return '';
  const source = await readAsDataUrl(file);
  return new Promise((resolve) => {
    const img = new window.Image();
    img.onload = () => {
      const scale = Math.min(1, 640 / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      canvas.getContext('2d')?.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', 0.72));
    };
    img.onerror = () => resolve('');
    img.src = source;
  });
}

export function PersonalTasksPanel() {
  const [items, setItems] = useState<PersonalItem[]>([]);
  const [kind, setKind] = useState<PersonalItemKind>('task');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let active = true;
    void webRequest<{ settings?: Record<string, unknown> }>('user.settings.get', {}, { timeoutMs: 15000 })
      .then((response) => {
        if (!active) return;
        const stored = response.settings?.[SETTINGS_KEY];
        setItems(Array.isArray(stored) ? stored as PersonalItem[] : []);
      })
      .catch((reason) => active && setError(reason instanceof Error ? reason.message : 'Could not load your personal tasks.'))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, []);

  const persist = useCallback(async (next: PersonalItem[]) => {
    setSaving(true);
    setError('');
    try {
      await webRequest('user.settings.set', { settings: { [SETTINGS_KEY]: next } }, { timeoutMs: 20000 });
      setItems(next);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Your changes could not be saved.');
      throw reason;
    } finally {
      setSaving(false);
    }
  }, []);

  const queueFiles = (incoming: File[]) => {
    const accepted = incoming.filter((file) => file.size <= MAX_FILE_BYTES).slice(0, 6 - pendingFiles.length);
    if (accepted.length !== incoming.length) setError('Files must be 25 MB or smaller; up to six can be attached at once.');
    setPendingFiles((current) => [...current, ...accepted].slice(0, 6));
  };

  const uploadFile = async (file: File): Promise<PersonalAttachment> => {
    const [dataUrl, thumbnailDataUrl] = await Promise.all([readAsDataUrl(file), makeThumbnail(file)]);
    const response = await webRequest<{ fileId?: string }>('storage.upload_file', {
      file: {
        name: file.name,
        mimeType: file.type || 'application/octet-stream',
        sizeBytes: file.size,
        dataUrl,
        thumbnailDataUrl,
        folderId: 'root',
      },
    }, { timeoutMs: 120000 });
    if (!response.fileId) throw new Error(`Could not store ${file.name}.`);
    return { id: response.fileId, name: file.name, mimeType: file.type || 'application/octet-stream', sizeBytes: file.size, thumbnailDataUrl };
  };

  const addItem = async () => {
    if (!title.trim() && !body.trim() && pendingFiles.length === 0) return;
    setSaving(true);
    setError('');
    try {
      const attachments: PersonalAttachment[] = [];
      for (const file of pendingFiles) attachments.push(await uploadFile(file));
      const now = new Date().toISOString();
      const next: PersonalItem[] = [{
        id: uid(), kind, title: title.trim() || (kind === 'note' ? 'Untitled note' : 'New task'), body: body.trim(), dueAt,
        completed: false, attachments, createdAt: now, updatedAt: now,
      }, ...items];
      await webRequest('user.settings.set', { settings: { [SETTINGS_KEY]: next } }, { timeoutMs: 20000 });
      setItems(next);
      setTitle(''); setBody(''); setDueAt(''); setPendingFiles([]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Your item could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  const toggleItem = async (item: PersonalItem) => {
    const next = items.map((entry) => entry.id === item.id ? { ...entry, completed: !entry.completed, updatedAt: new Date().toISOString() } : entry);
    await persist(next).catch(() => undefined);
  };

  const deleteItem = async (item: PersonalItem) => {
    if (!window.confirm(`Delete “${item.title}”?`)) return;
    await persist(items.filter((entry) => entry.id !== item.id)).catch(() => undefined);
  };

  const downloadAttachment = async (attachment: PersonalAttachment) => {
    try {
      const response = await webRequest<{ file?: { name: string; dataUrl: string } }>('storage.get_file_blob', { fileId: attachment.id }, { timeoutMs: 120000 });
      if (!response.file?.dataUrl) return;
      const anchor = document.createElement('a');
      anchor.href = response.file.dataUrl;
      anchor.download = response.file.name || attachment.name;
      anchor.click();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not open attachment.');
    }
  };

  return <div className="personal-tasks">
    <div className="personal-tasks__composer">
      <div className="personal-tasks__kind">
        <button className={kind === 'task' ? 'is-active' : ''} onClick={() => setKind('task')}><Check size={13} />To-do</button>
        <button className={kind === 'note' ? 'is-active' : ''} onClick={() => setKind('note')}><NotebookPen size={13} />Note</button>
      </div>
      <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder={kind === 'task' ? 'What needs to be done?' : 'Note title'} maxLength={180} />
      <textarea value={body} onChange={(event) => setBody(event.target.value)} onPaste={(event) => {
        const files = Array.from(event.clipboardData.files);
        if (files.length) { event.preventDefault(); queueFiles(files); }
      }} placeholder="Add details, paste text, or paste a screenshot…" rows={3} />
      {kind === 'task' ? <label className="personal-tasks__reminder"><Bell size={13} /><span>Reminder</span><input type="datetime-local" value={dueAt} onChange={(event) => setDueAt(event.target.value)} /></label> : null}
      {pendingFiles.length ? <div className="personal-tasks__pending">{pendingFiles.map((file, index) => <span key={`${file.name}-${index}`}><Paperclip size={11} />{file.name}<button onClick={() => setPendingFiles((current) => current.filter((_, fileIndex) => fileIndex !== index))}>×</button></span>)}</div> : null}
      <div className="personal-tasks__actions">
        <input ref={fileInputRef} hidden type="file" multiple accept="image/*,video/*,audio/*,.pdf,.txt,.doc,.docx,.xls,.xlsx" onChange={(event) => { queueFiles(Array.from(event.target.files || [])); event.target.value = ''; }} />
        <button className="is-secondary" onClick={() => fileInputRef.current?.click()}><Paperclip size={14} />Attach</button>
        <button className="is-primary" disabled={saving || (!title.trim() && !body.trim() && pendingFiles.length === 0)} onClick={() => void addItem()}><Plus size={14} />{saving ? 'Saving…' : `Add ${kind}`}</button>
      </div>
    </div>
    {error ? <div className="personal-tasks__error">{error}</div> : null}
    <div className="personal-tasks__heading"><span>My tasks & notes</span><span>{items.length}</span></div>
    <div className="personal-tasks__list">
      {loading ? <div className="personal-tasks__empty">Loading…</div> : items.length === 0 ? <div className="personal-tasks__empty">Add a to-do, reminder, note, or screenshot above.</div> : items.map((item) => <article key={item.id} className={item.completed ? 'is-completed' : ''}>
        <div className="personal-tasks__item-top">
          {item.kind === 'task' ? <button className="personal-tasks__check" onClick={() => void toggleItem(item)} aria-label={item.completed ? 'Mark incomplete' : 'Mark complete'}>{item.completed ? <Check size={13} /> : null}</button> : <span className="personal-tasks__note-icon"><NotebookPen size={13} /></span>}
          <strong>{item.title}</strong>
          <button className="personal-tasks__delete" onClick={() => void deleteItem(item)} aria-label="Delete"><Trash2 size={13} /></button>
        </div>
        {item.body ? <p>{item.body}</p> : null}
        {item.dueAt ? <div className="personal-tasks__due"><Bell size={11} />{new Date(item.dueAt).toLocaleString()}</div> : null}
        {item.attachments?.length ? <div className="personal-tasks__attachments">{item.attachments.map((attachment) => <button key={attachment.id} onClick={() => void downloadAttachment(attachment)} title={`Open ${attachment.name}`}>{attachment.thumbnailDataUrl ? <img src={attachment.thumbnailDataUrl} alt="" /> : attachment.mimeType.startsWith('image/') ? <Image size={18} /> : <File size={18} />}<span>{attachment.name}</span></button>)}</div> : null}
      </article>)}
    </div>
  </div>;
}

