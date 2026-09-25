import { describe, expect, it } from 'vitest';

import { LandmarkSmoother, OneEuroFilter } from '@/core/gesture/oneEuro';
import type { NormalizedLandmark, RawHand } from '@/core/hand/handState';

describe('OneEuroFilter', () => {
  it('第一次调用直接返回输入（没有历史可用）', () => {
    const filter = new OneEuroFilter();
    expect(filter.filter(0.42, 0)).toBe(0.42);
    expect(filter.hasHistory).toBe(true);
  });

  it('静止信号上的抖动被显著压掉', () => {
    const filter = new OneEuroFilter();
    const jitter = (i: number): number => 0.5 + (i % 2 === 0 ? 0.002 : -0.002);

    let outputJitter = 0;
    for (let i = 0; i < 60; i += 1) {
      const output = filter.filter(jitter(i), i / 30);
      if (i > 10) outputJitter = Math.max(outputJitter, Math.abs(output - 0.5));
    }

    // 输入抖动幅度 0.002，输出残余应该小一个数量级以上
    expect(outputJitter).toBeLessThan(0.0005);
  });

  it('阶跃响应收敛到新值（不产生稳态偏差）', () => {
    const filter = new OneEuroFilter();

    for (let i = 0; i < 30; i += 1) filter.filter(0, i / 30);
    let output = 0;
    for (let i = 30; i < 200; i += 1) output = filter.filter(1, i / 30);

    expect(output).toBeCloseTo(1, 3);
  });

  it('速度自适应：快速移动时比固定低通跟得更紧', () => {
    const adaptive = new OneEuroFilter();
    const fixedLowPass = new OneEuroFilter({ beta: 0 });

    let adaptiveError = 0;
    let fixedError = 0;

    for (let i = 0; i < 40; i += 1) {
      const value = i * 0.01; // 匀速直线运动
      const t = i / 60;
      adaptiveError = Math.abs(value - adaptive.filter(value, t));
      fixedError = Math.abs(value - fixedLowPass.filter(value, t));
    }

    // beta > 0 时截止频率随速度上升，滞后应该更小
    expect(adaptiveError).toBeLessThan(fixedError);
  });

  it('时间戳不递增时用兜底 dt，不产生 NaN / Infinity', () => {
    const filter = new OneEuroFilter();
    filter.filter(1, 5);
    const same = filter.filter(2, 5);
    const backwards = filter.filter(3, 4);

    expect(Number.isFinite(same)).toBe(true);
    expect(Number.isFinite(backwards)).toBe(true);
  });

  it('非有限输入被忽略，返回上一次的值', () => {
    const filter = new OneEuroFilter();
    filter.filter(0.3, 0);
    expect(filter.filter(Number.NaN, 0.1)).toBe(0.3);
  });

  it('参数非法时抛错', () => {
    expect(() => new OneEuroFilter({ minCutoff: 0 })).toThrow(RangeError);
    expect(() => new OneEuroFilter({ dCutoff: -1 })).toThrow(RangeError);
    expect(() => new OneEuroFilter({ beta: -0.1 })).toThrow(RangeError);
  });

  it('reset 之后回到"没有历史"的状态', () => {
    const filter = new OneEuroFilter();
    filter.filter(0, 0);
    filter.filter(0, 1);
    filter.reset();

    expect(filter.hasHistory).toBe(false);
    expect(filter.filter(9, 2)).toBe(9);
  });
});

function makeHand(x: number, y: number): RawHand {
  const landmarks: NormalizedLandmark[] = Array.from({ length: 21 }, () => ({
    position: { x, y },
    z: 0,
    visibility: 1,
  }));
  return { landmarks, handedness: 'right', confidence: 0.9 };
}

