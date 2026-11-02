import { useEffect, useMemo, useRef, useState } from 'react';
import {
  useStorageStore,
  type StorageFileItem,
  type StorageFolder,
  type StorageProviderKey,
} from '../../stores/storageStore';
import './StorageWorkspace.css';

interface Props {
  onExit: () => void;
}

const PROVIDERS: Array<{ key: StorageProviderKey; label: string }> = [
  { key: 'googleDrive', label: 'Google Drive' },
  { key: 'oneDrive', label: 'OneDrive' },
];

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function fileGlyph(file: StorageFileItem): string {
  if (file.kind === 'image') return 'IMG';
  if (file.kind === 'video') return 'VID';
  if (file.kind === 'audio') return 'AUD';
  if (file.kind === 'document') return (file.extension || 'DOC').replace('.', '').slice(0, 3).toUpperCase();
  return 'FILE';
}

function folderPath(folders: StorageFolder[], folderId: string): string {
  const lookup = new Map(folders.map((folder) => [folder.id, folder]));
  const names: string[] = [];
  let current = lookup.get(folderId);
  while (current) {
    names.unshift(current.name);
    current = current.parentId ? lookup.get(current.parentId) : undefined;
  }
  return names.join(' / ') || 'MAIN';
}

export function StorageWorkspace(_: Props) {
  const storage = useStorageStore();
  const {
    files, folders, categories, providers, isLoaded, isLoading, busy, error,
    loadState, clearError, createFolder, deleteFolder, createCategory, deleteCategory,
    uploadFiles, updateFile, deleteFile, downloadFile, saveProviderSettings,
    startDriveConnect, pollDriveConnect, disconnectProvider,
  } = storage;
  const [activeFolderId, setActiveFolderId] = useState('root');
  const [activeCategoryId, setActiveCategoryId] = useState('all');
  const [query, setQuery] = useState('');
  const [newFolderName, setNewFolderName] = useState('');
  const [newCategoryName, setNewCategoryName] = useState('');
  const [providerDrafts, setProviderDrafts] = useState<Record<StorageProviderKey, string>>({ googleDrive: '', oneDrive: '' });
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!isLoaded && !isLoading) void loadState();
  }, [isLoaded, isLoading, loadState]);

  useEffect(() => {
    setProviderDrafts({
      googleDrive: providers.googleDrive?.clientId || '',
      oneDrive: providers.oneDrive?.clientId || '',
    });
  }, [providers.googleDrive?.clientId, providers.oneDrive?.clientId]);

  const folderChildren = useMemo(() => folders.filter((folder) => folder.parentId === activeFolderId), [folders, activeFolderId]);
  const categoryLookup = useMemo(() => new Map(categories.map((category) => [category.id, category])), [categories]);
  const visibleFiles = useMemo(() => {
    const q = query.trim().toLowerCase();
    return files.filter((file) => {
      const inFolder = file.folderId === activeFolderId;
      const inCategory = activeCategoryId === 'all' || file.categoryId === activeCategoryId;
      const matches = !q || [file.name, file.mimeType, file.notes, categoryLookup.get(file.categoryId)?.name]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(q);
      return inFolder && inCategory && matches;
    });
  }, [files, activeFolderId, activeCategoryId, query, categoryLookup]);

  const totals = useMemo(() => {
    const bytes = files.reduce((sum, file) => sum + (file.sizeBytes || 0), 0);
    const images = files.filter((file) => file.kind === 'image').length;
    const videos = files.filter((file) => file.kind === 'video').length;
    const documents = files.filter((file) => file.kind === 'document').length;
    return { bytes, images, videos, documents };
  }, [files]);

  const handleCreateFolder = async () => {
    const name = newFolderName.trim();
    if (!name) return;
    setNewFolderName('');
    await createFolder(name, activeFolderId);
  };

  const handleCreateCategory = async () => {
    const name = newCategoryName.trim();
    if (!name) return;
    setNewCategoryName('');
    await createCategory(name);
  };

  const handleUpload = async (selected: FileList | null) => {
    if (!selected?.length) return;
    await uploadFiles(selected, { folderId: activeFolderId, categoryId: activeCategoryId === 'all' ? undefined : activeCategoryId });
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const activeFolder = folders.find((folder) => folder.id === activeFolderId) || folders[0];
  const activeFolderName = activeFolder?.name || 'MAIN';

  return (
    <div className="storage-ws">
      {error && (
        <div className="storage-ws__banner storage-ws__banner--error">
          <span>{error}</span>
          <button type="button" onClick={clearError}>Dismiss</button>
        </div>
      )}

      <section className="storage-ws__drive-bar">
        {PROVIDERS.map(({ key, label }) => {
          const provider = providers[key];
          const status = provider?.status || 'not_configured';
          return (
            <div className="storage-ws__provider" key={key}>
              <div className="storage-ws__provider-head">
                <strong>{label}</strong>
                <span className={`storage-ws__status storage-ws__status--${status}`}>{status.replace(/_/g, ' ')}</span>
              </div>
              <div className="storage-ws__provider-controls">
                <input
                  value={providerDrafts[key] || ''}
                  onChange={(event) => setProviderDrafts((drafts) => ({ ...drafts, [key]: event.target.value }))}
                  placeholder={`${label} OAuth client ID`}
                  disabled={busy}
                />
                <button type="button" onClick={() => saveProviderSettings(key, providerDrafts[key] || '')} disabled={busy}>Save</button>
                <button type="button" onClick={() => startDriveConnect(key)} disabled={busy || !provider?.clientId}>Connect</button>
                {status === 'pending' && <button type="button" onClick={() => pollDriveConnect(key)} disabled={busy}>Check</button>}
                {status === 'connected' && <button type="button" onClick={() => disconnectProvider(key)} disabled={busy}>Disconnect</button>}
              </div>
              {status === 'pending' && (
                <div className="storage-ws__device-code">
                  <span>{provider?.userCode}</span>
                  {provider?.verificationUri && <a href={provider.verificationUriComplete || provider.verificationUri} target="_blank" rel="noreferrer">Open authorization page</a>}
                </div>
              )}
              {provider?.lastError && <div className="storage-ws__provider-error">{provider.lastError}</div>}
            </div>
          );
        })}
      </section>

      <section className="storage-ws__stats">
        <div><strong>{files.length}</strong><span>Files</span></div>
        <div><strong>{folders.length - 1}</strong><span>Folders</span></div>
        <div><strong>{formatBytes(totals.bytes)}</strong><span>Used</span></div>
        <div><strong>{totals.images}/{totals.videos}/{totals.documents}</strong><span>Image / Video / Docs</span></div>
      </section>

      <div className="storage-ws__main">
        <aside className="storage-ws__nav">
          <div className="storage-ws__panel-title">Categories</div>
          <button type="button" className={activeCategoryId === 'all' ? 'is-active' : ''} onClick={() => setActiveCategoryId('all')}>All files</button>
          {categories.map((category) => (
            <button key={category.id} type="button" className={activeCategoryId === category.id ? 'is-active' : ''} onClick={() => setActiveCategoryId(category.id)}>
              <span>{category.name}</span>
              {category.kind === 'custom' && <span className="storage-ws__nav-count">custom</span>}
            </button>
          ))}
          <div className="storage-ws__inline-create">
            <input value={newCategoryName} onChange={(event) => setNewCategoryName(event.target.value)} placeholder="New category" onKeyDown={(event) => { if (event.key === 'Enter') void handleCreateCategory(); }} />
            <button type="button" onClick={handleCreateCategory} disabled={busy || !newCategoryName.trim()}>Add</button>
          </div>
          {categories.filter((category) => category.kind === 'custom').map((category) => (
            <button key={`delete-${category.id}`} type="button" className="storage-ws__danger-link" onClick={() => deleteCategory(category.id)}>Delete {category.name}</button>
          ))}

          <div className="storage-ws__panel-title storage-ws__panel-title--gap">Folders</div>
          {folders.map((folder) => (
            <button key={folder.id} type="button" className={activeFolderId === folder.id ? 'is-active' : ''} onClick={() => setActiveFolderId(folder.id)}>
              <span>{folder.name}</span>
              {folder.id !== 'root' && <span className="storage-ws__nav-count">{files.filter((file) => file.folderId === folder.id).length}</span>}
            </button>
          ))}
          <div className="storage-ws__inline-create">
            <input value={newFolderName} onChange={(event) => setNewFolderName(event.target.value)} placeholder="New folder" onKeyDown={(event) => { if (event.key === 'Enter') void handleCreateFolder(); }} />
            <button type="button" onClick={handleCreateFolder} disabled={busy || !newFolderName.trim()}>Add</button>
          </div>
          {activeFolderId !== 'root' && <button type="button" className="storage-ws__danger-link" onClick={() => deleteFolder(activeFolderId)}>Delete folder</button>}
        </aside>

        <main className="storage-ws__content">
          <div className="storage-ws__toolbar">
            <div className="storage-ws__folder-heading">
              <strong>{activeFolderName}</strong>
              {activeFolderId !== 'root' && <span>{folderPath(folders, activeFolderId)}</span>}
            </div>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search files, notes, type" />
            <button type="button" onClick={() => fileInputRef.current?.click()} disabled={busy}>Upload</button>
            <input ref={fileInputRef} className="storage-ws__file-input" title="Upload files" type="file" multiple onChange={(event) => handleUpload(event.currentTarget.files)} />
          </div>

          {folderChildren.length > 0 && (
            <div className="storage-ws__folders-row">
              {folderChildren.map((folder) => (
                <button key={folder.id} type="button" onClick={() => setActiveFolderId(folder.id)}>
                  <span>Folder</span>
                  <strong>{folder.name}</strong>
                </button>
              ))}
            </div>
          )}

          <div className="storage-ws__grid">
            {visibleFiles.map((file) => (
              <article className="storage-ws__file" key={file.id}>
                <div className="storage-ws__thumb">
                  {file.thumbnailDataUrl ? <img src={file.thumbnailDataUrl} alt="" /> : <span>{fileGlyph(file)}</span>}
                </div>
                <div className="storage-ws__file-body">
                  <strong title={file.name}>{file.name}</strong>
                  <span>{categoryLookup.get(file.categoryId)?.name || file.categoryId} · {formatBytes(file.sizeBytes)}</span>
                  <select title="File category" value={file.categoryId} onChange={(event) => updateFile(file.id, { categoryId: event.target.value })} disabled={busy}>
                    {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
                  </select>
                  <select title="File folder" value={file.folderId} onChange={(event) => updateFile(file.id, { folderId: event.target.value })} disabled={busy}>
                    {folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
                  </select>
                </div>
                <div className="storage-ws__file-actions">
                  <button type="button" onClick={() => downloadFile(file.id)} disabled={busy}>Download</button>
                  <button type="button" onClick={() => deleteFile(file.id)} disabled={busy}>Delete</button>
                </div>
              </article>
            ))}
            {!visibleFiles.length && (
              <div className="storage-ws__empty">
                <strong>No files in this view</strong>
                <span>Upload images, videos, PDFs, documents, spreadsheets, and any other files into the selected folder.</span>
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}