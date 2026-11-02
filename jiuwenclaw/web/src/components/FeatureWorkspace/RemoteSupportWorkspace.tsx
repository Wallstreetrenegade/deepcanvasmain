import { useMemo, useState } from 'react';
import { JitsiMeeting } from '@jitsi/react-sdk';
import './VideoMeetingWorkspace.css';
import './RemoteSupportWorkspace.css';

const SUPPORT_DOMAIN = (import.meta.env.VITE_JITSI_DEFAULT_DOMAIN || 'meet.jit.si').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');

interface RemoteSupportWorkspaceProps {
  onExit: () => void;
  embedded?: boolean;
}

type JitsiApi = {
  executeCommand: (command: string, ...args: unknown[]) => void;
};

function randomSupportRoom(): string {
  const values = window.crypto?.getRandomValues
    ? Array.from(window.crypto.getRandomValues(new Uint32Array(4)))
    : [Date.now(), Math.random() * 0xffffffff, Math.random() * 0xffffffff, Math.random() * 0xffffffff];
  return `deep-canvas-support-${values.map((value) => Math.floor(value).toString(36)).join('')}`;
}

function operatorName(): string {
  try {
    const session = JSON.parse(window.localStorage.getItem('exclaw_auth_session') || '{}') as {
      user?: { displayName?: string; email?: string };
    };
    return session.user?.displayName?.trim() || session.user?.email?.trim() || 'Deep Canvas Support';
  } catch {
    return 'Deep Canvas Support';
  }
}

