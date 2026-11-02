import { create } from 'zustand';
import { webRequest } from '../services/webClient';
import { mirrorFeatureState } from '../services/piMirror';

const DEFAULT_DOMAIN = (import.meta.env.VITE_JITSI_DEFAULT_DOMAIN || 'meet.jit.si').trim();
const DEFAULT_ROOM_PREFIX = (import.meta.env.VITE_JITSI_ROOM_PREFIX || 'meeting').trim();
const LOCAL_STORAGE_KEY = 'exclaw_video_meeting_settings';
const USER_SETTINGS_KEY = 'videoMeeting';

interface StoredAuthUser {
  id: string;
  email: string;
  displayName?: string;
}

export interface VideoMeetingSettings {
  domain: string;
  roomName: string;
  displayName: string;
  email: string;
  startWithAudioMuted: boolean;
  startWithVideoMuted: boolean;
}

export interface VideoMeetingSnapshot {
  settings: VideoMeetingSettings;
  activeMeeting: VideoMeetingSettings | null;
  inviteUrl: string;
  status: 'idle' | 'ready' | 'live';
  updatedAt: string;
}

interface SettingsResponse {
  settings?: Record<string, unknown>;
}

interface VideoMeetingState extends VideoMeetingSnapshot {
  isLoaded: boolean;
  isLoading: boolean;
  isSaving: boolean;
  error: string | null;
  loadSettings: () => Promise<void>;
  updateSettings: <Key extends keyof VideoMeetingSettings>(key: Key, value: VideoMeetingSettings[Key]) => void;
  normalizeDraft: () => void;
  createRoom: () => void;
  startMeeting: () => Promise<void>;
  closeMeeting: () => void;
  clearError: () => void;
}

function readStoredAuthUser(): StoredAuthUser | null {
  try {
    const raw = window.localStorage.getItem('exclaw_auth_session');
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { user?: Partial<StoredAuthUser> };
    if (!parsed.user?.id || !parsed.user.email) return null;
    return {
      id: parsed.user.id,
      email: parsed.user.email,
      displayName: parsed.user.displayName,
    };
  } catch {
    return null;
  }
}

function localStorageKey(user: StoredAuthUser | null) {
  return user?.id ? `${LOCAL_STORAGE_KEY}_${user.id}` : LOCAL_STORAGE_KEY;
}

export function generateVideoMeetingRoomName() {
  const randomValue = window.crypto?.getRandomValues
    ? Array.from(window.crypto.getRandomValues(new Uint32Array(2)))
        .map((value) => value.toString(36))
        .join('')
    : Math.random().toString(36).slice(2, 12);

  return `${DEFAULT_ROOM_PREFIX}-${randomValue.slice(0, 12)}`;
}

export function normalizeVideoMeetingDomain(value: string) {
  return value
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .replace(/:+$/, '')
    .toLowerCase() || DEFAULT_DOMAIN;
}

export function normalizeVideoMeetingRoomName(value: string) {
  const roomName = value
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 96);

  return roomName || generateVideoMeetingRoomName();
}

export function buildVideoMeetingUrl(settings: VideoMeetingSettings) {
  return `https://${normalizeVideoMeetingDomain(settings.domain)}/${encodeURIComponent(normalizeVideoMeetingRoomName(settings.roomName))}`;
}

function defaultSettings(user: StoredAuthUser | null): VideoMeetingSettings {
  return {
    domain: DEFAULT_DOMAIN,
    roomName: generateVideoMeetingRoomName(),
    displayName: user?.displayName?.trim() || user?.email || 'Guest',
    email: user?.email || '',
    startWithAudioMuted: true,
    startWithVideoMuted: true,
  };
}

function normalizeSettings(value: unknown, user: StoredAuthUser | null): VideoMeetingSettings {
  const defaults = defaultSettings(user);
  if (!value || typeof value !== 'object') return defaults;
  const raw = value as Partial<VideoMeetingSettings>;

  return {
    domain: raw.domain ? normalizeVideoMeetingDomain(raw.domain) : defaults.domain,
    roomName: raw.roomName ? normalizeVideoMeetingRoomName(raw.roomName) : defaults.roomName,
    displayName: raw.displayName?.trim() || defaults.displayName,
    email: raw.email?.trim() || defaults.email,
    startWithAudioMuted: raw.startWithAudioMuted ?? defaults.startWithAudioMuted,
    startWithVideoMuted: raw.startWithVideoMuted ?? defaults.startWithVideoMuted,
  };
}

