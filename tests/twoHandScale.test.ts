import { describe, expect, it } from 'vitest';

import type { BehaviorContext, BehaviorViewport } from '@/core/behavior/behavior';
import { TwoHandScaleBehavior, TWO_HAND_SCALE_BEHAVIOR_TYPE } from '@/core/behavior/behaviors/twoHandScale';
import {
  createIdleInteractionState,
  createIdleTwoHandState,
  type ObjectInteractionState,
} from '@/core/interaction/types';
import { SceneObject } from '@/core/scene/object';

const VIEWPORT: BehaviorViewport = { width: 400, height: 800, aspect: 0.5, mirrored: true };

function contextFor(
  object: SceneObject,
  interaction: Partial<ObjectInteractionState>,
  dt = 1 / 60,
): BehaviorContext {
  return {
    dt,
    time: 0,
    frame: 1,
    gestures: null,
    interaction: { ...createIdleInteractionState(object.id), ...interaction },
    object,
    assetAspect: 1,
    scene: {
      size: 1,
      list: () => [object],
      get: (id: string) => (id === object.id ? object : undefined),
    },
    viewport: VIEWPORT,
  };
}

/** 抓住 + 双手成立；distanceRatio 是交互层算好的"两手间距相对加入瞬间的比值" */
function grabbing(distanceRatio: number, active = true): Partial<ObjectInteractionState> {
  return {
    grabbed: true,
    targetPosition: { x: 0.5, y: 0.5 },
    twoHand: active ? { active: true, distanceRatio } : createIdleTwoHandState(),
  };
}

function createObject(scale = 1): SceneObject {
  return SceneObject.create('obj-1', { position: { x: 0.5, y: 0.5 }, scale });
}

