import { describe, expect, it } from 'vitest';

import { DEFAULT_FLICK_CONFIG } from '@/core/gesture/flick';
import { DEFAULT_SNAP_CONFIG, SnapDetector, type SnapSample } from '@/core/gesture/snap';

/**
 * 打响指（翻页）的判定。
 *
 * 它和指弹是**同构**的（贴住 → 急速弹开），所以用例也照着指弹那组来。
 * 但多一条**这个手势独有的**关键用例：**拇指贴的是中指，不是食指** ——
 * 否则普通捏合（拇指贴食指）也会被算成打响指。
 */

const FRAME = 1 / 30;

/** "贴住"：拇指-中指 0.45，拇指-食指 1.2 —— 中指明显更近 */
function stuck(time = 0): SnapSample {
  return { thumbMiddleGap: 0.45, thumbIndexGap: 1.2, tip: { x: 0.5, y: 0.5 }, aspect: 1, time };
}

/**
 * "弹开"：拇指-中指拉到 0.95（增量 0.50，**离门槛 0.45 留一点余量，别做刀尖上的测试**），
 * 中指尖一帧走 0.12 -> 速度 0.12 / (1/30) = 3.6 /秒，稳稳过门槛。
 */
function snapped(time: number, patch: Partial<SnapSample> = {}): SnapSample {
  return { thumbMiddleGap: 0.95, thumbIndexGap: 1.2, tip: { x: 0.5, y: 0.38 }, aspect: 1, time, ...patch };
}

/** 贴住两帧，返回下一帧的时间 */
function load(detector: SnapDetector, time = 0): number {
  detector.update(stuck(time), FRAME);
  detector.update(stuck(time + FRAME), FRAME);
  return time + 2 * FRAME;
}

describe('SnapDetector 能认出一次打响指', () => {
  it('拇指中指贴住两帧后急速弹开 -> 触发', () => {
    const detector = new SnapDetector();
    const t = load(detector);
    expect(detector.update(snapped(t), FRAME)).toBe(true);
  });

  it('调试读数可读：增量、速度、峰值（真机标定全靠它们）', () => {
    const detector = new SnapDetector();
    const t = load(detector);
    detector.update(snapped(t), FRAME);

    expect(detector.gapGain).toBeCloseTo(0.5, 6);
    expect(detector.releaseSpeed).toBeCloseTo(3.6, 6);
    // 峰值是"弹开那一帧"的瞬时速度，且**保持住**（人要来得及抬眼读）
    expect(detector.peakTipSpeed).toBeCloseTo(3.6, 6);
    detector.update(stuck(t + FRAME), FRAME);
    expect(detector.armedFrames).toBe(1);
  });

  it('冷却过去之后可以再打一下（连打翻页是常见动作）', () => {
    const detector = new SnapDetector();
    let t = load(detector);
    expect(detector.update(snapped(t), FRAME)).toBe(true);

    // 空转若干帧把冷却耗掉（0.22s ≈ 7 帧 @30fps）
    for (let i = 0; i < 8; i += 1) {
      t += FRAME;
      detector.update(null, FRAME);
    }

    const t2 = load(detector, t);
    expect(detector.update(snapped(t2), FRAME)).toBe(true);
  });

  it('冷却期内不会连发', () => {
    const detector = new SnapDetector();
    const t = load(detector);
    expect(detector.update(snapped(t), FRAME)).toBe(true);

    const t2 = load(detector, t + FRAME);
    expect(detector.update(snapped(t2), FRAME)).toBe(false);
  });
});

