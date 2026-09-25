import { describe, expect, it } from 'vitest';

import type { BehaviorContext, BehaviorViewport } from '@/core/behavior/behavior';
import { FollowHandBehavior, FOLLOW_HAND_BEHAVIOR_TYPE } from '@/core/behavior/behaviors/followHand';
import { createIdleInteractionState, type ObjectInteractionState } from '@/core/interaction/types';
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

/** 抓住：素材当前位置（会话锚点）与手指所在的目标位置 */
function grabbed(_startPosition: { x: number; y: number }, target: { x: number; y: number }) {
  return { grabbed: true, targetPosition: target, cursorPosition: target, transition: 'grab' as const };
}

function createObject(position = { x: 0.5, y: 0.5 }): SceneObject {
  return SceneObject.create('obj-1', { position, size: { width: 0.4 } });
}

describe('FollowHandBehavior 基本跟随', () => {
  it('没被抓住时一动不动', () => {
    const behavior = new FollowHandBehavior({ smoothing: 0 });
    const object = createObject({ x: 0.3, y: 0.7 });

    for (let i = 0; i < 10; i += 1) {
      behavior.update(contextFor(object, { grabbed: false, targetPosition: { x: 0.9, y: 0.9 } }));
    }

    expect(object.state.position).toEqual({ x: 0.3, y: 0.7 });
  });

  it('gain=1 且不平滑时，素材精确落在交互层算出的目标位置（这就是"能拖动图片"）', () => {
    const behavior = new FollowHandBehavior({ smoothing: 0, gain: 1, deadZone: 0 });
    const object = createObject({ x: 0.5, y: 0.5 });

    behavior.update(contextFor(object, grabbed({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 })));
    behavior.update(contextFor(object, grabbed({ x: 0.5, y: 0.5 }, { x: 0.72, y: 0.31 })));

    expect(object.state.position.x).toBeCloseTo(0.72, 9);
    expect(object.state.position.y).toBeCloseTo(0.31, 9);
  });

  it('抓住的第一帧不动（抓取偏移已经由交互层算好，行为不该再跳一次）', () => {
    const behavior = new FollowHandBehavior({ smoothing: 0, gain: 1, deadZone: 0 });
    const object = createObject({ x: 0.5, y: 0.5 });

    behavior.update(contextFor(object, grabbed({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 })));

    expect(object.state.position).toEqual({ x: 0.5, y: 0.5 });
  });

  it('死区内的微小位移被忽略（手静止时素材不会"呼吸"）', () => {
    const behavior = new FollowHandBehavior({ smoothing: 0, deadZone: 0.02 });
    const object = createObject({ x: 0.5, y: 0.5 });

    behavior.update(contextFor(object, grabbed({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 })));
    // 目标位置一直在小幅抖动，但都在死区内
    for (let i = 0; i < 30; i += 1) {
      const jitter = i % 2 === 0 ? 0.012 : -0.012;
      behavior.update(contextFor(object, grabbed({ x: 0.5, y: 0.5 }, { x: 0.5 + jitter, y: 0.5 })));
    }

    expect(object.state.position.x).toBeCloseTo(0.5, 9);
  });

  it('超过死区后开始跟随，且死区不消耗增益（位移不会少走一段）', () => {
    const behavior = new FollowHandBehavior({ smoothing: 0, gain: 1, deadZone: 0.01 });
    const object = createObject({ x: 0.5, y: 0.5 });

    behavior.update(contextFor(object, grabbed({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 })));
    behavior.update(contextFor(object, grabbed({ x: 0.5, y: 0.5 }, { x: 0.6, y: 0.5 })));

    // 累计位移 0.1 全部生效，而不是 0.1 - 0.01
    expect(object.state.position.x).toBeCloseTo(0.6, 9);
  });

  it('gain < 1 时素材位移是手指位移的对应比例（便于精细摆放）', () => {
    const behavior = new FollowHandBehavior({ smoothing: 0, gain: 0.5, deadZone: 0 });
    const object = createObject({ x: 0.5, y: 0.5 });

    behavior.update(contextFor(object, grabbed({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 })));
    behavior.update(contextFor(object, grabbed({ x: 0.5, y: 0.5 }, { x: 0.7, y: 0.5 })));

    // 手指走了 0.2，素材走 0.1
    expect(object.state.position.x).toBeCloseTo(0.6, 9);
  });

  it('gain < 1 时不会产生"永远追不上"的稳态偏差（增益作用在累计位移上）', () => {
    const behavior = new FollowHandBehavior({ smoothing: 0, gain: 0.5, deadZone: 0 });
    const object = createObject({ x: 0.5, y: 0.5 });

    behavior.update(contextFor(object, grabbed({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 })));
    // 手停住不动，跑很多帧
    for (let i = 0; i < 60; i += 1) {
      behavior.update(contextFor(object, grabbed({ x: 0.5, y: 0.5 }, { x: 0.8, y: 0.5 })));
    }

    expect(object.state.position.x).toBeCloseTo(0.65, 9);
  });
});

