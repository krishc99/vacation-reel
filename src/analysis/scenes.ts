// Scene types (Milestone 4b): CLIP image embedding vs. precomputed label embeddings.
import labels from './sceneLabels.json';

export type SceneClass =
  | 'people' | 'food' | 'scenery' | 'sunset' | 'city' | 'landmark' | 'nightlife'
  | 'activity' | 'travel' | 'vehicle' | 'room' | 'animal' | 'junk';

export interface Scene {
  label: SceneClass;
  /** Softmax over classes (CLIP logit scale 100). */
  probs: Partial<Record<SceneClass, number>>;
  /** 512-d CLIP image embedding, L2-normalised (variety / similarity later). */
  embedding: number[];
}

const CLASSES = labels.classes as Record<SceneClass, number[]>;

/** False until the label embeddings have been generated (scripts/clip_labels.py) and the model is shipped. */
export const SCENES_ENABLED = Object.keys(CLASSES).length > 0;

export const SCENE_LABEL: Record<SceneClass, string> = {
  people: 'people', food: 'food', scenery: 'scenery', sunset: 'sunset', city: 'city', landmark: 'landmark',
  nightlife: 'night out', activity: 'activity', travel: 'travel', vehicle: 'vehicle', room: 'room', animal: 'animal', junk: 'screenshot/doc',
};

export function classify(embedding: number[]): Scene {
  const names = Object.keys(CLASSES) as SceneClass[];
  const logits = names.map((n) => 100 * CLASSES[n].reduce((s, x, i) => s + x * embedding[i], 0));
  const max = Math.max(...logits);
  const exps = logits.map((l) => Math.exp(l - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  const probs: Partial<Record<SceneClass, number>> = {};
  names.forEach((n, i) => (probs[n] = exps[i] / sum));
  const label = names[logits.indexOf(max)];
  return { label, probs, embedding };
}

/**
 * Screenshots, receipts, documents: never what you want in a reel. CLIP's top
 * label must be "junk" with ≥ 0.25 (sample receipt: 0.29 in the browser, 0.35 in
 * Python; it's a soft "set aside" the user can undo). Screenshots are also caught
 * without CLIP, below.
 */
export const isJunk = (s?: Scene) => !!s && s.label === 'junk' && (s.probs.junk ?? 0) >= 0.25;

/**
 * Phone screenshots: no camera capture date, phone-screen shape (≥ 1.9:1), and
 * a PNG or "screenshot" in the name. Works even before/without CLIP.
 */
export function looksLikeScreenshot(p: { name?: string; width?: number; height?: number; timeSource?: string }): boolean {
  if (!p.name || !p.width || !p.height || p.timeSource !== 'file') return false;
  const ratio = Math.max(p.width, p.height) / Math.min(p.width, p.height);
  return ratio >= 1.9 && (/\.png$/i.test(p.name) || /screen ?shot/i.test(p.name));
}
