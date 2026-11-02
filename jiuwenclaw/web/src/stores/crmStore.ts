import { create } from 'zustand';
import { flushFeatureState, mirrorFeatureState, syncFeatureState } from '../services/piMirror';
import { webRequest } from '../services/webClient';

const STORAGE_KEY_PREFIX = 'deep_canvas_crm_v2';
const VIEW_STORAGE_KEY_PREFIX = 'deep_canvas_crm_view_v1';
const CRM_STATE_VERSION = 12;

export const CRM_MAX_IMPORT_BYTES = 5 * 1024 * 1024;
export const CRM_MAX_IMPORT_ROWS = 5000;

export type CrmLeadStage = string;
export type CrmLeadStatus = string;
export type CrmOptionKind = 'stage' | 'source';
export type CrmDensity = 'compact' | 'cozy';
export type CrmViewPreset = 'all' | 'hot' | 'follow-up' | 'pipeline' | 'closed';
export type CrmSortDirection = 'asc' | 'desc';
export type CrmColumnKind = 'core' | 'custom';
export type CrmSourceFilter = 'all' | string;
export type CrmBatchFilter = 'all' | string;
export type CrmHydrationStatus = 'idle' | 'loading' | 'ready' | 'error';
export type CrmImportableField =
  | 'name'
  | 'leadName'
  | 'company'
  | 'email'
  | 'phone'
  | 'address'
  | 'website'
  | 'owner'
  | 'source'
  | 'stage'
  | 'status'
  | 'score'
  | 'opm'
  | 'saleAmount'
  | 'nextAction'
  | 'lastContactAt'
  | 'tags';
export type CrmImportTarget = '__ignore__' | CrmImportableField | `custom:${string}`;

export interface CrmColumn {
  key: string;
  label: string;
  kind: CrmColumnKind;
  visible: boolean;
}

export interface CrmLeadNote {
  id: string;
  body: string;
  createdAt: string;
}

export interface CrmFormQuestion {
  id: string;
  prompt: string;
}

export interface CrmLead {
  id: string;
  name: string;
  leadName: string;
  company: string;
  email: string;
  phone: string;
  address: string;
  website: string;
  owner: string;
  source: string;
  stage: CrmLeadStage;
  status: CrmLeadStatus;
  score: number;
  opm: number;
  saleAmount: number;
  nextAction: string;
  lastContactAt: string;
  tags: string[];
  customFields: Record<string, string>;
  notes: CrmLeadNote[];
  formAnswers: Record<string, string>;
  isNew: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CrmCsvParseResult {
  headers: string[];
  rows: string[][];
}

export interface CrmImportMapping {
  header: string;
  target: CrmImportTarget;
}

export interface CrmImportResult {
  importedCount: number;
  skippedDuplicateCount: number;
  skippedInvalidCount: number;
  skippedLimitCount: number;
  totalRows: number;
}

export interface CreateLeadInput {
  name: string;
  leadName?: string;
  company?: string;
  email?: string;
  phone?: string;
  address?: string;
  website?: string;
  owner?: string;
  source?: string;
  stage?: CrmLeadStage;
  status?: CrmLeadStatus;
  score?: number;
  opm?: number;
  saleAmount?: number;
  nextAction?: string;
  lastContactAt?: string;
  tags?: string[];
  customFields?: Record<string, string>;
}

interface CrmSnapshot {
  schemaVersion: number;
  columns: CrmColumn[];
  leads: CrmLead[];
  powerDialerLeadIds: string[];
  formQuestions: CrmFormQuestion[];
  stageOptions: CrmLeadStage[];
  stageColors: Record<string, string>;
  favoriteStages: CrmLeadStage[];
  favoriteStagesUpdatedAt: string;
  statusOptions: CrmLeadStatus[];
  sourceOptions: string[];
  searchQuery: string;
  stageFilter: CrmLeadStage | 'all';
  statusFilter: CrmLeadStatus | 'all';
  sourceFilter: CrmSourceFilter;
  batchFilter: CrmBatchFilter;
  viewPreset: CrmViewPreset;
  density: CrmDensity;
  sortKey: string;
  sortDirection: CrmSortDirection;
  detailLeadId: string | null;
  lastSavedAt: string;
}

interface CrmState extends CrmSnapshot {
  hydrationStatus: CrmHydrationStatus;
  hydrationError: string | null;
  hydrate: () => Promise<void>;
  flushChanges: () => Promise<boolean>;
  setSearchQuery: (value: string) => void;
  setStageFilter: (value: CrmLeadStage | 'all') => void;
  setStatusFilter: (value: CrmLeadStatus | 'all') => void;
  setSourceFilter: (value: CrmSourceFilter) => void;
  setBatchFilter: (value: CrmBatchFilter) => void;
  setViewPreset: (value: CrmViewPreset) => void;
  setDensity: (value: CrmDensity) => void;
  setSort: (key: string) => void;
  toggleColumnVisibility: (key: string) => void;
  addCustomColumn: (label: string) => void;
  addOption: (kind: CrmOptionKind, value: string) => void;
  removeOption: (kind: CrmOptionKind, value: string) => void;
  setStageColor: (stage: string, color: string) => void;
  toggleFavoriteStage: (stage: string) => void;
  addLead: (input: CreateLeadInput) => CrmLead | null;
  updateLead: (leadId: string, updates: Partial<Omit<CrmLead, 'id' | 'notes' | 'customFields' | 'createdAt'>>) => void;
  updateLeadCustomField: (leadId: string, fieldKey: string, value: string) => void;
  assignBatchToLeads: (leadIds: string[], batchName: string) => number;
  renameBatch: (fromBatch: string, toBatch: string) => number;
  clearBatch: (batchName: string) => number;
  addLeadNote: (leadId: string, body: string) => void;
  updateLeadFormAnswer: (leadId: string, questionId: string, value: string) => void;
  saveLeadFormAnswers: (leadId: string, answers: Record<string, string>) => void;
  updateFormQuestion: (questionId: string, prompt: string) => void;
  addFormQuestion: () => void;
  deleteFormQuestion: (questionId: string) => void;
  resetFormQuestions: () => void;
  deleteLead: (leadId: string) => Promise<boolean>;
  deleteLeads: (leadIds: string[]) => Promise<number>;
  addLeadToPowerDialer: (leadId: string) => void;
  removeLeadFromPowerDialer: (leadId: string) => void;
  clearPowerDialer: () => void;
  openLead: (leadId: string) => void;
  closeLead: () => void;
  importCsv: (content: string, batchName?: string) => CrmImportResult;
  importMappedCsv: (content: string, mappings: CrmImportMapping[], batchName?: string) => CrmImportResult;
}

interface StoredAuthUser {
  id: string;
  email: string;
  displayName?: string;
}

interface PiStateResponse {
  feature?: string;
  data?: unknown;
}

export const CRM_STAGE_OPTIONS: CrmLeadStage[] = ['new', 'nurturing', 'follow-up', 'qualified', 'contacted', 'set appointment', 'close appointment', 'proposal', 'negotiation', 'won', 'lost', 'closed', 'stale'];
export const CRM_STATUS_OPTIONS: CrmLeadStatus[] = ['active', 'nurturing', 'follow-up', 'stale', 'closed'];
export const CRM_VIEW_PRESETS: CrmViewPreset[] = ['all', 'hot', 'follow-up', 'pipeline', 'closed'];
const CRM_STAGE_COLOR_PALETTE = ['#0d9488', '#2563eb', '#7c3aed', '#d97706', '#ea580c', '#0891b2', '#db2777', '#16a34a', '#dc2626'];

const DEFAULT_FORM_PROMPTS = [
  'Hi, is (name) available?',
  'This call may be monitored or recorded for quality assurance purposes.',
  'Have you ever built an online business before, or is this your first time?',
  'Are you looking for this business to supplement your income or become a primary source?',
  'Can you devote at least 10 hours a week to the business?',
  'Are you married or single?',
  'Do you understand that we cannot work one-on-one with everyone who purchases a program?',
  'Explain that this profile determines initial criteria before speaking with a director.',
  'What are your goals in having an online business? Dig into the motivation and why.',
  'If you accomplished those goals through this business, what would that do for you?',
  'Explain that the next questions cover employment, finances, and debt.',
  'Confirm that no account numbers, Social Security numbers, or identity-sensitive information will be requested.',
  'How old are you?',
  'What is the highest level of education you completed?',
  'Are you financially responsible for parents, grandparents, children, or anyone else?',
  'Are you currently employed?',
  'What do you do for a living?',
  'How many hours per week are you working?',
  'What is your current annual or monthly income?',
  'How would you rate your credit for building a business: great, good, fair, or poor?',
  'Do you currently have active or open credit-card accounts?',
  'Financially, are you getting ahead, getting by, or getting behind?',
  'With your current savings, are you getting ahead, getting by, or getting behind?',
  'Approximately how much do you have in savings?',
  'Is that liquid savings or held in investments?',
  'Do you have retirement funds or investments, such as a 401(k) or IRA?',
  'Approximately how much do you have in retirement funds or investments?',
  'Are you on track for retirement?',
  'Explain that accurate information helps determine the right business plan and income target.',
  'Do you rent or own your home? If owned: balance and mortgage payment. If rented: monthly rent.',
  'Do you have any home-equity loans?',
  'Do you have any personal loans?',
  'Do you have any auto loans?',
  'Do you have any student loans?',
  'Do you have any medical, dental, or hospital bills?',
  'Do you have any attorney fees?',
  'How many active or open credit-card accounts do you have?',
  'Explain that balances and limits are requested instead of running a credit check.',
  'For each card: record type, current balance, and limit.',
  'If there is pushback, explain why the director needs to understand credit responsibility.',
  'Do you have inactive cards or cards that have not been activated?',
  'Do you have store cards or department-store cards?',
  'Is there any other debt to add?',
  'Recap their current position and explain that the director will build a detailed plan.',
  'Confirm the director conversation covers the business plan, launch, and questions.',
  'Can you dedicate time now, and do you have internet access?',
  'Do you have the next two hours available without interruption?',
  'Place the prospect on silent hold and check director availability.',
  'Confirm director availability and continue the profile.',
  'After achieving your initial goals, what are your longer-term goals?',
  'Why do you feel the internet is the way to accomplish your goals?',
  'With the right professional help, do you believe you could accomplish your goals?',
  'How much would you need to make in six months to consider this a success?',
  'How much would you need to make one year from now?',
  'Without making a change now, could you accomplish your financial goals soon?',
  'Are you ready to make a change to reach financial freedom and improve your life?',
  'On a scale of 1–10, how serious are you about achieving your financial goals? If below 10, what is stopping you?',
  'Recommend that the prospect speak with the director.',
  'Place the prospect on hold and confirm the director is ready.',
  'Confirm qualification and introduce the four commitment steps.',
  'Commitment 1 — Time and effort: Can you commit at least 10 hours a week?',
  'Commitment 2 — Open minded and teachable: Can you embrace a student-teacher relationship, and why is that important?',
  'Commitment 3 — Investment / OPM: If the plan makes sense, are you willing and able to use this strategy today?',
  'Commitment 4 — Decision maker and action taker: Are you ready to decide and move forward once you have the details?',
];

export const DEFAULT_CRM_FORM_QUESTIONS: CrmFormQuestion[] = DEFAULT_FORM_PROMPTS.map((prompt, index) => ({
  id: `call_profile_${String(index + 1).padStart(2, '0')}`,
  prompt,
}));
export const CRM_IMPORTABLE_FIELDS: Array<{ key: CrmImportableField; label: string }> = [
  { key: 'name', label: 'Name' },
  { key: 'leadName', label: 'Lead Name' },
  { key: 'company', label: 'Company' },
  { key: 'email', label: 'Email' },
  { key: 'phone', label: 'Phone' },
  { key: 'address', label: 'Address' },
  { key: 'website', label: 'Website' },
  { key: 'owner', label: 'Owner' },
  { key: 'source', label: 'Source' },
  { key: 'stage', label: 'Stage' },
  { key: 'score', label: 'Score' },
  { key: 'opm', label: 'OPM' },
  { key: 'saleAmount', label: 'Sale Value' },
  { key: 'nextAction', label: 'Next Action' },
  { key: 'lastContactAt', label: 'Last Contact' },
  { key: 'tags', label: 'Tags' },
];

const DEFAULT_SOURCE_OPTIONS = ['Website', 'Referral', 'Outbound', 'Event', 'Partner'];

const DEFAULT_COLUMNS: CrmColumn[] = [
  { key: 'name', label: 'Name', kind: 'core', visible: true },
  { key: 'leadName', label: 'Lead Name', kind: 'core', visible: true },
  { key: 'company', label: 'Company', kind: 'core', visible: true },
  { key: 'email', label: 'Email', kind: 'core', visible: true },
  { key: 'phone', label: 'Phone', kind: 'core', visible: true },
  { key: 'address', label: 'Address', kind: 'core', visible: true },
  { key: 'stage', label: 'Stage', kind: 'core', visible: true },
  { key: 'owner', label: 'Owner', kind: 'core', visible: true },
  { key: 'source', label: 'Source', kind: 'core', visible: true },
  { key: 'score', label: 'Score', kind: 'core', visible: true },
  { key: 'opm', label: 'OPM', kind: 'core', visible: true },
  { key: 'saleAmount', label: 'Sale Value', kind: 'core', visible: true },
  { key: 'nextAction', label: 'Next Action', kind: 'core', visible: false },
  { key: 'lastContactAt', label: 'Last Contact', kind: 'core', visible: false },
  { key: 'updatedAt', label: 'Updated', kind: 'core', visible: false },
];

const EMPTY_IMPORT_RESULT: CrmImportResult = {
  importedCount: 0,
  skippedDuplicateCount: 0,
  skippedInvalidCount: 0,
  skippedLimitCount: 0,
  totalRows: 0,
};

function makeId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
}

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ');
}