describe('FollowHandBehavior 会话边界', () => {
  it('松手后素材停在原地', () => {
    const behavior = new FollowHandBehavior({ smoothing: 0, gain: 1, deadZone: 0 });
    const object = createObject({ x: 0.5, y: 0.5 });

    behavior.update(contextFor(object, grabbed({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 })));
    behavior.update(contextFor(object, grabbed({ x: 0.5, y: 0.5 }, { x: 0.7, y: 0.5 })));
    const moved = { ...object.state.position };

    for (let i = 0; i < 10; i += 1) {
      behavior.update(contextFor(object, { grabbed: false, targetPosition: null, transition: 'release' }));
    }

    expect(object.state.position).toEqual(moved);
  });

  it('再次抓取时以"当前位置"为新锚点，不会跳回旧位置', () => {
    const behavior = new FollowHandBehavior({ smoothing: 0, gain: 1, deadZone: 0 });
    const object = createObject({ x: 0.5, y: 0.5 });

    behavior.update(contextFor(object, grabbed({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 })));
    behavior.update(contextFor(object, grabbed({ x: 0.5, y: 0.5 }, { x: 0.8, y: 0.5 })));
    behavior.update(contextFor(object, { grabbed: false, targetPosition: null }));
    expect(object.state.position.x).toBeCloseTo(0.8, 9);

    // 素材还停在 0.8，手在别处（0.2）重新抓住：第一帧必须还是 0.8
    behavior.update(contextFor(object, grabbed({ x: 0.8, y: 0.5 }, { x: 0.8, y: 0.5 })));
    expect(object.state.position.x).toBeCloseTo(0.8, 9);

    // 手移动后按新锚点跟随
    behavior.update(contextFor(object, grabbed({ x: 0.8, y: 0.5 }, { x: 0.75, y: 0.5 })));
    expect(object.state.position.x).toBeCloseTo(0.75, 9);
  });

  it('抓住了但暂时拿不到手指位置（手丢失宽限期）时冻结，且会话不重置', () => {
    const behavior = new FollowHandBehavior({ smoothing: 0, gain: 1, deadZone: 0 });
    const object = createObject({ x: 0.5, y: 0.5 });

    behavior.update(contextFor(object, grabbed({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 })));
    behavior.update(contextFor(object, grabbed({ x: 0.5, y: 0.5 }, { x: 0.6, y: 0.5 })));
    const frozen = { ...object.state.position };

    // 宽限期：grabbed 仍为 true，但 targetPosition 为 null
    for (let i = 0; i < 5; i += 1) {
      behavior.update(contextFor(object, { grabbed: true, targetPosition: null, cursorPosition: null }));
    }
    expect(object.state.position).toEqual(frozen);

    // 手回来：仍然基于同一个会话锚点，不会跳
    behavior.update(contextFor(object, grabbed({ x: 0.5, y: 0.5 }, { x: 0.6, y: 0.5 })));
    expect(object.state.position.x).toBeCloseTo(0.6, 9);
  });
});

