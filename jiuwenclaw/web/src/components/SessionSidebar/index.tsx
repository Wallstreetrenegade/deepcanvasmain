/**
 * SessionSidebar 组件
 *
 * 会话侧边栏，显示会话列表
 */

import { useTranslation } from 'react-i18next';
import { useEffect, useState, type ReactNode } from 'react';
import { FEATURE_APP_UPDATER_UI } from '../../featureFlags';
import { OffloadFilesWidget } from './OffloadFilesWidget';
import { useSessionStore } from '../../stores';
import { webRequest } from '../../services/webClient';
import { HeartbeatMessageModal } from '../../features/HeartbeatMessageModal';
import { FEATURE_ORDER, useFeatureStore, type FeatureKey } from '../../stores/featureStore';
import './SessionSidebar.css';

type MainNavKey = 'chat' | 'skills' | 'agents' | 'sessions' | 'heartbeat' | 'cron' | 'channels' | 'configpanel' | 'browserpanel' | 'updatepanel';

interface SessionSidebarProps {
  activeNav: MainNavKey;
  onNavigate: (nav: MainNavKey) => void;
  sessionId: string;
  appVersion: string;
  footerControls?: ReactNode;
}

type SidebarTabKey = 'settings' | 'features';

const FEATURE_ICONS: Record<FeatureKey, ReactNode> = {
  storage: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4.5 6.75A2.25 2.25 0 0 1 6.75 4.5h10.5a2.25 2.25 0 0 1 2.25 2.25v10.5a2.25 2.25 0 0 1-2.25 2.25H6.75a2.25 2.25 0 0 1-2.25-2.25V6.75Z" />
      <path d="M8.25 15.75h7.5M8.25 8.25h7.5" />
      <path d="M8.25 12h.01M12 12h3.75" />
    </svg>
  ),
  kanban: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4.5 5.25h15v13.5h-15V5.25Z" />
      <path d="M9 5.25v13.5M15 5.25v13.5" />
      <path d="M6.75 8.25h1.5M11.25 11.25h1.5M17.25 8.25h1.5" />
    </svg>
  ),
  crm: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8.25 11.25a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM15.75 12a2.625 2.625 0 1 0 0-5.25" />
      <path d="M3.75 19.5a4.5 4.5 0 0 1 9 0M13.5 16.5a4.15 4.15 0 0 1 6.75 3" />
    </svg>
  ),
  leadGen: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 19.5a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15Z" />
      <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM12 3v3M12 18v3M3 12h3M18 12h3" />
    </svg>
  ),
  videoMeeting: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4.5 8.25A2.25 2.25 0 0 1 6.75 6h7.5a2.25 2.25 0 0 1 2.25 2.25v7.5A2.25 2.25 0 0 1 14.25 18h-7.5a2.25 2.25 0 0 1-2.25-2.25v-7.5Z" />
      <path d="m16.5 10.5 3-2.25v7.5l-3-2.25" />
    </svg>
  ),
  projectFlow: (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6.75 6.75h4.5v4.5h-4.5v-4.5ZM12.75 12.75h4.5v4.5h-4.5v-4.5Z" />
      <path d="M11.25 9h2.25A3.75 3.75 0 0 1 17.25 12.75M12.75 15H10.5A3.75 3.75 0 0 1 6.75 11.25" />
    </svg>
  ),
};

