/// <reference lib="webworker" />
import { errorText, processPhoto } from '../import/process';
import type { ImportRequest, ImportResponse } from '../types';

declare const self: DedicatedWorkerGlobalScope;

function post(msg: ImportResponse) {
  self.postMessage(msg);
}

// Anything that escapes processPhoto still reaches the page with its real text.
self.addEventListener('unhandledrejection', (e) => post({ type: 'fatal', message: errorText(e.reason) }));

// One file per message (pull model): if this worker dies, the page knows exactly
// which photo it was on and can retry or skip just that one.
self.onmessage = async (e: MessageEvent<ImportRequest>) => {
  if (e.data.type !== 'photo') return;
  const { id, file } = e.data;
  try {
    post(await processPhoto(id, file));
  } catch (err) {
    post({ type: 'skipped', id, name: file.name, reason: errorText(err) });
  }
};

post({ type: 'ready' });
