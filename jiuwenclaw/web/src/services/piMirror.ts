import { webRequest } from './webClient';

export type MirrorFeature =
  | 'storage'
  | 'kanban'
  | 'crm'
  | 'project_flow'
  | 'lead_gen'
  | 'video_meeting';

const DEBOUNCE_MS = 500;
const RETRY_DELAYS_MS = [0, 500, 1500];

interface MirrorQueue {
  latest: unknown;
  revision: number;
  savedRevision: number;
  timer?: ReturnType<typeof setTimeout>;
  worker?: Promise<void>;
}

const queues: Partial<Record<MirrorFeature, MirrorQueue>> = {};

function queueFor(feature: MirrorFeature): MirrorQueue {
  return queues[feature] ?? (queues[feature] = { latest: undefined, revision: 0, savedRevision: 0 });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendWithRetry(feature: MirrorFeature, data: unknown): Promise<void> {
  let lastError: unknown;
  for (const delay of RETRY_DELAYS_MS) {
    if (delay) await wait(delay);
    try {
      await webRequest('pi.state.sync', { feature, data }, { timeoutMs: 15000 });
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/** One worker per feature guarantees an older request can never finish after a newer one. */
function flushQueue(feature: MirrorFeature): Promise<void> {
  const queue = queueFor(feature);
  if (!queue.worker) {
    queue.worker = (async () => {
      while (queue.savedRevision < queue.revision) {
        const targetRevision = queue.revision;
        const data = queue.latest;
        await sendWithRetry(feature, data);
        queue.savedRevision = targetRevision;
      }
    })().finally(() => {
      queue.worker = undefined;
    });
  }
  return queue.worker;
}

function scheduleFlush(feature: MirrorFeature): void {
  const queue = queueFor(feature);
  if (queue.timer) clearTimeout(queue.timer);
  queue.timer = setTimeout(() => {
    queue.timer = undefined;
    void flushQueue(feature).catch((error) => {
      if (typeof console !== 'undefined') console.error('[piMirror] sync failed; retrying', feature, error);
      queue.timer = setTimeout(() => scheduleFlush(feature), 3000);
    });
  }, DEBOUNCE_MS);
}

/**
 * Push a feature snapshot to the backend mirror. Safe to call on every
 * store mutation — the call is debounced and errors are swallowed.
 */
export function mirrorFeatureState(feature: MirrorFeature, data: unknown): void {
  const queue = queueFor(feature);
  queue.latest = data;
  queue.revision += 1;
  scheduleFlush(feature);
}

/** Persist immediately when the mutation must be confirmed (for example deletes). */
export async function syncFeatureState(feature: MirrorFeature, data: unknown): Promise<void> {
  const queue = queueFor(feature);
  queue.latest = data;
  queue.revision += 1;
  if (queue.timer) {
    clearTimeout(queue.timer);
    queue.timer = undefined;
  }
  await flushQueue(feature);
}

/** Wait for already-queued changes without creating another snapshot revision. */
export async function flushFeatureState(feature: MirrorFeature): Promise<void> {
  const queue = queueFor(feature);
  if (queue.timer) {
    clearTimeout(queue.timer);
    queue.timer = undefined;
  }
  if (queue.savedRevision < queue.revision) await flushQueue(feature);
}

