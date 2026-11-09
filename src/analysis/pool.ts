// A few copies of a model worker sharing one queue of photos (faster on
// computers with memory to spare). The first worker downloads the models; the
// others start once it's ready, so they load from the browser cache instead of
// downloading in parallel.

/** How many copies of a heavy model worker this device can afford. */
export function modelWorkers(kind: 'people' | 'scenes'): number {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const phone = navigator.maxTouchPoints > 0 && (/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || navigator.platform === 'MacIntel');
  if (phone) return 1;
  const cores = navigator.hardwareConcurrency || 2;
  // Chrome reports memory (capped at 8); other browsers don't: go by cores.
  const mem = nav.deviceMemory ?? (cores >= 8 ? 8 : 4);
  // People ~60 MB per copy, scenes ~200 MB per copy, and both finders run at once.
  const byMem = mem >= 8 ? (kind === 'people' ? 3 : 2) : mem >= 4 ? 2 : 1;
  // Leave cores for the page and the other finder.
  const byCores = Math.max(1, Math.floor((cores - 2) / 2));
  return Math.max(1, Math.min(byMem, byCores));
}

export interface PoolMessages<Req, Res> {
  init: Req;
  /** Message for photo i. */
  request: (i: number) => Req;
  /** 'ready' | 'fatal' | a result for the photo sent last ('ok' or 'failed'). */
  kind: (m: Res) => 'ready' | 'fatal' | 'ok' | 'failed';
  fatalText: (m: Res) => string;
}

export interface PoolResult {
  failed: number;
  error: string | null;
}

export function runPool<Req, Res>(
  make: () => Worker,
  size: number,
  total: number,
  msgs: PoolMessages<Req, Res>,
  onResult: (m: Res) => void,
  onProgress: (done: number, total: number) => void,
  onReady: (m: Res) => void = () => {},
): { done: Promise<PoolResult>; cancel(): void } {
  let finish: (r: PoolResult) => void = () => {};
  const done = new Promise<PoolResult>((r) => (finish = r));
  const workers: Worker[] = [];
  let next = 0;
  let finished = 0;
  let failed = 0;
  let live = 0;
  let anyReady = false;
  let over = false;
  const end = (r: PoolResult) => {
    if (over) return;
    over = true;
    workers.forEach((w) => w.terminate());
    finish(r);
  };
  const checkDone = () => {
    if (finished >= total) end({ failed, error: null });
    else if (live === 0 && anyReady) end({ failed: failed + (total - finished), error: null });
  };

  const spawn = (first: boolean) => {
    const w = make();
    workers.push(w);
    live++;
    let current = -1;
    const pull = () => {
      if (over) return;
      if (next >= total) {
        w.terminate();
        live--;
        return checkDone();
      }
      current = next++;
      w.postMessage(msgs.request(current));
    };
    const die = (why: string) => {
      w.terminate();
      live--;
      if (first && !anyReady) return end({ failed: total, error: why });
      if (current >= 0) {
        // The photo it was on is lost; the others carry on.
        failed++;
        finished++;
        onProgress(finished, total);
      }
      checkDone();
    };
    w.onmessage = (e: MessageEvent<Res>) => {
      const m = e.data;
      const k = msgs.kind(m);
      if (k === 'ready') {
        if (!anyReady) {
          anyReady = true;
          onReady(m);
          // Extra copies now: models are in the browser cache.
          for (let i = 1; i < size && i < total; i++) spawn(false);
        }
        return pull();
      }
      if (k === 'fatal') return die(msgs.fatalText(m));
      if (k === 'ok') onResult(m);
      else failed++;
      current = -1;
      onProgress(++finished, total);
      if (finished >= total) return checkDone();
      pull();
    };
    w.onerror = (e) => {
      e.preventDefault();
      die(e.message || 'worker stopped');
    };
    w.postMessage(msgs.init);
  };

  if (total === 0) end({ failed: 0, error: null });
  else spawn(true);
  return {
    done,
    cancel() {
      end({ failed: 0, error: null });
    },
  };
}
