import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  ArrowRightLeft,
  Check,
  Delete,
  Headphones,
  Mic,
  MicOff,
  Pause,
  Play,
  Phone,
  PhoneCall,
  PhoneOff,
  X,
} from "lucide-react";
import {
  SignalWire,
  StaticCredentialProvider,
  type Call,
  type CallStatus,
} from "@signalwire/js";
import WebPhone from "ringcentral-web-phone";
import AircallWorkspace, { type AircallEventPayload } from "aircall-everywhere";
import { webRequest } from "../../services/webClient";
import {
  DIAL_REQUEST_EVENT,
  POWER_DIALER_STOP_EVENT,
  reportPowerDialerResult,
  type DialLeadSummary,
  type DialRequestDetail,
} from "../../services/communications";
import "./style.css";

interface CallRecord {
  id: string;
  toNumber: string;
  leadName?: string | null;
  status: string;
  disposition?: string | null;
  startedAt: number;
  durationSeconds: number;
}
interface CommunicationsState {
  enabled: boolean;
  callerId: string;
  allowedRegion: string;
  calls: CallRecord[];
  ringcentralConfigured: boolean;
  ringcentral: {
    connected: boolean;
    extensionId?: string;
    displayName?: string;
    phoneNumber?: string;
  };
  aircall: {
    connected: boolean;
    userId?: string;
    userName?: string;
    numberId?: string;
    numberName?: string;
    phoneNumber?: string;
  };
}
interface BrowserToken {
  token: string;
}
interface StartedCall {
  callId: string;
  toNumber: string;
  callerId: string;
  provider?: string;
  mode?: "browser" | "ringcentral-browser" | "aircall-browser";
}
type PhoneProvider = "aircall" | "ringcentral" | "signalwire";
interface RingCentralCredentials {
  sipInfo: ConstructorParameters<typeof WebPhone>[0]["sipInfo"];
  callerId: string;
}
interface RingCentralCallerId {
  phoneNumber: string;
  label: string;
  usageType: string;
}
interface RingCentralSession {
  callId: string;
  state: string;
  on(event: string, listener: (detail?: string) => void): void;
  hangup(): Promise<void>;
  mute(): void;
  unmute(): void;
  sendDtmf(value: string): void;
  transfer(target: string): Promise<void>;
  hold(): Promise<void>;
  unhold(): Promise<void>;
  changeInputDevice(id: string): Promise<void>;
  changeOutputDevice(id: string): Promise<void>;
}
interface Teammate {
  id: string;
  email: string;
  displayName: string;
  destination: string;
  ringCentralDestination: string;
  callPresence: {
    status: "available" | "ringing" | "on-call";
    callId?: string | null;
  };
}
const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"];
const TERMINAL: CallStatus[] = ["disconnected", "failed", "destroyed"];
const normalizePhone = (value: string) => {
  const clean = value.trim().replace(/[^\d+]/g, "");
  if (clean.startsWith("+")) return clean;
  if (clean.length === 10) return `+1${clean}`;
  if (clean.length === 11 && clean.startsWith("1")) return `+${clean}`;
  return clean;
};
const formatPhone = (value: string) => {
  const digits = value.replace(/\D/g, "");
  const number =
    digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  return number.length === 10
    ? `(${number.slice(0, 3)}) ${number.slice(3, 6)}-${number.slice(6)}`
    : value;
};
const formatDuration = (seconds: number) =>
  `${Math.floor(Math.max(0, seconds) / 60)}:${String(Math.max(0, seconds) % 60).padStart(2, "0")}`;

const providerCanCall = (
  provider: PhoneProvider,
  state: CommunicationsState | null,
) => {
  if (!state) return false;
  if (provider === "ringcentral") return state.ringcentral.connected;
  if (provider === "aircall") return state.aircall.connected;
  return state.enabled;
};

