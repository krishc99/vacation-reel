import { describe, expect, it } from 'vitest';
import { dropPose, easeOutBack, flashAt, leakAt, LOOKS, polaroid, punchAt, restingPose, stampText } from './looks';

describe('looks', () => {
  it('punch and flash fade out after the beat', () => {
    expect(punchAt(0)).toBeCloseTo(1 + LOOKS.punch);
    expect(punchAt(LOOKS.punchSec)).toBe(1);
    expect(punchAt(-0.1)).toBe(1);
    expect(flashAt(0)).toBeCloseTo(LOOKS.flash);
    expect(flashAt(1)).toBe(0);
  });
  it('light leaks flare on cuts', () => {
    expect(leakAt(2, [2])).toBeCloseTo(LOOKS.leakBase + LOOKS.leakPeak);
    expect(leakAt(3, [2])).toBeCloseTo(LOOKS.leakBase, 2);
  });
  it('polaroid fits the frame and lands on its resting pose', () => {
    for (const [W, H] of [[1080, 1920], [1920, 1080]]) {
      const p = polaroid(W, H);
      expect(p.w).toBeLessThan(W);
      expect(p.h).toBeLessThan(H);
      expect(p.h - p.inner.y - p.inner.h).toBeGreaterThan(p.inner.y); // thick bottom border
    }
    expect(easeOutBack(1)).toBeCloseTo(1);
    const rest = restingPose(3, 1080, 1920);
    const land = dropPose(3, 1, 1080, 1920);
    expect(land.cx).toBeCloseTo(rest.cx);
    expect(land.cy).toBeCloseTo(rest.cy);
    expect(dropPose(3, 0, 1080, 1920).cy).toBeGreaterThan(1920);
  });
  it('disposable-camera stamp', () => {
    expect(stampText(new Date(2026, 5, 1).getTime())).toBe("6 01 '26");
  });
});
