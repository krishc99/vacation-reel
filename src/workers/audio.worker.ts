/// <reference lib="webworker" />
import { analyzeBeats } from '../audio/beats';
import type { AudioAnalysisRequest, AudioAnalysisResponse } from '../types';

declare const self: DedicatedWorkerGlobalScope;

self.onmessage = (e: MessageEvent<AudioAnalysisRequest>) => {
  try {
    const analysis = analyzeBeats(e.data.mono, e.data.sampleRate);
    self.postMessage({ type: 'result', analysis } satisfies AudioAnalysisResponse);
  } catch (err) {
    self.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) } satisfies AudioAnalysisResponse);
  }
};
