import { create } from 'zustand';
import { webRequest } from '../services/webClient';
import { mirrorFeatureState } from '../services/piMirror';
import type { WebRequestOptions } from '../types/websocket';

export type StorageKind = 'image' | 'video' | 'audio' | 'document' | 'other';
export type StorageProviderKey = 'googleDrive' | 'oneDrive';
export type StorageProviderStatus = 'not_configured' | 'ready_to_connect' | 'pending' | 'connected' | 'error';

export interface StorageFileItem {
  id: string;
  name: string;
  mimeType: string;
  kind: StorageKind;
  sizeBytes: number;
  extension: string;
  folderId: string;
  categoryId: string;
  thumbnailDataUrl?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface StorageFolder {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StorageCategory {
  id: string;
  name: string;
  kind: 'system' | 'custom';
  createdAt: string;
  updatedAt: string;
}

export interface StorageProvider {
  status: StorageProviderStatus;
  clientId: string;
  lastError?: string | null;
  userCode?: string;
  verificationUri?: string;
  verificationUriComplete?: string;
  expiresAt?: string;
  connectedAt?: string | null;
  updatedAt?: string;
}

export interface StorageSnapshot {
  files: StorageFileItem[];
  folders: StorageFolder[];
  categories: StorageCategory[];
  providers: Record<StorageProviderKey, StorageProvider>;
  updatedAt: string;
}

interface RpcResponse {
  state: StorageSnapshot;
  file?: { id: string; name: string; mimeType: string; dataUrl: string };
  pending?: boolean;
  connected?: boolean;
}

interface UploadOptions {
  folderId: string;
  categoryId?: string;
}

interface StorageState extends StorageSnapshot {
  isLoaded: boolean;
  isLoading: boolean;
  busy: boolean;
  error: string | null;

  loadState: () => Promise<void>;
  refreshState: () => Promise<void>;
  clearError: () => void;
  createFolder: (name: string, parentId?: string) => Promise<void>;
  deleteFolder: (folderId: string) => Promise<void>;
  createCategory: (name: string) => Promise<void>;
  deleteCategory: (categoryId: string) => Promise<void>;
  uploadFiles: (files: FileList | File[], options: UploadOptions) => Promise<void>;
  updateFile: (fileId: string, patch: Partial<Pick<StorageFileItem, 'name' | 'folderId' | 'categoryId' | 'notes'>>) => Promise<void>;
  deleteFile: (fileId: string) => Promise<void>;
  downloadFile: (fileId: string) => Promise<void>;
  saveProviderSettings: (provider: StorageProviderKey, clientId: string) => Promise<void>;
  startDriveConnect: (provider: StorageProviderKey) => Promise<void>;
  pollDriveConnect: (provider: StorageProviderKey) => Promise<void>;
  disconnectProvider: (provider: StorageProviderKey) => Promise<void>;
}

const EMPTY_SNAPSHOT: StorageSnapshot = {
  files: [],
  folders: [{ id: 'root', name: 'MAIN', parentId: null, createdAt: '', updatedAt: '' }],
  categories: [
    { id: 'images', name: 'Images', kind: 'system', createdAt: '', updatedAt: '' },
    { id: 'videos', name: 'Videos', kind: 'system', createdAt: '', updatedAt: '' },
    { id: 'documents', name: 'Documents', kind: 'system', createdAt: '', updatedAt: '' },
    { id: 'other', name: 'Other', kind: 'system', createdAt: '', updatedAt: '' },
  ],
  providers: {
    googleDrive: { status: 'not_configured', clientId: '', lastError: null },
    oneDrive: { status: 'not_configured', clientId: '', lastError: null },
  },
  updatedAt: '',
};

const LONG_REQUEST: WebRequestOptions = { timeoutMs: 120000 };

function applySnapshot(snapshot: StorageSnapshot): StorageSnapshot {
  mirrorFeatureState('storage', snapshot);
  return snapshot;
}

function normalizeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'Storage request failed';
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Failed to read file'));
    reader.readAsDataURL(file);
  });
}