function cleanText(value: unknown, maxLength = 500): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function clampScore(value: unknown): number {
  const score = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(score)) return 0;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function normalizeWebsite(value: unknown): string {
  return cleanText(value, 240).replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

function normalizeDateValue(value: unknown): string {
  const raw = cleanText(value, 32);
  if (!raw) return '';
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return raw;
  return parsed.toISOString().slice(0, 10);
}

function sanitizeStage(value: unknown): CrmLeadStage {
  const normalized = cleanText(value, 40).toLowerCase();
  return normalized || 'new';
}

function normalizeMoney(value: unknown): number {
  const amount = typeof value === 'number'
    ? value
    : Number(String(value ?? '').replace(/[$,\s]/g, ''));
  if (!Number.isFinite(amount)) return 0;
  return Math.max(0, Math.round(amount * 100) / 100);
}

function sanitizeStatus(value: unknown): CrmLeadStatus {
  const normalized = cleanText(value, 40).toLowerCase();
  return normalized || 'active';
}

function migrateDispositionStage(stageValue: unknown, statusValue: unknown): CrmLeadStage {
  const stage = sanitizeStage(stageValue);
  const legacyStatus = sanitizeStatus(statusValue);
  if ((!cleanText(stageValue, 40) || stage === 'new') && legacyStatus !== 'active') {
    return legacyStatus;
  }
  return stage;
}

function normalizeOptionList(value: unknown, defaults: string[], used: string[], lowercase = false): string[] {
  const supplied = Array.isArray(value) ? value : [];
  const base = supplied.length > 0 ? supplied : defaults;
  const options = [...base, ...used]
    .map((option) => cleanText(option, 80))
    .map((option) => lowercase ? option.toLowerCase() : option)
    .filter(Boolean);
  return [...new Set(options)];
}

function normalizeStageColors(value: unknown, stages: string[]): Record<string, string> {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return Object.fromEntries(stages.map((stage, index) => {
    const saved = cleanText(raw[stage], 20);
    return [stage, /^#[0-9a-f]{6}$/i.test(saved) ? saved.toLowerCase() : CRM_STAGE_COLOR_PALETTE[index % CRM_STAGE_COLOR_PALETTE.length]];
  }));
}

function parseTags(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => cleanText(item, 80)).filter(Boolean).slice(0, 30);
  }
  return cleanText(value, 600).split(/[;,]/).map((item) => item.trim()).filter(Boolean).slice(0, 30);
}

function normalizeCustomFields(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.entries(value as Record<string, unknown>).reduce<Record<string, string>>((result, [key, fieldValue]) => {
    const cleanKey = cleanText(key, 80);
    const cleanValue = cleanText(fieldValue, 1200);
    if (cleanKey && cleanValue) {
      result[cleanKey] = cleanValue;
    }
    return result;
  }, {});
}

