import { lazy, type ComponentType } from 'react';
import { type FeatureKey } from '../../stores/featureStore';
import { CrmWorkspace } from './CrmWorkspace';
import { KanbanWorkspace } from './KanbanWorkspace';
import { LeadGenWorkspace } from './LeadGenWorkspace';
import { ProjectFlowWorkspace } from './ProjectFlowWorkspace';
import { StorageWorkspace } from './StorageWorkspace';

const VideoMeetingWorkspace = lazy(async () => {
  const module = await import('./MeetingSupportWorkspace');
  return { default: module.MeetingSupportWorkspace };
});

export interface FeatureWorkspaceComponentProps {
  onExit: () => void;
}

export const FEATURE_WORKSPACE_COMPONENTS: Record<FeatureKey, ComponentType<FeatureWorkspaceComponentProps>> = {
  storage: StorageWorkspace,
  kanban: KanbanWorkspace,
  crm: CrmWorkspace,
  leadGen: LeadGenWorkspace,
  videoMeeting: VideoMeetingWorkspace,
  projectFlow: ProjectFlowWorkspace,
};