export function RemoteSupportWorkspace({ onExit, embedded = false }: RemoteSupportWorkspaceProps) {
  const [roomName, setRoomName] = useState(randomSupportRoom);
  const [activeRoom, setActiveRoom] = useState('');
  const [clientName, setClientName] = useState('Client');
  const [copied, setCopied] = useState<'link' | 'instructions' | null>(null);
  const [connectionStatus, setConnectionStatus] = useState('Waiting to start a private viewing room');
  const inviteUrl = useMemo(() => `https://${SUPPORT_DOMAIN}/${encodeURIComponent(roomName)}`, [roomName]);
  const instructions = useMemo(() => [
    'Deep Canvas Remote Support',
    `Open this private support link: ${inviteUrl}`,
    'Join in your browser, then click Share Screen and choose the screen, window, or tab you want help with.',
    'You can stop sharing at any time. Deep Canvas cannot control your mouse or keyboard.',
  ].join('\n\n'), [inviteUrl]);

  const copyText = async (kind: 'link' | 'instructions') => {
    try {
      await window.navigator.clipboard.writeText(kind === 'link' ? inviteUrl : instructions);
      setCopied(kind);
      window.setTimeout(() => setCopied((current) => current === kind ? null : current), 1800);
    } catch {
      setCopied(null);
    }
  };

  const replaceSession = () => {
    setActiveRoom('');
    setRoomName(randomSupportRoom());
    setCopied(null);
  };

  const handleApiReady = (api: JitsiApi) => {
    api.executeCommand('subject', `Remote support for ${clientName.trim() || 'Client'}`);
    api.executeCommand('displayName', operatorName());
    setConnectionStatus('Viewing room connected · waiting for the client');
    if ('addListener' in api && typeof (api as JitsiApi & { addListener?: unknown }).addListener === 'function') {
      const eventApi = api as JitsiApi & { addListener: (event: string, listener: (payload?: Record<string, unknown>) => void) => void };
      eventApi.addListener('participantJoined', () => setConnectionStatus('Client connected · waiting for screen sharing'));
      eventApi.addListener('screenSharingStatusChanged', (payload) => {
        setConnectionStatus(payload?.on === true ? 'Screen sharing is active' : 'Client connected · screen sharing is stopped');
      });
    }
  };

  return (
    <section className="video-meeting remote-support">
      {!embedded ? <header className="video-meeting__topbar">
        <div>
          <div className="feature-workspace__eyebrow">Consent-based screen viewing</div>
          <h2 className="feature-workspace__title">Remote Support</h2>
        </div>
        <button type="button" className="feature-workspace__back feature-workspace__back--inline" onClick={onExit}>Back</button>
      </header> : null}

      <div className="video-meeting__layout">
        <aside className="video-meeting__panel">
          <div className="remote-support__privacy">
            <strong>View-only support</strong>
            <p>The client must explicitly choose what to share. You cannot control their mouse or keyboard, and recording is not enabled by Deep Canvas.</p>
          </div>

          <label className="video-meeting__field">
            <span>Client name</span>
            <input value={clientName} onChange={(event) => setClientName(event.target.value)} placeholder="Client name" />
          </label>

          <div className="video-meeting__invite remote-support__invite">
            <span>Private support link</span>
            <strong>{roomName}</strong>
            <p>Send this link only to the client you are assisting. Generate a new link for every support session.</p>
            <div className="remote-support__link">{inviteUrl}</div>
            <div className="remote-support__actions">
              <button type="button" onClick={() => void copyText('link')}>{copied === 'link' ? 'Copied' : 'Copy link'}</button>
              <button type="button" onClick={() => void copyText('instructions')}>{copied === 'instructions' ? 'Copied' : 'Copy instructions'}</button>
            </div>
          </div>

          <ol className="remote-support__steps">
            <li>Send the private link to your client.</li>
            <li>Start the viewing room below.</li>
            <li>The client joins and clicks <strong>Share Screen</strong>.</li>
            <li>They select a screen, window, or browser tab and can stop anytime.</li>
          </ol>

          <div className="video-meeting__actions">
            {!activeRoom ? (
              <button type="button" className="video-meeting__primary" onClick={() => setActiveRoom(roomName)}>Start viewing room</button>
            ) : (
              <button type="button" className="video-meeting__secondary" onClick={() => setActiveRoom('')}>Leave viewing room</button>
            )}
            <button type="button" className="video-meeting__secondary" onClick={replaceSession}>End session and create new link</button>
          </div>
          <div className={`remote-support__status ${connectionStatus.includes('active') ? 'is-active' : ''}`} role="status">
            <span aria-hidden="true" />
            <strong>{connectionStatus}</strong>
          </div>
        </aside>

        <main className={`video-meeting__stage ${activeRoom ? 'is-live' : ''}`}>
          {activeRoom ? (
            <JitsiMeeting
              key={activeRoom}
              domain={SUPPORT_DOMAIN}
              roomName={activeRoom}
              userInfo={{ displayName: operatorName(), email: '' }}
              configOverwrite={{
                disableDeepLinking: true,
                enableWelcomePage: false,
                prejoinConfig: { enabled: false },
                startWithAudioMuted: true,
                startWithVideoMuted: true,
                disableThirdPartyRequests: true,
              }}
              interfaceConfigOverwrite={{
                APP_NAME: 'Deep Canvas Remote Support',
                NATIVE_APP_NAME: 'Deep Canvas Remote Support',
                PROVIDER_NAME: 'Deep Canvas',
                SHOW_BRAND_WATERMARK: false,
                SHOW_JITSI_WATERMARK: false,
                SHOW_POWERED_BY: false,
                SHOW_WATERMARK_FOR_GUESTS: false,
                DEFAULT_REMOTE_DISPLAY_NAME: 'Client',
              }}
              onApiReady={handleApiReady}
              onReadyToClose={() => setActiveRoom('')}
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
                  iframe.title = 'Deep Canvas remote support viewing room';
                  iframe.setAttribute('allow', 'camera; microphone; display-capture; autoplay; fullscreen; clipboard-write');
                }
              }}
            />
          ) : (
            <div className="video-meeting__empty remote-support__empty">
              <div className="remote-support__screen-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24"><path d="M3.75 5.25h16.5v11.25H3.75V5.25Z" /><path d="M8.25 20.25h7.5M12 16.5v3.75" /></svg>
              </div>
              <h3>Ready to help</h3>
              <p>Start the viewing room, then wait for the client to join and explicitly share their screen.</p>
              <div className="remote-support__consent-badge">Client consent required</div>
            </div>
          )}
        </main>
      </div>
    </section>
  );
}