function normalizeNotes(value: unknown): CrmLeadNote[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((note, index) => {
    if (!note || typeof note !== 'object') return [];
    const raw = note as Record<string, unknown>;
    const body = cleanText(raw.body ?? raw.text ?? raw.note, 4000);
    if (!body) return [];
    return [{
      id: cleanText(raw.id, 80) || makeId(`note_${index}`),
      body,
      createdAt: cleanText(raw.createdAt ?? raw.created_at, 40) || nowIso(),
    }];
  });
}

function isDefaultSeedLead(lead: CrmLead): boolean {
  return (
    (lead.id === 'lead_1' && lead.name === 'Avery Brooks' && lead.company === 'Northline Studio') ||
    (lead.id === 'lead_2' && lead.name === 'Sofia Patel' && lead.company === 'Peak Logistics') ||
    (lead.id === 'lead_3' && lead.name === 'Marcus Green' && lead.company === 'Valence Health')
  );
}

function normalizeLead(value: unknown, index: number): CrmLead | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const timestamp = nowIso();
  const company = cleanText(raw.company ?? raw.organization, 240);
  const email = cleanText(raw.email ?? raw.emailAddress, 240).toLowerCase();
  const phone = cleanText(raw.phone ?? raw.mobile, 80);
  const name = cleanText(raw.name ?? raw.fullName ?? raw.title, 240) || company || email || phone;
  if (!name && !company && !email && !phone) return null;

  const lead: CrmLead = {
    id: cleanText(raw.id, 80) || makeId(`lead_${index}`),
    name: name || `Lead ${index + 1}`,
    leadName: cleanText(raw.leadName ?? raw.lead_name ?? raw.lead, 240),
    company,
    email,
    phone,
    address: cleanText(raw.address ?? raw.location, 500),
    website: normalizeWebsite(raw.website),
    owner: cleanText(raw.owner ?? raw.assignee, 160),
    source: cleanText(raw.source, 160) || 'Website',
    stage: migrateDispositionStage(raw.stage, raw.status),
    // Kept internally for backward compatibility with older snapshots and
    // agent tools. Stage is the only user-facing disposition field.
    status: 'active',
    score: clampScore(raw.score),
    opm: normalizeMoney(raw.opm ?? raw.availableCredit ?? raw.available_credit),
    saleAmount: normalizeMoney(raw.saleAmount ?? raw.sale_amount ?? raw.revenue ?? raw.dealValue ?? raw.deal_value),
    nextAction: cleanText(raw.nextAction ?? raw.next_action, 500),
    lastContactAt: normalizeDateValue(raw.lastContactAt ?? raw.last_contact_at),
    tags: parseTags(raw.tags),
    customFields: normalizeCustomFields(raw.customFields ?? raw.custom_fields),
    notes: normalizeNotes(raw.notes),
    formAnswers: normalizeFormAnswers(raw.formAnswers ?? raw.form_answers),
    isNew: raw.isNew === true || raw.is_new === true,
    createdAt: cleanText(raw.createdAt ?? raw.created_at, 40) || timestamp,
    updatedAt: cleanText(raw.updatedAt ?? raw.updated_at, 40) || timestamp,
  };

  return isDefaultSeedLead(lead) ? null : lead;
}

function normalizeColumns(value: unknown): CrmColumn[] {
  const incoming = Array.isArray(value) ? value : [];
  const merged = DEFAULT_COLUMNS.map((defaultColumn) => {
    const matching = incoming.find((column) => column && typeof column === 'object' && (column as CrmColumn).key === defaultColumn.key) as Partial<CrmColumn> | undefined;
    return {
      ...defaultColumn,
      visible: typeof matching?.visible === 'boolean' ? matching.visible : defaultColumn.visible,
    };
  });

  incoming.forEach((column) => {
    if (!column || typeof column !== 'object') return;
    const raw = column as Partial<CrmColumn>;
    if (raw.kind !== 'custom') return;
    const label = cleanText(raw.label, 80);
    if (!label) return;
    const key = cleanText(raw.key, 80) || `custom_${slugify(label)}`;
    if (merged.some((candidate) => candidate.key === key || normalizeHeader(candidate.label) === normalizeHeader(label))) return;
    merged.push({ key, label, kind: 'custom', visible: raw.visible !== false });
  });

  if (!merged.some((column) => column.visible)) {
    merged[0] = { ...merged[0], visible: true };
  }

  return merged;
}

function normalizeFormAnswers(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.entries(value as Record<string, unknown>).reduce<Record<string, string>>((result, [key, answer]) => {
    const cleanKey = cleanText(key, 80);
    const cleanAnswer = cleanText(answer, 8000);
    if (cleanKey && cleanAnswer) result[cleanKey] = cleanAnswer;
    return result;
  }, {});
}

function normalizeFormQuestions(value: unknown): CrmFormQuestion[] {
  if (!Array.isArray(value)) return DEFAULT_CRM_FORM_QUESTIONS.map((question) => ({ ...question }));
  const questions = value.flatMap((question, index) => {
    if (!question || typeof question !== 'object') return [];
    const raw = question as Record<string, unknown>;
    const prompt = cleanText(raw.prompt, 2000);
    if (!prompt) return [];
    return [{ id: cleanText(raw.id, 80) || makeId(`form_${index}`), prompt }];
  });
  return questions.length > 0 ? questions : DEFAULT_CRM_FORM_QUESTIONS.map((question) => ({ ...question }));
}

