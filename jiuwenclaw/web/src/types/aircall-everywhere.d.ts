declare module "aircall-everywhere" {
  export type AircallEventPayload = { call_id?: number; duration?: number; answer_status?: string };
  export default class AircallWorkspace {
    constructor(options: { onLogin: () => void; onLogout: () => void; domToLoadWorkspace: string; size?: "big" | "small" | "auto"; debug?: boolean });
    on(event: string, listener: (payload: AircallEventPayload) => void): void;
    send(event: string, payload: Record<string, unknown>, callback: (success: boolean, data: unknown) => void): void;
    isLoggedIn(callback: (loggedIn: boolean) => void): void;
  }
}

