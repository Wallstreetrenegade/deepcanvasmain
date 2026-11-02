import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { webRequest } from '../../services/webClient';
import './style.css';

const FEATURE_LABELS: Record<string, string> = {
  crm: 'CRM', kanban: 'Kanban', lead_gen: 'Lead Gen', project_flow: 'Project Flow',
  storage: 'Storage', video_meeting: 'Video Meeting',
};

interface TeamMember { id: string; email: string; displayName: string; role: string }
interface Team { id: string; name: string; features: string[]; members: TeamMember[]; isOwner: boolean }
interface Invite { id: string; teamId: string; teamName: string; inviterName: string; inviterEmail: string; features: string[] }
interface DirectContact { id: string; email: string; displayName: string }
interface TeamState { teams: Team[]; invites: Invite[]; shareableFeatures: string[]; directContacts: DirectContact[] }
interface TeamMessage { id: number; body: string; createdAt: number; senderUserId: string; senderName: string }

interface TeamUpProps { currentUserId: string; disabled?: boolean }

export function TeamUp({ currentUserId, disabled = false }: TeamUpProps) {
  const [panel, setPanel] = useState<'team' | 'chat' | null>(null);
  const [state, setState] = useState<TeamState>({ teams: [], invites: [], shareableFeatures: [], directContacts: [] });
  const [email, setEmail] = useState('');
  const [selectedFeatures, setSelectedFeatures] = useState<string[]>(['crm']);
  const [activeTeamId, setActiveTeamId] = useState('');
  const [chatMode, setChatMode] = useState<'team' | 'direct'>('team');
  const [activeDirectUserId, setActiveDirectUserId] = useState('');
  const [messages, setMessages] = useState<TeamMessage[]>([]);
  const [messageDraft, setMessageDraft] = useState('');
  const [messageMenuId, setMessageMenuId] = useState<number | null>(null);
  const [editingMessageId, setEditingMessageId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [unreadByTeam, setUnreadByTeam] = useState<Record<string, number>>({});
  const [messageAlert, setMessageAlert] = useState<TeamMessage | null>(null);
  const [chatPosition, setChatPosition] = useState<{ left: number; top: number } | null>(null);
  const [dragOffset, setDragOffset] = useState<{ x: number; y: number } | null>(null);
  const chatPopoverRef = useRef<HTMLElement | null>(null);
  const messagesScrollRef = useRef<HTMLDivElement | null>(null);
  const forceLatestMessageRef = useRef(false);
  const userScrolledUpRef = useRef(false);
  const lastReadRef = useRef<Record<string, number>>({});
  const lastPolledRef = useRef<Record<string, number>>({});
  const pollBusyRef = useRef(false);
  const readStorageKey = `dc-team-chat-read:${currentUserId}`;

  const persistReadState = (next: Record<string, number>) => {
    lastReadRef.current = next;
    localStorage.setItem(readStorageKey, JSON.stringify(next));
  };

  const markTeamRead = (teamId: string, messageId = 0) => {
    if (!teamId) return;
    const latest = Math.max(messageId, lastPolledRef.current[teamId] || 0);
    persistReadState({ ...lastReadRef.current, [teamId]: latest });
    setUnreadByTeam((current) => ({ ...current, [teamId]: 0 }));
  };

  const startChatDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest('button, input, select, textarea')) return;
    const rect = chatPopoverRef.current?.getBoundingClientRect();
    if (!rect) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setChatPosition({ left: rect.left, top: rect.top });
    setDragOffset({ x: event.clientX - rect.left, y: event.clientY - rect.top });
  };

  const moveChat = (event: ReactPointerEvent<HTMLElement>) => {
    if (!dragOffset || !chatPopoverRef.current) return;
    const rect = chatPopoverRef.current.getBoundingClientRect();
    const left = Math.min(Math.max(8, event.clientX - dragOffset.x), Math.max(8, window.innerWidth - rect.width - 8));
    const top = Math.min(Math.max(8, event.clientY - dragOffset.y), Math.max(8, window.innerHeight - 56));
    setChatPosition({ left, top });
  };

  const stopChatDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setDragOffset(null);
  };

  const refreshState = useCallback(async () => {
    try {
      const next = await webRequest<TeamState>('team_up.state', {}, { timeoutMs: 12000 });
      setState(next);
      setActiveTeamId((current) => current && next.teams.some((team) => team.id === current) ? current : next.teams[0]?.id || '');
      setActiveDirectUserId((current) => current && next.directContacts.some((contact) => contact.id === current) ? current : next.directContacts[0]?.id || '');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not load Team Up.');
    }
  }, []);

  const activeTeam = useMemo(() => state.teams.find((team) => team.id === activeTeamId) ?? null, [activeTeamId, state.teams]);
  const activeDirectContact = useMemo(() => state.directContacts.find((contact) => contact.id === activeDirectUserId) ?? null, [activeDirectUserId, state.directContacts]);

  const refreshMessages = useCallback(async () => {
    if (chatMode === 'team' ? !activeTeamId : !activeDirectUserId) return;
    try {
      const response = chatMode === 'team'
        ? await webRequest<{ messages: TeamMessage[] }>('team_up.messages', { teamId: activeTeamId }, { timeoutMs: 12000 })
        : await webRequest<{ messages: TeamMessage[] }>('team_up.direct_messages', { userId: activeDirectUserId }, { timeoutMs: 12000 });
      setMessages(response.messages);
      const latest = response.messages[response.messages.length - 1]?.id || 0;
      if (chatMode === 'team') {
        lastPolledRef.current[activeTeamId] = Math.max(lastPolledRef.current[activeTeamId] || 0, latest);
        if (panel === 'chat') markTeamRead(activeTeamId, latest);
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not load messages.');
    }
  }, [activeDirectUserId, activeTeamId, chatMode, panel]);

  useEffect(() => {
    try {
      const stored = JSON.parse(localStorage.getItem(readStorageKey) || '{}');
      if (stored && typeof stored === 'object') lastReadRef.current = stored;
    } catch { lastReadRef.current = {}; }
    lastPolledRef.current = { ...lastReadRef.current };
  }, [readStorageKey]);

  useEffect(() => {
    if (disabled) return;
    void refreshState();
    const timer = window.setInterval(() => void refreshState(), 15000);
    return () => window.clearInterval(timer);
  }, [disabled, refreshState]);

  useEffect(() => {
    if (panel !== 'chat' || (chatMode === 'team' ? !activeTeamId : !activeDirectUserId)) return;
    void refreshMessages();
    const timer = window.setInterval(() => void refreshMessages(), 4000);
    return () => window.clearInterval(timer);
  }, [activeDirectUserId, activeTeamId, chatMode, panel, refreshMessages]);

  useLayoutEffect(() => {
    if (panel !== 'chat' || messages.length === 0) return;
    if (!forceLatestMessageRef.current && userScrolledUpRef.current) return;

    const scrollToLatest = () => {
      const container = messagesScrollRef.current;
      if (!container) return;
      container.scrollTop = container.scrollHeight;
      userScrolledUpRef.current = false;
    };

    scrollToLatest();
    const frame = window.requestAnimationFrame(scrollToLatest);
    forceLatestMessageRef.current = false;
    return () => window.cancelAnimationFrame(frame);
  }, [activeDirectUserId, activeTeamId, messages, panel]);

  useEffect(() => {
    if (disabled || state.teams.length === 0) return;
    const poll = async () => {
      if (pollBusyRef.current) return;
      pollBusyRef.current = true;
      try {
        for (const team of state.teams) {
          const hasReadCursor = Object.prototype.hasOwnProperty.call(lastReadRef.current, team.id);
          const afterId = lastPolledRef.current[team.id] || 0;
          const response = await webRequest<{ messages: TeamMessage[] }>('team_up.messages', { teamId: team.id, afterId }, { timeoutMs: 12000 });
          const latest = response.messages[response.messages.length - 1]?.id || afterId;
          lastPolledRef.current[team.id] = latest;
          if (!hasReadCursor) {
            markTeamRead(team.id, latest);
            continue;
          }
          const incoming = response.messages.filter((message) => message.senderUserId !== currentUserId);
          if (panel === 'chat' && team.id === activeTeamId) {
            markTeamRead(team.id, latest);
            continue;
          }
          if (!incoming.length) continue;
          setUnreadByTeam((current) => ({ ...current, [team.id]: (current[team.id] || 0) + incoming.length }));
          const newest = incoming[incoming.length - 1];
          setMessageAlert(newest);
          window.setTimeout(() => setMessageAlert((current) => current?.id === newest.id ? null : current), 6000);
          if ('Notification' in window && Notification.permission === 'granted') {
            new Notification(`${newest.senderName} sent a message`, { body: newest.body, tag: `deepcanvas-team-${team.id}` });
          }
        }
      } finally { pollBusyRef.current = false; }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 5000);
    return () => window.clearInterval(timer);
  }, [activeTeamId, currentUserId, disabled, panel, state.teams]);

  const openChat = () => {
    const opening = panel !== 'chat';
    if (opening) {
      forceLatestMessageRef.current = true;
      userScrolledUpRef.current = false;
      setMessages([]);
    }
    setPanel(opening ? 'chat' : null);
    if (opening) {
      markTeamRead(activeTeamId);
      setMessageAlert(null);
      if ('Notification' in window && Notification.permission === 'default') void Notification.requestPermission();
    }
  };

  const toggleFeature = (feature: string) => {
    setSelectedFeatures((current) => current.includes(feature) ? current.filter((item) => item !== feature) : [...current, feature]);
  };

  const sendInvite = async () => {
    setBusy(true); setNotice('');
    try {
      await webRequest('team_up.invite', { email, features: selectedFeatures }, { timeoutMs: 15000 });
      setEmail('');
      setNotice('Invitation sent. Selected feature data is ready to share when they accept.');
      await refreshState();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not send invitation.');
    } finally { setBusy(false); }
  };

  const respond = async (inviteId: string, accept: boolean) => {
    setBusy(true); setNotice('');
    try {
      await webRequest('team_up.respond', { inviteId, accept }, { timeoutMs: 15000 });
      if (accept) {
        window.location.reload();
        return;
      }
      await refreshState();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not answer invitation.');
    } finally { setBusy(false); }
  };

  const sendMessage = async () => {
    const body = messageDraft.trim();
    if ((chatMode === 'team' ? !activeTeamId : !activeDirectUserId) || !body) return;
    setBusy(true);
    try {
      forceLatestMessageRef.current = true;
      if (chatMode === 'team') await webRequest('team_up.send', { teamId: activeTeamId, body }, { timeoutMs: 12000 });
      else await webRequest('team_up.direct_send', { userId: activeDirectUserId, body }, { timeoutMs: 12000 });
      setMessageDraft('');
      await refreshMessages();
      if (chatMode === 'team') markTeamRead(activeTeamId);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not send message.');
    } finally { setBusy(false); }
  };

  const beginEditMessage = (message: TeamMessage) => {
    setEditingMessageId(message.id);
    setEditDraft(message.body);
    setMessageMenuId(null);
  };

  const saveEditedMessage = async () => {
    const body = editDraft.trim();
    if (!editingMessageId || !body) return;
    setBusy(true); setNotice('');
    try {
      if (chatMode === 'team') await webRequest('team_up.message_update', { teamId: activeTeamId, messageId: editingMessageId, body }, { timeoutMs: 12000 });
      else await webRequest('team_up.direct_message_update', { userId: activeDirectUserId, messageId: editingMessageId, body }, { timeoutMs: 12000 });
      setEditingMessageId(null); setEditDraft('');
      await refreshMessages();
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Could not edit message.'); }
    finally { setBusy(false); }
  };

  const deleteChatMessage = async (messageId: number) => {
    if (!window.confirm('Delete this message?')) return;
    setBusy(true); setNotice(''); setMessageMenuId(null);
    try {
      if (chatMode === 'team') await webRequest('team_up.message_delete', { teamId: activeTeamId, messageId }, { timeoutMs: 12000 });
      else await webRequest('team_up.direct_message_delete', { userId: activeDirectUserId, messageId }, { timeoutMs: 12000 });
      if (editingMessageId === messageId) { setEditingMessageId(null); setEditDraft(''); }
      await refreshMessages();
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Could not delete message.'); }
    finally { setBusy(false); }
  };

  const clearChat = async () => {
    const label = chatMode === 'team' ? activeTeam?.name : activeDirectContact?.displayName;
    if (!label || !window.confirm(`Clear the entire conversation with ${label}? This removes it for everyone in this chat.`)) return;
    setBusy(true); setNotice(''); setMessageMenuId(null);
    try {
      if (chatMode === 'team') await webRequest('team_up.messages_clear', { teamId: activeTeamId }, { timeoutMs: 12000 });
      else await webRequest('team_up.direct_messages_clear', { userId: activeDirectUserId }, { timeoutMs: 12000 });
      setMessages([]); setEditingMessageId(null); setEditDraft(''); setNotice('Chat cleared.');
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Could not clear chat.'); }
    finally { setBusy(false); }
  };

  return (
    <div className="team-up">
      <button type="button" className={`team-up__header-button ${panel === 'team' ? 'is-active' : ''}`} disabled={disabled} onClick={() => setPanel(panel === 'team' ? null : 'team')}>
        Team Up {state.invites.length > 0 ? <span className="team-up__count">{state.invites.length}</span> : null}
      </button>
      <button type="button" className={`team-up__header-button ${panel === 'chat' ? 'is-active' : ''}`} disabled={disabled || state.teams.length === 0} onClick={openChat}>
        Chat {Object.values(unreadByTeam).reduce((total, count) => total + count, 0) > 0 ? <span className="team-up__count">{Object.values(unreadByTeam).reduce((total, count) => total + count, 0)}</span> : null}
      </button>

      {messageAlert ? <button type="button" className="team-up__message-alert" onClick={openChat}><strong>{messageAlert.senderName}</strong><span>{messageAlert.body}</span></button> : null}

      {panel === 'team' ? <button type="button" className="team-up__backdrop" aria-label="Close Team Up" onClick={() => setPanel(null)} /> : null}

      {panel === 'team' ? (
        <aside className="team-up__popover" aria-label="Team Up">
          <header><div><span className="team-up__eyebrow">Shared workspace</span><h3>Team Up</h3></div><button type="button" onClick={() => setPanel(null)}>×</button></header>
          {state.invites.length > 0 ? <section className="team-up__section"><h4>Invitations</h4>{state.invites.map((invite) => (
            <article className="team-up__invite" key={invite.id}>
              <strong>{invite.inviterName}</strong><span>{invite.inviterEmail}</span>
              <p>{invite.features.map((feature) => FEATURE_LABELS[feature] || feature).join(', ')}</p>
              <div><button disabled={busy} onClick={() => void respond(invite.id, true)}>Accept</button><button disabled={busy} onClick={() => void respond(invite.id, false)}>Decline</button></div>
            </article>
          ))}</section> : null}
          <section className="team-up__section">
            <h4>Invite a teammate</h4>
            <label><span>Their Deep Canvas email</span><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="partner@company.com" /></label>
            <div className="team-up__features">{state.shareableFeatures.map((feature) => (
              <label key={feature}><input type="checkbox" checked={selectedFeatures.includes(feature)} onChange={() => toggleFeature(feature)} /><span>{FEATURE_LABELS[feature] || feature}</span></label>
            ))}</div>
            <button className="team-up__primary" disabled={busy || !email.trim() || selectedFeatures.length === 0} onClick={() => void sendInvite()}>Send invitation</button>
          </section>
          {state.teams.length > 0 ? <section className="team-up__section"><h4>Your teams</h4>{state.teams.map((team) => (
            <article className="team-up__team" key={team.id}><strong>{team.name}</strong><span>{team.members.map((member) => member.displayName).join(' · ')}</span><p>{team.features.map((feature) => FEATURE_LABELS[feature] || feature).join(', ')}</p></article>
          ))}</section> : null}
          {notice ? <p className="team-up__notice">{notice}</p> : null}
        </aside>
      ) : null}

      {panel === 'chat' ? (
        <aside
          ref={chatPopoverRef}
          className="team-up__popover team-up__popover--chat"
          aria-label="Teammate chat"
          style={chatPosition ? { left: chatPosition.left, top: chatPosition.top, right: 'auto' } : undefined}
        >
          <header
            className={`team-up__chat-drag-handle ${dragOffset ? 'is-dragging' : ''}`}
            onPointerDown={startChatDrag}
            onPointerMove={moveChat}
            onPointerUp={stopChatDrag}
            onPointerCancel={stopChatDrag}
          ><div><span className="team-up__eyebrow">Team messages · drag to move</span><h3>Chat</h3></div><button type="button" onClick={() => setPanel(null)}>×</button></header>
          <div className="team-up__chat-modes">
            <button className={chatMode === 'team' ? 'is-active' : ''} onClick={() => { setChatMode('team'); setMessages([]); forceLatestMessageRef.current = true; }}>Team</button>
            <button className={chatMode === 'direct' ? 'is-active' : ''} disabled={!state.directContacts.length} onClick={() => { setChatMode('direct'); setMessages([]); forceLatestMessageRef.current = true; }}>Private</button>
          </div>
          {chatMode === 'team' && state.teams.length > 1 ? <select value={activeTeamId} onChange={(event) => {
            forceLatestMessageRef.current = true;
            userScrolledUpRef.current = false;
            setMessages([]);
            setActiveTeamId(event.target.value);
          }}>{state.teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}</select> : null}
          {chatMode === 'direct' ? <select value={activeDirectUserId} onChange={(event) => {
            forceLatestMessageRef.current = true;
            userScrolledUpRef.current = false;
            setMessages([]);
            setActiveDirectUserId(event.target.value);
          }}>{state.directContacts.map((contact) => <option key={contact.id} value={contact.id}>{contact.displayName} · {contact.email}</option>)}</select> : null}
          {chatMode === 'team' && activeTeam ? <div className="team-up__chat-meta"><span>{activeTeam.name} · {activeTeam.features.map((feature) => FEATURE_LABELS[feature] || feature).join(', ')}</span><button type="button" disabled={busy || messages.length === 0} onClick={() => void clearChat()}>Clear chat</button></div> : null}
          {chatMode === 'direct' && activeDirectContact ? <div className="team-up__chat-meta"><span>Private conversation with {activeDirectContact.displayName}</span><button type="button" disabled={busy || messages.length === 0} onClick={() => void clearChat()}>Clear chat</button></div> : null}
          <div
            className="team-up__messages"
            ref={messagesScrollRef}
            onScroll={(event) => {
              const container = event.currentTarget;
              userScrolledUpRef.current = container.scrollHeight - container.scrollTop - container.clientHeight > 24;
            }}
          >{messages.map((message) => (
            <article key={message.id} className={message.senderUserId === currentUserId ? 'is-mine' : ''}>
              <div className="team-up__message-heading"><strong>{message.senderUserId === currentUserId ? 'You' : message.senderName}</strong>{message.senderUserId === currentUserId ? <div className="team-up__message-actions"><button type="button" aria-label="Message options" aria-expanded={messageMenuId === message.id} onClick={() => setMessageMenuId((current) => current === message.id ? null : message.id)}>•••</button>{messageMenuId === message.id ? <div className="team-up__message-menu"><button type="button" onClick={() => beginEditMessage(message)}>Edit</button><button type="button" className="is-danger" onClick={() => void deleteChatMessage(message.id)}>Delete</button></div> : null}</div> : null}</div>
              {editingMessageId === message.id ? <div className="team-up__message-editor"><textarea value={editDraft} autoFocus onChange={(event) => setEditDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void saveEditedMessage(); } }} /><div><button type="button" disabled={busy || !editDraft.trim()} onClick={() => void saveEditedMessage()}>Save</button><button type="button" onClick={() => { setEditingMessageId(null); setEditDraft(''); }}>Cancel</button></div></div> : <p>{message.body}</p>}
              <time>{new Date(message.createdAt * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time>
            </article>
          ))}{messages.length === 0 ? <p className="team-up__empty">No messages yet. Start the conversation.</p> : null}</div>
          <div className="team-up__composer"><textarea value={messageDraft} onChange={(event) => setMessageDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendMessage(); } }} placeholder={chatMode === 'direct' ? 'Private message…' : 'Message your team…'} /><button disabled={busy || !messageDraft.trim()} onClick={() => void sendMessage()}>Send</button></div>
          {notice ? <p className="team-up__notice">{notice}</p> : null}
        </aside>
      ) : null}
    </div>
  );
}

