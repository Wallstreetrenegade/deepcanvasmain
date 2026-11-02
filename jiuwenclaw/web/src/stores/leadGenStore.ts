import { create } from 'zustand';
import { mirrorFeatureState } from '../services/piMirror';

const STORAGE_KEY = 'deep_canvas_lead_gen_v1';

export type LeadGenLeadStatus = 'new' | 'researching' | 'contacted' | 'qualified' | 'meeting' | 'proposal' | 'won' | 'lost';
export type LeadGenCampaignStatus = 'draft' | 'active' | 'paused' | 'completed';

export interface LeadGenNote {
  id: string;
  body: string;
  createdAt: string;
}

export interface LeadGenProspect {
  id: string;
  name: string;
  company: string;
  role: string;
  email: string;
  source: string;
  status: LeadGenLeadStatus;
  score: number;
  tags: string[];
  notes: LeadGenNote[];
  nextAction: string;
  createdAt: string;
  updatedAt: string;
}

export interface LeadGenCampaign {
  id: string;
  name: string;
  audience: string;
  offer: string;
  channel: string;
  status: LeadGenCampaignStatus;
  leadIds: string[];
  createdAt: string;
  updatedAt: string;
}

interface LeadGenSnapshot {
  schemaVersion: number;
  prospects: LeadGenProspect[];
  campaigns: LeadGenCampaign[];
  searchQuery: string;
  selectedProspectId: string | null;
  updatedAt: string;
}

interface LeadGenState extends LeadGenSnapshot {
  setSearchQuery: (value: string) => void;
  selectProspect: (prospectId: string | null) => void;
  addProspect: (input: Partial<Omit<LeadGenProspect, 'id' | 'notes' | 'createdAt' | 'updatedAt'>>) => LeadGenProspect | null;
  updateProspect: (prospectId: string, updates: Partial<Omit<LeadGenProspect, 'id' | 'notes' | 'createdAt' | 'updatedAt'>>) => void;
  addProspectNote: (prospectId: string, body: string) => void;
  deleteProspect: (prospectId: string) => void;
  addCampaign: (input: Partial<Omit<LeadGenCampaign, 'id' | 'createdAt' | 'updatedAt'>>) => LeadGenCampaign | null;
  updateCampaign: (campaignId: string, updates: Partial<Omit<LeadGenCampaign, 'id' | 'createdAt' | 'updatedAt'>>) => void;
  attachProspectToCampaign: (campaignId: string, prospectId: string) => void;
  detachProspectFromCampaign: (campaignId: string, prospectId: string) => void;
  deleteCampaign: (campaignId: string) => void;
}

function makeId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function createDefaultSnapshot(): LeadGenSnapshot {
  return {
    schemaVersion: 1,
    prospects: [],
    campaigns: [],
    searchQuery: '',
    selectedProspectId: null,
    updatedAt: nowIso(),
  };
}

function normalizeSnapshot(raw: unknown): LeadGenSnapshot {
  const base = createDefaultSnapshot();
  if (!raw || typeof raw !== 'object') return base;
  const parsed = raw as Partial<LeadGenSnapshot>;
  return {
    schemaVersion: 1,
    prospects: Array.isArray(parsed.prospects) ? parsed.prospects.filter((item): item is LeadGenProspect => Boolean(item && typeof item === 'object')) : [],
    campaigns: Array.isArray(parsed.campaigns) ? parsed.campaigns.filter((item): item is LeadGenCampaign => Boolean(item && typeof item === 'object')) : [],
    searchQuery: typeof parsed.searchQuery === 'string' ? parsed.searchQuery : '',
    selectedProspectId: typeof parsed.selectedProspectId === 'string' ? parsed.selectedProspectId : null,
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : base.updatedAt,
  };
}

function loadSnapshot(): LeadGenSnapshot {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return createDefaultSnapshot();
    return normalizeSnapshot(JSON.parse(raw));
  } catch {
    return createDefaultSnapshot();
  }
}

function persistSnapshot(snapshot: LeadGenSnapshot) {
  const next = { ...snapshot, updatedAt: nowIso() };
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // ignore browser storage failures
  }
  mirrorFeatureState('lead_gen', next);
  return next;
}

const initialSnapshot = persistSnapshot(loadSnapshot());