export function SessionSidebar({
  activeNav,
  onNavigate,
  sessionId,
  appVersion,
  footerControls,
}: SessionSidebarProps) {
  const { t } = useTranslation();
  const [activeTab, setActiveTab] = useState<SidebarTabKey>('features');
  const openFeature = useFeatureStore((state) => state.openFeature);
  const closeFeature = useFeatureStore((state) => state.closeFeature);
  const {
    contextCompressionRate,
    contextCompressionBefore,
    contextCompressionAfter,
    isConnected,
    memoryUsage,
    setMemoryUsage,
    heartbeatState,
    heartbeatMessage,
    heartbeatUpdatedAt,
  } = useSessionStore();
  const [heartbeatModalOpen, setHeartbeatModalOpen] = useState(false);

  useEffect(() => {
    if (!isConnected) {
      setMemoryUsage(null);
      return;
    }

    let disposed = false;
    let timerId: number | null = null;

    const refreshMemoryUsage = async () => {
      try {
        const payload = await webRequest<Record<string, unknown>>('memory.compute');
        if (disposed) return;

        const rssMb =
          typeof payload.rss_mb === 'number' && Number.isFinite(payload.rss_mb)
            ? payload.rss_mb
            : null;
        const usedPercent =
          typeof payload.used_percent === 'number' && Number.isFinite(payload.used_percent)
            ? payload.used_percent
            : null;

        setMemoryUsage({ rssMb, usedPercent });
      } catch {
        if (!disposed) {
          setMemoryUsage(null);
        }
      }
    };

    void refreshMemoryUsage();
    timerId = window.setInterval(() => {
      void refreshMemoryUsage();
    }, 10000);

    return () => {
      disposed = true;
      if (timerId != null) {
        window.clearInterval(timerId);
      }
    };
  }, [isConnected, setMemoryUsage]);

  const hasHeartbeatMessage = Boolean(heartbeatMessage?.trim());
  const heartbeatClassName =
    heartbeatState === 'ok' || hasHeartbeatMessage
      ? 'text-ok border-[var(--border-ok)] bg-ok-subtle'
      : heartbeatState === 'alert'
        ? 'text-danger border-[var(--border-danger)] bg-danger-subtle'
        : 'text-text-muted border-border bg-secondary/40';

  const heartbeatDetail = heartbeatUpdatedAt
    ? new Date(heartbeatUpdatedAt).toLocaleTimeString(undefined, { hour12: false })
    : '--:--:--';
  const isHeartbeatOk = heartbeatMessage?.toUpperCase().includes('HEARTBEAT_OK') ?? false;
  const heartbeatDisplayMessage = !heartbeatMessage
    ? 'HEARTBEAT_UNKNOWN'
    : isHeartbeatOk
      ? heartbeatMessage
      : t('toolPanel.heartbeatClick');
  const canOpenHeartbeatModal = Boolean(heartbeatMessage) && !isHeartbeatOk;
  const memoryDisplay =
    memoryUsage.rssMb == null
      ? '--'
      : `${memoryUsage.rssMb.toFixed(1)} MB${memoryUsage.usedPercent == null ? '' : ` (${memoryUsage.usedPercent.toFixed(1)}%)`}`;
  const beforeK = ((contextCompressionBefore ?? 0) / 1000).toFixed(1);
  const afterK = ((contextCompressionAfter ?? 0) / 1000).toFixed(1);
  let compressionRateDisplay;
  if (contextCompressionBefore === 0 || contextCompressionBefore === null) {
    compressionRateDisplay = '--';
  } else if (contextCompressionAfter === contextCompressionBefore) {
    compressionRateDisplay = '0.0';
  } else {
    compressionRateDisplay = Number.isFinite(contextCompressionRate)
      ? contextCompressionRate.toFixed(1)
      : '0.0';
  }
  const compressionDisplay = `${afterK}K/${beforeK}K (${compressionRateDisplay}%)`;

  const renderFeaturesPanel = () => (
    <div className="session-sidebar-features">
      <div className="session-sidebar-feature-grid">
        <button
          type="button"
          className="session-sidebar-feature-card session-sidebar-feature-card--chat"
          onClick={() => {
            closeFeature();
            onNavigate('chat');
          }}
        >
          <div className="session-sidebar-feature-card__icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4.5 6.75A2.25 2.25 0 0 1 6.75 4.5h10.5a2.25 2.25 0 0 1 2.25 2.25v7.5a2.25 2.25 0 0 1-2.25 2.25H9l-4.5 3v-12Z" />
              <path d="M8.25 9h7.5M8.25 12h4.5" />
            </svg>
          </div>
          <h4 className="session-sidebar-feature-card__title">
            {t('toolPanel.featuresPanel.chat.title')}
          </h4>
        </button>
        {FEATURE_ORDER.map((featureKey) => (
          <button
            key={featureKey}
            type="button"
            className="session-sidebar-feature-card"
            onClick={() => {
              openFeature(featureKey);
              onNavigate('chat');
            }}
          >
            <div className="session-sidebar-feature-card__icon" aria-hidden="true">
              {FEATURE_ICONS[featureKey]}
            </div>
            <h4 className="session-sidebar-feature-card__title">
              {t(`toolPanel.featuresPanel.items.${featureKey}.title`)}
            </h4>
          </button>
        ))}
      </div>
    </div>
  );

  const renderStatusCard = () => (
    <div className="session-sidebar-status-card">
      <h3 className="session-sidebar-status-card__title">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
          <rect x="1" y="8" width="3" height="7" rx="0.5" fill="currentColor" opacity="0.5" />
          <rect x="6" y="4" width="3" height="11" rx="0.5" fill="currentColor" opacity="0.7" />
          <rect x="11" y="1" width="3" height="14" rx="0.5" fill="currentColor" />
        </svg>
        {t('toolPanel.status')}
      </h3>
      <div className="space-y-2">
        <div className="session-sidebar-status-card__row">
          <span className="text-text-muted">{t('toolPanel.contextCompression')}</span>
          <span className="mono text-text">{compressionDisplay}</span>
        </div>
        <div className="session-sidebar-status-card__row">
          <span className="text-text-muted">{t('toolPanel.memoryUsage')}</span>
          <span className="mono text-text">{memoryDisplay}</span>
        </div>

        <div className={`session-sidebar-status-card__heartbeat ${heartbeatClassName}`}>
          <div className="session-sidebar-status-card__heartbeat-row">
            <span>{t('toolPanel.message')}</span>
            {canOpenHeartbeatModal ? (
              <button
                type="button"
                className="session-sidebar-status-card__heartbeat-link mono"
                onClick={() => setHeartbeatModalOpen(true)}
              >
                {heartbeatDisplayMessage}
              </button>
            ) : (
              <span className="session-sidebar-status-card__heartbeat-value mono">
                {heartbeatDisplayMessage}
              </span>
            )}
          </div>
          <div className="session-sidebar-status-card__heartbeat-row">
            <span>{t('toolPanel.time')}</span>
            <span className="session-sidebar-status-card__heartbeat-value mono">
              {heartbeatDetail}
            </span>
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <aside className="nav session-sidebar flex flex-col">
      <div className="session-sidebar-tabs">
        <button
          type="button"
          className={`session-sidebar-tab ${activeTab === 'settings' ? 'is-active' : ''}`}
          onClick={() => setActiveTab('settings')}
        >
          {t('sessionSidebar.tabs.settings')}
        </button>
        <button
          type="button"
          className={`session-sidebar-tab ${activeTab === 'features' ? 'is-active' : ''}`}
          onClick={() => setActiveTab('features')}
        >
          {t('toolPanel.tabs.features')}
        </button>
      </div>

      <div className="session-sidebar-panel flex-1">
        {activeTab === 'settings' ? (
          <>
            <div className="session-sidebar-group-title session-sidebar-group-title--uppercase">
              {t('nav.chat')}
            </div>
            <div className="space-y-1 mb-4">
              <button
                onClick={() => onNavigate('chat')}
                className={`nav-item w-full ${activeNav === 'chat' ? 'active' : ''}`}
              >
                <svg className="w-4 h-4 nav-item__icon" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                </svg>
                {t('nav.chat')}
              </button>
            </div>

            <div className="session-sidebar-group-title">
              {t('nav.agent')}
            </div>
            <div className="space-y-1">
              <button
                onClick={() => onNavigate('agents')}
                className={`nav-item w-full ${activeNav === 'agents' ? 'active' : ''}`}
              >
                <svg className="w-4 h-4 nav-item__icon" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                </svg>
                {t('nav.agent')}
              </button>
              <button
                onClick={() => onNavigate('sessions')}
                className={`nav-item w-full ${activeNav === 'sessions' ? 'active' : ''}`}
              >
                <svg className="w-4 h-4 nav-item__icon" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v12m6-6H6m9-9h3a2.25 2.25 0 012.25 2.25v3M9 3H6a2.25 2.25 0 00-2.25 2.25v3m0 6v3A2.25 2.25 0 006 19.75h3m6 0h3a2.25 2.25 0 002.25-2.25v-3" />
                </svg>
                {t('nav.sessions')}
              </button>
              <button
                onClick={() => onNavigate('heartbeat')}
                className={`nav-item w-full ${activeNav === 'heartbeat' ? 'active' : ''}`}
              >
                <svg className="w-4 h-4 nav-item__icon" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 12h3.75l1.5-4.5 3 9 2.25-6h6" />
                </svg>
                {t('nav.heartbeat')}
              </button>
              <button
                onClick={() => onNavigate('cron')}
                className={`nav-item w-full ${activeNav === 'cron' ? 'active' : ''}`}
              >
                <svg className="w-4 h-4 nav-item__icon" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                {t('nav.cron')}
              </button>
              <button
                onClick={() => onNavigate('skills')}
                className={`nav-item w-full ${activeNav === 'skills' ? 'active' : ''}`}
              >
                <svg className="w-4 h-4 nav-item__icon" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" />
                </svg>
                {t('nav.skills')}
              </button>
              <button
                onClick={() => onNavigate('channels')}
                className={`nav-item w-full ${activeNav === 'channels' ? 'active' : ''}`}
              >
                <svg className="w-4 h-4 nav-item__icon" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 6.75h15m-15 5.25h15m-15 5.25h15" />
                </svg>
                {t('nav.channels')}
              </button>
            </div>

            <div className="session-sidebar-group-title session-sidebar-group-title--with-top-gap">
              {t('nav.settings')}
            </div>
            <div className="space-y-1">
              <button
                onClick={() => onNavigate('configpanel')}
                className={`nav-item w-full ${activeNav === 'configpanel' ? 'active' : ''}`}
              >
                <svg className="w-4 h-4 nav-item__icon" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 010 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 010-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28z" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
                {t('nav.config')}
              </button>
              <button
                onClick={() => onNavigate('browserpanel')}
                className={`nav-item w-full ${activeNav === 'browserpanel' ? 'active' : ''}`}
              >
                <svg className="w-4 h-4 nav-item__icon" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                  <circle cx="12" cy="12" r="10" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10A15.3 15.3 0 0112 2z" />
                </svg>
                {t('nav.browser')}
              </button>
              {FEATURE_APP_UPDATER_UI && (
                <button
                  onClick={() => onNavigate('updatepanel')}
                  className={`nav-item w-full ${activeNav === 'updatepanel' ? 'active' : ''}`}
                >
                  <svg className="w-4 h-4 nav-item__icon" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 16.5V3.75m0 0L7.5 8.25M12 3.75l4.5 4.5" />
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 15.75v1.5A2.25 2.25 0 006 19.5h12a2.25 2.25 0 002.25-2.25v-1.5" />
                  </svg>
                  {t('nav.update')}
                </button>
              )}
            </div>
          </>
        ) : renderFeaturesPanel()}
      </div>

      {activeTab === 'settings' && renderStatusCard()}

      {false && <OffloadFilesWidget sessionId={sessionId} />}

      {footerControls ? <div className="session-sidebar-footer">{footerControls}</div> : (
        <div className="pt-4 mt-4 border-t border-border text-xs text-text-muted">
          <div className="px-2.5"><span>{t('version', { version: appVersion })}</span></div>
        </div>
      )}
      <HeartbeatMessageModal
        open={heartbeatModalOpen}
        message={heartbeatMessage ?? ''}
        onClose={() => setHeartbeatModalOpen(false)}
      />
    </aside>
  );
}
