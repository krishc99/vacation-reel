// "Debug report": one HTML file describing how the app saw the album and why it
// picked what it picked, so problems can be diagnosed without the photos
// themselves. Built on the device and only saved when you tap the button.
// Small thumbnails are included only if you tick the box.
import type { AlbumAnalysis } from '../analysis';
import type { Person } from '../analysis/friends';
import type { PhotoScore } from '../analysis/scoring';
import { hamming } from '../analysis/dhash';
import type { Who } from '../selection';
import { clipSim } from '../selection';
import type { Photo } from '../types';

export interface ReportInput {
  photos: Photo[];
  analysis: AlbumAnalysis | null;
  scores: Map<string, PhotoScore>;
  who: Who;
  persons: Person[];
  /** Reel order. */
  picks: Photo[];
  candidates: string[];
  settings: Record<string, unknown>;
  build: string;
}

const r2 = (x: number | null | undefined) => (x === null || x === undefined ? null : Math.round(x * 100) / 100);

async function thumb(p: Photo): Promise<string> {
  const bmp = await createImageBitmap(p.detail);
  const s = 160 / Math.max(bmp.width, bmp.height);
  const c = new OffscreenCanvas(Math.round(bmp.width * s), Math.round(bmp.height * s));
  c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.7 });
  return await new Promise((res) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result as string);
    fr.readAsDataURL(blob);
  });
}

export async function buildReport(r: ReportInput, withThumbs: boolean): Promise<Blob> {
  const inReel = new Map(r.picks.map((p, i) => [p.id, i + 1]));
  const cand = new Set(r.candidates);
  const short = new Map(r.photos.map((p, i) => [p.id, `#${i + 1}`]));
  const rows = r.photos.map((p) => {
    const v = r.analysis?.verdicts.get(p.id);
    const s = r.scores.get(p.id);
    const near = r.photos
      .filter((q) => q !== p)
      .map((q) => ({ q, sim: clipSim(p, q), ham: hamming(p.dhash, q.dhash) }))
      .sort((a, b) => b.sim - a.sim)[0];
    return {
      n: short.get(p.id),
      name: p.name,
      time: new Date(p.takenAt).toISOString(),
      timeSource: p.timeSource,
      gps: p.lat !== null ? [r2(p.lat), r2(p.lon)] : null,
      size: [p.width, p.height],
      video: p.video ? { duration: r2(p.video.duration), start: r2(p.video.start), end: r2(p.video.end), sound: p.video.hasAudio } : null,
      reel: inReel.get(p.id) ?? null,
      candidate: cand.has(p.id),
      burst: v?.burstId ?? null,
      status: v?.status ?? null,
      reasons: v?.reasons ?? [],
      q: r2(v?.q),
      issues: v?.faceRank?.issues ?? [],
      scene: p.scene ? { label: p.scene.label, top: Object.entries(p.scene.probs).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, x]) => `${k} ${r2(x)}`) } : null,
      hasClip: !!p.scene?.embedding,
      people: p.people
        ? {
            count: p.people.count,
            faces: p.people.faces.map((f) => ({ h: r2(f.box.h), yaw: Math.round(f.yaw), id: !!f.embedding, covered: !!f.covered, blink: r2(Math.max(f.blinkL, f.blinkR)), smile: r2(f.smile) })),
            bodies: p.people.bodies.length,
          }
        : null,
      friends: r.who.known ? r.who.friends(p) : [],
      score: s ? { total: r2(s.score), Q: r2(s.Q), F: r2(s.F), C: r2(s.C), M: r2(s.M), aes: r2(s.aesthetic), hl: s.highlight } : null,
      nearest: near ? { n: short.get(near.q.id), clip: r2(near.sim), dhash: near.ham } : null,
    };
  });
  // Near-repeat pairs inside the reel: the thing to look at for "duplicates".
  const pairs: { a: string; b: string; clip: number | null; dhash: number }[] = [];
  for (let i = 0; i < r.picks.length; i++)
    for (let j = i + 1; j < r.picks.length; j++) {
      const a = r.picks[i];
      const b = r.picks[j];
      const sim = clipSim(a, b);
      const ham = hamming(a.dhash, b.dhash);
      if (sim >= 0.75 || ham <= 12) pairs.push({ a: short.get(a.id)!, b: short.get(b.id)!, clip: r2(sim), dhash: ham });
    }
  pairs.sort((x, y) => (y.clip ?? 0) - (x.clip ?? 0));
  const people = r.persons.map((x) => ({
    id: x.id,
    friend: x.friend,
    me: x.id === r.who.me,
    photos: x.photoIds.length,
    moments: x.moments,
    largest: r2(x.largest),
    inReel: r.picks.filter((p) => r.who.friends(p).includes(x.id)).length,
  }));
  const data = { build: r.build, made: new Date().toISOString(), settings: r.settings, photos: rows, reelPairs: pairs, people };

  const thumbs = new Map<string, string>();
  if (withThumbs) for (const p of r.photos) thumbs.set(p.id, await thumb(p));
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  const cards = r.photos
    .map((p, i) => {
      const d = rows[i];
      const img = thumbs.get(p.id);
      return `<figure class="${d.reel ? 'in' : d.candidate ? '' : 'out'}">${img ? `<img src="${img}" alt="">` : ''}<figcaption><b>${d.n}${d.reel ? ` · reel ${d.reel}` : ''}</b> ${esc(p.name)}<br>${esc(d.scene?.label ?? '?')} · ppl ${d.people?.count ?? 0} · friends ${d.friends.join(',') || '-'}<br>score ${d.score?.total ?? '-'} · q ${d.q ?? '-'} · near ${d.nearest?.n ?? '-'} (${d.nearest?.clip ?? '-'})${d.issues.length ? `<br>${esc(d.issues.join(', '))}` : ''}</figcaption></figure>`;
    })
    .join('');
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Vacation Reel debug report</title>
<style>body{font:13px system-ui,sans-serif;margin:16px;background:#fafafa}figure{display:inline-block;vertical-align:top;width:170px;margin:4px;padding:4px;background:#fff;border:2px solid #ddd;border-radius:6px}figure.in{border-color:#2a7}figure.out{opacity:.45}img{max-width:160px;display:block}figcaption{font-size:11px;line-height:1.3}pre{white-space:pre-wrap;font-size:11px}</style>
<h1>Debug report</h1><p>${r.photos.length} photos · ${r.picks.length} in the reel (green border) · faded = set aside. Build ${esc(r.build)}.</p>
<h2>Similar pairs inside the reel</h2><pre>${esc(pairs.map((x) => `${x.a} ~ ${x.b}  clip ${x.clip}  dhash ${x.dhash}`).join('\n') || 'none')}</pre>
<h2>People</h2><pre>${esc(people.map((x) => `${x.id}${x.me ? ' (me)' : ''}${x.friend ? '' : ' (one-off)'}: ${x.photos} photos, ${x.moments} moments, ${x.inReel} in reel`).join('\n'))}</pre>
<h2>Photos</h2>${cards}
<script type="application/json" id="data">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`;
  return new Blob([html], { type: 'text/html' });
}