function readLocalSettings(user: StoredAuthUser | null): VideoMeetingSettings {
  try {
    const raw = window.localStorage.getItem(localStorageKey(user));
    if (!raw) return defaultSettings(user);
    return normalizeSettings(JSON.parse(raw), user);
  } catch {
    return defaultSettings(user);
  }
}

function saveLocalSettings(user: StoredAuthUser | null, settings: VideoMeetingSettings) {
  try {
    window.localStorage.setItem(localStorageKey(user), JSON.stringify(settings));
  } catch {
    // Best-effort browser cache only; backend settings remain the durable source.
  }
}

function snapshot(settings: VideoMeetingSettings, activeMeeting: VideoMeetingSettings | null): VideoMeetingSnapshot {
  const currentMeeting = activeMeeting ?? settings;
  return {
    settings,
    activeMeeting,
    inviteUrl: buildVideoMeetingUrl(currentMeeting),
    status: activeMeeting ? 'live' : 'ready',
    updatedAt: new Date().toISOString(),
  };
}

function mirrorSnapshot(value: VideoMeetingSnapshot) {
  mirrorFeatureState('video_meeting', value);
  return value;
}

async function loadServerSettings(user: StoredAuthUser | null): Promise<VideoMeetingSettings | null> {
  const response = await webRequest<SettingsResponse>('user.settings.get');
  const value = response.settings?.[USER_SETTINGS_KEY];
  return value ? normalizeSettings(value, user) : null;
}

async function saveServerSettings(settings: VideoMeetingSettings) {
  await webRequest<SettingsResponse>('user.settings.set', {
    settings: { [USER_SETTINGS_KEY]: settings },
  });
}

export const useVideoMeetingStore = create<VideoMeetingState>((set, get) => {
  const user = readStoredAuthUser();
  const initialSettings = readLocalSettings(user);
  const initialSnapshot = mirrorSnapshot(snapshot(initialSettings, null));

  return {
    ...initialSnapshot,
    isLoaded: false,
    isLoading: false,
    isSaving: false,
    error: null,

    loadSettings: async () => {
      if (get().isLoading) return;
      set({ isLoading: true, error: null });
      try {
        const nextSettings = (await loadServerSettings(user)) ?? readLocalSettings(user);
        saveLocalSettings(user, nextSettings);
        const nextSnapshot = mirrorSnapshot(snapshot(nextSettings, get().activeMeeting));
        set({ ...nextSnapshot, isLoaded: true });
      } catch (error) {
        const fallback = readLocalSettings(user);
        const nextSnapshot = mirrorSnapshot(snapshot(fallback, get().activeMeeting));
        set({
          ...nextSnapshot,
          isLoaded: true,
          error: error instanceof Error ? error.message : 'Failed to load meeting settings',
        });
      } finally {
        set({ isLoading: false });
      }
    },

    updateSettings: (key, value) => {
      const nextSettings = { ...get().settings, [key]: value };
      const nextSnapshot = mirrorSnapshot(snapshot(nextSettings, get().activeMeeting));
      set(nextSnapshot);
    },

    normalizeDraft: () => {
      const nextSettings = normalizeSettings(get().settings, user);
      const nextSnapshot = mirrorSnapshot(snapshot(nextSettings, get().activeMeeting));
      set(nextSnapshot);
    },

    createRoom: () => {
      const nextSettings = { ...get().settings, roomName: generateVideoMeetingRoomName() };
      const nextSnapshot = mirrorSnapshot(snapshot(nextSettings, get().activeMeeting));
      set(nextSnapshot);
    },

    startMeeting: async () => {
      const nextSettings = normalizeSettings(get().settings, user);
      const nextSnapshot = mirrorSnapshot(snapshot(nextSettings, nextSettings));
      set({ ...nextSnapshot, isSaving: true, error: null });
      saveLocalSettings(user, nextSettings);
      try {
        await saveServerSettings(nextSettings);
      } catch (error) {
        set({ error: error instanceof Error ? error.message : 'Meeting settings saved locally only' });
      } finally {
        set({ isSaving: false });
      }
    },

    closeMeeting: () => {
      const nextSnapshot = mirrorSnapshot(snapshot(get().settings, null));
      set(nextSnapshot);
    },

    clearError: () => set({ error: null }),
  };
});