describe('LandmarkSmoother', () => {
  it('逐关键点、逐分量平滑，不影响 visibility', () => {
    const smoother = new LandmarkSmoother(1, 21, { minCutoff: 1.2 });
    const hand = makeHand(0.2, 0.3);

    const first = smoother.smooth([hand], 0)[0];
    expect(first?.landmarks).toHaveLength(21);
    expect(first?.landmarks[7]?.position.x).toBeCloseTo(0.2, 9);
    expect(first?.landmarks[7]?.visibility).toBe(1);

    // 跳变后输出应该被平滑拖住，而不是立刻等于新值。
    // （跳变取 0.15：必须留在 REACQUIRE_JUMP 以内，否则会被当成"重新捕获"而重置 ——
    //   那是另一条规则，见下面的专门用例。）
    const jumped = smoother.smooth([makeHand(0.35, 0.3)], 1 / 30)[0];
    expect(jumped?.landmarks[7]?.position.x).toBeGreaterThan(0.2);
    expect(jumped?.landmarks[7]?.position.x).toBeLessThan(0.35);
  });

  it('某个槽位这一帧没有手时整组重置（手再出现不带陈旧状态）', () => {
    const smoother = new LandmarkSmoother(1, 21, { minCutoff: 1.2 });

    smoother.smooth([makeHand(0.2, 0.3)], 0);
    smoother.smooth([makeHand(0.25, 0.3)], 1 / 30);

    // 手消失一帧 -> 该槽位滤波器重置（槽位保留，值为 undefined）
    expect(smoother.smooth([], 2 / 30)).toEqual([undefined]);
    expect(smoother.smooth([undefined], 2 / 30)).toEqual([undefined]);

    // 手在完全不同的位置回来：第一个值必须直接通过，而不是从 0.2 滑过去
    const resumed = smoother.smooth([makeHand(0.9, 0.3)], 3 / 30)[0];
    expect(resumed?.landmarks[7]?.position.x).toBeCloseTo(0.9, 9);
  });

  it('保槽位：输出长度恒等于槽位数，缺席的槽位是 undefined', () => {
    // 双手场景下的回归：slot 0 缺席、slot 1 有手时，
    // 结果**不能**把右手挤到第 0 项去（那会让右手的滤波状态串进左手的槽）
    const smoother = new LandmarkSmoother(2, 21, { minCutoff: 1.2 });
    const hands = smoother.smooth([undefined, makeHand(0.9, 0.9)], 0);

    expect(hands).toHaveLength(2);
    expect(hands[0]).toBeUndefined();
    expect(hands[1]?.landmarks[0]?.position.x).toBe(0.9);
  });

  it('超出手数的部分直接丢弃（不挤占已有槽位）', () => {
    const smoother = new LandmarkSmoother(1, 21, { minCutoff: 1.2 });
    const hands = smoother.smooth([makeHand(0.1, 0.1), makeHand(0.9, 0.9)], 0);

    expect(hands).toHaveLength(1);
    expect(hands[0]?.landmarks[0]?.position.x).toBe(0.1);
  });

  it('手腕巨跳 = 重新捕获 -> 整组重置，不从旧位置滑过去', () => {
    // 真机场景：MediaPipe 偶尔把两只手认反，或者一只手在别处被重新捕获。
    // 这时如果继续平滑，滤波器要花约 0.4 秒滑过去，而双手缩放的基准间距
    // 恰好在这段时间采样 —— 素材会自己变大/变小。
    const smoother = new LandmarkSmoother(1, 21, { minCutoff: 1.2 });
    smoother.smooth([makeHand(0.2, 0.3)], 0);
    smoother.smooth([makeHand(0.22, 0.3)], 1 / 30);

    const teleported = smoother.smooth([makeHand(0.9, 0.3)], 2 / 30)[0];
    expect(teleported?.landmarks[0]?.position.x).toBeCloseTo(0.9, 9);
  });

  it('正常范围内的快速移动仍然被平滑（不许把挥手当跳变）', () => {
    const smoother = new LandmarkSmoother(1, 21, { minCutoff: 1.2 });
    smoother.smooth([makeHand(0.2, 0.3)], 0);
    // 每帧移动 0.08，远低于 0.25 的判据 -> 必须继续被拖住
    const moved = smoother.smooth([makeHand(0.28, 0.3)], 1 / 30)[0];
    expect(moved?.landmarks[0]?.position.x).toBeGreaterThan(0.2);
    expect(moved?.landmarks[0]?.position.x).toBeLessThan(0.28);
  });

  it('手数非法时抛错', () => {
    expect(() => new LandmarkSmoother(0)).toThrow(RangeError);
  });
});
