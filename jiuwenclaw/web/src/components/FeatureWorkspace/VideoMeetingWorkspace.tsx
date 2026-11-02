import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { JitsiMeeting } from '@jitsi/react-sdk';
import {
  buildVideoMeetingUrl,
  normalizeVideoMeetingDomain,
  normalizeVideoMeetingRoomName,
  useVideoMeetingStore,
} from '../../stores/videoMeetingStore';
import './VideoMeetingWorkspace.css';

const COPY_RESET_MS = 1800;
const MEETING_BRAND = 'Deep Canvas Live';
const MEETING_NETWORK = 'Deep Canvas Network';

interface VideoMeetingWorkspaceProps {
  onExit: () => void;
  embedded?: boolean;
}

type JitsiApi = {
  executeCommand: (command: string, ...args: unknown[]) => void;
  addListener: (event: string, listener: (payload?: Record<string, unknown>) => void) => void;
  isVideoMuted?: () => Promise<boolean>;
};

function MeetingSpinner() {
  return (
    <div className="video-meeting__spinner" role="status">
      <span className="video-meeting__spinner-mark" aria-hidden="true" />
      <span>Connecting to Deep Canvas Live</span>
    </div>
  );
}

export function VideoMeetingWorkspace({ onExit, embedded = false }: VideoMeetingWorkspaceProps) {
  const settings = useVideoMeetingStore((state) => state.settings);
  const activeMeeting = useVideoMeetingStore((state) => state.activeMeeting);
  const isLoaded = useVideoMeetingStore((state) => state.isLoaded);
  const isLoading = useVideoMeetingStore((state) => state.isLoading);
  const isSaving = useVideoMeetingStore((state) => state.isSaving);
  const error = useVideoMeetingStore((state) => state.error);
  const loadSettings = useVideoMeetingStore((state) => state.loadSettings);
  const updateSettings = useVideoMeetingStore((state) => state.updateSettings);
  const normalizeDraft = useVideoMeetingStore((state) => state.normalizeDraft);
  const createRoom = useVideoMeetingStore((state) => state.createRoom);
  const startMeeting = useVideoMeetingStore((state) => state.startMeeting);
  const closeMeeting = useVideoMeetingStore((state) => state.closeMeeting);
  const clearError = useVideoMeetingStore((state) => state.clearError);
  const [copied, setCopied] = useState(false);
  const [roomTouched, setRoomTouched] = useState(false);
  const [mediaStatus, setMediaStatus] = useState('Camera and microphone will be checked when the room starts.');
  const [cameraIssue, setCameraIssue] = useState('');
  const meetingApiRef = useRef<JitsiApi | null>(null);

  useEffect(() => {
    if (!isLoaded && !isLoading) void loadSettings();
  }, [isLoaded, isLoading, loadSettings]);

  const previewSettings = useMemo(() => ({
    ...settings,
    domain: normalizeVideoMeetingDomain(settings.domain),
    roomName: normalizeVideoMeetingRoomName(settings.roomName),
    displayName: settings.displayName.trim() || 'Guest',
    email: settings.email.trim(),
  }), [settings]);

  const inviteUrl = useMemo(
    () => buildVideoMeetingUrl(activeMeeting ?? previewSettings),
    [activeMeeting, previewSettings]
  );
  const roomLabel = useMemo(
    () => normalizeVideoMeetingRoomName((activeMeeting ?? previewSettings).roomName),
    [activeMeeting, previewSettings]
  );

  useEffect(() => {
    if (!copied) return undefined;
    const timerId = window.setTimeout(() => setCopied(false), COPY_RESET_MS);
    return () => window.clearTimeout(timerId);
  }, [copied]);

  const handleCreateRoom = () => {
    setRoomTouched(false);
    createRoom();
  };

  const handleStartMeeting = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await startMeeting();
    setCopied(false);
  };

  const handleCopyInvite = async () => {
    try {
      await window.navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const handleApiReady = (api: JitsiApi) => {
    if (!activeMeeting) return;
    meetingApiRef.current = api;
    api.executeCommand('subject', `${MEETING_BRAND} Room`);
    api.executeCommand('displayName', activeMeeting.displayName);
    api.executeCommand('setVideoQuality', 720);
    api.addListener('videoConferenceJoined', () => {
      setMediaStatus(activeMeeting.startWithVideoMuted ? 'Meeting connected · camera is currently off' : 'Meeting connected · camera is active');
      setCameraIssue('');
    });
    api.addListener('cameraError', (payload) => {
      const detail = String(payload?.message || payload?.type || 'The browser could not start the selected camera.');
      setCameraIssue(detail);
      setMediaStatus('Camera needs attention');
    });
    api.addListener('videoMuteStatusChanged', (payload) => {
      setMediaStatus(payload?.muted === true ? 'Meeting connected · camera is off' : 'Meeting connected · camera is active');
      if (payload?.muted !== true) setCameraIssue('');
    });
  };

  const restartLocalCamera = async () => {
    const api = meetingApiRef.current;
    if (!api) return;
    setMediaStatus('Restarting local camera…');
    try {
      const muted = api.isVideoMuted ? await api.isVideoMuted() : false;
      if (!muted) {
        api.executeCommand('toggleVideo');
        await new Promise((resolve) => window.setTimeout(resolve, 500));
      }
      api.executeCommand('toggleVideo');
      setCameraIssue('');
      setMediaStatus('Camera restarted · waiting for video');
    } catch {
      setCameraIssue('Camera restart failed. Choose a different camera from the meeting device menu.');
    }
  };

  return (
    <section className="video-meeting">
      {!embedded ? <header className="video-meeting__topbar">
        <div>
          <div className="feature-workspace__eyebrow">Live Collaboration</div>
          <h2 className="feature-workspace__title">Video Meeting</h2>
        </div>
        <button type="button" className="feature-workspace__back feature-workspace__back--inline" onClick={onExit}>
          Back
        </button>
      </header> : null}

      <div className="video-meeting__layout">
        <aside className="video-meeting__panel">
          {error && (
            <div className="video-meeting__error">
              <span>{error}</span>
              <button type="button" onClick={clearError}>Dismiss</button>
            </div>
          )}
          <form className="video-meeting__form" onSubmit={handleStartMeeting}>
            <label className="video-meeting__field">
              <span>Room</span>
              <div className="video-meeting__inline-control">
                <input
                  value={settings.roomName}
                  onChange={(event) => {
                    setRoomTouched(true);
                    updateSettings('roomName', event.target.value);
                  }}
                  onBlur={normalizeDraft}
                  placeholder="meeting"
                />
                <button type="button" onClick={handleCreateRoom}>New</button>
              </div>
            </label>

            <div className="video-meeting__brand-card">
              <span>Meeting network</span>
              <strong>{MEETING_NETWORK}</strong>
              <p>Every room launches inside the Deep Canvas meeting experience.</p>
            </div>

            <label className="video-meeting__field">
              <span>Display name</span>
              <input
                value={settings.displayName}
                onChange={(event) => updateSettings('displayName', event.target.value)}
                placeholder="Your name"
              />
            </label>

            <div className="video-meeting__toggle-row">
              <label className="video-meeting__toggle">
                <input
                  type="checkbox"
                  checked={settings.startWithAudioMuted}
                  onChange={(event) => updateSettings('startWithAudioMuted', event.target.checked)}
                />
                <span>Start muted</span>
              </label>
              <label className="video-meeting__toggle">
                <input
                  type="checkbox"
                  checked={settings.startWithVideoMuted}
                  onChange={(event) => updateSettings('startWithVideoMuted', event.target.checked)}
                />
                <span>Camera off</span>
              </label>
            </div>

            <div className="video-meeting__actions">
              <button type="submit" className="video-meeting__primary" disabled={isSaving}>
                {isSaving ? 'Starting...' : activeMeeting ? 'Restart meeting' : 'Start meeting'}
              </button>
              {activeMeeting && (
                <button type="button" className="video-meeting__secondary" onClick={closeMeeting}>
                  Close room
                </button>
              )}
            </div>
          </form>

          <div className="video-meeting__invite">
            <span>Deep Canvas invite</span>
            <strong>{roomLabel}</strong>
            <p>Copy the room link or open the live room in a separate tab.</p>
            <div className="video-meeting__invite-actions">
              <button type="button" onClick={handleCopyInvite}>{copied ? 'Copied' : 'Copy invite link'}</button>
              <a href={inviteUrl} target="_blank" rel="noreferrer">Open room</a>
            </div>
          </div>

          <div className="video-meeting__notes">
            <div>
              <strong>Workspace</strong>
              <span>{MEETING_BRAND}</span>
            </div>
            <div>
              <strong>Network</strong>
              <span>{MEETING_NETWORK}</span>
            </div>
            <div>
              <strong>Room status</strong>
              <span>{activeMeeting ? 'Live' : roomTouched ? 'Ready to start' : 'Private room generated'}</span>
            </div>
          </div>
          {activeMeeting ? (
            <div className={`video-meeting__media-health ${cameraIssue ? 'is-error' : ''}`} role="status">
              <div><strong>Local media</strong><span>{cameraIssue || mediaStatus}</span></div>
              <button type="button" onClick={() => void restartLocalCamera()}>Restart camera</button>
            </div>
          ) : null}
        </aside>

        <main className={`video-meeting__stage ${activeMeeting ? 'is-live' : ''}`}>
          {activeMeeting ? (
            <JitsiMeeting
              key={`${activeMeeting.domain}/${activeMeeting.roomName}`}
              domain={activeMeeting.domain}
              roomName={activeMeeting.roomName}
              userInfo={{ displayName: activeMeeting.displayName, email: activeMeeting.email }}
              configOverwrite={{
                disableDeepLinking: true,
                enableWelcomePage: false,
                prejoinConfig: { enabled: false },
                startWithAudioMuted: activeMeeting.startWithAudioMuted,
                startWithVideoMuted: activeMeeting.startWithVideoMuted,
                enableNoisyMicDetection: true,
                resolution: 720,
                constraints: {
                  video: { height: { ideal: 720, max: 1080 }, width: { ideal: 1280, max: 1920 } },
                },
              }}
              interfaceConfigOverwrite={{
                DEFAULT_REMOTE_DISPLAY_NAME: 'Guest',
                APP_NAME: MEETING_BRAND,
                NATIVE_APP_NAME: MEETING_BRAND,
                PROVIDER_NAME: MEETING_NETWORK,
                SHOW_BRAND_WATERMARK: false,
                SHOW_JITSI_WATERMARK: false,
                SHOW_POWERED_BY: false,
                SHOW_WATERMARK_FOR_GUESTS: false,
                DISPLAY_WELCOME_PAGE_CONTENT: false,
                DISPLAY_WELCOME_PAGE_TOOLBAR_ADDITIONAL_CONTENT: false,
                JITSI_WATERMARK_LINK: '',
              }}
              spinner={MeetingSpinner}
              onApiReady={handleApiReady}
              onReadyToClose={closeMeeting}
              getIFrameRef={(parentNode) => {
                parentNode.style.height = '100%';
                parentNode.style.width = '100%';
                const iframe = parentNode.tagName === 'IFRAME'
                  ? parentNode as unknown as HTMLIFrameElement
                  : parentNode.querySelector('iframe');
                if (iframe) {
                  iframe.style.height = '100%';
                  iframe.style.width = '100%';
                  iframe.style.border = '0';
                  iframe.title = `${MEETING_BRAND} room`;
                  iframe.setAttribute('allow', 'camera; microphone; display-capture; autoplay; fullscreen; clipboard-write');
                }
              }}
            />
          ) : (
            <div className="video-meeting__empty">
              <div className="video-meeting__empty-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path d="M4.5 8.25A2.25 2.25 0 0 1 6.75 6h7.5a2.25 2.25 0 0 1 2.25 2.25v7.5A2.25 2.25 0 0 1 14.25 18h-7.5a2.25 2.25 0 0 1-2.25-2.25v-7.5Z" />
                  <path d="m16.5 10.5 3-2.25v7.5l-3-2.25" />
                </svg>
              </div>
              <h3>Ready for a live room</h3>
              <p>Launch a Deep Canvas room here or open the invite link in a separate tab.</p>
            </div>
          )}
        </main>
      </div>
    </section>
  );
}

