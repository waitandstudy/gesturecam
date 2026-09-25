import { describe, expect, it } from 'vitest';

import { DEFAULT_FLICK_CONFIG, FlickDetector, type FlickSample } from '@/core/gesture/flick';

/**
 * 指弹检测的单测。
 *
 * ⚠️ 第五轮真机标定把整个模型换掉了（见 `flick.ts` 文件头），这一组用例是重写的：
 *   · 原来假设"装填"= 食指弯向掌心 + **拇指躲开**（gap ≥ 0.60）；
 *   · 真机实测"弹脑瓜"蓄力姿势是**拇指扣住食指尖**（gap 0.45、食 1.52、中 0.91），
 *     旧门槛三条全挡，而且方向和真姿势**相反**。
 *
 * 现在钉住两件事：
 *   1. **真机那个蓄力姿势必须能装填**（下面所有 `load()` 用的就是它）；
 *   2. 区分靠动态 —— **抓着图快速拖动**（指尖飞快但 gap 不变）绝不能算指弹。
 */

const FRAME = 1 / 30;

/**
 * 默认采样 = **真机实测的"弹脑瓜"蓄力姿势**：
 * 拇指扣住食指尖（gap 0.45）、其余三指蜷着（中指 0.91）、食指是伸着的（1.52）。
 */
function sample(patch: Partial<FlickSample> = {}): FlickSample {
  return {
    indexReach: patch.indexReach ?? 1.52,
    middleReach: patch.middleReach ?? 0.91,
    gap: patch.gap ?? 0.45,
    tip: patch.tip ?? { x: 0.5, y: 0.5 },
    aspect: patch.aspect ?? 1,
    time: patch.time ?? 0,
  };
}

/** 扣住两帧（满足 `loadedFrames`），返回下一帧的时间。 */
function load(detector: FlickDetector, time = 0): number {
  detector.update(sample({ time }), FRAME);
  detector.update(sample({ time: time + FRAME }), FRAME);
  return time + 2 * FRAME;
}

/**
 * 甩开：一帧内拇指松开（gap 0.45 → 0.90）+ 指尖走 0.12。
 * 位移 0.12 / (1/30) = 3.6 /秒，稳稳过速度门槛。
 */
function release(detector: FlickDetector, time: number, patch: Partial<FlickSample> = {}) {
  return detector.update(sample({ gap: 0.9, tip: { x: 0.5, y: 0.38 }, time, ...patch }), FRAME);
}

describe('FlickDetector 能认出一次指弹', () => {
  it('扣住两帧后急速甩开 -> 触发一次，且带方向与速度', () => {
    const detector = new FlickDetector();
    const t = load(detector);

    const flick = release(detector, t);

    expect(flick).not.toBeNull();
    expect(flick?.gesture).toBe('index-flick');
    expect(flick?.frames).toBe(1);
    // 速度 = 0.12 / (1/30) = 3.6 /秒
    expect(flick?.speed).toBeCloseTo(3.6, 6);
    expect(flick?.direction.y).toBeCloseTo(-1, 6);
    expect(flick?.position).toEqual({ x: 0.5, y: 0.38 });
  });

  it('冷却期内不会连发（一次动作只算一次）', () => {
    const detector = new FlickDetector();
    const t = load(detector);
    expect(release(detector, t)).not.toBeNull();

    // 紧接着再扣住 + 甩开：冷却没过完 -> 不触发
    const t2 = load(detector, t + FRAME);
    expect(release(detector, t2)).toBeNull();
  });

  it('冷却过去之后可以再弹一次', () => {
    const detector = new FlickDetector();
    let t = load(detector);
    expect(release(detector, t)).not.toBeNull();

    // 冷却按 dt 递减：空转十几帧（约 0.5 秒）把它耗掉
    for (let i = 0; i < 16; i += 1) {
      t += FRAME;
      detector.update(null, FRAME);
    }
    expect(detector.isCoolingDown).toBe(false);

    const t2 = load(detector, t);
    expect(release(detector, t2)).not.toBeNull();
  });
});