describe('SnapDetector 不误判', () => {
  it('**拇指贴的是食指**（中指只是碰巧也近）不算打响指 —— 那是捏合', () => {
    const detector = new SnapDetector();
    // 拇指到中指 0.45，但到食指更近 0.35 -> 贴着的是食指
    const pinchLike: SnapSample = { ...stuck(0), thumbIndexGap: 0.35 };
    detector.update(pinchLike, FRAME);
    detector.update({ ...pinchLike, time: FRAME }, FRAME);
    expect(detector.armedFrames).toBe(0);

    // 接着弹开也不该触发
    expect(detector.update(snapped(2 * FRAME, { thumbIndexGap: 0.35 }), FRAME)).toBe(false);
  });

  it('只贴住一帧就分开不算（顺手碰一下）', () => {
    const detector = new SnapDetector();
    detector.update(stuck(0), FRAME);
    expect(detector.update(snapped(FRAME), FRAME)).toBe(false);
  });

  it('没贴住就直接弹开不算', () => {
    const detector = new SnapDetector();
    expect(detector.update(snapped(0), FRAME)).toBe(false);
  });

  it('分开的增量不够不算（只是手指松了一下）', () => {
    const detector = new SnapDetector();
    const t = load(detector);
    // 0.68 - 0.45 = 0.23 < minGapGain(0.25)
    expect(detector.update(snapped(t, { thumbMiddleGap: 0.68 }), FRAME)).toBe(false);
  });

  it('中指尖几乎没动不算（张开得够但没弹）', () => {
    const detector = new SnapDetector();
    const t = load(detector);
    expect(detector.update(snapped(t, { tip: { x: 0.5, y: 0.499 } }), FRAME)).toBe(false);
  });

  it('手丢了之后状态作废（离开画面再回来不该凑出一次假响指）', () => {
    const detector = new SnapDetector();
    const t = load(detector);
    detector.update(null, FRAME);
    expect(detector.update(snapped(t), FRAME)).toBe(false);
  });

  it('参数非法时抛错', () => {
    expect(() => new SnapDetector({ loadedFrames: 0 })).toThrow(RangeError);
    expect(() => new SnapDetector({ releaseFrames: 0 })).toThrow(RangeError);
    expect(() => new SnapDetector({ minTipSpeed: 0 })).toThrow(RangeError);
    expect(() => new SnapDetector({ minGapGain: -0.1 })).toThrow(RangeError);
  });

  it('冷却刻意比指弹短（连打翻页是常见动作，太长会把第二下吃掉）', () => {
    expect(DEFAULT_SNAP_CONFIG.cooldownSeconds).toBeLessThanOrEqual(0.25);
  });

  it('门槛必须卡在真机两点读数之间：误触发挡掉、真响指放过', () => {
    /*
     * 真机实测的两组数：
     *   贴着拇指移动（误触发）：增 ≈ 0.3，速 ≈ 0.6
     *   真打响指　　　　　　　：增 ≈ 0.6，速 ≈ 3.0
     *
     * 这条测试**就是这两个点本身**：门槛必须落在它们中间。
     * 谁把门槛调到"挡不住误触发"或"放不过真响指"，它会立刻红。
     *
     * ⚠️ 上一版这里钉的是"翻页门槛必须低于删除"—— 那是**错的**：
     * 两个动作的自然速度不一样（响指比食指弹出更快），两个门槛本来就没有可比性。
     * 错的"不变式"比没有不变式更糟，所以换成了这两个实测点。
     */
    expect(DEFAULT_SNAP_CONFIG.minGapGain).toBeGreaterThan(0.3);
    expect(DEFAULT_SNAP_CONFIG.minGapGain).toBeLessThan(0.6);
    expect(DEFAULT_SNAP_CONFIG.minTipSpeed).toBeGreaterThan(0.6);
    expect(DEFAULT_SNAP_CONFIG.minTipSpeed).toBeLessThan(3.0);
  });

  it('"贴住"的判据和指弹用**同一个数**，且已经收到 0.50', () => {
    /*
     * 这两个数是同一个物理量（"拇指和某根手指贴上没"），刻意保持一致 ——
     * 分开写迟早会漂开，而"翻页认得出、删除认不出"这种不一致最难查。
     * 单测钉住它们相等，谁改了其中一个，这条会红。
     */
    expect(DEFAULT_SNAP_CONFIG.loadedMaxGap).toBe(DEFAULT_FLICK_CONFIG.loadedMaxGap);
    // 真机反馈"没贴住也能触发"，从 0.65 收到 0.50（= 捏合的进入阈值）
    expect(DEFAULT_SNAP_CONFIG.loadedMaxGap).toBeCloseTo(0.5, 6);
  });
});
