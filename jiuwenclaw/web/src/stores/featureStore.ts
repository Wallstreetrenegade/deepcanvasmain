import { create } from 'zustand';

export type FeatureKey =
  | 'storage'
  | 'kanban'
  | 'crm'
  | 'leadGen'
  | 'videoMeeting'
  | 'projectFlow';

export const FEATURE_ORDER: FeatureKey[] = [
  'storage',
  'kanban',
  'crm',
  'leadGen',
  'videoMeeting',
  'projectFlow',
];

export const FEATURE_LABELS: Record<FeatureKey, string> = {
  storage: 'Storage',
  kanban: 'Kanban',
  crm: 'CRM',
  leadGen: 'Lead Gen',
  videoMeeting: 'Video Meeting',
  projectFlow: 'Project Flow',
};

interface FeatureState {
  activeFeature: FeatureKey | null;
  openFeature: (feature: FeatureKey) => void;
  closeFeature: () => void;
}

export const useFeatureStore = create<FeatureState>((set) => ({
  activeFeature: null,
  openFeature: (feature) => set({ activeFeature: feature }),
  closeFeature: () => set({ activeFeature: null }),
}));