describe('FlickDetector 不误判', () => {
  it('**抓着图快速拖动**不算指弹（指尖飞快，但拇指没松开、gap 不变）', () => {
    const detector = new FlickDetector();
    const t = load(detector);

    // 指尖同样一帧走 0.12，但 gap 一直是 0.45（拇指还扣着 = 还在捏合）
    const moved = detector.update(
      sample({ gap: 0.45, tip: { x: 0.5, y: 0.38 }, time: t }),
      FRAME,
    );
    expect(moved).toBeNull();

    // 连着拖几帧也不该弹
    let current = t;
    for (let i = 0; i < 5; i += 1) {
      current += FRAME;
      expect(
        detector.update(sample({ gap: 0.45, tip: { x: 0.5, y: 0.38 - i * 0.12 }, time: current }), FRAME),
      ).toBeNull();
    }
  });

  it('整只手张开（其余三指也伸直）不算指弹 —— 那是"释放"手势', () => {
    const detector = new FlickDetector();
    const t = load(detector);

    const flick = release(detector, t, { middleReach: 1.5 });
    expect(flick).toBeNull();
  });

  it('甩开增量不够（gap 只从 0.45 到 0.68）不算', () => {
    const detector = new FlickDetector();
    const t = load(detector);

    // 0.68 - 0.45 = 0.23 < minGapGain(0.25)
    const flick = detector.update(
      sample({ gap: 0.68, tip: { x: 0.5, y: 0.38 }, time: t }),
      FRAME,
    );
    expect(flick).toBeNull();
  });

  it('慢慢松开（速度不够）不算，且窗口过期后不再触发', () => {
    const detector = new FlickDetector();
    let t = load(detector);

    // gap 一步到位张开，但指尖每帧只挪 0.005（= 0.15 /秒）
    let fired = null as ReturnType<FlickDetector['update']>;
    for (let i = 0; i < 5; i += 1) {
      t += FRAME;
      const result = detector.update(
        sample({ gap: 0.9, tip: { x: 0.5, y: 0.5 - i * 0.005 }, time: t }),
        FRAME,
      );
      if (result) fired = result;
    }
    expect(fired).toBeNull();
  });

  it('没有扣住就直接甩开不算', () => {
    const detector = new FlickDetector();
    const flick = detector.update(sample({ gap: 0.9, tip: { x: 0.5, y: 0.38 }, time: 0 }), FRAME);
    expect(flick).toBeNull();
  });

  it('只扣住一帧不算（顺手碰一下拇指）', () => {
    const detector = new FlickDetector();
    detector.update(sample({ time: 0 }), FRAME);
    expect(release(detector, FRAME)).toBeNull();
  });

  it('指尖几乎没动（gap 张开了但位置没动）不算', () => {
    const detector = new FlickDetector();
    const t = load(detector);
    const flick = detector.update(
      sample({ gap: 0.9, tip: { x: 0.5, y: 0.499 }, time: t }),
      FRAME,
    );
    expect(flick).toBeNull();
  });

  it('手丢了之后状态作废（离开画面再回来不该凑出指弹）', () => {
    const detector = new FlickDetector();
    const t = load(detector);
    detector.update(null, FRAME);
    const flick = release(detector, t);
    expect(flick).toBeNull();
  });

  it('armedFrames 暴露装填进度（真机标定要看它）', () => {
    const detector = new FlickDetector();
    expect(detector.armedFrames).toBe(0);
    detector.update(sample(), FRAME);
    expect(detector.armedFrames).toBe(1);
    detector.update(sample(), FRAME);
    expect(detector.armedFrames).toBe(2);
    detector.update(sample({ gap: 0.9, tip: { x: 0.5, y: 0.3 } }), FRAME);
    expect(detector.armedFrames).toBe(0);
  });

  it('阈值参数非法时抛错', () => {
    expect(() => new FlickDetector({ loadedFrames: 0 })).toThrow(RangeError);
    expect(() => new FlickDetector({ releaseFrames: 0 })).toThrow(RangeError);
    expect(() => new FlickDetector({ minTipSpeed: 0 })).toThrow(RangeError);
    expect(() => new FlickDetector({ minGapGain: -0.1 })).toThrow(RangeError);
  });

  it('默认阈值取向：防误触靠"甩开增量"，速度门槛刻意压低', () => {
    expect(DEFAULT_FLICK_CONFIG.loadedFrames).toBeGreaterThanOrEqual(2);
    // 防误触的主力：抓着图快速拖动时指尖很快、但 gap 不变，全靠这一条挡
    expect(DEFAULT_FLICK_CONFIG.minGapGain).toBeGreaterThan(0);
    /*
     * 速度门槛**刻意**比第一版的 1.5 低：那个数是按"指尖移动画幅宽的 10–20%"估的，
     * 而"弹脑瓜"的指尖实际只走 3–7%（见 `flick.ts` 里那段推算），1.5 会把真实指弹全挡在门外。
     * 但也不能退化成"随便动一下就算"，所以上下都要钉住。
     */
    expect(DEFAULT_FLICK_CONFIG.minTipSpeed).toBeGreaterThan(0);
    expect(DEFAULT_FLICK_CONFIG.minTipSpeed).toBeLessThanOrEqual(1.0);
  });
});

/**
 * 装填门槛的真机标定。
 *
 * 这一组是被**第五轮真机反馈**逼出来的：用户按"弹脑瓜"蓄力，
 * 三条旧门槛（食 ≤1.35 / gap ≥0.60 / 中 ≥1.10）**一条都不成立**，
 * 而且 gap 那条的方向和真姿势是**相反的**（真姿势拇指就扣在食指尖上）。
 * 下面第一条用的就是那次的实测读数。
 */
