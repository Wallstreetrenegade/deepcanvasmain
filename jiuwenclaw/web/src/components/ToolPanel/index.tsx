/**
 * ToolPanel 组件
 *
 * 工具面板，显示 Todo 列表和状态信息
 */

import { useTranslation } from 'react-i18next';
import { useSessionStore } from '../../stores';
import { useState } from 'react';
import { TodoList } from '../TodoList';
import { PersonalTasksPanel } from '../PersonalTasksPanel';
import { TeamArea } from '../TeamArea';
import { TeamTaskEvents } from '../TeamTaskEvents';
import { useAssistantName } from '../../hooks/useAssistantName';
import './ToolPanel.css';

type ToolTabKey = 'tasks' | 'personal';

export function ToolPanel() {
  const { t } = useTranslation();
  const {
    mode,
    teamTaskEvents,
    teamMembers,
  } = useSessionStore();
  const [activeTab, setActiveTab] = useState<ToolTabKey>('tasks');
  const assistantName = useAssistantName('Chappie');

  return (
    <div
      data-testid="tool-panel"
      className="toolpanel-shell bg-panel border-l border-border h-full overflow-hidden py-4 px-3 shrink-0"
    >
      <div className="h-full bg-panel flex flex-col overflow-hidden">
        <div className="toolpanel-tabs">
          <button
            type="button"
            className={`toolpanel-tab ${activeTab === 'tasks' ? 'is-active' : ''}`}
            onClick={() => setActiveTab('tasks')}
          >
            {t('toolPanel.tabs.tasks')}
          </button>
          <button
            type="button"
            className={`toolpanel-tab ${activeTab === 'personal' ? 'is-active' : ''}`}
            onClick={() => setActiveTab('personal')}
          >
            My Tasks
          </button>
        </div>

        {activeTab === 'tasks' ? (
          <>
            {/* 任务事件日志 */}
            {mode === 'team' ? (
              <div className="flex-1 overflow-y-auto mb-4">
                <div className="bg-card rounded-lg border border-border overflow-hidden h-full">
                  <TeamTaskEvents events={teamTaskEvents} />
                </div>
              </div>
            ) : (
              /* Todo 列表 */
              <div className="flex-1 overflow-y-auto mb-4">
                <div className="bg-card rounded-lg border border-border overflow-hidden h-full">
                  <TodoList />
                </div>
              </div>
            )}

            {/* 团队区域 */}
            {mode === 'team' && (
              <div className="flex-1 overflow-y-auto">
                <div className="bg-card rounded-lg border border-border overflow-hidden h-full">
                  <TeamArea 
                    members={teamMembers}
                  />
                </div>
              </div>
            )}

            {/* 底部信息区：与左侧版本信息保持一致 */}
            <div className="toolpanel-footer shrink-0 pt-4 text-text-muted text-center">
              <div className="px-2.5">
                <span>{assistantName}</span>
              </div>
            </div>
          </>
        ) : <PersonalTasksPanel />}
      </div>
    </div>
  );
}