export const useLeadGenStore = create<LeadGenState>((set) => ({
  ...initialSnapshot,

  setSearchQuery: (searchQuery) => {
    set((state) => persistSnapshot({ ...state, searchQuery }));
  },

  selectProspect: (selectedProspectId) => {
    set((state) => persistSnapshot({ ...state, selectedProspectId }));
  },

  addProspect: (input) => {
    const cleanName = String(input.name || '').trim();
    if (!cleanName) return null;
    const prospect: LeadGenProspect = {
      id: makeId('prospect'),
      name: cleanName,
      company: String(input.company || '').trim(),
      role: String(input.role || '').trim(),
      email: String(input.email || '').trim(),
      source: String(input.source || 'Manual').trim() || 'Manual',
      status: (input.status as LeadGenLeadStatus) || 'new',
      score: Math.max(0, Math.min(100, Number(input.score ?? 50) || 0)),
      tags: Array.isArray(input.tags) ? input.tags.map((item) => String(item).trim()).filter(Boolean) : [],
      notes: [],
      nextAction: String(input.nextAction || '').trim(),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    set((state) => {
      const next = persistSnapshot({
        ...state,
        prospects: [prospect, ...state.prospects],
        selectedProspectId: prospect.id,
      });
      return next;
    });
    return prospect;
  },

  updateProspect: (prospectId, updates) => {
    set((state) =>
      persistSnapshot({
        ...state,
        prospects: state.prospects.map((prospect) =>
          prospect.id === prospectId
            ? {
                ...prospect,
                ...updates,
                tags: Array.isArray(updates.tags) ? updates.tags.map((item) => String(item).trim()).filter(Boolean) : prospect.tags,
                score: updates.score === undefined ? prospect.score : Math.max(0, Math.min(100, Number(updates.score) || 0)),
                updatedAt: nowIso(),
              }
            : prospect
        ),
      })
    );
  },

  addProspectNote: (prospectId, body) => {
    const cleanBody = body.trim();
    if (!cleanBody) return;
    const note: LeadGenNote = { id: makeId('note'), body: cleanBody, createdAt: nowIso() };
    set((state) =>
      persistSnapshot({
        ...state,
        prospects: state.prospects.map((prospect) =>
          prospect.id === prospectId
            ? { ...prospect, notes: [note, ...prospect.notes], updatedAt: nowIso() }
            : prospect
        ),
      })
    );
  },

  deleteProspect: (prospectId) => {
    set((state) =>
      persistSnapshot({
        ...state,
        prospects: state.prospects.filter((prospect) => prospect.id !== prospectId),
        campaigns: state.campaigns.map((campaign) => ({
          ...campaign,
          leadIds: campaign.leadIds.filter((leadId) => leadId !== prospectId),
          updatedAt: campaign.leadIds.includes(prospectId) ? nowIso() : campaign.updatedAt,
        })),
        selectedProspectId: state.selectedProspectId === prospectId ? null : state.selectedProspectId,
      })
    );
  },

  addCampaign: (input) => {
    const cleanName = String(input.name || '').trim();
    if (!cleanName) return null;
    const campaign: LeadGenCampaign = {
      id: makeId('campaign'),
      name: cleanName,
      audience: String(input.audience || '').trim(),
      offer: String(input.offer || '').trim(),
      channel: String(input.channel || 'Email').trim() || 'Email',
      status: (input.status as LeadGenCampaignStatus) || 'draft',
      leadIds: Array.isArray(input.leadIds) ? input.leadIds.map((item) => String(item)).filter(Boolean) : [],
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    set((state) => persistSnapshot({ ...state, campaigns: [campaign, ...state.campaigns] }));
    return campaign;
  },

  updateCampaign: (campaignId, updates) => {
    set((state) =>
      persistSnapshot({
        ...state,
        campaigns: state.campaigns.map((campaign) =>
          campaign.id === campaignId
            ? {
                ...campaign,
                ...updates,
                leadIds: Array.isArray(updates.leadIds) ? updates.leadIds.map((item) => String(item)).filter(Boolean) : campaign.leadIds,
                updatedAt: nowIso(),
              }
            : campaign
        ),
      })
    );
  },

  attachProspectToCampaign: (campaignId, prospectId) => {
    set((state) =>
      persistSnapshot({
        ...state,
        campaigns: state.campaigns.map((campaign) =>
          campaign.id === campaignId && !campaign.leadIds.includes(prospectId)
            ? { ...campaign, leadIds: [...campaign.leadIds, prospectId], updatedAt: nowIso() }
            : campaign
        ),
      })
    );
  },

  detachProspectFromCampaign: (campaignId, prospectId) => {
    set((state) =>
      persistSnapshot({
        ...state,
        campaigns: state.campaigns.map((campaign) =>
          campaign.id === campaignId
            ? {
                ...campaign,
                leadIds: campaign.leadIds.filter((leadId) => leadId !== prospectId),
                updatedAt: nowIso(),
              }
            : campaign
        ),
      })
    );
  },

  deleteCampaign: (campaignId) => {
    set((state) =>
      persistSnapshot({
        ...state,
        campaigns: state.campaigns.filter((campaign) => campaign.id !== campaignId),
      })
    );
  },
}));