describe('FollowHandBehavior 平滑', () => {
  it('smoothing > 0 时一帧内到不了目标，多帧后收敛', () => {
    const behavior = new FollowHandBehavior({ smoothing: 0.05, gain: 1, deadZone: 0 });
    const object = createObject({ x: 0.5, y: 0.5 });

    behavior.update(contextFor(object, grabbed({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 })));
    behavior.update(contextFor(object, grabbed({ x: 0.5, y: 0.5 }, { x: 0.8, y: 0.5 })));

    const afterOneFrame = object.state.position.x;
    expect(afterOneFrame).toBeGreaterThan(0.5);
    expect(afterOneFrame).toBeLessThan(0.8);

    for (let i = 0; i < 120; i += 1) {
      behavior.update(contextFor(object, grabbed({ x: 0.5, y: 0.5 }, { x: 0.8, y: 0.5 })));
    }
    expect(object.state.position.x).toBeCloseTo(0.8, 3);
  });

  it('平滑与帧率无关：60fps 与 30fps 在相同时长后的位置一致', () => {
    const run = (dt: number, frames: number): number => {
      const behavior = new FollowHandBehavior({ smoothing: 0.05, gain: 1, deadZone: 0 });
      const object = createObject({ x: 0.5, y: 0.5 });
      behavior.update(contextFor(object, grabbed({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }), dt));
      for (let i = 0; i < frames; i += 1) {
        behavior.update(contextFor(object, grabbed({ x: 0.5, y: 0.5 }, { x: 0.9, y: 0.5 }), dt));
      }
      return object.state.position.x;
    };

    // 同样 0.1 秒：60fps 跑 6 帧，30fps 跑 3 帧
    const at60 = run(1 / 60, 6);
    const at30 = run(1 / 30, 3);

    expect(Math.abs(at60 - at30)).toBeLessThan(0.005);
  });

  it('serialize 返回可重建行为的配置', () => {
    const behavior = new FollowHandBehavior({ deadZone: 0.01, gain: 0.8, smoothing: 0.02 });
    expect(behavior.type).toBe(FOLLOW_HAND_BEHAVIOR_TYPE);
    expect(behavior.serialize()).toEqual({ deadZone: 0.01, gain: 0.8, smoothing: 0.02 });
  });

  it('参数非法时抛错', () => {
    expect(() => new FollowHandBehavior({ deadZone: -1 })).toThrow(RangeError);
    expect(() => new FollowHandBehavior({ gain: 0 })).toThrow(RangeError);
    expect(() => new FollowHandBehavior({ smoothing: -0.1 })).toThrow(RangeError);
  });

  it('两个素材各自独立会话（一个抓着一个没抓）', () => {
    const behaviorA = new FollowHandBehavior({ smoothing: 0, gain: 1, deadZone: 0 });
    const behaviorB = new FollowHandBehavior({ smoothing: 0, gain: 1, deadZone: 0 });
    const objectA = SceneObject.create('a', { position: { x: 0.3, y: 0.5 } });
    const objectB = SceneObject.create('b', { position: { x: 0.7, y: 0.5 } });

    behaviorA.update(contextFor(objectA, grabbed({ x: 0.3, y: 0.5 }, { x: 0.3, y: 0.5 })));
    behaviorB.update(contextFor(objectB, { grabbed: false, targetPosition: null }));

    behaviorA.update(contextFor(objectA, grabbed({ x: 0.3, y: 0.5 }, { x: 0.45, y: 0.5 })));
    behaviorB.update(contextFor(objectB, { grabbed: false, targetPosition: null }));

    expect(objectA.state.position.x).toBeCloseTo(0.45, 9);
    expect(objectB.state.position.x).toBeCloseTo(0.7, 9);
  });
});