function labelForCustomField(key: string): string {
  const labels: Record<string, string> = {
    lead_gen_batch: 'Lead Gen Batch',
    lead_gen_profile_url: 'Profile URL',
    lead_gen_location: 'Lead Location',
    lead_gen_industry: 'Industry',
    lead_gen_summary: 'Lead Summary',
    lead_gen_source_key: 'Source Key',
    lead_gen_source_label: 'Lead Source',
    lead_gen_source_url: 'Source URL',
    lead_gen_source_query: 'Source Query',
    lead_gen_source_mode: 'Source Mode',
    lead_gen_source_actor: 'Source Actor',
    lead_gen_scraped_at: 'Scraped At',
  };
  if (labels[key]) return labels[key];
  return key
    .replace(/^custom_/, '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .slice(0, 80);
}

function customFieldVisibleByDefault(key: string): boolean {
  return key === 'lead_gen_batch' || key === 'lead_gen_source_label';
}

function ensureCustomFieldColumns(columns: CrmColumn[], leads: CrmLead[]): CrmColumn[] {
  const next = [...columns];
  leads.forEach((lead) => {
    Object.keys(lead.customFields).forEach((fieldKey) => {
      const cleanKey = cleanText(fieldKey, 80);
      if (!cleanKey || next.some((column) => column.key === cleanKey)) return;
      next.push({
        key: cleanKey,
        label: labelForCustomField(cleanKey),
        kind: 'custom',
        visible: customFieldVisibleByDefault(cleanKey),
      });
    });
  });
  return next;
}

function createDefaultSnapshot(): CrmSnapshot {
  const timestamp = nowIso();
  return {
    schemaVersion: CRM_STATE_VERSION,
    columns: DEFAULT_COLUMNS,
    leads: [],
    powerDialerLeadIds: [],
    formQuestions: DEFAULT_CRM_FORM_QUESTIONS.map((question) => ({ ...question })),
    stageOptions: [...CRM_STAGE_OPTIONS],
    stageColors: normalizeStageColors({}, CRM_STAGE_OPTIONS),
    favoriteStages: [],
    favoriteStagesUpdatedAt: timestamp,
    statusOptions: [...CRM_STATUS_OPTIONS],
    sourceOptions: [...DEFAULT_SOURCE_OPTIONS],
    searchQuery: '',
    stageFilter: 'all',
    statusFilter: 'all',
    sourceFilter: 'all',
    batchFilter: 'all',
    viewPreset: 'all',
    density: 'compact',
    sortKey: '',
    sortDirection: 'desc',
    detailLeadId: null,
    lastSavedAt: timestamp,
  };
}

function normalizeSnapshot(value: unknown, fallback: CrmSnapshot = createDefaultSnapshot()): CrmSnapshot {
  if (Array.isArray(value)) {
    const leads = deduplicateLeads(value.map((lead, index) => normalizeLead(lead, index)).filter((lead): lead is CrmLead => Boolean(lead)));
    const stageOptions = normalizeOptionList(fallback.stageOptions, CRM_STAGE_OPTIONS, leads.map((lead) => lead.stage), true);
    return {
      ...fallback,
      columns: ensureCustomFieldColumns(fallback.columns, leads),
      leads,
      stageOptions,
      stageColors: normalizeStageColors(fallback.stageColors, stageOptions),
      favoriteStages: fallback.favoriteStages.filter((stage) => stageOptions.includes(stage)),
      statusOptions: normalizeOptionList(fallback.statusOptions, CRM_STATUS_OPTIONS, leads.map((lead) => lead.status), true),
      sourceOptions: normalizeOptionList(fallback.sourceOptions, DEFAULT_SOURCE_OPTIONS, leads.map((lead) => lead.source)),
      detailLeadId: leads[0]?.id ?? null,
    };
  }

  if (!value || typeof value !== 'object') return fallback;

  const raw = value as Partial<CrmSnapshot> & Record<string, unknown>;
  const rawLeads = Array.isArray(raw.leads) ? raw.leads : Array.isArray(raw.contacts) ? raw.contacts : Array.isArray(raw.items) ? raw.items : [];
  const leads = deduplicateLeads(rawLeads.map((lead, index) => normalizeLead(lead, index)).filter((lead): lead is CrmLead => Boolean(lead)));
  const detailLeadId = cleanText(raw.detailLeadId, 80);
  const stageOptions = normalizeOptionList(raw.stageOptions, CRM_STAGE_OPTIONS, leads.map((lead) => lead.stage), true);
  const stageColors = normalizeStageColors(raw.stageColors, stageOptions);
  const favoriteStages = Array.isArray(raw.favoriteStages)
    ? raw.favoriteStages
        .map((stage) => cleanText(stage, 80).toLowerCase())
        .filter((stage, index, values): stage is CrmLeadStage => Boolean(stage) && stageOptions.includes(stage) && values.indexOf(stage) === index)
    : fallback.favoriteStages.filter((stage) => stageOptions.includes(stage));
  const statusOptions = normalizeOptionList(raw.statusOptions, CRM_STATUS_OPTIONS, leads.map((lead) => lead.status), true);
  const sourceOptions = normalizeOptionList(raw.sourceOptions, DEFAULT_SOURCE_OPTIONS, leads.map((lead) => lead.source));
  const stageFilter = raw.stageFilter === 'all' || stageOptions.includes(raw.stageFilter as CrmLeadStage)
    ? raw.stageFilter as CrmLeadStage | 'all'
    : fallback.stageFilter;
  const statusFilter = raw.statusFilter === 'all' || statusOptions.includes(raw.statusFilter as CrmLeadStatus)
    ? raw.statusFilter as CrmLeadStatus | 'all'
    : fallback.statusFilter;

  const columns = ensureCustomFieldColumns(normalizeColumns(raw.columns), leads);
  const leadIds = new Set(leads.map((lead) => lead.id));
  const powerDialerLeadIds = Array.isArray(raw.powerDialerLeadIds)
    ? raw.powerDialerLeadIds
        .map((leadId) => cleanText(leadId, 80))
        .filter((leadId, index, values) => leadIds.has(leadId) && values.indexOf(leadId) === index)
    : [];

  return {
    schemaVersion: CRM_STATE_VERSION,
    columns,
    leads,
    powerDialerLeadIds,
    formQuestions: normalizeFormQuestions(raw.formQuestions),
    stageOptions,
    stageColors,
    favoriteStages,
    favoriteStagesUpdatedAt: cleanText(raw.favoriteStagesUpdatedAt, 60) || fallback.favoriteStagesUpdatedAt,
    statusOptions,
    sourceOptions,
    searchQuery: cleanText(raw.searchQuery, 200),
    stageFilter,
    statusFilter,
    sourceFilter: cleanText(raw.sourceFilter, 160) || fallback.sourceFilter,
    batchFilter: cleanText(raw.batchFilter, 160) || fallback.batchFilter,
    viewPreset: CRM_VIEW_PRESETS.includes(raw.viewPreset as CrmViewPreset) ? raw.viewPreset as CrmViewPreset : fallback.viewPreset,
    density: raw.density === 'cozy' ? 'cozy' : fallback.density,
    sortKey: Number(raw.schemaVersion ?? 0) < 5 && raw.sortKey === 'updatedAt'
      ? ''
      : cleanText(raw.sortKey, 80) || fallback.sortKey,
    sortDirection: raw.sortDirection === 'asc' ? 'asc' : fallback.sortDirection,
    detailLeadId: leads.some((lead) => lead.id === detailLeadId) ? detailLeadId : null,
    lastSavedAt: cleanText(raw.lastSavedAt, 40) || fallback.lastSavedAt,
  };
}

function readStoredAuthUser(): StoredAuthUser | null {
  if (typeof window === 'undefined') return null;
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

function localStorageKey(user: StoredAuthUser | null = readStoredAuthUser()): string {
  return user?.id ? `${STORAGE_KEY_PREFIX}_${user.id}` : `${STORAGE_KEY_PREFIX}_anonymous`;
}

function viewStorageKey(user: StoredAuthUser | null = readStoredAuthUser()): string {
  return user?.id ? `${VIEW_STORAGE_KEY_PREFIX}_${user.id}` : `${VIEW_STORAGE_KEY_PREFIX}_anonymous`;
}

type CrmPersonalView = Pick<CrmSnapshot,
  | 'searchQuery'
  | 'stageFilter'
  | 'statusFilter'
  | 'sourceFilter'
  | 'batchFilter'
  | 'viewPreset'
  | 'density'
  | 'sortKey'
  | 'sortDirection'
> & { schemaVersion?: number };

function readLocalView(): CrmPersonalView | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(viewStorageKey());
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CrmPersonalView;
    // Version 12 fixes uploads being hidden by stale shared filters. Reset a
    // pre-fix personal view once, then preserve preferences normally.
    if (Number(parsed.schemaVersion ?? 0) < CRM_STATE_VERSION) return null;
    const normalized = normalizeSnapshot(parsed);
    return {
      searchQuery: normalized.searchQuery,
      stageFilter: normalized.stageFilter,
      statusFilter: normalized.statusFilter,
      sourceFilter: normalized.sourceFilter,
      batchFilter: normalized.batchFilter,
      viewPreset: normalized.viewPreset,
      density: normalized.density,
      sortKey: normalized.sortKey,
      sortDirection: normalized.sortDirection,
    };
  } catch {
    return null;
  }
}

function readLocalSnapshot(): CrmSnapshot | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(localStorageKey());
    if (!raw) return null;
    return normalizeSnapshot(JSON.parse(raw));
  } catch {
    return null;
  }
}

function persistSnapshot(snapshot: CrmSnapshot): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(localStorageKey(), JSON.stringify(snapshot));
    const personalView: CrmPersonalView = {
      schemaVersion: CRM_STATE_VERSION,
      searchQuery: snapshot.searchQuery,
      stageFilter: snapshot.stageFilter,
      statusFilter: snapshot.statusFilter,
      sourceFilter: snapshot.sourceFilter,
      batchFilter: snapshot.batchFilter,
      viewPreset: snapshot.viewPreset,
      density: snapshot.density,
      sortKey: snapshot.sortKey,
      sortDirection: snapshot.sortDirection,
    };
    window.localStorage.setItem(viewStorageKey(), JSON.stringify(personalView));
  } catch {
    // Backend PI state is the durable source; browser cache failures are non-fatal.
  }
}

function loadSnapshot(): CrmSnapshot {
  return readLocalSnapshot() ?? createDefaultSnapshot();
}

function crmMirrorPayload(snapshot: CrmSnapshot): Record<string, unknown> {
  return {
    schemaVersion: CRM_STATE_VERSION,
    columns: snapshot.columns,
    leads: snapshot.leads,
    powerDialerLeadIds: snapshot.powerDialerLeadIds,
    formQuestions: snapshot.formQuestions,
    stageOptions: snapshot.stageOptions,
    stageColors: snapshot.stageColors,
    favoriteStages: snapshot.favoriteStages,
    favoriteStagesUpdatedAt: snapshot.favoriteStagesUpdatedAt,
    statusOptions: snapshot.statusOptions,
    sourceOptions: snapshot.sourceOptions,
    // Search, filters, density, and sorting belong to the individual browser.
    // Mirroring them into shared Team Up state lets one teammate's view hide
    // records for everyone else.
    lastSavedAt: snapshot.lastSavedAt,
  };
}