describe('FlickDetector 装填门槛（真机标定：弹脑瓜）', () => {
  it('真机蓄力姿势（食 1.52 / gap 0.45 / 中 0.91）能装填，而且能弹出来', () => {
    const detector = new FlickDetector();
    detector.update(sample({ indexReach: 1.52, gap: 0.45, middleReach: 0.91, time: 0 }), FRAME);
    expect(detector.armedFrames).toBe(1);
    detector.update(sample({ indexReach: 1.52, gap: 0.45, middleReach: 0.91, time: FRAME }), FRAME);
    expect(detector.armedFrames).toBe(2);

    // 甩开：食指数值继续变大（1.52 → 1.75），拇指松开
    const flick = release(detector, 2 * FRAME, { indexReach: 1.75, gap: 0.95, middleReach: 0.93 });
    expect(flick).not.toBeNull();
  });

  it('旧模型的"半勾 + 拇指躲开"（食 1.30 / gap 0.90）现在**反而是**装填不上的那个', () => {
    const detector = new FlickDetector();
    detector.update(sample({ indexReach: 1.3, gap: 0.9, time: 0 }), FRAME);
    detector.update(sample({ indexReach: 1.3, gap: 0.9, time: FRAME }), FRAME);
    expect(detector.armedFrames).toBe(0);
  });

  it('其余三指张开（中指 1.40）不装填 —— 那是张开手掌，不是弹脑瓜', () => {
    const detector = new FlickDetector();
    detector.update(sample({ middleReach: 1.4, time: 0 }), FRAME);
    detector.update(sample({ middleReach: 1.4, time: FRAME }), FRAME);
    expect(detector.armedFrames).toBe(0);
  });

  it('中指刚好在蜷曲阈值上（1.10）仍算蜷着', () => {
    const detector = new FlickDetector();
    detector.update(sample({ middleReach: 1.1, time: 0 }), FRAME);
    detector.update(sample({ middleReach: 1.1, time: FRAME }), FRAME);
    expect(detector.armedFrames).toBe(2);
  });
});

/**
 * 弹速读数 —— 真机标定要读的就是这个数（"我到底弹得够快吗"）。
 *
 * 这里钉住的是一个**真机才会暴露的真 bug**：峰值恰恰出现在"甩开的那一帧"，
 * 而那一帧走完阶段已经变了；旧实现用 `loadedFrames > 0 ? peak : 0` 把读数
 * 一起抹掉了，于是调试面板永远显示 `弹速 0.00`。
 */
describe('弹速读数（调试面板的"我弹得够快吗"）', () => {
  it('甩开之后峰值仍然可读，并且保持住（曾经恒为 0.00）', () => {
    const detector = new FlickDetector();
    const t = load(detector);
    const flick = release(detector, t);
    expect(flick?.speed).toBeCloseTo(3.6, 6);
    expect(detector.armedFrames).toBe(0);
    expect(detector.peakTipSpeed).toBeCloseTo(3.6, 6);

    // 手张开不动：读数保持在面板上，人才来得及抬眼读
    detector.update(sample({ gap: 1.2, tip: { x: 0.5, y: 0.38 }, time: t + FRAME }), FRAME);
    expect(detector.peakTipSpeed).toBeCloseTo(3.6, 6);
  });

  it('甩开的增量与速度都留了读数（标定要看"差多少"）', () => {
    const detector = new FlickDetector();
    const t = load(detector);

    // gap 0.45 -> 0.68：增量 0.23，差 0.02 不达标
    detector.update(sample({ gap: 0.68, tip: { x: 0.5, y: 0.38 }, time: t }), FRAME);
    expect(detector.gapGain).toBeCloseTo(0.23, 6);
    expect(detector.releaseSpeed).toBeCloseTo(3.6, 6);
  });

  it('下一次开始扣住时读数清零（不会一直挂着上一轮的数字）', () => {
    const detector = new FlickDetector();
    const t = load(detector);
    release(detector, t);
    expect(detector.peakTipSpeed).toBeCloseTo(3.6, 6);

    load(detector, t + FRAME);
    expect(detector.armedFrames).toBe(2);
    expect(detector.peakTipSpeed).toBe(0);
    expect(detector.gapGain).toBe(0);
    expect(detector.releaseSpeed).toBe(0);
  });

  it('手离开画面之后读数清零', () => {
    const detector = new FlickDetector();
    const t = load(detector);
    release(detector, t);
    expect(detector.peakTipSpeed).toBeCloseTo(3.6, 6);

    detector.update(null, FRAME);
    expect(detector.peakTipSpeed).toBe(0);
    expect(detector.gapGain).toBe(0);
  });
});

describe('FlickDetector 各向同性', () => {
  it('同样的位移在不同画幅比下速度一致（y 会被换算）', () => {
    const run = (aspect: number): number => {
      const detector = new FlickDetector();
      const t = load(detector);
      const flick = release(detector, t, { tip: { x: 0.5, y: 0.5 - 0.06 * aspect }, aspect });
      return flick?.speed ?? 0;
    };
    // 画幅比 0.5 时，同样的"各向同性 0.06"对应场景 y 位移 0.03
    expect(run(0.5)).toBeCloseTo(run(1), 6);
    expect(run(0.5)).toBeCloseTo(0.06 / FRAME, 6);
  });
});