function imageThumbnail(file: File): Promise<string> {
  return new Promise((resolve) => {
    const image = new Image();
    const url = URL.createObjectURL(file);
    image.onload = () => {
      const canvas = document.createElement('canvas');
      const max = 360;
      const ratio = Math.min(1, max / Math.max(image.width, image.height));
      canvas.width = Math.max(1, Math.round(image.width * ratio));
      canvas.height = Math.max(1, Math.round(image.height * ratio));
      const ctx = canvas.getContext('2d');
      ctx?.drawImage(image, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', 0.82));
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      resolve('');
    };
    image.src = url;
  });
}

function videoThumbnail(file: File): Promise<string> {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    const url = URL.createObjectURL(file);
    let done = false;
    const finish = (value: string) => {
      if (done) return;
      done = true;
      URL.revokeObjectURL(url);
      resolve(value);
    };
    video.muted = true;
    video.playsInline = true;
    video.preload = 'metadata';
    video.onloadedmetadata = () => {
      video.currentTime = Math.min(1, Number.isFinite(video.duration) ? Math.max(0, video.duration / 4) : 0);
    };
    video.onseeked = () => {
      const canvas = document.createElement('canvas');
      const max = 360;
      const width = video.videoWidth || 320;
      const height = video.videoHeight || 180;
      const ratio = Math.min(1, max / Math.max(width, height));
      canvas.width = Math.max(1, Math.round(width * ratio));
      canvas.height = Math.max(1, Math.round(height * ratio));
      const ctx = canvas.getContext('2d');
      ctx?.drawImage(video, 0, 0, canvas.width, canvas.height);
      finish(canvas.toDataURL('image/jpeg', 0.8));
    };
    video.onerror = () => finish('');
    window.setTimeout(() => finish(''), 6000);
    video.src = url;
  });
}

async function thumbnailFor(file: File): Promise<string> {
  if (file.type.startsWith('image/')) return imageThumbnail(file);
  if (file.type.startsWith('video/')) return videoThumbnail(file);
  return '';
}

function downloadDataUrl(file: { name: string; dataUrl: string }): void {
  const link = document.createElement('a');
  link.href = file.dataUrl;
  link.download = file.name || 'download';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

export const useStorageStore = create<StorageState>((set, get) => {
  async function callAndApply(method: string, params?: Record<string, unknown>, options?: WebRequestOptions): Promise<RpcResponse | null> {
    const resp = await webRequest<RpcResponse>(method, params ?? {}, options);
    if (resp?.state) {
      set({ ...applySnapshot(resp.state), isLoaded: true, error: null });
    }
    return resp ?? null;
  }

  async function run(fn: () => Promise<void>) {
    set({ busy: true, error: null });
    try {
      await fn();
    } catch (err) {
      set({ error: normalizeError(err) });
    } finally {
      set({ busy: false });
    }
  }

  return {
    ...EMPTY_SNAPSHOT,
    isLoaded: false,
    isLoading: false,
    busy: false,
    error: null,

    loadState: async () => {
      if (get().isLoading) return;
      set({ isLoading: true, error: null });
      try {
        await callAndApply('storage.get_state');
      } catch (err) {
        set({ error: normalizeError(err) });
      } finally {
        set({ isLoading: false });
      }
    },

    refreshState: async () => {
      await callAndApply('storage.get_state');
    },

    clearError: () => set({ error: null }),

    createFolder: async (name, parentId = 'root') => run(async () => {
      await callAndApply('storage.create_folder', { name, parentId });
    }),

    deleteFolder: async (folderId) => run(async () => {
      await callAndApply('storage.delete_folder', { folderId });
    }),

    createCategory: async (name) => run(async () => {
      await callAndApply('storage.create_category', { name });
    }),

    deleteCategory: async (categoryId) => run(async () => {
      await callAndApply('storage.delete_category', { categoryId });
    }),

    uploadFiles: async (files, options) => run(async () => {
      const uploadList = Array.from(files);
      for (const file of uploadList) {
        const [dataUrl, thumbnailDataUrl] = await Promise.all([fileToDataUrl(file), thumbnailFor(file)]);
        await callAndApply('storage.upload_file', {
          file: {
            name: file.name,
            mimeType: file.type || 'application/octet-stream',
            sizeBytes: file.size,
            dataUrl,
            thumbnailDataUrl,
            folderId: options.folderId,
            categoryId: options.categoryId,
          },
        }, LONG_REQUEST);
      }
    }),

    updateFile: async (fileId, patch) => run(async () => {
      await callAndApply('storage.update_file', { fileId, patch });
    }),

    deleteFile: async (fileId) => run(async () => {
      await callAndApply('storage.delete_file', { fileId });
    }),

    downloadFile: async (fileId) => run(async () => {
      const resp = await callAndApply('storage.get_file_blob', { fileId }, LONG_REQUEST);
      if (resp?.file) downloadDataUrl(resp.file);
    }),

    saveProviderSettings: async (provider, clientId) => run(async () => {
      await callAndApply('storage.save_provider_settings', { provider, clientId });
    }),

    startDriveConnect: async (provider) => run(async () => {
      await callAndApply('storage.start_drive_connect', { provider }, LONG_REQUEST);
    }),

    pollDriveConnect: async (provider) => run(async () => {
      await callAndApply('storage.poll_drive_connect', { provider }, LONG_REQUEST);
    }),

    disconnectProvider: async (provider) => run(async () => {
      await callAndApply('storage.disconnect_provider', { provider });
    }),
  };
});