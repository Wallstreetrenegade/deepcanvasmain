export interface DialLeadSummary {
  id?: string;
  name?: string;
  leadName?: string;
  company?: string;
  email?: string;
  phone?: string;
  address?: string;
  website?: string;
  owner?: string;
  source?: string;
  stage?: string;
  score?: number;
  nextAction?: string;
  tags?: string[];
  notes?: string[];
}

export interface DialRequestDetail {
  phone: string;
  leadId?: string;
  leadName?: string;
  lead?: DialLeadSummary;
  autoStart?: boolean;
  powerDialerSessionId?: string;
}

export interface PowerDialerResultDetail {
  sessionId: string;
  leadId?: string;
  status: 'answered' | 'no-answer' | 'failed';
}

export const DIAL_REQUEST_EVENT = 'deepcanvas:dial';
export const POWER_DIALER_RESULT_EVENT = 'deepcanvas:power-dialer-result';
export const POWER_DIALER_STOP_EVENT = 'deepcanvas:power-dialer-stop';

export function requestDial(detail: DialRequestDetail): void {
  window.dispatchEvent(new CustomEvent<DialRequestDetail>(DIAL_REQUEST_EVENT, { detail }));
}

export function reportPowerDialerResult(detail: PowerDialerResultDetail): void {
  window.dispatchEvent(new CustomEvent<PowerDialerResultDetail>(POWER_DIALER_RESULT_EVENT, { detail }));
}

export function stopPowerDialerSession(sessionId: string): void {
  window.dispatchEvent(new CustomEvent(POWER_DIALER_STOP_EVENT, { detail: { sessionId } }));
}

