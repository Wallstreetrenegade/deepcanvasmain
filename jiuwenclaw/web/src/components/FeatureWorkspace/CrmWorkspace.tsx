import { useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { Check, MessageSquare, Phone, Play, Plus, RefreshCw, Send, Square, Trash2 } from 'lucide-react';
import {
  CRM_MAX_IMPORT_BYTES,
  CRM_MAX_IMPORT_ROWS,
  CRM_IMPORTABLE_FIELDS,
  buildCrmCsv,
  findDuplicateLead,
  getCrmBatchOptions,
  getDefaultCrmImportMappings,
  getLeadBatch,
  parseCrmCsv,
  useCrmStore,
  type CreateLeadInput,
  type CrmImportMapping,
  type CrmImportTarget,
  type CrmLead,
  type CrmLeadStage,
  type CrmOptionKind,
} from '../../stores/crmStore';
import {
  POWER_DIALER_RESULT_EVENT,
  requestDial,
  stopPowerDialerSession,
  type PowerDialerResultDetail,
} from '../../services/communications';
import { webRequest } from '../../services/webClient';
import './CrmWorkspace.css';

const EMPTY_LEAD_DRAFT: CreateLeadInput = {
  name: '',
  leadName: '',
  company: '',
  email: '',
  phone: '',
  address: '',
  website: '',
  owner: '',
  source: 'Website',
  stage: 'new',
  score: 50,
  opm: 0,
  saleAmount: 0,
  nextAction: '',
  lastContactAt: '',
  tags: [],
};

const CRM_COLUMN_WIDTHS_STORAGE_KEY = 'deepcanvas.crm.column-widths.v1';
const CRM_DEFAULT_COLUMN_WIDTHS: Record<string, number> = {
  name: 152, leadName: 152, company: 120, email: 184, phone: 136,
  address: 160, stage: 132, owner: 112, source: 108,
  score: 68, nextAction: 176, lastContactAt: 120, updatedAt: 120,
  opm: 112, saleAmount: 112,
};

const getDefaultColumnWidth = (key: string) => CRM_DEFAULT_COLUMN_WIDTHS[key] ?? 144;

function loadSavedColumnWidths(): Record<string, number> {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(CRM_COLUMN_WIDTHS_STORAGE_KEY) || '{}') as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]))
    );
  } catch {
    return {};
  }
}

function getLeadFieldValue(lead: CrmLead, key: string): string | number {
  if (key in lead) {
    const value = lead[key as keyof CrmLead];
    if (Array.isArray(value)) return value.join(', ');
    if (typeof value === 'number') return value;
    if (typeof value === 'string') return value;
  }

  return lead.customFields[key] ?? '';
}

function formatColumnValue(lead: CrmLead, key: string): string {
  const value = getLeadFieldValue(lead, key);
  if ((key === 'saleAmount' || key === 'opm') && typeof value === 'number') return formatCurrency(value);
  if (typeof value === 'number') return String(value);
  if (key === 'updatedAt' && value) return new Date(value).toLocaleDateString();
  return value || '—';
}

function formatDateLabel(value: string): string {
  if (!value) return 'No date';
  return new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: value % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(value || 0);
}