describe('TwoHandScaleBehavior', () => {
  it('没抓住时不缩放，即使交互层给了比例', () => {
    const behavior = new TwoHandScaleBehavior();
    const object = createObject();

    behavior.update(contextFor(object, { grabbed: false, twoHand: { active: true, distanceRatio: 3 } }));

    expect(object.state.scale).toBe(1);
  });

  it('抓住但没有双手 -> 完全不碰大小（单手指不动尺寸）', () => {
    // 这条正是"单手缩放改成双手"的核心收益：单手拖动永远不改尺寸，
    // 位置和大小彻底解耦，不可能再出现"一边拖一边颤"
    const behavior = new TwoHandScaleBehavior({ deadZone: 0, smoothing: 0 });
    const object = createObject(1.3);

    behavior.update(contextFor(object, { grabbed: true, targetPosition: { x: 0.5, y: 0.5 } }));
    for (let i = 0; i < 30; i += 1) {
      behavior.update(contextFor(object, { grabbed: true, targetPosition: { x: 0.6, y: 0.5 } }));
    }

    expect(object.state.scale).toBe(1.3);
  });

  it('双手张开 -> 按比例放大', () => {
    const behavior = new TwoHandScaleBehavior({ deadZone: 0, smoothing: 0 });
    const object = createObject();

    behavior.update(contextFor(object, grabbing(1)));
    behavior.update(contextFor(object, grabbing(1.8)));

    expect(object.state.scale).toBeCloseTo(1.8, 9);
  });

  it('双手收拢 -> 缩小', () => {
    const behavior = new TwoHandScaleBehavior({ deadZone: 0, smoothing: 0 });
    const object = createObject();

    behavior.update(contextFor(object, grabbing(1)));
    behavior.update(contextFor(object, grabbing(0.5)));

    expect(object.state.scale).toBeCloseTo(0.5, 9);
  });

  it('以会话开始时的 scale 为基准，而不是每帧累乘（手停住素材就停住）', () => {
    const behavior = new TwoHandScaleBehavior({ deadZone: 0, smoothing: 0 });
    const object = createObject(2);

    behavior.update(contextFor(object, grabbing(1))); // 基准 = 2
    for (let i = 0; i < 20; i += 1) behavior.update(contextFor(object, grabbing(1.5)));

    expect(object.state.scale).toBeCloseTo(3, 9);
  });

  it('死区内完全不动（第二只手刚搭上来的微动不该改变大小）', () => {
    const behavior = new TwoHandScaleBehavior({ deadZone: 0.05, smoothing: 0 });
    const object = createObject(1.4);

    behavior.update(contextFor(object, grabbing(1)));
    for (const noise of [1.02, 0.97, 1.04, 0.96]) {
      behavior.update(contextFor(object, grabbing(noise)));
    }

    expect(object.state.scale).toBeCloseTo(1.4, 9);
  });

  it('超出死区后才开始缩放，且缩放量不扣掉死区（手感线性）', () => {
    const behavior = new TwoHandScaleBehavior({ deadZone: 0.05, smoothing: 0 });
    const object = createObject(1);

    behavior.update(contextFor(object, grabbing(1)));
    behavior.update(contextFor(object, grabbing(1.5)));

    expect(object.state.scale).toBeCloseTo(1.5, 9);
  });

  it('夹在上下限之间', () => {
    const behavior = new TwoHandScaleBehavior({ minScale: 0.5, maxScale: 2, deadZone: 0, smoothing: 0 });
    const object = createObject(1);

    behavior.update(contextFor(object, grabbing(1)));
    behavior.update(contextFor(object, grabbing(10)));
    expect(object.state.scale).toBe(2);

    behavior.update(contextFor(object, grabbing(0.01)));
    expect(object.state.scale).toBe(0.5);
  });

  it('松手后再抓取，以当时的 scale 重新定基准（不会跨会话累乘）', () => {
    const behavior = new TwoHandScaleBehavior({ deadZone: 0, smoothing: 0 });
    const object = createObject(1);

    behavior.update(contextFor(object, grabbing(1)));
    behavior.update(contextFor(object, grabbing(2)));
    expect(object.state.scale).toBeCloseTo(2, 9);

    behavior.update(contextFor(object, { grabbed: false }));
    // 新会话：这次只放大 1.5 倍
    behavior.update(contextFor(object, grabbing(1)));
    behavior.update(contextFor(object, grabbing(1.5)));

    expect(object.state.scale).toBeCloseTo(3, 9);
  });

  it('第二只手离开后大小停在当前值，下次双手会话重新以当时大小定基准（不回弹、不跳）', () => {
    const behavior = new TwoHandScaleBehavior({ deadZone: 0, smoothing: 0 });
    const object = createObject(1);

    behavior.update(contextFor(object, grabbing(1)));
    behavior.update(contextFor(object, grabbing(2)));
    expect(object.state.scale).toBeCloseTo(2, 9);

    // 第二只手走人：仍抓着，但比例复位成 1
    for (let i = 0; i < 10; i += 1) behavior.update(contextFor(object, grabbing(1, false)));
    // 关键：大小停在 2，而不是弹回 1
    expect(object.state.scale).toBeCloseTo(2, 9);

    // 双手再次成立：比例 1 就是当前大小，张开到 1.5 → 3
    behavior.update(contextFor(object, grabbing(1)));
    behavior.update(contextFor(object, grabbing(1.5)));
    expect(object.state.scale).toBeCloseTo(3, 9);
  });

  it('手丢失宽限期内比例保持不变 -> 大小也跟着冻结', () => {
    const behavior = new TwoHandScaleBehavior({ deadZone: 0, smoothing: 0 });
    const object = createObject(1);

    behavior.update(contextFor(object, grabbing(1)));
    behavior.update(contextFor(object, grabbing(1.6)));

    // 宽限期：仍算抓住，但位置为空；双手比例保留最后一个值
    for (let i = 0; i < 5; i += 1) {
      behavior.update(
        contextFor(object, {
          grabbed: true,
          targetPosition: null,
          cursorPosition: null,
          twoHand: { active: true, distanceRatio: 1.6 },
        }),
      );
    }

    expect(object.state.scale).toBeCloseTo(1.6, 9);
  });

  it('素材声明 scalable = false 时只跟随，不改大小', () => {
    const behavior = new TwoHandScaleBehavior({ deadZone: 0, smoothing: 0 });
    const object = createObject(1);
    object.setInteractionConfig({ scalable: false });

    behavior.update(contextFor(object, grabbing(1)));
    behavior.update(contextFor(object, grabbing(2)));

    expect(object.state.scale).toBe(1);
  });

  it('serialize 能重建配置', () => {
    const behavior = new TwoHandScaleBehavior({ minScale: 0.3, maxScale: 3, deadZone: 0.05, smoothing: 0.02 });
    expect(behavior.type).toBe(TWO_HAND_SCALE_BEHAVIOR_TYPE);
    expect(behavior.serialize()).toEqual({ minScale: 0.3, maxScale: 3, deadZone: 0.05, smoothing: 0.02 });
  });

  it('参数非法时抛错', () => {
    expect(() => new TwoHandScaleBehavior({ minScale: 0 })).toThrow(RangeError);
    expect(() => new TwoHandScaleBehavior({ minScale: 2, maxScale: 1 })).toThrow(RangeError);
    expect(() => new TwoHandScaleBehavior({ deadZone: -1 })).toThrow(RangeError);
    expect(() => new TwoHandScaleBehavior({ smoothing: -0.1 })).toThrow(RangeError);
  });
});