function mirrorCrmSnapshot(snapshot: CrmSnapshot): void {
  mirrorFeatureState('crm', crmMirrorPayload(snapshot));
}

function touchSnapshot(snapshot: CrmSnapshot): CrmSnapshot {
  return { ...snapshot, schemaVersion: CRM_STATE_VERSION, lastSavedAt: nowIso() };
}

function commitSnapshot(
  set: (partial: Partial<CrmState> | ((state: CrmState) => Partial<CrmState>)) => void,
  snapshotOrUpdater: CrmSnapshot | ((state: CrmState) => CrmSnapshot),
  mirror = true,
  immediate = false
): CrmSnapshot {
  let committed: CrmSnapshot | null = null;
  set((state) => {
    const rawNextSnapshot = typeof snapshotOrUpdater === 'function' ? snapshotOrUpdater(state) : snapshotOrUpdater;
    const nextSnapshot = mirror ? touchSnapshot(rawNextSnapshot) : rawNextSnapshot;
    persistSnapshot(nextSnapshot);
    if (mirror) {
      if (immediate) {
        void syncFeatureState('crm', crmMirrorPayload(nextSnapshot)).catch((error) => {
          if (typeof console !== 'undefined') console.error('[CRM] immediate save failed', error);
        });
      } else {
        mirrorCrmSnapshot(nextSnapshot);
      }
    }
    committed = nextSnapshot;
    return {
      ...nextSnapshot,
      hydrationStatus: state.hydrationStatus === 'idle' ? 'ready' : state.hydrationStatus,
      hydrationError: null,
    };
  });
  return committed ?? createDefaultSnapshot();
}

function ensureColumn(columns: CrmColumn[], label: string): CrmColumn[] {
  const cleanLabel = cleanText(label, 80);
  const slug = slugify(cleanLabel);
  const existing = columns.find((column) => column.key === `custom_${slug}` || normalizeHeader(column.label) === normalizeHeader(cleanLabel));
  if (!cleanLabel || existing) {
    return columns;
  }

  return [
    ...columns,
    {
      key: `custom_${slug || makeId('field')}`,
      label: cleanLabel,
      kind: 'custom',
      visible: true,
    },
  ];
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];

    if (char === '"') {
      if (inQuotes && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === ',' && !inQuotes) {
      cells.push(current.trim());
      current = '';
      continue;
    }

    current += char;
  }

  cells.push(current.trim());
  return cells;
}

export function parseCrmCsv(content: string): CrmCsvParseResult {
  const lines = content
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return { headers: [], rows: [] };
  }

  const [headerLine, ...rowLines] = lines;
  const firstCells = parseCsvLine(headerLine);
  // Some lead vendors export raw rows with no heading line. Treating that
  // first lead as column labels silently dropped it and made the mapping UI
  // look like the remaining data was shifted. Preserve every row when none
  // of the first-line cells resembles a supported CRM heading.
  const hasHeaderRow = firstCells.some((cell) => resolveCoreField(cell) !== null);
  const headers = hasHeaderRow
    ? firstCells.map((header, index) => cleanText(header, 120) || `Column ${index + 1}`)
    : firstCells.map((_, index) => `Column ${index + 1}`);
  return {
    headers,
    rows: (hasHeaderRow ? rowLines : lines).map(parseCsvLine),
  };
}

function resolveCoreField(header: string): CrmImportableField | null {
  const normalized = normalizeHeader(header);
  const aliases: Record<string, CrmImportableField> = {
    lead: 'leadName',
    'lead name': 'leadName',
    'lead type': 'leadName',
    'opportunity name': 'leadName',
    category: 'leadName',
    'lead category': 'leadName',
    campaign: 'leadName',
    product: 'leadName',
    name: 'name',
    'person name': 'name',
    'contact name': 'name',
    'full name': 'name',
    company: 'company',
    organization: 'company',
    email: 'email',
    'email address': 'email',
    phone: 'phone',
    'phone number': 'phone',
    mobile: 'phone',
    address: 'address',
    location: 'address',
    website: 'website',
    owner: 'owner',
    rep: 'owner',
    source: 'source',
    stage: 'stage',
    // Legacy CSVs may still contain Status. Treat it as the single Stage
    // disposition rather than recreating a second concept.
    status: 'stage',
    score: 'score',
    'lead score': 'score',
    opm: 'opm',
    'available credit': 'opm',
    'credit available': 'opm',
    'other people money': 'opm',
    "other people's money": 'opm',
    'sale amount': 'saleAmount',
    'sale value': 'saleAmount',
    'sold amount': 'saleAmount',
    revenue: 'saleAmount',
    'deal value': 'saleAmount',
    'next action': 'nextAction',
    'follow up': 'nextAction',
    'last contact': 'lastContactAt',
    tags: 'tags',
  };

  return aliases[normalized] ?? null;
}

export function getDefaultCrmImportMappings(headers: string[]): CrmImportMapping[] {
  return headers.map((header): CrmImportMapping => {
    const coreField = resolveCoreField(header);
    const target: CrmImportTarget = coreField ?? (`custom:${header}` as CrmImportTarget);
    return { header, target };
  });
}

function normalizeLeadPhone(value: string): string {
  const digits = value.replace(/\D/g, '');
  // Treat US/Canada numbers with and without the leading country code as equal.
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
}

function leadIdentityKeys(lead: Pick<CrmLead, 'email' | 'phone' | 'name' | 'company'>): string[] {
  const keys: string[] = [];
  const email = lead.email.trim().toLowerCase();
  const phone = normalizeLeadPhone(lead.phone);
  if (email) keys.push(`email:${email}`);
  if (phone) keys.push(`phone:${phone}`);

  // Name + company is only a fallback when the row has no stronger identifier.
  // This avoids collapsing two different people who happen to share a name.
  if (keys.length === 0) {
    const nameAndCompany = normalizeHeader(`${lead.name} ${lead.company}`);
    if (nameAndCompany) keys.push(`name:${nameAndCompany}`);
  }
  return keys;
}

function leadFingerprint(lead: Pick<CrmLead, 'email' | 'phone' | 'name' | 'company'>): string {
  return leadIdentityKeys(lead)[0] ?? 'empty:';
}

export function findDuplicateLead(leads: CrmLead[], candidate: Pick<CrmLead, 'email' | 'phone' | 'name' | 'company'>): CrmLead | null {
  const candidateKeys = new Set(leadIdentityKeys(candidate));
  if (candidateKeys.size === 0) return null;
  return leads.find((lead) => leadIdentityKeys(lead).some((key) => candidateKeys.has(key))) ?? null;
}

function createLeadFromInput(input: CreateLeadInput): CrmLead | null {
  const timestamp = nowIso();
  return normalizeLead({
    id: makeId('lead'),
    ...input,
    score: clampScore(input.score),
    opm: normalizeMoney(input.opm),
    saleAmount: normalizeMoney(input.saleAmount),
    website: normalizeWebsite(input.website),
    createdAt: timestamp,
    updatedAt: timestamp,
  }, 0);
}

function deduplicateLeads(leads: CrmLead[]): CrmLead[] {
  const byFingerprint = new Map<string, CrmLead>();
  const order: string[] = [];
  leads.forEach((lead) => {
    const fingerprint = leadFingerprint(lead);
    const current = byFingerprint.get(fingerprint);
    if (!current) {
      byFingerprint.set(fingerprint, lead);
      order.push(fingerprint);
      return;
    }
    const newer = (lead.updatedAt || '') >= (current.updatedAt || '') ? lead : current;
    const older = newer === lead ? current : lead;
    byFingerprint.set(fingerprint, {
      ...older,
      ...newer,
      leadName: newer.leadName || older.leadName,
      company: newer.company || older.company,
      email: newer.email || older.email,
      phone: newer.phone || older.phone,
      address: newer.address || older.address,
      website: newer.website || older.website,
      owner: newer.owner || older.owner,
      nextAction: newer.nextAction || older.nextAction,
      opm: newer.opm || older.opm,
      saleAmount: newer.saleAmount || older.saleAmount,
      lastContactAt: newer.lastContactAt || older.lastContactAt,
      tags: Array.from(new Set([...older.tags, ...newer.tags])),
      customFields: { ...older.customFields, ...newer.customFields },
      notes: Array.from(new Map([...newer.notes, ...older.notes].map((note) => [note.id, note])).values()),
      formAnswers: { ...older.formAnswers, ...newer.formAnswers },
      isNew: older.isNew || newer.isNew,
      createdAt: [older.createdAt, newer.createdAt].filter(Boolean).sort()[0] || newer.createdAt,
    });
  });
  return order.map((fingerprint) => byFingerprint.get(fingerprint)).filter((lead): lead is CrmLead => Boolean(lead));
}