export function Dialer({ disabled = false }: { disabled?: boolean }) {
  const [open, setOpen] = useState(false),
    [number, setNumber] = useState(""),
    [status, setStatus] = useState("Ready"),
    [error, setError] = useState("");
  const [state, setState] = useState<CommunicationsState | null>(null),
    [lead, setLead] = useState<DialLeadSummary>({});
  const [busy, setBusy] = useState(false),
    [muted, setMuted] = useState(false),
    [held, setHeld] = useState(false),
    [elapsed, setElapsed] = useState(0);
  const [recordId, setRecordId] = useState(""),
    [showDisposition, setShowDisposition] = useState(false),
    [disposition, setDisposition] = useState("answered"),
    [notes, setNotes] = useState("");
  const [teammates, setTeammates] = useState<Teammate[]>([]),
    [transferOpen, setTransferOpen] = useState(false),
    [transferring, setTransferring] = useState("");
  const [incomingCall, setIncomingCall] = useState<Call | null>(null),
    [audioInputs, setAudioInputs] = useState<MediaDeviceInfo[]>([]),
    [audioOutputs, setAudioOutputs] = useState<MediaDeviceInfo[]>([]);
  const [inputId, setInputId] = useState(
      localStorage.getItem("dc-call-input") || "",
    ),
    [outputId, setOutputId] = useState(
      localStorage.getItem("dc-call-output") || "",
    ),
    [audioSettingsOpen, setAudioSettingsOpen] = useState(false);
  const [ringCentralCallerIds, setRingCentralCallerIds] = useState<
    RingCentralCallerId[]
  >([]);
  // RingCentral identity is account-bound. Do not persist this in a shared
  // browser key because a second Deep Canvas user may use this same browser.
  const [ringCentralCallerId, setRingCentralCallerId] = useState("");
  const [phoneProvider, setPhoneProvider] = useState<PhoneProvider>(() =>
    (localStorage.getItem("dc-phone-provider") as PhoneProvider) || "aircall",
  );
  const [aircallConnectOpen, setAircallConnectOpen] = useState(false);
  const [aircallCredentials, setAircallCredentials] = useState({ apiId: "", apiToken: "" });
  const [aircallPhoneLoggedIn, setAircallPhoneLoggedIn] = useState(false);
  const [aircallPhoneAuthOpen, setAircallPhoneAuthOpen] = useState(false);
  const [aircallCallActive, setAircallCallActive] = useState(false);
  const [autoStartRequest, setAutoStartRequest] = useState(0);
  const [panelPosition, setPanelPosition] = useState(() => ({
    x: Math.max(12, window.innerWidth - 368),
    y: 68,
  }));
  const clientRef = useRef<SignalWire | null>(null),
    callRef = useRef<Call | null>(null),
    ringCentralPhoneRef = useRef<WebPhone | null>(null),
    ringCentralCallRef = useRef<RingCentralSession | null>(null),
    recordIdRef = useRef(""),
    connectedAtRef = useRef(0),
    audioRef = useRef<HTMLAudioElement>(null),
    terminalHandledRef = useRef(false),
    oauthPopupRef = useRef<Window | null>(null),
    aircallRef = useRef<AircallWorkspace | null>(null),
    panelRef = useRef<HTMLElement | null>(null),
    powerDialerSessionRef = useRef(""),
    powerDialerResultReportedRef = useRef(false),
    ringbackRef = useRef<{ context: AudioContext; timer: number } | null>(null);

  const stopRingback = () => {
    const active = ringbackRef.current;
    if (!active) return;
    window.clearInterval(active.timer);
    void active.context.close();
    ringbackRef.current = null;
  };
  const startRingback = () => {
    stopRingback();
    const context = new AudioContext();
    const playPulse = () => {
      if (context.state === "suspended") void context.resume();
      const gain = context.createGain();
      gain.gain.value = 0.035;
      gain.connect(context.destination);
      [440, 480].forEach((frequency) => {
        const oscillator = context.createOscillator();
        oscillator.frequency.value = frequency;
        oscillator.connect(gain);
        oscillator.start();
        oscillator.stop(context.currentTime + 1.8);
      });
    };
    playPulse();
    ringbackRef.current = { context, timer: window.setInterval(playPulse, 6000) };
  };

  const startPanelDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    event.preventDefault();
    const panel = panelRef.current;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    const offsetX = event.clientX - rect.left;
    const offsetY = event.clientY - rect.top;
    const move = (moveEvent: PointerEvent) => {
      const maxX = Math.max(8, window.innerWidth - panel.offsetWidth - 8);
      const maxY = Math.max(8, window.innerHeight - 56);
      setPanelPosition({
        x: Math.min(maxX, Math.max(8, moveEvent.clientX - offsetX)),
        y: Math.min(maxY, Math.max(8, moveEvent.clientY - offsetY)),
      });
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
  };
  const refreshState = async () => {
    const next = await webRequest<CommunicationsState>(
      "communications.state",
      {},
      { timeoutMs: 12000 },
    );
    setState(next);
    return next;
  };
  const connectRingCentral = async () => {
    setError("");
    try {
      const result = await webRequest<{ authorizationUrl: string }>(
        "communications.ringcentral.connect",
        {},
        { timeoutMs: 12000 },
      );
      const popup = window.open(
        result.authorizationUrl,
        "deepcanvas-ringcentral",
        "popup,width=560,height=760",
      );
      if (!popup) {
        setError("Allow popups, then click Connect RingCentral again.");
        return;
      }
      oauthPopupRef.current = popup;
      const started = Date.now();
      const timer = window.setInterval(() => {
        if (!popup.closed && Date.now() - started < 120000) return;
        window.clearInterval(timer);
        oauthPopupRef.current = null;
        void refreshState().then((next) => {
          if (next.ringcentral.connected) setStatus("RingCentral connected");
          else if (!error)
            setError(
              "RingCentral authorization did not complete. Please try again.",
            );
        });
      }, 750);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Could not start RingCentral connection.",
      );
    }
  };
  const disconnectRingCentral = async () => {
    if (
      !window.confirm("Disconnect this RingCentral account from Deep Canvas?")
    )
      return;
    await webRequest(
      "communications.ringcentral.disconnect",
      {},
      { timeoutMs: 12000 },
    );
    await refreshState();
  };
  const connectAircall = async () => {
    setBusy(true);
    setError("");
    try {
      await webRequest("communications.aircall.connect", aircallCredentials, { timeoutMs: 30000 });
      setAircallCredentials({ apiId: "", apiToken: "" });
      setAircallConnectOpen(false);
      setStatus("Aircall connected");
      await refreshState();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Aircall could not be connected.");
    } finally {
      setBusy(false);
    }
  };
  const disconnectAircall = async () => {
    if (!window.confirm("Disconnect this Aircall account from Deep Canvas?")) return;
    await webRequest("communications.aircall.disconnect", {}, { timeoutMs: 12000 });
    await refreshState();
  };
  const refreshTeammates = async () =>
    setTeammates(
      (
        await webRequest<{ teammates: Teammate[] }>(
          "communications.teammates",
          {},
          { timeoutMs: 12000 },
        )
      ).teammates,
    );
  const setPresence = (
    next: "available" | "ringing" | "on-call",
    callId = "",
  ) =>
    webRequest(
      "communications.presence",
      { status: next, callId },
      { timeoutMs: 12000 },
    );
  const loadDevices = async () => {
    const items = await navigator.mediaDevices?.enumerateDevices();
    if (items) {
      const inputs = items.filter((x) => x.kind === "audioinput");
      const outputs = items.filter((x) => x.kind === "audiooutput");
      setAudioInputs(inputs);
      setAudioOutputs(outputs);
      if (inputId && !inputs.some((item) => item.deviceId === inputId)) {
        setInputId("");
        localStorage.removeItem("dc-call-input");
      }
      if (outputId && !outputs.some((item) => item.deviceId === outputId)) {
        setOutputId("");
        localStorage.removeItem("dc-call-output");
      }
    }
  };
  const attachRemote = (call: Call) =>
    call.remoteStream$.subscribe((stream) => {
      if (!audioRef.current) return;
      audioRef.current.srcObject = stream;
      if (outputId && "setSinkId" in audioRef.current)
        void (
          audioRef.current as HTMLAudioElement & {
            setSinkId(id: string): Promise<void>;
          }
        ).setSinkId(outputId);
      void audioRef.current.play();
    });
  const reportPowerResult = (status: "answered" | "no-answer" | "failed") => {
    if (!powerDialerSessionRef.current || powerDialerResultReportedRef.current) return;
    powerDialerResultReportedRef.current = true;
    reportPowerDialerResult({
      sessionId: powerDialerSessionRef.current,
      leadId: lead.id,
      status,
    });
  };
  const handleTerminal = async (next: string) => {
    if (terminalHandledRef.current) return;
    terminalHandledRef.current = true;
    stopRingback();
    const mapped =
      next === "failed"
        ? "failed"
        : connectedAtRef.current
          ? "completed"
          : "no-answer";
    setStatus(
      mapped === "completed"
        ? "Call ended"
        : mapped === "no-answer"
          ? "No answer"
          : "Call failed",
    );
    callRef.current = null;
    ringCentralCallRef.current = null;
    setBusy(false);
    setMuted(false);
    setHeld(false);
    setTransferOpen(false);
    void setPresence("available");
    if (recordIdRef.current)
      await webRequest(
        "communications.call.update",
        { callId: recordIdRef.current, status: mapped },
        { timeoutMs: 12000 },
      ).catch(() => undefined);
    setShowDisposition(Boolean(recordIdRef.current));
    reportPowerResult(mapped === "completed" ? "answered" : mapped);
    void refreshState();
  };
  const monitorCall = (call: Call) => {
    call.status$.subscribe((next) => {
      if (next === "connected") {
        if (powerDialerSessionRef.current) {
          stopRingback();
          setStatus("Answered — keep this call or skip to the next lead");
          setBusy(false);
          void setPresence("on-call", call.id);
          return;
        }
        connectedAtRef.current = Date.now();
        setStatus("Connected");
        void setPresence("on-call", call.id);
      } else if (
        next === "ringing" ||
        next === "trying" ||
        next === "connecting"
      ) {
        setStatus(next === "ringing" ? "Ringing…" : "Connecting…");
        void setPresence("ringing", call.id);
      } else if (TERMINAL.includes(next)) void handleTerminal(next);
    });
    call.errors$.subscribe((item) =>
      setError(item.error.message || "A call error occurred."),
    );
    attachRemote(call);
  };
  const ensureClient = async () => {
    if (clientRef.current) return clientRef.current;
    const credential = await webRequest<BrowserToken>(
      "communications.browser_token",
      {},
      { timeoutMs: 20000 },
    );
    const client = new SignalWire(
      new StaticCredentialProvider({ token: credential.token }),
      { persistSession: true, savePreferences: true },
    );
    clientRef.current = client;
    await client.connect();
    await client.register();
    client.session.incomingCalls$.subscribe((calls: Call[]) => {
      const next = calls.find((item: Call) => !TERMINAL.includes(item.status));
      if (next && next !== callRef.current) {
        setIncomingCall(next);
        setOpen(true);
        setStatus("Incoming teammate transfer");
        void setPresence("ringing", next.id);
      }
    });
    await loadDevices();
    return client;
  };
  const ensureRingCentralPhone = async () => {
    if (ringCentralPhoneRef.current) return ringCentralPhoneRef.current;
    // Ask the browser for its current default microphone before creating the
    // SIP phone. This clears stale device selections and produces a useful
    // error when a browser has no usable input device.
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
      await loadDevices();
    } catch (deviceError) {
      const name =
        deviceError instanceof DOMException ? deviceError.name : "";
      if (name === "NotFoundError" || name === "DevicesNotFoundError") {
        throw new Error(
          "No microphone was found. Connect or enable a microphone, then reopen Audio devices and try again.",
        );
      }
      if (name === "NotAllowedError" || name === "PermissionDeniedError") {
        throw new Error(
          "Microphone access is blocked. Allow microphone access for Deep Canvas in the browser address bar, then try again.",
        );
      }
      throw deviceError;
    }
    const credential = await webRequest<RingCentralCredentials>(
      "communications.ringcentral.webphone",
      {},
      { timeoutMs: 20000 },
    );
    const phone = new WebPhone({ sipInfo: credential.sipInfo });
    await phone.start();
    ringCentralPhoneRef.current = phone;
    await loadDevices();
    return phone;
  };
  const refreshRingCentralCallerIds = async () => {
    const result = await webRequest<{
      callerIds: RingCentralCallerId[];
      defaultCallerId: string;
    }>("communications.ringcentral.caller_ids", {}, { timeoutMs: 12000 });
    setRingCentralCallerIds(result.callerIds || []);
    const selected = result.callerIds?.some(
      (item) => item.phoneNumber === ringCentralCallerId,
    )
      ? ringCentralCallerId
      : result.defaultCallerId || result.callerIds?.[0]?.phoneNumber || "";
    setRingCentralCallerId(selected);
    return selected;
  };
  const monitorRingCentralCall = (call: RingCentralSession) => {
    if (powerDialerSessionRef.current) startRingback();
    call.on("ringing", () => {
      setStatus("Ringing…");
      setBusy(false);
      void setPresence("ringing", call.callId);
      if (recordIdRef.current)
        void webRequest(
          "communications.call.update",
          {
            callId: recordIdRef.current,
            status: "ringing",
            providerCallId: call.callId,
          },
          { timeoutMs: 12000 },
        );
    });
    call.on("answered", () => {
      if (powerDialerSessionRef.current) {
        stopRingback();
        setStatus("Answered — keep this call or skip to the next lead");
        setBusy(false);
        void setPresence("on-call", call.callId);
        return;
      }
      connectedAtRef.current = Date.now();
      setStatus("Connected");
      setBusy(false);
      void setPresence("on-call", call.callId);
      if (recordIdRef.current)
        void webRequest(
          "communications.call.update",
          {
            callId: recordIdRef.current,
            status: "connected",
            providerCallId: call.callId,
          },
          { timeoutMs: 12000 },
        );
    });
    call.on("failed", (reason) => {
      setError(reason || "RingCentral rejected the call.");
      void handleTerminal("failed");
    });
    call.on("disposed", () => void handleTerminal("disconnected"));
  };

  useEffect(() => {
    const handle = (event: Event) => {
      const d = (event as CustomEvent<DialRequestDetail>).detail;
      setNumber(normalizePhone(d.phone));
      setLead(d.lead ?? { id: d.leadId, name: d.leadName });
      powerDialerSessionRef.current = d.powerDialerSessionId || "";
      powerDialerResultReportedRef.current = false;
      setOpen(true);
      if (d.autoStart) {
        setAutoStartRequest((request) => request + 1);
      } else {
        // A regular CRM Call click only prepares the dialer. The user must
        // press Call inside the phone panel before any outbound call starts.
        setAutoStartRequest(0);
        setStatus("Ready to call");
        setBusy(false);
      }
    };
    window.addEventListener(DIAL_REQUEST_EVENT, handle);
    return () => window.removeEventListener(DIAL_REQUEST_EVENT, handle);
  }, []);
  useEffect(() => {
    const handleStop = (event: Event) => {
      const sessionId = (event as CustomEvent<{ sessionId?: string }>).detail?.sessionId || "";
      if (!sessionId || sessionId !== powerDialerSessionRef.current) return;
      powerDialerSessionRef.current = "";
      powerDialerResultReportedRef.current = true;
      stopRingback();
      setStatus(callRef.current || ringCentralCallRef.current || aircallCallActive
        ? "Queue stopped — current call remains connected"
        : "Queue stopped");
    };
    window.addEventListener(POWER_DIALER_STOP_EVENT, handleStop);
    return () => window.removeEventListener(POWER_DIALER_STOP_EVENT, handleStop);
  }, [aircallCallActive]);
  useEffect(() => {
    const handle = (event: MessageEvent) => {
      if (
        event.data?.type !== "deepcanvas:ringcentral" ||
        event.source !== oauthPopupRef.current
      )
        return;
      if (event.data.ok) {
        setStatus("RingCentral connected");
        setError("");
        void refreshState();
      } else
        setError(
          String(
            event.data.message || "RingCentral connection was not completed.",
          ),
        );
    };
    window.addEventListener("message", handle);
    return () => window.removeEventListener("message", handle);
  }, []);
  useEffect(() => {
    if (state) return;
    void refreshState()
      .then(() => refreshTeammates())
      .catch((e) =>
        setError(e instanceof Error ? e.message : "Could not load calling."),
      );
  }, [state]);
  useEffect(() => {
    localStorage.setItem("dc-phone-provider", phoneProvider);
  }, [phoneProvider]);
  useEffect(() => {
    if (!state) return;

    // The provider preference is stored by the browser, but provider
    // connections belong to the signed-in Deep Canvas user. A shared browser
    // can therefore carry another user's Aircall/RingCentral choice across a
    // logout. When exactly one external provider is connected for the current
    // user, select that provider instead of presenting a false disconnected
    // state.
    if (
      state.ringcentral.connected &&
      !state.aircall.connected &&
      phoneProvider === "aircall"
    ) {
      setPhoneProvider("ringcentral");
    } else if (
      state.aircall.connected &&
      !state.ringcentral.connected &&
      phoneProvider === "ringcentral"
    ) {
      setPhoneProvider("aircall");
    }
  }, [phoneProvider, state]);
  useEffect(() => {
    if (aircallRef.current) return;
    const workspace = new AircallWorkspace({
      domToLoadWorkspace: "#deepcanvas-aircall-runtime",
      size: "auto",
      debug: false,
      onLogin: () => {
        setAircallPhoneLoggedIn(true);
        setAircallPhoneAuthOpen(false);
        setStatus("Aircall ready");
      },
      onLogout: () => {
        setAircallPhoneLoggedIn(false);
        setStatus("Authorize Aircall Phone");
      },
    });
    workspace.on("outgoing_call", (payload: AircallEventPayload) => {
      setAircallCallActive(true);
      setBusy(false);
      setStatus("Ringing…");
      void setPresence("ringing", String(payload.call_id || ""));
      if (recordIdRef.current) void webRequest("communications.call.update", {
        callId: recordIdRef.current, status: "ringing", providerCallId: String(payload.call_id || ""),
      });
    });
    workspace.on("outgoing_answered", (payload: AircallEventPayload) => {
      if (powerDialerSessionRef.current) {
        stopRingback();
        setStatus("Answered — keep this call or skip to the next lead");
        setBusy(false);
        void setPresence("on-call", String(payload.call_id || recordIdRef.current || ""));
        return;
      }
      connectedAtRef.current = Date.now();
      setStatus("Connected");
      if (recordIdRef.current) void webRequest("communications.call.update", { callId: recordIdRef.current, status: "connected" });
    });
    workspace.on("call_ended", () => {
      setAircallCallActive(false);
      void handleTerminal("disconnected");
    });
    workspace.isLoggedIn(setAircallPhoneLoggedIn);
    aircallRef.current = workspace;
  }, []);
  useEffect(() => {
    // A login/account change must never reuse another user's registered SIP
    // phone or outbound caller ID.
    void ringCentralCallRef.current?.hangup();
    void ringCentralPhoneRef.current?.dispose();
    ringCentralCallRef.current = null;
    ringCentralPhoneRef.current = null;
    setRingCentralCallerIds([]);
    setRingCentralCallerId("");
    if (!state?.ringcentral?.connected) return;
    void refreshRingCentralCallerIds().catch((e) =>
      setError(
        e instanceof Error
          ? e.message
          : "Could not load RingCentral caller IDs.",
      ),
    );
  }, [
    state?.ringcentral?.connected,
    state?.ringcentral?.extensionId,
  ]);
  useEffect(() => {
    const timer = window.setInterval(() => {
      void refreshTeammates();
      const c = callRef.current,
        r = ringCentralCallRef.current;
      void setPresence(
        c
          ? c.status === "connected"
            ? "on-call"
            : "ringing"
          : r
            ? r.state === "answered"
              ? "on-call"
              : "ringing"
            : "available",
        c?.id || r?.callId || "",
      );
    }, 15000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (status !== "Connected") return;
    const timer = window.setInterval(
      () =>
        setElapsed(Math.floor((Date.now() - connectedAtRef.current) / 1000)),
      1000,
    );
    return () => window.clearInterval(timer);
  }, [status]);
  useEffect(
    () => () => {
      stopRingback();
      void callRef.current?.hangup();
      void ringCentralCallRef.current?.hangup();
      void ringCentralPhoneRef.current?.dispose();
      void setPresence("available");
      clientRef.current?.destroy();
    },
    [],
  );

  const placeCall = async () => {
    setError("");
    if (callRef.current || ringCentralCallRef.current || aircallCallActive) {
      setStatus("Current call is still active");
      setError("End the current call before starting another.");
      return;
    }
    setBusy(true);
    setShowDisposition(false);
    setElapsed(0);
    connectedAtRef.current = 0;
    terminalHandledRef.current = false;
    try {
      const provider = phoneProvider === "ringcentral" && !state?.ringcentral.connected
        ? "ringcentral"
        : phoneProvider;
      if (provider === "aircall" && !aircallPhoneLoggedIn) {
        setAircallPhoneAuthOpen(true);
        throw new Error("Authorize Aircall Phone, then press Call again.");
      }
      const callerId =
        provider === "ringcentral" && !ringCentralCallerId
          ? await refreshRingCentralCallerIds()
          : ringCentralCallerId;
      const started = await webRequest<StartedCall>(
        "communications.call.start",
        {
          toNumber: normalizePhone(number),
          leadId: lead.id || "",
          leadName: lead.name || "",
          provider,
          callerId: provider === "ringcentral" ? callerId : "",
        },
        { timeoutMs: 20000 },
      );
      setRecordId(started.callId);
      recordIdRef.current = started.callId;
      setNumber(started.toNumber);
      if (started.mode === "aircall-browser") {
        const workspace = aircallRef.current;
        if (!workspace || !aircallPhoneLoggedIn) {
          setAircallPhoneAuthOpen(true);
          throw new Error("Authorize Aircall Phone, then press Call again.");
        }
        setStatus("Starting Aircall…");
        await new Promise<void>((resolve, reject) => workspace.send(
          "dial_number", { phone_number: started.toNumber },
          (success, detail) => success ? resolve() : reject(new Error(`Aircall could not start the call${detail ? `: ${JSON.stringify(detail)}` : "."}`)),
        ));
        return;
      }
      if (started.mode === "ringcentral-browser") {
        setStatus("Connecting securely…");
        const phone = await ensureRingCentralPhone();
        phone.once("outboundCall", (rawSession) => {
          const session = rawSession as RingCentralSession;
          ringCentralCallRef.current = session;
          monitorRingCentralCall(session);
        });
        void phone
          .call(
            started.toNumber.replace(/\D/g, ""),
            started.callerId.replace(/\D/g, ""),
          )
          .catch((callError: unknown) => {
            setError(
              callError instanceof Error
                ? callError.message
                : "RingCentral rejected the call.",
            );
            void handleTerminal("failed");
          });
        return;
      }
      if (false) {
        setStatus("RingCentral is connecting your phone to this lead…");
        setBusy(false);
        setShowDisposition(true);
        void refreshState();
        return;
      }
      setStatus("Connecting securely…");
      const client = await ensureClient();
      const call = await client.dial(started.toNumber, {
        audio: true,
        video: false,
        receiveAudio: true,
        stereo: false,
        inputAudioDeviceConstraints: {
          ...(inputId ? { deviceId: { exact: inputId } } : {}),
          echoCancellation: { ideal: true },
          noiseSuppression: { ideal: true },
          autoGainControl: { ideal: true },
          channelCount: { ideal: 1 },
          sampleRate: { ideal: 48000 },
        },
      });
      callRef.current = call;
      await webRequest(
        "communications.call.update",
        { callId: started.callId, status: "ringing", providerCallId: call.id },
        { timeoutMs: 12000 },
      );
      monitorCall(call);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "The call could not be started.",
      );
      setStatus("Call failed");
      setBusy(false);
      if (recordIdRef.current)
        void webRequest("communications.call.update", {
          callId: recordIdRef.current,
          status: "failed",
        });
      setShowDisposition(Boolean(recordIdRef.current));
      reportPowerResult("failed");
    }
  };
  useEffect(() => {
    if (!autoStartRequest) return;
    // Consume this request once. It must never leak into a later normal Call
    // click or replay after the panel/component is refreshed.
    setAutoStartRequest(0);
    void placeCall();
  }, [autoStartRequest]);
  const answerIncoming = () => {
    if (!incomingCall) return;
    const call = incomingCall;
    setIncomingCall(null);
    callRef.current = call;
    terminalHandledRef.current = false;
    call.answer({
      audio: true,
      video: false,
      receiveAudio: true,
      inputAudioDeviceConstraints: {
        ...(inputId ? { deviceId: { exact: inputId } } : {}),
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });
    monitorCall(call);
  };
  const rejectIncoming = () => {
    incomingCall?.reject();
    setIncomingCall(null);
    setStatus("Ready");
    void setPresence("available");
  };
  const hangup = async () => {
    setStatus("Ending call…");
    stopRingback();
    const call = callRef.current;
    const ringCentralCall = ringCentralCallRef.current;
    if (ringCentralCall) await ringCentralCall.hangup();
    else await call?.hangup();
    // Give the provider time to release its media/session before CRM is told
    // to advance. This prevents the next call from overlapping the old one.
    await new Promise((resolve) => window.setTimeout(resolve, 600));
    if ((call || ringCentralCall) && !terminalHandledRef.current) await handleTerminal("disconnected");
  };
  const toggleMute = async () => {
    const ringCentralCall = ringCentralCallRef.current;
    if (ringCentralCall) {
      if (muted) ringCentralCall.unmute();
      else ringCentralCall.mute();
      setMuted(!muted);
      return;
    }
    const self = callRef.current?.self;
    if (!self) return;
    if (muted) await self.unmute();
    else await self.mute();
    setMuted(!muted);
  };
  const confirmPowerDialerAnswer = () => {
    stopRingback();
    connectedAtRef.current = Date.now();
    setStatus("Connected");
    const activeCallId = ringCentralCallRef.current?.callId || callRef.current?.id || recordIdRef.current;
    if (activeCallId) void setPresence("on-call", activeCallId);
    reportPowerResult("answered");
  };
  const skipPowerDialerCall = async () => {
    setError("");
    if (aircallCallActive && !callRef.current && !ringCentralCallRef.current) {
      const workspace = aircallRef.current;
      if (!workspace) return;
      setStatus("Ending call before next lead…");
      await new Promise<void>((resolve, reject) => workspace.send(
        "hangup",
        {},
        (success, detail) => success ? resolve() : reject(new Error(
          `Aircall could not end the call${detail ? `: ${JSON.stringify(detail)}` : "."}`,
        )),
      )).catch((error) => {
        setError(error instanceof Error ? error.message : "End the Aircall call before continuing.");
      });
      return;
    }
    await hangup();
  };
  const toggleHold = async () => {
    const ringCentralCall = ringCentralCallRef.current;
    if (!ringCentralCall) return;
    setError("");
    try {
      if (held) await ringCentralCall.unhold();
      else await ringCentralCall.hold();
      setHeld(!held);
      setStatus(held ? "Connected" : "On hold");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not change hold status.");
    }
  };
  const pressKey = async (key: string) =>
    ringCentralCallRef.current
      ? ringCentralCallRef.current.sendDtmf(key)
      : callRef.current
        ? callRef.current
            .sendDigits(key)
            .catch(() => setError("Could not send keypad tone."))
        : setNumber((x) => `${x}${key}`);
  const transferCall = async (person: Teammate) => {
    const call = callRef.current;
    const ringCentralCall = ringCentralCallRef.current;
    const destination = ringCentralCall ? person.ringCentralDestination : person.destination;
    if ((!call && !ringCentralCall) || !destination || person.callPresence.status !== "available") return;
    setTransferring(person.id);
    setError("");
    try {
      if (ringCentralCall) await ringCentralCall.transfer(destination);
      else await call?.transfer({ destination });
      setStatus(`Transferred to ${person.displayName}`);
      setTransferOpen(false);
      await handleTerminal("disconnected");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Call transfer failed.");
    } finally {
      setTransferring("");
    }
  };
  const changeInput = (id: string) => {
    setInputId(id);
    localStorage.setItem("dc-call-input", id);
    clientRef.current?.selectAudioInputDevice(
      audioInputs.find((x) => x.deviceId === id) || null,
    );
  };
  const changeOutput = async (id: string) => {
    setOutputId(id);
    localStorage.setItem("dc-call-output", id);
    clientRef.current?.selectAudioOutputDevice(
      audioOutputs.find((x) => x.deviceId === id) || null,
    );
    if (audioRef.current && id && "setSinkId" in audioRef.current)
      await (
        audioRef.current as HTMLAudioElement & {
          setSinkId(value: string): Promise<void>;
        }
      ).setSinkId(id);
  };
  const saveDisposition = async () => {
    if (!recordId) return;
    setBusy(true);
    try {
      await webRequest(
        "communications.call.disposition",
        { callId: recordId, disposition, notes },
        { timeoutMs: 12000 },
      );
      setShowDisposition(false);
      setNotes("");
      setRecordId("");
      recordIdRef.current = "";
      setStatus("Ready");
      await refreshState();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save call outcome.");
    } finally {
      setBusy(false);
    }
  };
  const close = () => {
    if (callRef.current || ringCentralCallRef.current || incomingCall || aircallCallActive) return;
    setOpen(false);
    setLead({});
    setError("");
  };

  return (
    <div className="dc-dialer">
      <button
        type="button"
        className={`dc-dialer__header-button ${open ? "is-active" : ""}`}
        disabled={disabled}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <Phone size={16} />
        <span>Call</span>
      </button>
      <section className={`dc-aircall-phone-auth ${aircallPhoneAuthOpen ? "is-open" : ""}`}>
        {aircallPhoneAuthOpen ? <header><div><span>Aircall authorization</span><strong>Sign in once to enable browser calling</strong></div><button onClick={() => setAircallPhoneAuthOpen(false)}><X size={17} /></button></header> : null}
        <div id="deepcanvas-aircall-runtime" />
      </section>
      {open ? (
        <aside
          ref={panelRef}
          className="dc-dialer__panel"
          style={{ left: panelPosition.x, top: panelPosition.y }}
        >
          <header onPointerDown={startPanelDrag}>
            <div>
              <span>Deep Canvas Phone</span>
              <strong>
                {lead.name ||
                  (callRef.current ? formatPhone(number) : "Place a call")}
              </strong>
              {lead.leadName ? <small className="dc-dialer__lead-category">{lead.leadName}</small> : null}
            </div>
            <button
              onClick={close}
              disabled={Boolean(callRef.current || incomingCall)}
            >
              <X size={17} />
            </button>
          </header>
          <audio ref={audioRef} autoPlay playsInline />
          {incomingCall ? (
            <section className="dc-dialer__incoming">
              <PhoneCall />
              <div>
                <strong>Incoming transfer</strong>
                <span>
                  {incomingCall.fromName || "A teammate is transferring a call"}
                </span>
              </div>
              <button onClick={answerIncoming}>
                <Check />
                Accept
              </button>
              <button className="is-reject" onClick={rejectIncoming}>
                <X />
                Decline
              </button>
            </section>
          ) : null}
          <section className="dc-dialer__provider">
            <div>
              <span>Phone provider</span>
              <select value={phoneProvider} onChange={(event) => setPhoneProvider(event.target.value as PhoneProvider)} disabled={busy}>
                <option value="aircall">Aircall</option>
                <option value="ringcentral">RingCentral</option>
                <option value="signalwire">Deep Canvas Phone</option>
              </select>
              <small>{phoneProvider === "aircall" ? (state?.aircall?.connected ? `${state.aircall.userName || "Aircall"} connected` : "Connect your Aircall account") : phoneProvider === "ringcentral" ? (state?.ringcentral?.connected ? `${state.ringcentral.displayName || "RingCentral"} connected` : "Optional user connection") : "SignalWire browser calling"}</small>
            </div>
            {phoneProvider === "aircall" && state?.aircall?.connected && !aircallPhoneLoggedIn ? (
              <button onClick={() => setAircallPhoneAuthOpen(true)}>Authorize Phone</button>
            ) : phoneProvider === "aircall" && state?.aircall?.connected ? (
              <button onClick={() => void disconnectAircall()}>Disconnect</button>
            ) : phoneProvider === "aircall" ? (
              <button onClick={() => setAircallConnectOpen(true)}>Connect Aircall</button>
            ) : phoneProvider === "ringcentral" && state?.ringcentral?.connected ? (
              <button onClick={() => void disconnectRingCentral()}>
                Disconnect
              </button>
            ) : phoneProvider === "ringcentral" ? (
              <button
                disabled={!state?.ringcentralConfigured}
                onClick={() => void connectRingCentral()}
              >
                Connect RingCentral
              </button>
            ) : null}
          </section>
          {aircallConnectOpen ? <section className="dc-dialer__aircall-connect">
            <strong>Connect Aircall</strong>
            <small>In Aircall Dashboard, open Integrations & API → API keys and create an API ID and token.</small>
            <input value={aircallCredentials.apiId} onChange={(event) => setAircallCredentials((current) => ({ ...current, apiId: event.target.value }))} placeholder="Aircall API ID" autoComplete="off" />
            <input type="password" value={aircallCredentials.apiToken} onChange={(event) => setAircallCredentials((current) => ({ ...current, apiToken: event.target.value }))} placeholder="Aircall API token" autoComplete="new-password" />
            <div><button onClick={() => setAircallConnectOpen(false)}>Cancel</button><button disabled={busy || !aircallCredentials.apiId || !aircallCredentials.apiToken} onClick={() => void connectAircall()}>Connect</button></div>
          </section> : null}
          <div className="dc-dialer__identity">
            <span>Calling from</span>
            {phoneProvider === "ringcentral" && state?.ringcentral?.connected && ringCentralCallerIds.length ? (
              <select
                aria-label="Outbound caller ID"
                value={ringCentralCallerId}
                onChange={(event) =>
                  setRingCentralCallerId(event.target.value)
                }
              >
                {ringCentralCallerIds.map((item) => (
                  <option key={item.phoneNumber} value={item.phoneNumber}>
                    {item.label} · {formatPhone(item.phoneNumber)}
                  </option>
                ))}
              </select>
            ) : (
              <strong>
                {phoneProvider === "aircall"
                  ? state?.aircall?.phoneNumber ? formatPhone(state.aircall.phoneNumber) : "Connect Aircall"
                  : phoneProvider === "ringcentral" && state?.ringcentral?.connected
                  ? state.ringcentral.phoneNumber
                    ? formatPhone(state.ringcentral.phoneNumber)
                    : "RingCentral"
                  : state?.callerId
                    ? formatPhone(state.callerId)
                    : "Loading…"}
              </strong>
            )}
            <small>{state?.allowedRegion || "US/Canada"} outbound</small>
          </div>
          <div className="dc-dialer__number">
            <input
              value={number}
              onChange={(e) => {
                setNumber(e.target.value);
                setLead({});
              }}
              disabled={Boolean(callRef.current)}
              placeholder="Enter phone number"
            />
            <button
              disabled={Boolean(callRef.current) || !number}
              onClick={() => setNumber((x) => x.slice(0, -1))}
            >
              <Delete size={18} />
            </button>
          </div>
          <div className={`dc-dialer__status ${error ? "is-error" : ""}`}>
            <span>{error || status}</span>
            {connectedAtRef.current ? (
              <strong>{formatDuration(elapsed)}</strong>
            ) : null}
          </div>
          {powerDialerSessionRef.current && (callRef.current || ringCentralCallRef.current || aircallCallActive) && !powerDialerResultReportedRef.current ? (
            <div className="dc-dialer__power-actions">
              <button type="button" className="is-answered" onClick={confirmPowerDialerAnswer}>
                <Check size={16} /> Keep call / stop queue
              </button>
              <button type="button" onClick={() => void skipPowerDialerCall()}>
                <PhoneOff size={16} /> Skip / end and next
              </button>
            </div>
          ) : null}
          <div className="dc-dialer__keypad">
            {KEYS.map((key) => (
              <button key={key} onClick={() => void pressKey(key)}>
                {key}
              </button>
            ))}
          </div>
          <div className={`dc-dialer__controls ${callRef.current || ringCentralCallRef.current ? "is-active-call" : ""}`}>
            {callRef.current || ringCentralCallRef.current ? (
              <>
                <button
                  className={muted ? "is-active" : ""}
                  onClick={() => void toggleMute()}
                >
                  {muted ? <MicOff /> : <Mic />}
                  <span>{muted ? "Unmute" : "Mute"}</span>
                </button>
                {ringCentralCallRef.current ? (
                  <button className={held ? "is-active" : ""} onClick={() => void toggleHold()}>
                    {held ? <Play /> : <Pause />}
                    <span>{held ? "Resume" : "Hold"}</span>
                  </button>
                ) : null}
                <button onClick={() => setTransferOpen((x) => !x)}>
                  <ArrowRightLeft />
                  <span>Transfer</span>
                </button>
                <button className="is-danger" onClick={() => void hangup()}>
                  <PhoneOff />
                  <span>End</span>
                </button>
              </>
            ) : (
              <button
                className="is-call"
                disabled={
                  busy ||
                  !providerCanCall(phoneProvider, state) ||
                  normalizePhone(number).length < 12
                }
                onClick={() => void placeCall()}
              >
                <PhoneCall />
                <span>{busy ? "Starting…" : "Call"}</span>
              </button>
            )}
          </div>
          {transferOpen ? (
            <section className="dc-dialer__transfer">
              <strong>Transfer to teammate</strong>
              {teammates.length ? (
                teammates.map((item) => (
                  <button
                    key={item.id}
                    disabled={
                      item.callPresence.status !== "available" ||
                      (Boolean(ringCentralCallRef.current) && !item.ringCentralDestination) ||
                      Boolean(transferring)
                    }
                    onClick={() => void transferCall(item)}
                  >
                    <span>
                      <i className={`is-${item.callPresence.status}`} />
                      {item.displayName}
                    </span>
                    <small>
                      {transferring === item.id
                        ? "Transferring…"
                        : ringCentralCallRef.current && !item.ringCentralDestination
                          ? "Connect RingCentral"
                          : item.callPresence.status === "on-call"
                          ? "On a call"
                          : item.callPresence.status === "ringing"
                            ? "Ringing"
                            : "Available"}
                    </small>
                  </button>
                ))
              ) : (
                <p>No accepted Team Up teammates yet.</p>
              )}
            </section>
          ) : null}
          <button
            className="dc-dialer__audio-toggle"
            onClick={() => {
              setAudioSettingsOpen((x) => !x);
              void loadDevices();
            }}
          >
            <Headphones size={15} />
            Audio devices
          </button>
          {audioSettingsOpen ? (
            <section className="dc-dialer__audio-settings">
              <label>
                Microphone
                <select
                  value={inputId}
                  onChange={(e) => void changeInput(e.target.value)}
                >
                  <option value="">System default</option>
                  {audioInputs.map((x) => (
                    <option key={x.deviceId} value={x.deviceId}>
                      {x.label || "Microphone"}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Speaker
                <select
                  value={outputId}
                  onChange={(e) => void changeOutput(e.target.value)}
                >
                  <option value="">System default</option>
                  {audioOutputs.map((x) => (
                    <option key={x.deviceId} value={x.deviceId}>
                      {x.label || "Speaker"}
                    </option>
                  ))}
                </select>
              </label>
              <small>
                Echo cancellation, noise suppression, and automatic gain control
                are enabled. A headset gives the cleanest sound.
              </small>
            </section>
          ) : null}
          {showDisposition ? (
            <section className="dc-dialer__disposition">
              <strong>Call outcome</strong>
              <select
                value={disposition}
                onChange={(e) => setDisposition(e.target.value)}
              >
                <option value="answered">Answered</option>
                <option value="no-answer">No answer</option>
                <option value="voicemail">Left voicemail</option>
                <option value="follow-up">Follow up</option>
                <option value="bad-number">Bad number</option>
              </select>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Optional call notes"
                rows={2}
              />
              <button disabled={busy} onClick={() => void saveDisposition()}>
                Save outcome
              </button>
            </section>
          ) : null}
          {!showDisposition && !callRef.current && state?.calls.length ? (
            <section className="dc-dialer__recent">
              <strong>Recent</strong>
              {state.calls.slice(0, 3).map((item) => (
                <button
                  key={item.id}
                  onClick={() => {
                    setNumber(item.toNumber);
                    setLead({ name: item.leadName || undefined });
                  }}
                >
                  <span>{item.leadName || formatPhone(item.toNumber)}</span>
                  <small>
                    {item.disposition || item.status} ·{" "}
                    {formatDuration(item.durationSeconds)}
                  </small>
                </button>
              ))}
            </section>
          ) : null}
        </aside>
      ) : null}
    </div>
  );
}