function getColumnClassName(key: string): string {
  return `feature-crm__column feature-crm__column--${key.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

function getOptionClass(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
}

function isDateSortKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return normalized.includes('date') || normalized.includes('time') || [
    'createdat', 'updatedat', 'lastcontactat', 'leadgenscrapedat',
  ].includes(normalized);
}

function parseSortableDate(value: string | number): number | null {
  const text = String(value ?? '').trim();
  if (!text) return null;

  // Excel and Google Sheets may export date/time cells as serial numbers.
  if (/^\d{4,6}(?:\.\d+)?$/.test(text)) {
    const serial = Number(text);
    if (serial >= 20_000 && serial <= 100_000) {
      return Math.round((serial - 25_569) * 86_400_000);
    }
  }

  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function compareLeads(left: CrmLead, right: CrmLead, sortKey: string, direction: 'asc' | 'desc'): number {
  const leftValue = getLeadFieldValue(left, sortKey);
  const rightValue = getLeadFieldValue(right, sortKey);
  const order = direction === 'asc' ? 1 : -1;

  if (isDateSortKey(sortKey)) {
    const leftDate = parseSortableDate(leftValue);
    const rightDate = parseSortableDate(rightValue);
    // Empty or malformed dates remain at the bottom in either direction.
    if (leftDate === null && rightDate !== null) return 1;
    if (leftDate !== null && rightDate === null) return -1;
    if (leftDate !== null && rightDate !== null && leftDate !== rightDate) {
      return (leftDate - rightDate) * order;
    }
  }

  if (typeof leftValue === 'number' && typeof rightValue === 'number') {
    return (leftValue - rightValue) * order;
  }

  return String(leftValue).localeCompare(String(rightValue)) * order;
}

interface CrmWorkspaceProps {
  onExit: () => void;
}

interface EmailConnectionStatus {
  connected: boolean;
  email: string;
  provider: string;
  host?: string;
  port?: number;
  useTls?: boolean;
}

interface EmailConnectionResponse {
  connection?: EmailConnectionStatus;
  message?: string;
}

interface SmsSenderNumber { phoneNumber: string; label: string }
interface SmsStateResponse { connected: boolean; smsAvailable?: boolean; defaultSender?: string; senderNumbers: SmsSenderNumber[] }
interface SmsMessage {
  id: string; direction: 'inbound' | 'outbound'; fromNumber: string; toNumbers: string[];
  text: string; status: string; readStatus?: string; createdAt: string;
}
interface SmsMessagesResponse { phoneNumber: string; messages: SmsMessage[] }

export function CrmWorkspace({ onExit }: CrmWorkspaceProps) {
  const composeForRecipients = (recipients: string[]) => { window.location.href = `mailto:${recipients.join(',')}`; };
  const {
    columns,
    leads,
    powerDialerLeadIds,
    formQuestions,
    stageOptions,
    stageColors,
    favoriteStages,
    sourceOptions,
    searchQuery,
    stageFilter,
    sourceFilter,
    batchFilter,
    density,
    sortKey,
    sortDirection,
    detailLeadId,
    hydrationStatus,
    hydrationError,
    hydrate,
    flushChanges,
    setSearchQuery,
    setStageFilter,
    setSourceFilter,
    setBatchFilter,
    setDensity,
    setSort,
    toggleColumnVisibility,
    addCustomColumn,
    addOption,
    removeOption,
    setStageColor,
    toggleFavoriteStage,
    addLead,
    updateLead,
    updateLeadCustomField,
    assignBatchToLeads,
    renameBatch,
    addLeadNote,
    saveLeadFormAnswers,
    updateFormQuestion,
    addFormQuestion,
    deleteFormQuestion,
    resetFormQuestions,
    deleteLead,
    deleteLeads,
    addLeadToPowerDialer,
    removeLeadFromPowerDialer,
    clearPowerDialer,
    openLead,
    closeLead,
    importMappedCsv,
  } = useCrmStore();

  const [leadDraft, setLeadDraft] = useState<CreateLeadInput>(EMPTY_LEAD_DRAFT);
  const [leadFormError, setLeadFormError] = useState('');
  const [customColumnLabel, setCustomColumnLabel] = useState('');
  const [optionDrafts, setOptionDrafts] = useState<Record<CrmOptionKind, string>>({ stage: '', source: '' });
  const [noteDraft, setNoteDraft] = useState('');
  const [drawerTab, setDrawerTab] = useState<'details' | 'messages' | 'forms'>('details');
  const [smsState, setSmsState] = useState<SmsStateResponse>({ connected: false, senderNumbers: [] });
  const [smsMessages, setSmsMessages] = useState<SmsMessage[]>([]);
  const [smsFromNumber, setSmsFromNumber] = useState('');
  const [smsDraft, setSmsDraft] = useState('');
  const [smsBusy, setSmsBusy] = useState(false);
  const [smsMessage, setSmsMessage] = useState('');
  const [formAnswerDraft, setFormAnswerDraft] = useState<Record<string, string>>({});
  const [formCustomizeOpen, setFormCustomizeOpen] = useState(false);
  const [formSaveMessage, setFormSaveMessage] = useState('');
  const [leadSaveMessage, setLeadSaveMessage] = useState('');
  const [leadSaveBusy, setLeadSaveBusy] = useState(false);
  const [importMessage, setImportMessage] = useState('');
  const [deleteConfirmLeadId, setDeleteConfirmLeadId] = useState<string | null>(null);
  const [csvImportOpen, setCsvImportOpen] = useState(false);
  const [csvImportName, setCsvImportName] = useState('');
  const [csvImportBatchName, setCsvImportBatchName] = useState('');
  const [csvImportContent, setCsvImportContent] = useState('');
  const [csvImportHeaders, setCsvImportHeaders] = useState<string[]>([]);
  const [csvImportRows, setCsvImportRows] = useState<string[][]>([]);
  const [csvImportMappings, setCsvImportMappings] = useState<CrmImportMapping[]>([]);
  const [selectedLeadIds, setSelectedLeadIds] = useState<string[]>([]);
  const [bulkDeleteConfirm, setBulkDeleteConfirm] = useState(false);
  const [batchNameDraft, setBatchNameDraft] = useState('');
  const [batchDeleteConfirm, setBatchDeleteConfirm] = useState('');
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>(loadSavedColumnWidths);
  const [emailConnectOpen, setEmailConnectOpen] = useState(false);
  const [emailConnection, setEmailConnection] = useState<EmailConnectionStatus>({ connected: false, email: '', provider: '' });
  const [emailConnectionDraft, setEmailConnectionDraft] = useState({ provider: 'gmail', email: '', password: '', host: '', port: 587, useTls: true });
  const [emailConnectionBusy, setEmailConnectionBusy] = useState(false);
  const [emailConnectionMessage, setEmailConnectionMessage] = useState('');
  const [workspaceView, setWorkspaceView] = useState<'crm' | 'power-dialer'>('crm');
  const [powerDialerStatus, setPowerDialerStatus] = useState<'idle' | 'running' | 'answered' | 'complete' | 'stopped'>('idle');
  const [powerDialerCurrentLeadId, setPowerDialerCurrentLeadId] = useState('');
  const [powerDialerAttempted, setPowerDialerAttempted] = useState(0);
  const [signatureOpen, setSignatureOpen] = useState(false);
  const [signatureBusy, setSignatureBusy] = useState(false);
  const [signatureMessage, setSignatureMessage] = useState('');
  const [docuSealBuilderToken, setDocuSealBuilderToken] = useState('');
  const [signatureEditorMode, setSignatureEditorMode] = useState<'place' | 'fill'>('place');
  const docuSealBuilderRef = useRef<HTMLDivElement | null>(null);
  const bulkUploadRef = useRef<HTMLInputElement | null>(null);
  const columnResizeRef = useRef<{ key: string; startX: number; startWidth: number } | null>(null);
  const powerDialerSessionRef = useRef('');
  const powerDialerQueueRef = useRef<CrmLead[]>([]);
  const powerDialerIndexRef = useRef(0);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  useEffect(() => {
    void webRequest<EmailConnectionResponse>('email.get_state', {}, { timeoutMs: 12000 })
      .then((response) => {
        if (response?.connection) setEmailConnection(response.connection);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!signatureOpen || !docuSealBuilderToken || !docuSealBuilderRef.current) return;
    let disposed = false;
    const mountBuilder = () => {
      if (disposed || !docuSealBuilderRef.current) return;
      docuSealBuilderRef.current.replaceChildren();
      const builder = document.createElement('docuseal-builder');
      builder.setAttribute('data-token', docuSealBuilderToken);
      builder.setAttribute('data-roles', 'Client');
      builder.setAttribute('data-field-types', 'text,signature,initials,date,number,checkbox,image');
      builder.setAttribute('data-draw-field-type', 'text');
      builder.setAttribute('data-with-upload-button', 'false');
      builder.setAttribute('data-with-add-page-button', 'false');
      builder.setAttribute('data-with-sign-yourself-button', 'false');
      builder.setAttribute('data-with-fields-detection', 'true');
      builder.setAttribute('data-with-field-placeholder', 'true');
      builder.setAttribute('data-autosave', 'true');
      builder.setAttribute('data-input-mode', signatureEditorMode === 'fill' ? 'true' : 'false');
      builder.setAttribute('data-language', 'en');
      builder.addEventListener('send', () => setSignatureMessage('Agreement sent successfully.'));
      docuSealBuilderRef.current.appendChild(builder);
    };
    const existing = document.querySelector<HTMLScriptElement>('script[data-deepcanvas-docuseal-builder]');
    if (existing) mountBuilder();
    else {
      const script = document.createElement('script');
      script.src = 'https://cdn.docuseal.com/js/builder.js';
      script.async = true;
      script.dataset.deepcanvasDocusealBuilder = 'true';
      script.onload = mountBuilder;
      script.onerror = () => setSignatureMessage('The document editor could not load. Please reopen it.');
      document.head.appendChild(script);
    }
    return () => { disposed = true; };
  }, [docuSealBuilderToken, signatureEditorMode, signatureOpen]);

  useEffect(() => {
    window.localStorage.setItem(CRM_COLUMN_WIDTHS_STORAGE_KEY, JSON.stringify(columnWidths));
  }, [columnWidths]);

  const visibleColumns = useMemo(() => columns.filter((column) => column.visible), [columns]);
  const visibleTableWidth = useMemo(
    () => 38 + visibleColumns.reduce((total, column) => total + (columnWidths[column.key] ?? getDefaultColumnWidth(column.key)), 0),
    [columnWidths, visibleColumns]
  );
  const batchOptions = useMemo(() => getCrmBatchOptions(leads), [leads]);
  const customColumns = useMemo(() => columns.filter((column) => column.kind === 'custom'), [columns]);
  const importTargetOptions = useMemo(
    () => [
      { value: '__ignore__' as CrmImportTarget, label: 'Ignore column' },
      ...CRM_IMPORTABLE_FIELDS.map((field) => ({ value: field.key as CrmImportTarget, label: field.label })),
      { value: 'custom:new', label: 'Create custom field from header' },
      ...customColumns.map((column) => ({ value: `custom:${column.label}` as CrmImportTarget, label: `Custom: ${column.label}` })),
    ],
    [customColumns]
  );

  // A removed/renamed source or batch can remain in a user's local view. A
  // controlled <select> then looks like "All" even though the stale value is
  // still filtering every row out. Repair that personal view automatically.
  useEffect(() => {
    if (sourceFilter !== 'all' && !sourceOptions.includes(sourceFilter)) setSourceFilter('all');
    if (batchFilter !== 'all' && !batchOptions.includes(batchFilter)) setBatchFilter('all');
  }, [batchFilter, batchOptions, setBatchFilter, setSourceFilter, sourceFilter, sourceOptions]);

  const handleColumnResizeStart = (event: ReactPointerEvent<HTMLSpanElement>, key: string) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    columnResizeRef.current = {
      key,
      startX: event.clientX,
      startWidth: columnWidths[key] ?? getDefaultColumnWidth(key),
    };
    document.body.classList.add('feature-crm-is-resizing');
  };

  const handleColumnResizeMove = (event: ReactPointerEvent<HTMLSpanElement>) => {
    const resize = columnResizeRef.current;
    if (!resize) return;
    const nextWidth = Math.min(600, Math.max(64, resize.startWidth + event.clientX - resize.startX));
    setColumnWidths((current) => ({ ...current, [resize.key]: nextWidth }));
  };

  const handleColumnResizeEnd = (event: ReactPointerEvent<HTMLSpanElement>) => {
    if (!columnResizeRef.current) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    columnResizeRef.current = null;
    document.body.classList.remove('feature-crm-is-resizing');
  };

  const resetColumnWidth = (event: ReactMouseEvent<HTMLSpanElement>, key: string) => {
    event.preventDefault();
    event.stopPropagation();
    setColumnWidths((current) => ({ ...current, [key]: getDefaultColumnWidth(key) }));
  };

  const filteredLeads = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const activeSourceFilter = sourceFilter === 'all' || sourceOptions.includes(sourceFilter) ? sourceFilter : 'all';
    const activeBatchFilter = batchFilter === 'all' || batchOptions.includes(batchFilter) ? batchFilter : 'all';

    const matchingLeads = [...leads]
      .filter((lead) => (stageFilter === 'all' ? true : lead.stage === stageFilter))
      .filter((lead) => (activeSourceFilter === 'all' ? true : lead.source === activeSourceFilter))
      .filter((lead) => (activeBatchFilter === 'all' ? true : getLeadBatch(lead) === activeBatchFilter))
      .filter((lead) => {
        if (!query) return true;

        return [
          lead.name,
          lead.leadName,
          lead.company,
          lead.email,
          lead.phone,
          lead.address,
          lead.owner,
          lead.source,
          lead.tags.join(' '),
          ...Object.values(lead.customFields),
        ].some((value) => value.toLowerCase().includes(query));
      });
    return matchingLeads.sort((left, right) => {
      if (sortKey) return compareLeads(left, right, sortKey, sortDirection);
      if (left.isNew !== right.isNew) return left.isNew ? -1 : 1;
      // A legacy migration marked every lead as NEW. Use the import timestamp
      // as the secondary default so a newly uploaded batch still appears at
      // the top, while the stable sort preserves row order within that batch.
      const importedComparison = Date.parse(right.createdAt || '') - Date.parse(left.createdAt || '');
      if (Number.isFinite(importedComparison) && importedComparison !== 0) return importedComparison;
      return 0;
    });
  }, [batchFilter, batchOptions, leads, searchQuery, sourceFilter, sourceOptions, sortDirection, sortKey, stageFilter]);

  const selectedLead = leads.find((lead) => lead.id === detailLeadId) ?? null;

  const loadSmsThread = async (quiet = false) => {
    if (!selectedLead?.phone.trim()) {
      setSmsMessages([]);
      setSmsMessage('Add a phone number to this lead before messaging.');
      return;
    }
    if (!quiet) setSmsBusy(true);
    try {
      const state = await webRequest<SmsStateResponse>('communications.ringcentral.sms.state');
      setSmsState(state);
      const sender = smsFromNumber || state.defaultSender || state.senderNumbers[0]?.phoneNumber || '';
      setSmsFromNumber(sender);
      if (!state.connected) {
        setSmsMessages([]);
        setSmsMessage('Connect RingCentral in the Call settings to start messaging.');
        return;
      }
      if (!state.smsAvailable) {
        setSmsMessages([]);
        setSmsMessage('This RingCentral extension does not have an SMS-enabled number.');
        return;
      }
      const thread = await webRequest<SmsMessagesResponse>('communications.ringcentral.sms.messages', { phoneNumber: selectedLead.phone });
      setSmsMessages(thread.messages);
      setSmsMessage('');
    } catch (error) {
      setSmsMessage(error instanceof Error ? error.message : 'Could not load this conversation.');
    } finally {
      if (!quiet) setSmsBusy(false);
    }
  };

  const sendSmsMessage = async () => {
    if (!selectedLead || !smsDraft.trim() || !smsFromNumber) return;
    setSmsBusy(true);
    setSmsMessage('');
    try {
      const sent = await webRequest<SmsMessage>('communications.ringcentral.sms.send', {
        toNumber: selectedLead.phone, fromNumber: smsFromNumber, text: smsDraft.trim(), leadId: selectedLead.id,
      }, { timeoutMs: 30000 });
      setSmsMessages((current) => [...current.filter((item) => item.id !== sent.id), sent]);
      setSmsDraft('');
      window.setTimeout(() => { void loadSmsThread(true); }, 1200);
    } catch (error) {
      setSmsMessage(error instanceof Error ? error.message : 'Message could not be sent.');
    } finally {
      setSmsBusy(false);
    }
  };
  const selectedLeads = useMemo(
    () => filteredLeads.filter((lead) => selectedLeadIds.includes(lead.id)),
    [filteredLeads, selectedLeadIds]
  );
  const powerDialerLeads = useMemo(
    () => powerDialerLeadIds.flatMap((leadId) => {
      const lead = leads.find((candidate) => candidate.id === leadId);
      return lead?.phone.trim() ? [lead] : [];
    }),
    [leads, powerDialerLeadIds]
  );

  const dialPowerLead = (lead: CrmLead, sessionId: string) => {
    setPowerDialerCurrentLeadId(lead.id);
    requestDial({
      phone: lead.phone,
      leadId: lead.id,
      leadName: lead.name,
      lead: {
        id: lead.id,
        name: lead.name,
        leadName: lead.leadName,
        company: lead.company,
        email: lead.email,
        phone: lead.phone,
        stage: lead.stage,
      },
      autoStart: true,
      powerDialerSessionId: sessionId,
    });
  };

  const startPowerDialer = () => {
    if (powerDialerLeads.length === 0) return;
    const sessionId = `power_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    powerDialerSessionRef.current = sessionId;
    powerDialerQueueRef.current = [...powerDialerLeads];
    powerDialerIndexRef.current = 0;
    setPowerDialerAttempted(1);
    setPowerDialerStatus('running');
    dialPowerLead(powerDialerLeads[0], sessionId);
  };

  const stopPowerDialer = () => {
    const sessionId = powerDialerSessionRef.current;
    powerDialerSessionRef.current = '';
    if (sessionId) stopPowerDialerSession(sessionId);
    setPowerDialerStatus('stopped');
  };

  useEffect(() => {
    const handleResult = (event: Event) => {
      const result = (event as CustomEvent<PowerDialerResultDetail>).detail;
      if (!result?.sessionId || result.sessionId !== powerDialerSessionRef.current) return;
      if (result.status === 'answered') {
        powerDialerSessionRef.current = '';
        setPowerDialerStatus('answered');
        return;
      }
      const nextIndex = powerDialerIndexRef.current + 1;
      const nextLead = powerDialerQueueRef.current[nextIndex];
      if (!nextLead) {
        powerDialerSessionRef.current = '';
        setPowerDialerStatus('complete');
        setPowerDialerCurrentLeadId('');
        return;
      }
      powerDialerIndexRef.current = nextIndex;
      setPowerDialerAttempted(nextIndex + 1);
      window.setTimeout(() => {
        if (powerDialerSessionRef.current === result.sessionId) dialPowerLead(nextLead, result.sessionId);
      }, 1500);
    };
    window.addEventListener(POWER_DIALER_RESULT_EVENT, handleResult);
    return () => window.removeEventListener(POWER_DIALER_RESULT_EVENT, handleResult);
  }, []);

  useEffect(() => {
    setDeleteConfirmLeadId(null);
    setDrawerTab('details');
    setFormCustomizeOpen(false);
    setFormSaveMessage('');
    setLeadSaveMessage('');
    setFormAnswerDraft(selectedLead?.formAnswers ?? {});
  }, [selectedLead?.id]);

  useEffect(() => {
    if (drawerTab !== 'messages' || !selectedLead) return;
    void loadSmsThread();
    const timer = window.setInterval(() => { void loadSmsThread(true); }, 15000);
    return () => window.clearInterval(timer);
  }, [drawerTab, selectedLead?.id, selectedLead?.phone]);

  useEffect(() => {
    setSelectedLeadIds((current) => current.filter((leadId) => leads.some((lead) => lead.id === leadId)));
  }, [leads]);

  useEffect(() => {
    setBulkDeleteConfirm(false);
  }, [selectedLeadIds]);

  useEffect(() => {
    setBatchDeleteConfirm('');
    setBatchNameDraft(batchFilter === 'all' ? '' : batchFilter);
  }, [batchFilter]);

  useEffect(() => {
    setLeadDraft((current) => ({
      ...current,
      stage: stageOptions.includes(current.stage ?? '') ? current.stage : stageOptions[0],
      source: sourceOptions.includes(current.source ?? '') ? current.source : sourceOptions[0],
    }));
  }, [sourceOptions, stageOptions]);

  const totalLeads = leads.length;
  const appointmentCount = leads.filter((lead) => ['set appointment', 'close appointment'].includes(lead.stage.toLowerCase())).length;
  const soldLeads = leads.filter((lead) => lead.stage.toLowerCase() === 'won' || lead.saleAmount > 0);
  const soldCount = soldLeads.length;
  const totalRevenue = soldLeads.reduce((sum, lead) => sum + lead.saleAmount, 0);
  const batchSummaries = useMemo(() => batchOptions.map((batch) => {
    const batchLeads = leads.filter((lead) => getLeadBatch(lead) === batch);
    return {
      name: batch,
      count: batchLeads.length,
      hot: batchLeads.filter((lead) => lead.score >= 80 && !['closed', 'won', 'lost'].includes(lead.stage)).length,
      followUp: batchLeads.filter((lead) => lead.stage === 'follow-up').length,
    };
  }), [batchOptions, leads]);

  function updateDraftField<Key extends keyof CreateLeadInput>(key: Key, value: CreateLeadInput[Key]) {
    setLeadDraft((current) => ({ ...current, [key]: value }));
  }

  function handleCreateLead() {
    if (!leadDraft.name?.trim()) {
      setLeadFormError('Name is required.');
      return;
    }

    const duplicate = findDuplicateLead(leads, {
      name: leadDraft.name.trim(),
      company: leadDraft.company?.trim() || '',
      email: leadDraft.email?.trim() || '',
      phone: leadDraft.phone?.trim() || '',
    });
    if (duplicate) {
      setSearchQuery('');
      setStageFilter('all');
      setSourceFilter('all');
      setBatchFilter('all');
      openLead(duplicate.id);
      setLeadFormError(`${duplicate.name} already exists. Filters were cleared and the existing lead was opened.`);
      return;
    }

    const createdLead = addLead({
      ...leadDraft,
      tags: leadDraft.tags,
      score: Number(leadDraft.score ?? 0),
    });
    if (!createdLead) {
      setLeadFormError('A lead with the same email, phone, or name already exists.');
      return;
    }

    setLeadFormError('');
    setImportMessage(`Created lead ${createdLead.name}.`);
    setLeadDraft(EMPTY_LEAD_DRAFT);
  }

  async function handleImportFile(file: File | null) {
    if (!file) return;
    if (file.size > CRM_MAX_IMPORT_BYTES) {
      setImportMessage(`CSV is too large. Upload a file under ${Math.round(CRM_MAX_IMPORT_BYTES / 1024 / 1024)} MB.`);
      return;
    }
    const content = await file.text();
    const parsed = parseCrmCsv(content);

    if (parsed.headers.length === 0 || parsed.rows.length === 0) {
      setImportMessage(`No leads were found in ${file.name}.`);
      return;
    }

    setCsvImportName(file.name);
    setCsvImportBatchName(file.name.replace(/\.[^.]+$/, '') || `CSV import ${new Date().toLocaleDateString()}`);
    setCsvImportContent(content);
    setCsvImportHeaders(parsed.headers);
    setCsvImportRows(parsed.rows.slice(0, 4));
    setCsvImportMappings(getDefaultCrmImportMappings(parsed.headers));
    const headerless = parsed.headers.every((header, index) => header === `Column ${index + 1}`);
    setImportMessage(
      headerless
        ? 'No header row was detected. The first lead is preserved; match each column before importing.'
        : parsed.rows.length > CRM_MAX_IMPORT_ROWS
          ? `Only the first ${CRM_MAX_IMPORT_ROWS} rows will be imported from ${file.name}.`
          : '',
    );
    setCsvImportOpen(true);
  }

  function handleAddCustomColumn() {
    if (!customColumnLabel.trim()) return;
    addCustomColumn(customColumnLabel);
    setCustomColumnLabel('');
  }

  function handleAddNote() {
    if (!selectedLead || !noteDraft.trim()) return;
    addLeadNote(selectedLead.id, noteDraft);
    setNoteDraft('');
  }

  async function handleNewLeadToggle() {
    if (!selectedLead || leadSaveBusy) return;
    const nextIsNew = !selectedLead.isNew;
    setLeadSaveBusy(true);
    setLeadSaveMessage(nextIsNew ? 'Marking lead as new...' : 'Removing new label...');
    updateLead(selectedLead.id, { isNew: nextIsNew });
    try {
      const saved = await flushChanges();
      setLeadSaveMessage(saved
        ? (nextIsNew ? 'Lead marked as new.' : 'New label removed.')
        : 'Could not save the new-lead status. Please try again.');
    } finally {
      setLeadSaveBusy(false);
    }
  }

  function handleAddOption(kind: CrmOptionKind) {
    const value = optionDrafts[kind].trim();
    if (!value) return;
    addOption(kind, value);
    setOptionDrafts((current) => ({ ...current, [kind]: '' }));
  }

  async function handleSaveForm() {
    if (!selectedLead) return false;
    saveLeadFormAnswers(selectedLead.id, formAnswerDraft);
    const saved = await flushChanges();
    setFormSaveMessage(saved
      ? `Saved ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
      : 'Save failed. Your changes remain in this browser; please retry.');
    return saved;
  }

  async function handleConfirmLeadSave() {
    if (!selectedLead || leadSaveBusy) return;
    setLeadSaveBusy(true);
    setLeadSaveMessage('Saving...');
    try {
      const saved = drawerTab === 'forms'
        ? await handleSaveForm()
        : (updateLead(selectedLead.id, {}), await flushChanges());
      setLeadSaveMessage(saved
        ? `Saved ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
        : 'Save failed. Your changes remain in this browser; please retry.');
    } finally {
      setLeadSaveBusy(false);
    }
  }

  function handleImportMappingChange(header: string, target: string) {
    setCsvImportMappings((current) =>
      current.map((mapping) =>
        mapping.header === header
          ? {
              ...mapping,
              target: target === 'custom:new' ? (`custom:${header}` as CrmImportTarget) : (target as CrmImportTarget),
            }
          : mapping
      )
    );
  }

  function handleAssignSelectedBatch() {
    const cleanBatch = batchNameDraft.trim();
    if (!cleanBatch) {
      setImportMessage('Enter a batch name first.');
      return;
    }
    if (selectedLeadIds.length === 0) {
      setImportMessage('Select leads before assigning a batch.');
      return;
    }
    const updated = assignBatchToLeads(selectedLeadIds, cleanBatch);
    setImportMessage(`Assigned ${updated} leads to "${cleanBatch}".`);
  }

  function handleRenameBatch() {
    const cleanBatch = batchNameDraft.trim();
    if (batchFilter === 'all') {
      setImportMessage('Select a batch to rename.');
      return;
    }
    if (!cleanBatch) {
      setImportMessage('Enter the new batch name.');
      return;
    }
    const updated = renameBatch(batchFilter, cleanBatch);
    setImportMessage(`Renamed ${updated} leads from "${batchFilter}" to "${cleanBatch}".`);
  }

  async function handleClearBatch() {
    if (batchFilter === 'all') {
      setImportMessage('Select a batch to remove.');
      return;
    }
    if (batchDeleteConfirm !== batchFilter) {
      setBatchDeleteConfirm(batchFilter);
      const count = leads.filter((lead) => getLeadBatch(lead) === batchFilter).length;
      setImportMessage(`Click Confirm delete to permanently delete all ${count} leads in "${batchFilter}".`);
      return;
    }
    const deletingBatch = batchFilter;
    const leadIds = leads
      .filter((lead) => getLeadBatch(lead) === deletingBatch)
      .map((lead) => lead.id);
    const deleted = await deleteLeads(leadIds);
    setBatchFilter('all');
    setSelectedLeadIds((current) => current.filter((id) => !leadIds.includes(id)));
    setImportMessage(
      deleted === leadIds.length
        ? `Permanently deleted "${deletingBatch}" and all ${deleted} leads in it.`
        : `Batch deletion was not saved. No leads were permanently removed.`,
    );
    setBatchDeleteConfirm('');
  }

  async function handleConfirmImport() {
    const cleanBatchName = csvImportBatchName.trim() || csvImportName.replace(/\.[^.]+$/, '') || `CSV import ${new Date().toLocaleDateString()}`;
    const result = importMappedCsv(csvImportContent, csvImportMappings, cleanBatchName);
    const saved = result.importedCount === 0 || await flushChanges();
    if (result.importedCount > 0) {
      // Never leave a successful upload hidden behind the user's previous
      // search/filter/sort view. Show the imported rows in their file order.
      setSearchQuery('');
      setStageFilter('all');
      setSourceFilter('all');
      setBatchFilter(cleanBatchName);
      setSort('');
    }
    const skippedParts = [
      result.skippedDuplicateCount > 0 ? `${result.skippedDuplicateCount} duplicates skipped` : '',
      result.skippedInvalidCount > 0 ? `${result.skippedInvalidCount} invalid rows skipped` : '',
      result.skippedLimitCount > 0 ? `${result.skippedLimitCount} rows over the import limit skipped` : '',
    ].filter(Boolean);
    setImportMessage(
      result.importedCount > 0 && saved
        ? `Imported ${result.importedCount} leads into "${cleanBatchName}".${skippedParts.length ? ` ${skippedParts.join(', ')}.` : ''}`
        : result.importedCount > 0
          ? `Imported ${result.importedCount} leads locally, but the server save failed. Keep this page open and try again.`
        : `No leads were imported from ${csvImportName}.${skippedParts.length ? ` ${skippedParts.join(', ')}.` : ''}`
    );
    setCsvImportOpen(false);
    setCsvImportName('');
    setCsvImportBatchName('');
    setCsvImportContent('');
    setCsvImportHeaders([]);
    setCsvImportRows([]);
    setCsvImportMappings([]);
  }

  function handleExportCsv() {
    const csv = buildCrmCsv(filteredLeads, columns);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `crm-leads-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    setImportMessage(`Exported ${filteredLeads.length} leads.`);
  }

  async function handleDeleteSelectedLead() {
    if (!selectedLead) return;
    if (deleteConfirmLeadId !== selectedLead.id) {
      setDeleteConfirmLeadId(selectedLead.id);
      return;
    }
    const deleted = await deleteLead(selectedLead.id);
    if (!deleted) {
      setImportMessage(`Could not permanently delete ${selectedLead.name}. The lead was restored; please try again.`);
      return;
    }
    setDeleteConfirmLeadId(null);
    setImportMessage(`Deleted lead ${selectedLead.name}.`);
  }

  async function handleDeleteSelectedLeads() {
    if (selectedLeadIds.length === 0) return;
    if (!bulkDeleteConfirm) {
      setBulkDeleteConfirm(true);
      setImportMessage(`Click Confirm delete to permanently remove ${selectedLeadIds.length} selected lead${selectedLeadIds.length === 1 ? '' : 's'}.`);
      return;
    }
    const deletedCount = await deleteLeads(selectedLeadIds);
    if (deletedCount === 0) {
      setBulkDeleteConfirm(false);
      setImportMessage('The deletion could not be confirmed by the server. No leads were permanently removed.');
      return;
    }
    setSelectedLeadIds([]);
    setBulkDeleteConfirm(false);
    setImportMessage(`Deleted ${deletedCount} lead${deletedCount === 1 ? '' : 's'}.`);
  }

  function handleToggleLeadSelection(leadId: string, checked: boolean) {
    setSelectedLeadIds((current) => checked ? Array.from(new Set([...current, leadId])) : current.filter((id) => id !== leadId));
  }

  function handleSelectAllVisible(checked: boolean) {
    setSelectedLeadIds(checked ? filteredLeads.map((lead) => lead.id) : []);
  }

  function handleComposeLeads(targetLeads: CrmLead[]) {
    const recipients = targetLeads.filter((lead) => lead.email.trim()).map((lead) => lead.email);
    if (!recipients.length) {
      setImportMessage('Selected leads need email addresses first.');
      return;
    }
    composeForRecipients(recipients);
  }

  async function openSignaturePanel() {
    if (!selectedLead) return;
    setSignatureOpen(true);
    setSignatureEditorMode('place');
    setSignatureMessage('');
    setSignatureBusy(true);
    try {
      const response = await webRequest<{ token: string }>('docuseal.builder_token', {
        leadId: selectedLead.id,
        name: selectedLead.name,
        email: selectedLead.email,
      }, { timeoutMs: 12000 });
      if (!response?.token) throw new Error('The document editor could not be prepared.');
      setDocuSealBuilderToken(response.token);
    } catch (error) {
      setSignatureMessage(error instanceof Error ? error.message : 'Could not load agreement signing.');
    } finally {
      setSignatureBusy(false);
    }
  }

  async function handleConnectEmail() {
    setEmailConnectionBusy(true);
    setEmailConnectionMessage('Testing the mailbox connection...');
    try {
      const response = await webRequest<EmailConnectionResponse>(
        'email.connect',
        { connection: emailConnectionDraft },
        { timeoutMs: 90000 }
      );
      if (response?.connection) setEmailConnection(response.connection);
      setEmailConnectionDraft((current) => ({ ...current, password: '' }));
      setEmailConnectionMessage(response?.message || 'Mailbox connected.');
    } catch (error) {
      setEmailConnectionMessage(error instanceof Error ? error.message : 'Could not connect the mailbox.');
    } finally {
      setEmailConnectionBusy(false);
    }
  }

  async function handleDisconnectEmail() {
    setEmailConnectionBusy(true);
    try {
      const response = await webRequest<EmailConnectionResponse>('email.disconnect', {}, { timeoutMs: 12000 });
      setEmailConnection(response?.connection || { connected: false, email: '', provider: '' });
      setEmailConnectionMessage('Mailbox disconnected.');
    } catch (error) {
      setEmailConnectionMessage(error instanceof Error ? error.message : 'Could not disconnect the mailbox.');
    } finally {
      setEmailConnectionBusy(false);
    }
  }

  const statusMessage = hydrationStatus === 'loading'
    ? 'Loading saved CRM data...'
    : hydrationStatus === 'error'
      ? `CRM is using local cache. ${hydrationError ?? ''}`
      : importMessage;

  return (
    <div className={`feature-crm ${workspaceView === 'power-dialer' ? 'is-power-dialer' : ''}`}>
      <section className="feature-crm__table-shell">
        <header className="feature-crm__header">
          <div className="feature-crm__header-actions">
            <button type="button" className="feature-crm__back" onClick={onExit}>
              Back to workspace
            </button>
            <button
              type="button"
              className="feature-crm__bulk-button"
              onClick={() => handleComposeLeads(selectedLeads)}
              disabled={selectedLeads.length === 0}
            >
              Email selected
            </button>
            <button
              type="button"
              className="feature-crm__danger"
              onClick={handleDeleteSelectedLeads}
              disabled={selectedLeadIds.length === 0}
            >
              {bulkDeleteConfirm ? `Confirm delete (${selectedLeadIds.length})` : `Delete selected (${selectedLeadIds.length})`}
            </button>
            <button type="button" className="feature-crm__bulk-button" onClick={() => bulkUploadRef.current?.click()}>
              Bulk leads
            </button>
            <button type="button" className="feature-crm__bulk-button" onClick={handleExportCsv} disabled={filteredLeads.length === 0}>
              Export CSV
            </button>
            <button
              type="button"
              className={`feature-crm__email-connection ${emailConnection.connected ? 'is-connected' : ''}`}
              onClick={() => setEmailConnectOpen(true)}
              title={emailConnection.connected ? `Sending from ${emailConnection.email}` : 'Connect a mailbox for CRM email'}
            >
              <span className="feature-crm__email-dot" />
              {emailConnection.connected ? emailConnection.email : 'Connect email'}
            </button>
            <button
              type="button"
              className={`feature-crm__bulk-button ${workspaceView === 'power-dialer' ? 'is-active' : ''}`}
              onClick={() => {
                if (workspaceView === 'crm') closeLead();
                setWorkspaceView((view) => view === 'crm' ? 'power-dialer' : 'crm');
              }}
            >
              {workspaceView === 'power-dialer' ? 'Back to CRM' : `Power dialer (${powerDialerLeads.length})`}
            </button>
            <input
              ref={bulkUploadRef}
              type="file"
              className="feature-crm__hidden-upload"
              accept=".csv,text/csv"
              aria-label="Bulk lead CSV upload"
              title="Bulk lead CSV upload"
              onChange={(event) => {
                void handleImportFile(event.target.files?.[0] ?? null);
                event.currentTarget.value = '';
              }}
            />
            {statusMessage ? <p className="feature-crm__header-message">{statusMessage}</p> : null}
          </div>
          <div className="feature-crm__stats">
            <div>
              <span>Total</span>
              <strong>{totalLeads}</strong>
            </div>
            <div>
              <span>Appointments</span>
              <strong>{appointmentCount}</strong>
            </div>
            <div>
              <span>Sold</span>
              <strong>{soldCount}</strong>
            </div>
            <div>
              <span>Revenue</span>
              <strong>{formatCurrency(totalRevenue)}</strong>
            </div>
          </div>
        </header>

        <div className="feature-crm__table-wrap">
          {workspaceView === 'power-dialer' ? (
            <section className="feature-crm__power-dialer">
              <header className="feature-crm__power-head">
                <div>
                  <span>Power dialer</span>
                  <h2>Calling queue</h2>
                  <p>Calls one lead at a time. When a person, voicemail, or voice service answers, choose Keep call or Skip to next.</p>
                </div>
                <div className="feature-crm__power-controls">
                  {powerDialerStatus === 'running' ? (
                    <button type="button" className="is-stop" onClick={stopPowerDialer}><Square size={14} /> Stop</button>
                  ) : (
                    <button type="button" className="is-start" onClick={startPowerDialer} disabled={powerDialerLeads.length === 0}><Play size={15} /> Start</button>
                  )}
                  <button type="button" onClick={clearPowerDialer} disabled={powerDialerLeads.length === 0 || powerDialerStatus === 'running'}><Trash2 size={14} /> Clear list</button>
                </div>
              </header>
              <div className={`feature-crm__power-status is-${powerDialerStatus}`}>
                <strong>{powerDialerStatus === 'running' ? `Calling ${powerDialerLeads.find((lead) => lead.id === powerDialerCurrentLeadId)?.name || 'lead'}${powerDialerLeads.find((lead) => lead.id === powerDialerCurrentLeadId)?.leadName ? ` — ${powerDialerLeads.find((lead) => lead.id === powerDialerCurrentLeadId)?.leadName}` : ''} — waiting for your decision` : powerDialerStatus === 'answered' ? 'Call kept — automatic dialing stopped' : powerDialerStatus === 'complete' ? 'Queue complete' : powerDialerStatus === 'stopped' ? 'Queue stopped — current call was not disconnected' : 'Ready to call'}</strong>
                <span>{powerDialerStatus === 'running' ? `${powerDialerAttempted} of ${powerDialerQueueRef.current.length}` : `${powerDialerLeads.length} leads queued`}</span>
              </div>
              <div className="feature-crm__power-list">
                {powerDialerLeads.length > 0 ? (
                  <div className="feature-crm__power-columns" aria-hidden="true">
                    <span>#</span><span>Lead</span><span>Source</span><span>Phone</span><span />
                  </div>
                ) : null}
                {powerDialerLeads.map((lead, index) => (
                  <article key={lead.id} className={lead.id === powerDialerCurrentLeadId ? 'is-current' : ''}>
                    <span className="feature-crm__power-order">{index + 1}</span>
                    <div className="feature-crm__power-lead">
                      <strong>{lead.name}</strong>
                      <small className={lead.leadName ? 'is-lead-name' : ''}>{lead.leadName || lead.company || lead.stage}</small>
                    </div>
                    <span className="feature-crm__power-source" title={lead.source || 'No source'}>{lead.source || 'No source'}</span>
                    <span className="feature-crm__power-phone">{lead.phone}</span>
                    <button type="button" onClick={() => removeLeadFromPowerDialer(lead.id)} disabled={powerDialerStatus === 'running'} aria-label={`Remove ${lead.name} from power dialer`}><Trash2 size={14} /></button>
                  </article>
                ))}
                {powerDialerLeads.length === 0 ? <div className="feature-crm__power-empty"><Phone size={22} /><strong>No leads in the calling queue</strong><span>Add leads from the main CRM list.</span></div> : null}
              </div>
            </section>
          ) : <>
          <table
            className={`feature-crm__table feature-crm__table--${density}`}
            style={{ '--crm-table-width': `${visibleTableWidth}px` } as CSSProperties}
          >
            <colgroup>
              <col className="feature-crm__column feature-crm__column--check" />
              {visibleColumns.map((column) => (
                <col
                  key={column.key}
                  className={getColumnClassName(column.key)}
                  style={{ width: columnWidths[column.key] ?? getDefaultColumnWidth(column.key) }}
                />
              ))}
            </colgroup>
            <thead>
              <tr>
                <th className="feature-crm__check-column">
                  <label className="feature-crm__check-head">
                    <input
                      type="checkbox"
                      checked={filteredLeads.length > 0 && selectedLeadIds.length === filteredLeads.length}
                      onChange={(event) => handleSelectAllVisible(event.target.checked)}
                    />
                  </label>
                </th>
                {visibleColumns.map((column) => (
                  <th key={column.key} className={getColumnClassName(column.key)}>
                    <button type="button" className="feature-crm__sort" onClick={() => setSort(column.key)}>
                      <span>{column.label}</span>
                      <small>{sortKey === column.key ? (sortDirection === 'asc' ? '↑' : '↓') : ''}</small>
                    </button>
                    <span
                      className="feature-crm__column-resizer"
                      role="separator"
                      aria-orientation="vertical"
                      aria-label={`Resize ${column.label} column`}
                      title="Drag to resize. Double-click to reset."
                      onPointerDown={(event) => handleColumnResizeStart(event, column.key)}
                      onPointerMove={handleColumnResizeMove}
                      onPointerUp={handleColumnResizeEnd}
                      onPointerCancel={handleColumnResizeEnd}
                      onDoubleClick={(event) => resetColumnWidth(event, column.key)}
                    />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filteredLeads.map((lead) => (
                <tr key={lead.id} className={lead.id === detailLeadId ? 'is-active' : ''}>
                  <td className="feature-crm__check-column">
                    <label className="feature-crm__check-head">
                      <input
                        type="checkbox"
                        checked={selectedLeadIds.includes(lead.id)}
                        onChange={(event) => handleToggleLeadSelection(lead.id, event.target.checked)}
                      />
                    </label>
                  </td>
                  {visibleColumns.map((column) => (
                    <td key={column.key} className={getColumnClassName(column.key)}>
                      {column.key === 'name' ? (
                        <div className="feature-crm__lead-cell">
                          <button type="button" className="feature-crm__lead-trigger" onClick={() => openLead(lead.id)}>
                            <span className="feature-crm__lead-name">
                              <span>{lead.name}</span>
                              {lead.isNew ? <strong className="feature-crm__new-flag">NEW</strong> : null}
                            </span>
                          </button>
                          <button
                            type="button"
                            className="feature-crm__mail-action"
                            onClick={() => handleComposeLeads([lead])}
                            title="Send email"
                            aria-label={`Send email to ${lead.name}`}
                          >
                            <svg viewBox="0 0 24 24" aria-hidden="true">
                              <path d="M3.75 6.75A2.25 2.25 0 0 1 6 4.5h12A2.25 2.25 0 0 1 20.25 6.75v10.5A2.25 2.25 0 0 1 18 19.5H6a2.25 2.25 0 0 1-2.25-2.25V6.75Z" />
                              <path d="m4.5 7.5 7.5 6 7.5-6" />
                            </svg>
                          </button>
                        </div>
                      ) : column.key === 'phone' ? (
                        <div className="feature-crm__phone-cell">
                          <span className="feature-crm__cell">{formatColumnValue(lead, column.key)}</span>
                          {lead.phone.trim() ? (
                            <><button
                              type="button"
                              className="feature-crm__phone-action"
                              onClick={() => {
                                setDrawerTab('details');
                                openLead(lead.id);
                                requestDial({
                                  phone: lead.phone,
                                  leadId: lead.id,
                                  leadName: lead.name,
                                });
                              }}
                              title={`Call ${lead.name}`}
                              aria-label={`Call ${lead.name}`}
                            >
                              <Phone size={14} />
                            </button>
                            <button
                              type="button"
                              className={`feature-crm__power-add ${powerDialerLeadIds.includes(lead.id) ? 'is-added' : ''}`}
                              onClick={() => powerDialerLeadIds.includes(lead.id) ? removeLeadFromPowerDialer(lead.id) : addLeadToPowerDialer(lead.id)}
                              title={powerDialerLeadIds.includes(lead.id) ? 'Remove from power dialer' : 'Add to power dialer'}
                              aria-label={powerDialerLeadIds.includes(lead.id) ? `Remove ${lead.name} from power dialer` : `Add ${lead.name} to power dialer`}
                            >{powerDialerLeadIds.includes(lead.id) ? <Check size={14} /> : <Plus size={14} />}</button></>
                          ) : null}
                        </div>
                      ) : column.key === 'stage' ? (
                        <select
                          className="feature-crm__stage-select"
                          style={{ '--crm-stage-color': stageColors[lead.stage] } as CSSProperties}
                          value={lead.stage}
                          onChange={(event) => updateLead(lead.id, { stage: event.target.value })}
                          aria-label={`Change stage for ${lead.name}`}
                          title={`Change ${lead.name}'s stage`}
                        >
                          {stageOptions.map((stage) => <option key={stage} value={stage}>{stage}</option>)}
                        </select>
                      ) : (
                        <span className="feature-crm__cell">{formatColumnValue(lead, column.key)}</span>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>

          {filteredLeads.length === 0 ? (
            <div className="feature-crm__empty">
              <h3>{totalLeads === 0 ? 'No leads yet' : 'No leads match this view'}</h3>
              <p>{totalLeads === 0 ? 'Import a CSV or add a verified lead manually.' : 'Adjust the filters on the right, import a CSV, or add a lead manually.'}</p>
            </div>
          ) : null}
          </>}
        </div>
      </section>

      {workspaceView === 'crm' ? <aside className="feature-crm__rail">
        <section className="feature-crm__panel">
          <div className="feature-crm__panel-head">
            <h3>View controls</h3>
            <span>{filteredLeads.length} shown</span>
          </div>
          <label className="feature-crm__field">
            <span>Search</span>
            <input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Name, company, phone, tags" />
          </label>
          <div className="feature-crm__preset-strip">
            <button
              type="button"
              className={stageFilter === 'all' ? 'is-active' : ''}
              onClick={() => setStageFilter('all')}
            >
              All
            </button>
            {favoriteStages.map((stage) => (
              <button
                key={stage}
                type="button"
                className={stageFilter === stage ? 'is-active' : ''}
                onClick={() => setStageFilter(stage)}
                style={{ '--crm-stage-color': stageColors[stage] } as CSSProperties}
              >
                {stage}
              </button>
            ))}
          </div>
          <p className="feature-crm__helper">Star stages below to add your own quick filters here.</p>
          <div className="feature-crm__field-grid">
            <label className="feature-crm__field">
              <span>Stage</span>
              <select value={stageFilter} onChange={(event) => setStageFilter(event.target.value as CrmLeadStage | 'all')}>
                <option value="all">All stages</option>
                {stageOptions.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
            <label className="feature-crm__field">
              <span>Source</span>
              <select value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value)}>
                <option value="all">All sources</option>
                {sourceOptions.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
            <label className="feature-crm__field">
              <span>Batch</span>
              <select value={batchFilter} onChange={(event) => setBatchFilter(event.target.value)}>
                <option value="all">All batches</option>
                {batchOptions.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
            <label className="feature-crm__field">
              <span>Row density</span>
              <select value={density} onChange={(event) => setDensity(event.target.value as 'compact' | 'cozy')}>
                <option value="compact">Compact</option>
                <option value="cozy">Cozy</option>
              </select>
            </label>
          </div>
        </section>

        <section className="feature-crm__panel">
          <div className="feature-crm__panel-head">
            <h3>Pipeline options</h3>
            <span>Customize</span>
          </div>
          {([
            ['stage', 'Stages', stageOptions],
            ['source', 'Sources', sourceOptions],
          ] as Array<[CrmOptionKind, string, string[]]>).map(([kind, label, options]) => (
            <div className="feature-crm__option-manager" key={kind}>
              <strong>{label}</strong>
              <div className="feature-crm__option-list">
                {options.map((option) => (
                  <span className="feature-crm__option-chip" key={option}>
                    {kind === 'stage' ? (
                      <label className="feature-crm__stage-color" style={{ backgroundColor: stageColors[option] || '#0d9488' }} title={`Choose a color for ${option}`}>
                        <input type="color" value={stageColors[option] || '#0d9488'} onChange={(event) => setStageColor(option, event.target.value)} />
                      </label>
                    ) : null}
                    <span>{option}</span>
                    {kind === 'stage' ? (
                      <button
                        type="button"
                        className="feature-crm__favorite-star"
                        onClick={() => toggleFavoriteStage(option)}
                        title={favoriteStages.includes(option) ? `Remove ${option} from favorites` : `Add ${option} to favorites`}
                        aria-label={favoriteStages.includes(option) ? `Remove ${option} from favorites` : `Add ${option} to favorites`}
                        aria-pressed={favoriteStages.includes(option)}
                      >{favoriteStages.includes(option) ? '★' : '☆'}</button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => removeOption(kind, option)}
                      disabled={options.length === 1}
                      title={`Remove ${option}`}
                      aria-label={`Remove ${option} from ${label.toLowerCase()}`}
                    >×</button>
                  </span>
                ))}
              </div>
              <div className="feature-crm__inline-field">
                <input
                  value={optionDrafts[kind]}
                  onChange={(event) => setOptionDrafts((current) => ({ ...current, [kind]: event.target.value }))}
                  onKeyDown={(event) => { if (event.key === 'Enter') handleAddOption(kind); }}
                  placeholder={`Add ${kind}`}
                  aria-label={`Add ${kind}`}
                />
                <button type="button" onClick={() => handleAddOption(kind)} disabled={!optionDrafts[kind].trim()}>Add</button>
              </div>
            </div>
          ))}
          <p className="feature-crm__helper">Removing an option moves affected leads to the first remaining option.</p>
        </section>

        <section className="feature-crm__panel">
          <div className="feature-crm__panel-head">
            <h3>Batches</h3>
            <span>{batchSummaries.length} saved</span>
          </div>
          <label className="feature-crm__field">
            <span>Batch name</span>
            <input
              value={batchNameDraft}
              onChange={(event) => setBatchNameDraft(event.target.value)}
              placeholder="New or selected batch name"
            />
          </label>
          <div className="feature-crm__batch-actions">
            <button type="button" onClick={handleAssignSelectedBatch} disabled={selectedLeadIds.length === 0}>
              Add selected
            </button>
            <button type="button" onClick={handleRenameBatch} disabled={batchFilter === 'all'}>
              Rename
            </button>
            <button type="button" className="is-danger" onClick={handleClearBatch} disabled={batchFilter === 'all'}>
              {batchDeleteConfirm === batchFilter ? 'Confirm delete' : 'Delete batch'}
            </button>
          </div>
          {batchSummaries.length > 0 ? (
            <div className="feature-crm__batch-list">
              {batchSummaries.map((batch) => (
                <button
                  key={batch.name}
                  type="button"
                  className={batchFilter === batch.name ? 'is-active' : ''}
                  onClick={() => setBatchFilter(batch.name)}
                >
                  <strong>{batch.name}</strong>
                  <span>{batch.count} leads</span>
                  <small>{batch.hot} hot / {batch.followUp} follow-up</small>
                </button>
              ))}
            </div>
          ) : (
            <p className="feature-crm__helper">Import a CSV or save leads from Lead Gen to create a named batch.</p>
          )}
          {batchFilter !== 'all' ? (
            <button type="button" className="feature-crm__bulk-button feature-crm__bulk-button--wide" onClick={() => setBatchFilter('all')}>
              Show all batches
            </button>
          ) : null}
        </section>

        <section className="feature-crm__panel">
          <div className="feature-crm__panel-head">
            <h3>Visible columns</h3>
            <span>{visibleColumns.length} active</span>
          </div>
          <div className="feature-crm__column-list">
            {columns.map((column) => (
              <label key={column.key} className="feature-crm__toggle">
                <input type="checkbox" checked={column.visible} onChange={() => toggleColumnVisibility(column.key)} />
                <span>{column.label}</span>
              </label>
            ))}
          </div>
          <div className="feature-crm__inline-field">
            <input
              value={customColumnLabel}
              onChange={(event) => setCustomColumnLabel(event.target.value)}
              placeholder="New custom column"
              title="New custom column"
              aria-label="New custom column"
            />
            <button type="button" onClick={handleAddCustomColumn}>
              Add
            </button>
          </div>
          {customColumns.length > 0 ? (
            <p className="feature-crm__helper">Custom fields stay available in the lead drawer and import automatically from matching CSV headers.</p>
          ) : null}
        </section>

        <section className="feature-crm__panel">
          <div className="feature-crm__panel-head">
            <h3>Add lead</h3>
            <span>Single entry</span>
          </div>
          <div className="feature-crm__field-grid">
            <label className="feature-crm__field">
              <span>Name</span>
              <input value={leadDraft.name ?? ''} onChange={(event) => updateDraftField('name', event.target.value)} placeholder="Person name" />
            </label>
            <label className="feature-crm__field">
              <span>Lead name</span>
              <input value={leadDraft.leadName ?? ''} onChange={(event) => updateDraftField('leadName', event.target.value)} placeholder="Lead type or opportunity" />
            </label>
            <label className="feature-crm__field">
              <span>Company</span>
              <input value={leadDraft.company ?? ''} onChange={(event) => updateDraftField('company', event.target.value)} placeholder="Company" />
            </label>
            <label className="feature-crm__field">
              <span>Email</span>
              <input value={leadDraft.email ?? ''} onChange={(event) => updateDraftField('email', event.target.value)} placeholder="Email" />
            </label>
            <label className="feature-crm__field">
              <span>Phone</span>
              <input value={leadDraft.phone ?? ''} onChange={(event) => updateDraftField('phone', event.target.value)} placeholder="Phone" />
            </label>
            <label className="feature-crm__field feature-crm__field--wide">
              <span>Address</span>
              <input value={leadDraft.address ?? ''} onChange={(event) => updateDraftField('address', event.target.value)} placeholder="Address" />
            </label>
            <label className="feature-crm__field">
              <span>Owner</span>
              <input value={leadDraft.owner ?? ''} onChange={(event) => updateDraftField('owner', event.target.value)} placeholder="Owner" />
            </label>
            <label className="feature-crm__field">
              <span>Source</span>
              <select value={leadDraft.source ?? sourceOptions[0]} onChange={(event) => updateDraftField('source', event.target.value)}>
                {sourceOptions.map((option) => <option key={option} value={option}>{option}</option>)}
              </select>
            </label>
            <label className="feature-crm__field">
              <span>Stage</span>
              <select value={leadDraft.stage} onChange={(event) => updateDraftField('stage', event.target.value as CrmLeadStage)}>
                {stageOptions.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
            <label className="feature-crm__field">
              <span>Score</span>
              <input
                type="number"
                min={0}
                max={100}
                value={leadDraft.score ?? 0}
                onChange={(event) => updateDraftField('score', Number(event.target.value))}
              />
            </label>
            <label className="feature-crm__field feature-crm__field--wide">
              <span>Next action</span>
              <input value={leadDraft.nextAction ?? ''} onChange={(event) => updateDraftField('nextAction', event.target.value)} placeholder="Next step" />
            </label>
          </div>
          <button type="button" className="feature-crm__primary" onClick={handleCreateLead}>
            Create lead
          </button>
          {leadFormError ? <p className="feature-crm__form-error">{leadFormError}</p> : null}
        </section>

      </aside> : null}

      {emailConnectOpen ? (
        <div className="feature-crm__email-overlay" role="dialog" aria-modal="true" aria-label="Connect email mailbox">
          <section className="feature-crm__email-modal">
            <header>
              <div><p className="feature-crm__eyebrow">CRM sender</p><h3>Connect your email</h3></div>
              <button type="button" className="feature-crm__bulk-button" onClick={() => setEmailConnectOpen(false)}>Close</button>
            </header>
            {emailConnection.connected ? (
              <div className="feature-crm__connected-mailbox">
                <span className="feature-crm__email-dot" />
                <div><strong>{emailConnection.email}</strong><small>{emailConnection.provider || 'SMTP'} mailbox connected</small></div>
                <button type="button" className="feature-crm__danger" disabled={emailConnectionBusy} onClick={() => void handleDisconnectEmail()}>Disconnect</button>
              </div>
            ) : (
              <>
                <p className="feature-crm__email-intro">Connect the mailbox CRM should use when you email one lead or a selected group.</p>
                <div className="feature-crm__email-fields">
                  <label className="feature-crm__field"><span>Provider</span><select value={emailConnectionDraft.provider} onChange={(event) => setEmailConnectionDraft((current) => ({ ...current, provider: event.target.value }))}><option value="gmail">Gmail / Google Workspace</option><option value="outlook">Outlook / Microsoft 365</option><option value="yahoo">Yahoo</option><option value="custom">Custom SMTP</option></select></label>
                  <label className="feature-crm__field"><span>Email address</span><input type="email" value={emailConnectionDraft.email} onChange={(event) => setEmailConnectionDraft((current) => ({ ...current, email: event.target.value }))} placeholder="you@company.com" /></label>
                  <label className="feature-crm__field feature-crm__field--wide"><span>App password</span><input type="password" value={emailConnectionDraft.password} onChange={(event) => setEmailConnectionDraft((current) => ({ ...current, password: event.target.value }))} placeholder="Mailbox app password" autoComplete="new-password" /><small>Use an app password from your email provider, not your normal sign-in password.</small></label>
                  {emailConnectionDraft.provider === 'custom' ? <><label className="feature-crm__field"><span>SMTP host</span><input value={emailConnectionDraft.host} onChange={(event) => setEmailConnectionDraft((current) => ({ ...current, host: event.target.value }))} placeholder="smtp.example.com" /></label><label className="feature-crm__field"><span>Port</span><input type="number" value={emailConnectionDraft.port} onChange={(event) => setEmailConnectionDraft((current) => ({ ...current, port: Number(event.target.value) || 587 }))} /></label></> : null}
                </div>
                <button type="button" className="feature-crm__primary feature-crm__primary--auto" disabled={emailConnectionBusy || !emailConnectionDraft.email.trim() || !emailConnectionDraft.password} onClick={() => void handleConnectEmail()}>{emailConnectionBusy ? 'Testing connection...' : 'Connect and test'}</button>
              </>
            )}
            {emailConnectionMessage ? <p className="feature-crm__email-message">{emailConnectionMessage}</p> : null}
          </section>
        </div>
      ) : null}

      {csvImportOpen ? (
        <>
          <button type="button" className="feature-crm__drawer-backdrop" onClick={() => setCsvImportOpen(false)} aria-label="Close bulk import" />
          <aside className="feature-crm__import-modal">
            <div className="feature-crm__drawer-head">
              <div>
                <h3>Map bulk lead columns</h3>
                <p className="feature-crm__helper">Review {csvImportName} and match each uploaded column before import.</p>
              </div>
              <button type="button" className="feature-crm__close" onClick={() => setCsvImportOpen(false)}>
                Close
              </button>
            </div>

            <label className="feature-crm__field feature-crm__field--wide">
              <span>Batch name</span>
              <input
                value={csvImportBatchName}
                onChange={(event) => setCsvImportBatchName(event.target.value)}
                placeholder="Name this import batch"
              />
            </label>
            <label className="feature-crm__field">
              <span>OPM ($)</span>
              <input
                type="number"
                min={0}
                step="1"
                value={leadDraft.opm ?? 0}
                onChange={(event) => updateDraftField('opm', Number(event.target.value))}
                placeholder="9000"
              />
            </label>
            <label className="feature-crm__field">
              <span>Sale value ($)</span>
              <input
                type="number"
                min={0}
                step="0.01"
                value={leadDraft.saleAmount ?? 0}
                onChange={(event) => updateDraftField('saleAmount', Number(event.target.value))}
                placeholder="0.00"
              />
            </label>

            <div className="feature-crm__mapping-list">
              {csvImportHeaders.map((header, index) => (
                <div key={header} className="feature-crm__mapping-row">
                  <div className="feature-crm__mapping-meta">
                    <strong>{header}</strong>
                    <span>{csvImportRows[0]?.[index] || 'No sample value'}</span>
                  </div>
                  <select
                    value={csvImportMappings.find((mapping) => mapping.header === header)?.target ?? '__ignore__'}
                    onChange={(event) => handleImportMappingChange(header, event.target.value)}
                    title={`Import mapping for ${header}`}
                    aria-label={`Import mapping for ${header}`}
                  >
                    {importTargetOptions.map((option) => (
                      <option key={`${header}_${option.value}`} value={option.value}>
                        {option.value === 'custom:new' ? `Custom: ${header}` : option.label}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>

            <div className="feature-crm__import-preview">
              <div className="feature-crm__panel-head">
                <h4>Preview</h4>
                <span>{csvImportRows.length} sample rows</span>
              </div>
              <div className="feature-crm__preview-table-wrap">
                <table className="feature-crm__preview-table">
                  <thead>
                    <tr>
                      {csvImportHeaders.map((header) => (
                        <th key={header}>{header}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {csvImportRows.map((row, rowIndex) => (
                      <tr key={`preview_${rowIndex}`}>
                        {csvImportHeaders.map((header, columnIndex) => (
                          <td key={`${header}_${rowIndex}`}>{row[columnIndex] || '—'}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="feature-crm__import-actions">
              <button type="button" className="feature-crm__close" onClick={() => setCsvImportOpen(false)}>
                Cancel
              </button>
              <button type="button" className="feature-crm__primary feature-crm__primary--auto" onClick={handleConfirmImport}>
                Import leads
              </button>
            </div>
          </aside>
        </>
      ) : null}

      {selectedLead ? (
        <>
          <button type="button" className="feature-crm__drawer-backdrop" onClick={closeLead} aria-label="Close lead details" />
          <aside className="feature-crm__drawer">
            <div className="feature-crm__drawer-scroll">
            <div className="feature-crm__drawer-head">
              <div>
                <p className="feature-crm__eyebrow">Lead detail</p>
                <h3>{selectedLead.name}</h3>
              </div>
              <button type="button" className="feature-crm__close" onClick={closeLead}>
                Close
              </button>
            </div>
            <div className="feature-crm__drawer-actions">
              <button type="button" className="feature-crm__bulk-button" disabled={!selectedLead.phone.trim()} onClick={() => requestDial({ phone: selectedLead.phone, leadId: selectedLead.id, leadName: selectedLead.name, lead: { id: selectedLead.id, name: selectedLead.name, company: selectedLead.company, email: selectedLead.email, phone: selectedLead.phone, stage: selectedLead.stage } })}>
                <Phone size={15} /> Call
              </button>
              <button type="button" className={`feature-crm__bulk-button ${drawerTab === 'messages' ? 'is-active' : ''}`} disabled={!selectedLead.phone.trim()} onClick={() => setDrawerTab('messages')}>
                <MessageSquare size={15} /> Messages
              </button>
              <button type="button" className="feature-crm__bulk-button" onClick={() => handleComposeLeads([selectedLead])}>
                Email lead
              </button>
              <button type="button" className="feature-crm__bulk-button feature-crm__signature-button" onClick={() => void openSignaturePanel()}>
                Send for signature
              </button>
              <button
                type="button"
                className={`feature-crm__bulk-button ${drawerTab === 'forms' ? 'is-active' : ''}`}
                onClick={() => setDrawerTab((current) => current === 'forms' ? 'details' : 'forms')}
              >
                {drawerTab === 'forms' ? 'Lead details' : 'Forms'}
              </button>
              <button type="button" className="feature-crm__danger" onClick={handleDeleteSelectedLead}>
                {deleteConfirmLeadId === selectedLead.id ? 'Confirm delete' : 'Delete lead'}
              </button>
            </div>

            <div className="feature-crm__drawer-meta">
              <span
                className={`feature-crm__badge is-${getOptionClass(selectedLead.stage)}`}
                style={{ '--crm-stage-color': stageColors[selectedLead.stage] } as CSSProperties}
              >{selectedLead.stage}</span>
              <strong>{selectedLead.score}</strong>
              <button
                type="button"
                className={`feature-crm__new-toggle ${selectedLead.isNew ? 'is-on' : ''}`}
                role="switch"
                aria-checked={selectedLead.isNew}
                onClick={() => { void handleNewLeadToggle(); }}
                disabled={leadSaveBusy}
              >
                <span className="feature-crm__new-toggle-copy">
                  <b>New lead</b>
                  <small>{selectedLead.isNew ? 'Label shown' : 'Label hidden'}</small>
                </span>
                <span className="feature-crm__new-toggle-track" aria-hidden="true"><span /></span>
              </button>
            </div>

            {drawerTab === 'details' ? (
              <>
                <section className="feature-crm__drawer-section feature-crm__notes-primary">
                  <div className="feature-crm__panel-head">
                    <h4>Notes</h4>
                    <span>{selectedLead.notes.length}</span>
                  </div>
                  <div className="feature-crm__note-entry">
                    <textarea value={noteDraft} onChange={(event) => setNoteDraft(event.target.value)} placeholder="Add detailed notes about this lead" rows={6} />
                    <button type="button" className="feature-crm__primary feature-crm__primary--auto" onClick={handleAddNote}>
                      Save note
                    </button>
                  </div>
                  <div className="feature-crm__note-list">
                    {selectedLead.notes.map((note) => (
                      <article key={note.id} className="feature-crm__note-card">
                        <p>{note.body}</p>
                        <span>{formatDateLabel(note.createdAt)}</span>
                      </article>
                    ))}
                    {selectedLead.notes.length === 0 ? <p className="feature-crm__helper">No notes yet.</p> : null}
                  </div>
                </section>

            <div className="feature-crm__detail-grid">
              <label className="feature-crm__field">
                <span>Name</span>
                <input value={selectedLead.name} onChange={(event) => updateLead(selectedLead.id, { name: event.target.value })} />
              </label>
              <label className="feature-crm__field">
                <span>Lead name</span>
                <input value={selectedLead.leadName} onChange={(event) => updateLead(selectedLead.id, { leadName: event.target.value })} />
              </label>
              <label className="feature-crm__field">
                <span>Company</span>
                <input value={selectedLead.company} onChange={(event) => updateLead(selectedLead.id, { company: event.target.value })} />
              </label>
              <label className="feature-crm__field">
                <span>Email</span>
                <input value={selectedLead.email} onChange={(event) => updateLead(selectedLead.id, { email: event.target.value })} />
              </label>
              <label className="feature-crm__field">
                <span>Phone</span>
                <input value={selectedLead.phone} onChange={(event) => updateLead(selectedLead.id, { phone: event.target.value })} />
              </label>
              <label className="feature-crm__field feature-crm__field--wide">
                <span>Address</span>
                <input value={selectedLead.address} onChange={(event) => updateLead(selectedLead.id, { address: event.target.value })} />
              </label>
              <label className="feature-crm__field">
                <span>Website</span>
                <input value={selectedLead.website} onChange={(event) => updateLead(selectedLead.id, { website: event.target.value })} />
              </label>
              <label className="feature-crm__field">
                <span>Owner</span>
                <input value={selectedLead.owner} onChange={(event) => updateLead(selectedLead.id, { owner: event.target.value })} />
              </label>
              <label className="feature-crm__field">
                <span>Source</span>
                <select value={selectedLead.source} onChange={(event) => updateLead(selectedLead.id, { source: event.target.value })}>
                  {sourceOptions.map((option) => <option key={option} value={option}>{option}</option>)}
                </select>
              </label>
              <label className="feature-crm__field">
                <span>Stage</span>
                <select value={selectedLead.stage} onChange={(event) => updateLead(selectedLead.id, { stage: event.target.value as CrmLeadStage })}>
                  {stageOptions.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>
              <label className="feature-crm__field">
                <span>Score</span>
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={selectedLead.score}
                  onChange={(event) => updateLead(selectedLead.id, { score: Number(event.target.value) })}
                />
              </label>
              <label className="feature-crm__field">
                <span>Sale value ($)</span>
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={selectedLead.saleAmount}
                  onChange={(event) => updateLead(selectedLead.id, { saleAmount: Number(event.target.value) })}
                  onBlur={() => { void flushChanges(); }}
                  placeholder="0.00"
                />
              </label>
              <label className="feature-crm__field">
                <span>OPM — available credit ($)</span>
                <input
                  type="number"
                  min={0}
                  step="1"
                  value={selectedLead.opm}
                  onChange={(event) => updateLead(selectedLead.id, { opm: Number(event.target.value) })}
                  onBlur={() => { void flushChanges(); }}
                  placeholder="9000"
                />
              </label>
              <label className="feature-crm__field">
                <span>Last contact</span>
                <input
                  type="date"
                  value={selectedLead.lastContactAt}
                  onChange={(event) => updateLead(selectedLead.id, { lastContactAt: event.target.value })}
                />
              </label>
              <label className="feature-crm__field feature-crm__field--wide">
                <span>Next action</span>
                <input value={selectedLead.nextAction} onChange={(event) => updateLead(selectedLead.id, { nextAction: event.target.value })} />
              </label>
              <label className="feature-crm__field feature-crm__field--wide">
                <span>Tags</span>
                <input
                  value={selectedLead.tags.join(', ')}
                  onChange={(event) =>
                    updateLead(selectedLead.id, {
                      tags: event.target.value.split(',').map((tag) => tag.trim()).filter(Boolean),
                    })
                  }
                />
              </label>
            </div>

            {customColumns.length > 0 ? (
              <section className="feature-crm__drawer-section">
                <div className="feature-crm__panel-head">
                  <h4>Custom fields</h4>
                  <span>{customColumns.length}</span>
                </div>
                <div className="feature-crm__detail-grid">
                  {customColumns.map((column) => (
                    <label key={column.key} className="feature-crm__field">
                      <span>{column.label}</span>
                      <input
                        value={selectedLead.customFields[column.key] ?? ''}
                        onChange={(event) => updateLeadCustomField(selectedLead.id, column.key, event.target.value)}
                      />
                    </label>
                  ))}
                </div>
              </section>
            ) : null}
              </>
            ) : drawerTab === 'messages' ? (
              <section className="feature-crm__sms-workspace">
                <header className="feature-crm__sms-head">
                  <div>
                    <p className="feature-crm__eyebrow">RingCentral SMS</p>
                    <h4>{selectedLead.name}</h4>
                    <span>{selectedLead.phone}</span>
                  </div>
                  <button type="button" className="feature-crm__bulk-button" disabled={smsBusy} onClick={() => void loadSmsThread()}>
                    <RefreshCw size={15} className={smsBusy ? 'is-spinning' : ''} /> Refresh
                  </button>
                </header>
                <div className="feature-crm__sms-line">
                  <label><span>Send from</span>
                    <select value={smsFromNumber} onChange={(event) => setSmsFromNumber(event.target.value)} disabled={!smsState.smsAvailable}>
                      {smsState.senderNumbers.map((number) => <option key={number.phoneNumber} value={number.phoneNumber}>{number.label} · {number.phoneNumber}</option>)}
                    </select>
                  </label>
                  <span className={`feature-crm__sms-status ${smsState.connected && smsState.smsAvailable ? 'is-connected' : ''}`}>
                    {smsState.connected && smsState.smsAvailable ? 'SMS ready' : 'Setup needed'}
                  </span>
                </div>
                {smsMessage ? <div className="feature-crm__sms-notice">{smsMessage}</div> : null}
                <div className="feature-crm__sms-thread" aria-live="polite">
                  {smsBusy && smsMessages.length === 0 ? <p className="feature-crm__sms-empty">Loading conversation...</p> : null}
                  {!smsBusy && smsMessages.length === 0 && !smsMessage ? <p className="feature-crm__sms-empty">No messages with this lead yet. Start the conversation below.</p> : null}
                  {smsMessages.map((message) => (
                    <article key={message.id || `${message.createdAt}-${message.text}`} className={`feature-crm__sms-bubble is-${message.direction}`}>
                      <p>{message.text || 'Media message'}</p>
                      <footer><time>{message.createdAt ? new Date(message.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Sending now'}</time><span>{message.direction === 'outbound' ? message.status : 'Received'}</span></footer>
                    </article>
                  ))}
                </div>
                <div className="feature-crm__sms-compose">
                  <textarea value={smsDraft} onChange={(event) => setSmsDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendSmsMessage(); } }} placeholder={`Message ${selectedLead.name}`} rows={4} disabled={!smsState.smsAvailable || smsBusy} />
                  <div><span>{smsDraft.length} characters · Enter to send, Shift+Enter for a new line</span><button type="button" className="feature-crm__primary feature-crm__primary--auto" disabled={!smsDraft.trim() || !smsFromNumber || smsBusy} onClick={() => void sendSmsMessage()}><Send size={15} /> {smsBusy ? 'Sending...' : 'Send'}</button></div>
                </div>
              </section>
            ) : (
              <section className="feature-crm__form-workspace">
                <div className="feature-crm__form-toolbar">
                  <div>
                    <p className="feature-crm__eyebrow">Saved lead form</p>
                    <h4>Call Qualification Profile</h4>
                    <span>{formQuestions.length} questions · {Object.keys(formAnswerDraft).filter((key) => formAnswerDraft[key]?.trim()).length} answered</span>
                  </div>
                  <div className="feature-crm__form-toolbar-actions">
                    <button type="button" className="feature-crm__bulk-button" onClick={() => setFormCustomizeOpen((current) => !current)}>
                      {formCustomizeOpen ? 'Done editing' : 'Customize form'}
                    </button>
                    <button type="button" className="feature-crm__primary feature-crm__primary--auto" onClick={handleSaveForm}>
                      Save form
                    </button>
                  </div>
                </div>
                {formSaveMessage ? <p className="feature-crm__form-saved">{formSaveMessage}</p> : null}

                {formCustomizeOpen ? (
                  <div className="feature-crm__form-editor">
                    <div className="feature-crm__form-editor-head">
                      <p>Edit prompts below. Changes apply to this CRM form for all leads; saved answers remain attached to each lead.</p>
                      <div>
                        <button type="button" className="feature-crm__bulk-button" onClick={addFormQuestion}>Add question</button>
                        <button type="button" className="feature-crm__danger" onClick={resetFormQuestions}>Reset script</button>
                      </div>
                    </div>
                    {formQuestions.map((question, index) => (
                      <div key={question.id} className="feature-crm__form-edit-row">
                        <strong>{index + 1}</strong>
                        <textarea
                          defaultValue={question.prompt}
                          onBlur={(event) => updateFormQuestion(question.id, event.target.value)}
                          rows={2}
                        />
                        <button type="button" className="feature-crm__danger" onClick={() => deleteFormQuestion(question.id)}>Remove</button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="feature-crm__question-list">
                    {formQuestions.map((question, index) => (
                      <label key={question.id} className="feature-crm__question-card">
                        <span className="feature-crm__question-number">{index + 1}</span>
                        <span className="feature-crm__question-prompt">{question.prompt.split('(name)').join(selectedLead.name || 'the lead')}</span>
                        <textarea
                          value={formAnswerDraft[question.id] ?? ''}
                          onChange={(event) => {
                            setFormAnswerDraft((current) => ({ ...current, [question.id]: event.target.value }));
                            setFormSaveMessage('Unsaved changes');
                          }}
                          placeholder="Type the answer or call notes here"
                          rows={3}
                        />
                      </label>
                    ))}
                  </div>
                )}

                {!formCustomizeOpen ? (
                  <div className="feature-crm__form-save-footer">
                    <span>{formSaveMessage || 'Answers are saved only when you click Save form.'}</span>
                    <button type="button" className="feature-crm__primary feature-crm__primary--auto" disabled={leadSaveBusy} onClick={() => void handleSaveForm()}>Save form</button>
                  </div>
                ) : null}
              </section>
            )}
            </div>
            <footer className="feature-crm__drawer-footer">
              <span>{leadSaveMessage || (drawerTab === 'forms' ? 'Save form answers before closing.' : drawerTab === 'messages' ? 'Messages sync from your RingCentral account.' : 'Review the lead, then confirm your changes.')}</span>
              <div>
                <button type="button" className="feature-crm__bulk-button" onClick={closeLead}>Close</button>
                <button type="button" className="feature-crm__primary feature-crm__primary--auto" disabled={leadSaveBusy} onClick={() => void handleConfirmLeadSave()}>
                  {leadSaveBusy ? 'Saving...' : drawerTab === 'forms' ? 'Save form' : 'Save lead'}
                </button>
              </div>
            </footer>
          </aside>
          {signatureOpen ? (
            <div className="feature-crm__signature-layer" role="dialog" aria-modal="true" aria-label="Send agreement for signature">
              <button type="button" className="feature-crm__signature-backdrop" onClick={() => setSignatureOpen(false)} aria-label="Close signing panel" />
              <section className="feature-crm__signature-modal">
                <header className="feature-crm__signature-head">
                  <div><p className="feature-crm__eyebrow">Secure e-signature</p><h3>Send agreement to {selectedLead.name}</h3><span>{selectedLead.email || 'Add an email address to this lead first'}</span></div>
                  <div className="feature-crm__signature-head-actions">
                    <div className="feature-crm__signature-modes" role="group" aria-label="Agreement editing mode">
                      <button type="button" className={signatureEditorMode === 'place' ? 'is-active' : ''} onClick={() => setSignatureEditorMode('place')}>Place fields</button>
                      <button type="button" className={signatureEditorMode === 'fill' ? 'is-active' : ''} onClick={() => setSignatureEditorMode('fill')}>Fill agreement</button>
                    </div>
                    <button type="button" className="feature-crm__close" onClick={() => setSignatureOpen(false)}>Close</button>
                  </div>
                </header>

                <div className="feature-crm__signature-body">
                  {signatureBusy ? <div className="feature-crm__signature-loading">Opening document editor...</div> : null}
                  {signatureMessage ? <div className="feature-crm__signature-notice">{signatureMessage}</div> : null}
                  <div className="feature-crm__signature-mode-help">
                    {signatureEditorMode === 'place'
                      ? 'Place package fields on the service lines and position signature fields, then choose Fill agreement.'
                      : 'Click a placed field and type the client package, pricing, dates, or terms directly into the agreement before sending.'}
                  </div>
                  <div ref={docuSealBuilderRef} className="feature-crm__docuseal-builder" />
                </div>
              </section>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