function applyBatchToLead(lead: CrmLead, batchName: string): CrmLead {
  const cleanBatch = cleanText(batchName, 160);
  const tagsWithoutBatch = lead.tags.filter((tag) => !tag.toLowerCase().startsWith('batch:'));
  const customFields = { ...lead.customFields };
  if (cleanBatch) {
    customFields.lead_gen_batch = cleanBatch;
  } else {
    delete customFields.lead_gen_batch;
  }
  return {
    ...lead,
    customFields,
    tags: cleanBatch ? Array.from(new Set([...tagsWithoutBatch, `Batch: ${cleanBatch}`])) : tagsWithoutBatch,
    updatedAt: nowIso(),
  };
}

function applyMappedImport(
  state: CrmSnapshot,
  content: string,
  mappings: CrmImportMapping[],
  batchName = ''
): { snapshot: CrmSnapshot; result: CrmImportResult } {
  const parsed = parseCrmCsv(content);
  if (parsed.headers.length === 0 || parsed.rows.length === 0) {
    return { snapshot: state, result: EMPTY_IMPORT_RESULT };
  }

  let nextColumns = [...state.columns];
  const mappingByHeader = new Map(mappings.map((mapping) => [normalizeHeader(mapping.header), mapping.target]));

  const headerMappings = parsed.headers.map((header, index) => {
    const selectedTarget = mappingByHeader.get(normalizeHeader(header)) ?? '__ignore__';
    if (selectedTarget === '__ignore__') {
      return { index, kind: 'ignore' as const, key: '__ignore__', label: header };
    }

    if (selectedTarget.startsWith('custom:')) {
      const customLabel = selectedTarget.slice('custom:'.length).trim() || header;
      nextColumns = ensureColumn(nextColumns, customLabel);
      const matchingColumn = nextColumns.find((column) => normalizeHeader(column.label) === normalizeHeader(customLabel));
      return {
        index,
        kind: 'custom' as const,
        key: matchingColumn?.key ?? `custom_${slugify(customLabel)}`,
        label: customLabel,
      };
    }

    return { index, kind: 'core' as const, key: selectedTarget, label: header };
  });

  // Seed all known identities so duplicate rows are rejected both against the
  // existing CRM and against earlier rows in this same upload.
  const existingIdentityKeys = new Set(state.leads.flatMap(leadIdentityKeys));
  const importRows = parsed.rows.slice(0, CRM_MAX_IMPORT_ROWS);
  const result: CrmImportResult = {
    importedCount: 0,
    skippedDuplicateCount: 0,
    skippedInvalidCount: 0,
    skippedLimitCount: Math.max(0, parsed.rows.length - CRM_MAX_IMPORT_ROWS),
    totalRows: parsed.rows.length,
  };

  const nextLeads: CrmLead[] = [];
  // One timestamp per file keeps the source file's row ordering stable when
  // the default CRM view sorts the newest import batch first.
  const importTimestamp = nowIso();
  importRows.forEach((row, rowIndex) => {
    if (!row.some((cell) => cell.trim().length > 0)) {
      result.skippedInvalidCount += 1;
      return;
    }

    const rawLead: Record<string, unknown> = {
      id: makeId('lead'),
      source: 'Website',
      stage: 'new',
      status: 'active',
      score: 0,
      opm: 0,
      saleAmount: 0,
      customFields: {},
      notes: [],
      isNew: true,
      createdAt: importTimestamp,
      updatedAt: importTimestamp,
    };

    headerMappings.forEach(({ index, kind, key }) => {
      if (kind === 'ignore') return;
      const cell = row[index]?.trim() ?? '';
      if (!cell) return;
      if (kind === 'custom') {
        const customFields = rawLead.customFields as Record<string, string>;
        customFields[key] = cleanText(cell, 1200);
        return;
      }
      rawLead[key] = cell;
    });

    const normalizedRaw = normalizeLead(rawLead, state.leads.length + rowIndex);
    const normalized = normalizedRaw && batchName ? applyBatchToLead(normalizedRaw, batchName) : normalizedRaw;
    if (!normalized) {
      result.skippedInvalidCount += 1;
      return;
    }

    const identityKeys = leadIdentityKeys(normalized);
    if (identityKeys.some((key) => existingIdentityKeys.has(key))) {
      result.skippedDuplicateCount += 1;
      return;
    }

    identityKeys.forEach((key) => existingIdentityKeys.add(key));
    nextLeads.push(normalized);
    result.importedCount += 1;
  });

  if (nextLeads.length === 0 && nextColumns.length === state.columns.length) {
    return { snapshot: state, result };
  }

  return {
    snapshot: {
      ...state,
      columns: ensureCustomFieldColumns(nextColumns, nextLeads),
      stageOptions: normalizeOptionList(state.stageOptions, CRM_STAGE_OPTIONS, nextLeads.map((lead) => lead.stage), true),
      stageColors: normalizeStageColors(state.stageColors, normalizeOptionList(state.stageOptions, CRM_STAGE_OPTIONS, nextLeads.map((lead) => lead.stage), true)),
      statusOptions: normalizeOptionList(state.statusOptions, CRM_STATUS_OPTIONS, nextLeads.map((lead) => lead.status), true),
      sourceOptions: normalizeOptionList(state.sourceOptions, DEFAULT_SOURCE_OPTIONS, nextLeads.map((lead) => lead.source)),
      leads: [...nextLeads, ...state.leads],
      detailLeadId: nextLeads[0]?.id ?? state.detailLeadId,
    },
    result,
  };
}