describe('TwoHandScaleBehavior 输出平滑（"缩放时尺寸乱跳"的回归）', () => {
  it('一帧内到不了目标，多帧后收敛（尺寸变化有重量，不是逐帧跳）', () => {
    const behavior = new TwoHandScaleBehavior({ deadZone: 0, smoothing: 0.05 });
    const object = createObject(1);

    behavior.update(contextFor(object, grabbing(1)));
    behavior.update(contextFor(object, grabbing(2)));

    const afterOneFrame = object.state.scale;
    expect(afterOneFrame).toBeGreaterThan(1);
    expect(afterOneFrame).toBeLessThan(2);

    for (let i = 0; i < 120; i += 1) behavior.update(contextFor(object, grabbing(2)));
    expect(object.state.scale).toBeCloseTo(2, 3);
  });

  it('高频抖动被显著衰减（这是"震颤"的直接护栏）', () => {
    const behavior = new TwoHandScaleBehavior({ deadZone: 0, smoothing: 0.05 });
    const object = createObject(1);

    behavior.update(contextFor(object, grabbing(1)));

    // 双手方案的残余噪声比单手小，这里给一个保守的输入抖动：
    // 在 1.3 上下 ±0.03 来回摆（峰峰 0.06）
    const input = [1.27, 1.33];
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < 120; i += 1) {
      behavior.update(contextFor(object, grabbing(input[i % 2] ?? 1.3)));
      // 跳过起步收敛段，只看稳态振荡
      if (i > 40) {
        min = Math.min(min, object.state.scale);
        max = Math.max(max, object.state.scale);
      }
    }

    const outputPeakToPeak = max - min;
    const inputPeakToPeak = 0.06;
    // 输出峰峰值至少被压掉 4 倍，否则屏幕上就是肉眼可见的"一惊一乍"
    expect(outputPeakToPeak).toBeLessThan(inputPeakToPeak / 4);
  });

  it('与帧率无关：60fps 与 30fps 在相同时长后的尺寸一致', () => {
    const run = (dt: number, frames: number): number => {
      const behavior = new TwoHandScaleBehavior({ deadZone: 0, smoothing: 0.05 });
      const object = createObject(1);
      behavior.update(contextFor(object, grabbing(1), dt));
      for (let i = 0; i < frames; i += 1) behavior.update(contextFor(object, grabbing(2), dt));
      return object.state.scale;
    };

    // 同样 0.1 秒：60fps 跑 6 帧，30fps 跑 3 帧
    expect(Math.abs(run(1 / 60, 6) - run(1 / 30, 3))).toBeLessThan(0.005);
  });
});
