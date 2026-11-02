import { useState } from 'react';
import { RemoteSupportWorkspace } from './RemoteSupportWorkspace';
import { VideoMeetingWorkspace } from './VideoMeetingWorkspace';
import './MeetingSupportWorkspace.css';

interface MeetingSupportWorkspaceProps {
  onExit: () => void;
}

export function MeetingSupportWorkspace({ onExit }: MeetingSupportWorkspaceProps) {
  const [tab, setTab] = useState<'meeting' | 'support'>('meeting');

  return (
    <section className="meeting-support">
      <header className="meeting-support__header">
        <div>
          <div className="feature-workspace__eyebrow">Live Collaboration</div>
          <h2 className="feature-workspace__title">Video Meeting</h2>
        </div>
        <nav className="meeting-support__tabs" aria-label="Meeting tools">
          <button type="button" className={tab === 'meeting' ? 'is-active' : ''} onClick={() => setTab('meeting')}>Video Meeting</button>
          <button type="button" className={tab === 'support' ? 'is-active' : ''} onClick={() => setTab('support')}>Remote Support</button>
        </nav>
        <button type="button" className="feature-workspace__back feature-workspace__back--inline" onClick={onExit}>Back</button>
      </header>
      <div className="meeting-support__body">
        {tab === 'meeting'
          ? <VideoMeetingWorkspace onExit={onExit} embedded />
          : <RemoteSupportWorkspace onExit={onExit} embedded />}
      </div>
    </section>
  );
}