function csvEscape(value: unknown): string {
  const text = Array.isArray(value) ? value.join('; ') : String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function buildCrmCsv(leads: CrmLead[], columns: CrmColumn[]): string {
  const exportColumns = columns.filter((column) => column.visible || column.kind === 'custom');
  const headers = exportColumns.map((column) => column.label);
  const rows = leads.map((lead) => exportColumns.map((column) => {
    if (column.key in lead) {
      const value = lead[column.key as keyof CrmLead];
      return csvEscape(value);
    }
    return csvEscape(lead.customFields[column.key] ?? '');
  }));
  return [headers.map(csvEscape).join(','), ...rows.map((row) => row.join(','))].join('\n');
}

const initialSnapshot = loadSnapshot();

export const useCrmStore = create<CrmState>((set, get) => ({
  ...initialSnapshot,
  hydrationStatus: 'idle',
  hydrationError: null,

  hydrate: async () => {
    if (get().hydrationStatus === 'loading') return;
    set({ hydrationStatus: 'loading', hydrationError: null });
    try {
      // Navigating away and back remounts the CRM. Finish any debounced edit
      // before reading the server, otherwise the older remote snapshot can
      // replace a just-entered sale value, stage favorite, note, or field.
      await flushFeatureState('crm');
      const response = await webRequest<PiStateResponse>('pi.state.get', { feature: 'crm' }, { timeoutMs: 12000 });
      const remoteData = response?.data;
      const remoteSnapshot = normalizeSnapshot(remoteData, createDefaultSnapshot());
      const localView = readLocalView();
      // Team state is canonical, including an intentionally empty CRM. Falling
      // back to a populated browser cache here can resurrect leads after an
      // administrator clears the shared workspace.
      const sharedSnapshot = remoteSnapshot;
      // View preferences have their own per-user key. Do not migrate filters
      // from the old full snapshot: older builds copied shared teammate filters
      // there, which is the source of the hidden-leads bug.
      const nextSnapshot = localView
        ? {
            ...sharedSnapshot,
            ...localView,
          }
        : {
            ...sharedSnapshot,
            searchQuery: '',
            stageFilter: 'all',
            statusFilter: 'all',
            sourceFilter: 'all',
            batchFilter: 'all',
            viewPreset: 'all' as CrmViewPreset,
          };
      persistSnapshot(nextSnapshot);
      set({ ...nextSnapshot, hydrationStatus: 'ready', hydrationError: null });
    } catch (error) {
      const fallback = readLocalSnapshot() ?? normalizeSnapshot(get());
      set({
        ...fallback,
        hydrationStatus: 'error',
        hydrationError: error instanceof Error ? error.message : 'Failed to load saved CRM data',
      });
    }
  },

  flushChanges: async () => {
    try {
      const snapshot = normalizeSnapshot(get());
      await syncFeatureState('crm', crmMirrorPayload(snapshot));
      set({ hydrationError: null });
      return true;
    } catch (error) {
      set({ hydrationError: error instanceof Error ? error.message : 'CRM save failed' });
      return false;
    }
  },

  setSearchQuery: (value) => {
    commitSnapshot(set, (state) => ({ ...state, searchQuery: value }), false);
  },

  setStageFilter: (value) => {
    commitSnapshot(set, (state) => ({ ...state, stageFilter: value }), false);
  },

  setStatusFilter: (value) => {
    commitSnapshot(set, (state) => ({ ...state, statusFilter: value }), false);
  },

  setSourceFilter: (value) => {
    commitSnapshot(set, (state) => ({ ...state, sourceFilter: value }), false);
  },

  setBatchFilter: (value) => {
    commitSnapshot(set, (state) => ({ ...state, batchFilter: value }), false);
  },

  setViewPreset: (value) => {
    commitSnapshot(set, (state) => ({ ...state, viewPreset: value }), false);
  },

  setDensity: (value) => {
    commitSnapshot(set, (state) => ({ ...state, density: value }), false);
  },

  setSort: (key) => {
    commitSnapshot(set, (state) => ({
      ...state,
      sortKey: key,
      sortDirection: state.sortKey === key
        ? state.sortDirection === 'asc' ? 'desc' : 'asc'
        : /(?:date|time|createdat|updatedat|lastcontactat)/i.test(key.replace(/[^a-z0-9]/gi, ''))
          ? 'desc'
          : 'asc',
    }));
  },

  toggleColumnVisibility: (key) => {
    commitSnapshot(set, (state) => {
      const nextColumns = state.columns.map((column) =>
        column.key === key ? { ...column, visible: !column.visible } : column
      );
      if (!nextColumns.some((column) => column.visible)) {
        return state;
      }
      return { ...state, columns: nextColumns };
    });
  },

  addCustomColumn: (label) => {
    const cleanLabel = label.trim();
    if (!cleanLabel) return;
    commitSnapshot(set, (state) => ({ ...state, columns: ensureColumn(state.columns, cleanLabel) }));
  },

  addOption: (kind, value) => {
    const cleanValue = kind === 'source' ? cleanText(value, 80) : cleanText(value, 80).toLowerCase();
    if (!cleanValue) return;
    commitSnapshot(set, (state) => {
      const key = kind === 'stage' ? 'stageOptions' : 'sourceOptions';
      if (state[key].some((option) => option.toLowerCase() === cleanValue.toLowerCase())) return state;
      return {
        ...state,
        [key]: [...state[key], cleanValue],
        stageColors: kind === 'stage'
          ? { ...state.stageColors, [cleanValue]: CRM_STAGE_COLOR_PALETTE[state.stageOptions.length % CRM_STAGE_COLOR_PALETTE.length] }
          : state.stageColors,
      };
    });
  },

  removeOption: (kind, value) => {
    commitSnapshot(set, (state) => {
      const key = kind === 'stage' ? 'stageOptions' : 'sourceOptions';
      const remaining = state[key].filter((option) => option !== value);
      if (remaining.length === 0 || remaining.length === state[key].length) return state;
      const fallback = remaining[0];
      const nextStageColors = { ...state.stageColors };
      if (kind === 'stage') delete nextStageColors[value];
      return {
        ...state,
        [key]: remaining,
        stageColors: nextStageColors,
        favoriteStages: kind === 'stage' ? state.favoriteStages.filter((stage) => stage !== value) : state.favoriteStages,
        leads: state.leads.map((lead) => lead[kind] === value ? { ...lead, [kind]: fallback, updatedAt: nowIso() } : lead),
        stageFilter: kind === 'stage' && state.stageFilter === value ? 'all' : state.stageFilter,
        sourceFilter: kind === 'source' && state.sourceFilter === value ? 'all' : state.sourceFilter,
      };
    });
  },

  setStageColor: (stage, color) => {
    const cleanStage = cleanText(stage, 80).toLowerCase();
    const cleanColor = cleanText(color, 20).toLowerCase();
    if (!cleanStage || !/^#[0-9a-f]{6}$/.test(cleanColor)) return;
    commitSnapshot(set, (state) => state.stageOptions.includes(cleanStage)
      ? { ...state, stageColors: { ...state.stageColors, [cleanStage]: cleanColor } }
      : state
    );
  },

  toggleFavoriteStage: (stage) => {
    const cleanStage = cleanText(stage, 80).toLowerCase();
    if (!cleanStage) return;
    commitSnapshot(set, (state) => {
      if (!state.stageOptions.includes(cleanStage)) return state;
      return {
        ...state,
        favoriteStages: state.favoriteStages.includes(cleanStage)
          ? state.favoriteStages.filter((option) => option !== cleanStage)
          : [...state.favoriteStages, cleanStage],
        favoriteStagesUpdatedAt: nowIso(),
      };
    }, true, true);
  },

  addLead: (input) => {
    const nextLead = createLeadFromInput(input);
    if (!nextLead) return null;
    let createdLead: CrmLead | null = null;
    commitSnapshot(set, (state) => {
      if (findDuplicateLead(state.leads, nextLead)) {
        return state;
      }
      createdLead = nextLead;
      return {
        ...state,
        columns: ensureCustomFieldColumns(state.columns, [nextLead]),
        stageOptions: normalizeOptionList(state.stageOptions, CRM_STAGE_OPTIONS, [nextLead.stage], true),
        stageColors: normalizeStageColors(state.stageColors, normalizeOptionList(state.stageOptions, CRM_STAGE_OPTIONS, [nextLead.stage], true)),
        statusOptions: normalizeOptionList(state.statusOptions, CRM_STATUS_OPTIONS, [nextLead.status], true),
        sourceOptions: normalizeOptionList(state.sourceOptions, DEFAULT_SOURCE_OPTIONS, [nextLead.source]),
        leads: [nextLead, ...state.leads],
        detailLeadId: nextLead.id,
      };
    });
    return createdLead;
  },

  updateLead: (leadId, updates) => {
    commitSnapshot(set, (state) => ({
      ...state,
      leads: state.leads.map((lead) =>
        lead.id === leadId
          ? normalizeLead({
              ...lead,
              ...updates,
              score: updates.score !== undefined ? clampScore(updates.score) : lead.score,
              opm: updates.opm !== undefined ? normalizeMoney(updates.opm) : lead.opm,
              saleAmount: updates.saleAmount !== undefined ? normalizeMoney(updates.saleAmount) : lead.saleAmount,
              website: updates.website !== undefined ? normalizeWebsite(updates.website) : lead.website,
              lastContactAt: updates.lastContactAt !== undefined ? normalizeDateValue(updates.lastContactAt) : lead.lastContactAt,
              updatedAt: nowIso(),
            }, 0) ?? lead
          : lead
      ),
    }), true, updates.saleAmount !== undefined || updates.stage !== undefined);
  },

  updateLeadCustomField: (leadId, fieldKey, value) => {
    commitSnapshot(set, (state) => ({
      ...state,
      leads: state.leads.map((lead) =>
        lead.id === leadId
          ? {
              ...lead,
              customFields: { ...lead.customFields, [fieldKey]: cleanText(value, 1200) },
              updatedAt: nowIso(),
            }
          : lead
      ),
    }), false);
  },

  assignBatchToLeads: (leadIds, batchName) => {
    const cleanBatch = cleanText(batchName, 160);
    const targetIds = new Set(leadIds);
    if (!cleanBatch || targetIds.size === 0) return 0;
    let updatedCount = 0;
    commitSnapshot(set, (state) => {
      const nextLeads = state.leads.map((lead) => {
        if (!targetIds.has(lead.id)) return lead;
        updatedCount += 1;
        return applyBatchToLead(lead, cleanBatch);
      });
      return {
        ...state,
        columns: ensureCustomFieldColumns(state.columns, nextLeads),
        leads: nextLeads,
        batchFilter: cleanBatch,
      };
    });
    return updatedCount;
  },

  renameBatch: (fromBatch, toBatch) => {
    const cleanFrom = cleanText(fromBatch, 160);
    const cleanTo = cleanText(toBatch, 160);
    if (!cleanFrom || !cleanTo || cleanFrom === cleanTo) return 0;
    let updatedCount = 0;
    commitSnapshot(set, (state) => {
      const nextLeads = state.leads.map((lead) => {
        if (getLeadBatch(lead) !== cleanFrom) return lead;
        updatedCount += 1;
        return applyBatchToLead(lead, cleanTo);
      });
      return {
        ...state,
        columns: ensureCustomFieldColumns(state.columns, nextLeads),
        leads: nextLeads,
        batchFilter: state.batchFilter === cleanFrom ? cleanTo : state.batchFilter,
      };
    });
    return updatedCount;
  },

  clearBatch: (batchName) => {
    const cleanBatch = cleanText(batchName, 160);
    if (!cleanBatch) return 0;
    let updatedCount = 0;
    commitSnapshot(set, (state) => {
      const nextLeads = state.leads.map((lead) => {
        if (getLeadBatch(lead) !== cleanBatch) return lead;
        updatedCount += 1;
        return applyBatchToLead(lead, '');
      });
      return {
        ...state,
        leads: nextLeads,
        batchFilter: state.batchFilter === cleanBatch ? 'all' : state.batchFilter,
      };
    });
    return updatedCount;
  },

  addLeadNote: (leadId, body) => {
    const cleanBody = cleanText(body, 4000);
    if (!cleanBody) return;
    commitSnapshot(set, (state) => ({
      ...state,
      leads: state.leads.map((lead) =>
        lead.id === leadId
          ? {
              ...lead,
              notes: [{ id: makeId('note'), body: cleanBody, createdAt: nowIso() }, ...lead.notes],
              updatedAt: nowIso(),
            }
          : lead
      ),
    }));
  },

  updateLeadFormAnswer: (leadId, questionId, value) => {
    const cleanQuestionId = cleanText(questionId, 80);
    if (!cleanQuestionId) return;
    commitSnapshot(set, (state) => ({
      ...state,
      leads: state.leads.map((lead) => {
        if (lead.id !== leadId) return lead;
        const formAnswers = { ...lead.formAnswers };
        const cleanValue = cleanText(value, 8000);
        if (cleanValue) formAnswers[cleanQuestionId] = cleanValue;
        else delete formAnswers[cleanQuestionId];
        return { ...lead, formAnswers, updatedAt: nowIso() };
      }),
    }));
  },

  saveLeadFormAnswers: (leadId, answers) => {
    const formAnswers = normalizeFormAnswers(answers);
    commitSnapshot(set, (state) => ({
      ...state,
      leads: state.leads.map((lead) =>
        lead.id === leadId ? { ...lead, formAnswers, updatedAt: nowIso() } : lead
      ),
    }));
  },

  updateFormQuestion: (questionId, prompt) => {
    const cleanPrompt = cleanText(prompt, 2000);
    if (!cleanPrompt) return;
    commitSnapshot(set, (state) => ({
      ...state,
      formQuestions: state.formQuestions.map((question) =>
        question.id === questionId ? { ...question, prompt: cleanPrompt } : question
      ),
    }));
  },

  addFormQuestion: () => {
    commitSnapshot(set, (state) => ({
      ...state,
      formQuestions: [...state.formQuestions, { id: makeId('call_profile'), prompt: 'New question' }],
    }));
  },

  deleteFormQuestion: (questionId) => {
    commitSnapshot(set, (state) => ({
      ...state,
      formQuestions: state.formQuestions.filter((question) => question.id !== questionId),
    }));
  },

  resetFormQuestions: () => {
    commitSnapshot(set, (state) => ({
      ...state,
      formQuestions: DEFAULT_CRM_FORM_QUESTIONS.map((question) => ({ ...question })),
    }));
  },

  deleteLead: async (leadId) => {
    const previous = normalizeSnapshot(get());
    const next = commitSnapshot(set, (state) => ({
      ...state,
      leads: state.leads.filter((lead) => lead.id !== leadId),
      powerDialerLeadIds: state.powerDialerLeadIds.filter((id) => id !== leadId),
      detailLeadId: state.detailLeadId === leadId ? null : state.detailLeadId,
    }));
    if (next.leads.length === previous.leads.length) return false;
    try {
      await webRequest('pi.state.crm.delete', { leadIds: [leadId], deletedAt: nowIso() }, { timeoutMs: 12000 });
      return true;
    } catch (error) {
      persistSnapshot(previous);
      set({ ...previous, hydrationError: error instanceof Error ? error.message : 'Lead deletion could not be saved' });
      return false;
    }
  },

  deleteLeads: async (leadIds) => {
    const ids = new Set(leadIds);
    const previous = normalizeSnapshot(get());
    let deletedCount = 0;
    commitSnapshot(set, (state) => {
      deletedCount = state.leads.filter((lead) => ids.has(lead.id)).length;
      return {
        ...state,
        leads: state.leads.filter((lead) => !ids.has(lead.id)),
        powerDialerLeadIds: state.powerDialerLeadIds.filter((id) => !ids.has(id)),
        detailLeadId: state.detailLeadId && ids.has(state.detailLeadId) ? null : state.detailLeadId,
      };
    });
    if (deletedCount === 0) return 0;
    try {
      await webRequest('pi.state.crm.delete', { leadIds: [...ids], deletedAt: nowIso() }, { timeoutMs: 12000 });
      return deletedCount;
    } catch (error) {
      persistSnapshot(previous);
      set({ ...previous, hydrationError: error instanceof Error ? error.message : 'Lead deletion could not be saved' });
      return 0;
    }
  },

  addLeadToPowerDialer: (leadId) => {
    commitSnapshot(set, (state) => {
      if (state.powerDialerLeadIds.includes(leadId) || !state.leads.some((lead) => lead.id === leadId && lead.phone.trim())) return state;
      return { ...state, powerDialerLeadIds: [...state.powerDialerLeadIds, leadId] };
    });
  },

  removeLeadFromPowerDialer: (leadId) => {
    commitSnapshot(set, (state) => ({
      ...state,
      powerDialerLeadIds: state.powerDialerLeadIds.filter((id) => id !== leadId),
    }));
  },

  clearPowerDialer: () => {
    commitSnapshot(set, (state) => ({ ...state, powerDialerLeadIds: [] }));
  },

  openLead: (leadId) => {
    commitSnapshot(set, (state) => ({ ...state, detailLeadId: leadId }), false);
  },

  closeLead: () => {
    commitSnapshot(set, (state) => ({ ...state, detailLeadId: null }), false);
  },

  importCsv: (content, batchName = '') => {
    const defaultMappings = getDefaultCrmImportMappings(parseCrmCsv(content).headers);
    let result = EMPTY_IMPORT_RESULT;
    commitSnapshot(set, (state) => {
      const imported = applyMappedImport(state, content, defaultMappings, batchName);
      result = imported.result;
      return imported.snapshot;
    }, true, true);
    return result;
  },

  importMappedCsv: (content, mappings, batchName = '') => {
    let result = EMPTY_IMPORT_RESULT;
    commitSnapshot(set, (state) => {
      const imported = applyMappedImport(state, content, mappings, batchName);
      result = imported.result;
      return imported.snapshot;
    }, true, true);
    return result;
  },
}));

export function getCrmSourceOptions(leads: CrmLead[]): string[] {
  const values = new Set([...DEFAULT_SOURCE_OPTIONS, ...leads.map((lead) => lead.source).filter(Boolean)]);
  return Array.from(values);
}

export function getLeadBatch(lead: Pick<CrmLead, 'customFields' | 'tags'>): string {
  const direct = cleanText(lead.customFields.lead_gen_batch, 160);
  if (direct) return direct;
  const tag = lead.tags.find((item) => item.toLowerCase().startsWith('batch:'));
  return tag ? cleanText(tag.replace(/^batch:\s*/i, ''), 160) : '';
}

export function getCrmBatchOptions(leads: CrmLead[]): string[] {
  const values = new Set<string>();
  leads.forEach((lead) => {
    const batch = getLeadBatch(lead);
    if (batch) values.add(batch);
  });
  return Array.from(values).sort((left, right) => left.localeCompare(right));
}

