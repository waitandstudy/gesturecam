import { describe, expect, it } from 'vitest';

import { Viewport } from '@/core/coords/viewport';
import type { FlickEvent } from '@/core/gesture/flick';
import {
  createIdleGestures,
  type ContinuousGestures,
  type GestureEvent,
  type GestureState,
  type PinchState,
  type TwoHandState,
} from '@/core/gesture/types';
import type { Handedness } from '@/core/hand/handState';
import { InteractionManager } from '@/core/interaction/interactionManager';
import type { Vec2 } from '@/core/math/vec2';
import { SceneObject } from '@/core/scene/object';
import type { ObjectState, ObjectStatePatch } from '@/core/scene/types';

const DT = 1 / 60;

function createViewport(): Viewport {
  // 竖屏画布 + 横屏摄像头；输出画幅等于画布，数值断言更直观
  return new Viewport({ width: 1280, height: 720 }, { width: 400, height: 800 }, {
    mirrored: false,
    outputAspect: 0.5,
  });
}

/**
 * 捏合状态（手势文法的"鼠标左键"）。
 *
 * `gap` 只是给用户看的读数 —— 判定本身早就在手势层做完了，交互层只消费
 * `active` / `center` / `handedness` / `shape`。
 */
function pinch(gap: number, center: Vec2, handedness: Handedness = 'right'): PinchState {
  return { active: true, handedness, shape: 'pinch', center, gap };
}

/** 非捏合的手：用来构造"另一只手只是放在画面里"或"握拳急停"这类场景。 */
function otherHand(shape: PinchState['shape'], handedness: Handedness): PinchState {
  return { active: false, handedness, shape, center: null, gap: null };
}

/**
 * 双手状态。`rawDistance` 默认等于 `distance`（静止时两者本来就一致），
 * 需要单独构造"基准取自原始值"的场景时再显式给。
 */
function twoHand(center: Vec2, distance: number, rawDistance = distance): TwoHandState {
  return { active: true, center, distance, rawDistance };
}

function gestures(
  patch: Partial<ContinuousGestures> = {},
  events: readonly GestureEvent[] = [],
  time = 0,
  flicks: readonly FlickEvent[] = [],
): GestureState {
  return { time, controls: { ...createIdleGestures(), ...patch }, events, flicks, snaps: [] };
}

function startEvent(position: Vec2, hand: Handedness = 'right', time = 0): GestureEvent {
  return { type: 'gesture-start', gesture: 'pinch', hand, position, time };
}

function endEvent(position: Vec2, hand: Handedness = 'right', time = 0): GestureEvent {
  return { type: 'gesture-end', gesture: 'pinch', hand, position, time };
}

interface RunOptions {
  dt?: number;
  time?: number;
  viewport?: Viewport;
  aspectOf?: (state: Readonly<ObjectState>) => number;
}

function run(
  manager: InteractionManager,
  objects: readonly SceneObject[],
  state: GestureState | null,
  options: RunOptions = {},
): void {
  manager.update({
    dt: options.dt ?? DT,
    time: options.time ?? 0,
    gestures: state,
    viewport: options.viewport ?? createViewport(),
    objects,
    aspectOf: options.aspectOf ?? (() => 1),
  });
}

/** 场景中央一个 0.4 宽、正方形纹理的素材：屏幕包围盒 x∈[120,280] y∈[320,480] */
function createCenterObject(id = 'obj-1', patch: ObjectStatePatch = {}): SceneObject {
  return SceneObject.create(id, { position: { x: 0.5, y: 0.5 }, size: { width: 0.4 }, ...patch });
}

describe('InteractionManager 命中与抓取', () => {
  it('空闲时返回兜底状态，行为侧不需要判空', () => {
    const manager = new InteractionManager();

    expect(manager.get('never-existed').grabbed).toBe(false);
    expect(manager.get('never-existed').targetPosition).toBeNull();
    expect(manager.grabbedIds()).toEqual([]);
    expect(manager.size).toBe(0);
  });

  it('参数非法时抛错', () => {
    expect(() => new InteractionManager({ grabHitMarginFrac: -1 })).toThrow(RangeError);
    expect(() => new InteractionManager({ releaseTimeoutSeconds: -0.1 })).toThrow(RangeError);
  });

  it('捏合落在素材上 -> 抓住，且首帧目标位置等于原地（不跳）', () => {
    const manager = new InteractionManager();
    const object = createCenterObject();

    run(manager, [object], gestures({ pinch: pinch(0.1, { x: 0.45, y: 0.45 }) }, [startEvent({ x: 0.45, y: 0.45 })]));

    const state = manager.get(object.id);
    expect(state.grabbed).toBe(true);
    expect(state.grabbedBy).toBe('right');
    expect(state.transition).toBe('grab');
    expect(state.grabOffset.x).toBeCloseTo(-0.05, 9);
    expect(state.grabOffset.y).toBeCloseTo(-0.05, 9);
    expect(state.targetPosition).toEqual({ x: 0.5, y: 0.5 });
    expect(state.dragDelta).toEqual({ x: 0, y: 0 });
  });

  it('抓取偏移被保持：手指移动多少，目标位置就移动多少', () => {
    const manager = new InteractionManager();
    const object = createCenterObject();

    run(manager, [object], gestures({ pinch: pinch(0.1, { x: 0.45, y: 0.45 }) }, [startEvent({ x: 0.45, y: 0.45 })]));
    run(manager, [object], gestures({ pinch: pinch(0.1, { x: 0.55, y: 0.5 }) }), { time: DT });

    const state = manager.get(object.id);
    // 手指 0.45 抓在素材中心偏左上 0.05；手指移到 0.55 时素材应到 0.60
    expect(state.targetPosition?.x).toBeCloseTo(0.6, 9);
    expect(state.targetPosition?.y).toBeCloseTo(0.55, 9);
    expect(state.dragDelta.x).toBeCloseTo(0.1, 9);
    expect(state.dragDelta.y).toBeCloseTo(0.05, 9);
    expect(state.transition).toBe('move');
    expect(state.grabDuration).toBeCloseTo(DT, 9);
  });

  it('捏合落在素材之外 -> 不抓', () => {
    const manager = new InteractionManager();
    const object = createCenterObject();

    run(manager, [object], gestures({ pinch: pinch(0.1, { x: 0.95, y: 0.05 }) }, [startEvent({ x: 0.95, y: 0.05 })]));

    expect(manager.grabbedIds()).toEqual([]);
  });

  it('宽容边距让"差一点点"的捏合也能抓住（handy 的 GRAB_HIT_MARGIN_FRAC）', () => {
    const manager = new InteractionManager();
    const object = createCenterObject();
    // 素材场景包围盒 x∈[0.3,0.7]；0.06 * 400px = 24px = 场景 0.06
    run(manager, [object], gestures({ pinch: pinch(0.1, { x: 0.74, y: 0.5 }) }, [startEvent({ x: 0.74, y: 0.5 })]));

    expect(manager.grabbedIds()).toEqual([object.id]);
  });

  it('超出宽容边距仍然抓不住', () => {
    const manager = new InteractionManager();
    const object = createCenterObject();

    run(manager, [object], gestures({ pinch: pinch(0.1, { x: 0.85, y: 0.5 }) }, [startEvent({ x: 0.85, y: 0.5 })]));

    expect(manager.grabbedIds()).toEqual([]);
  });

  it('把宽容边距设为 0 就退化成精确命中', () => {
    const manager = new InteractionManager({ grabHitMarginFrac: 0 });
    const object = createCenterObject();

    run(manager, [object], gestures({ pinch: pinch(0.1, { x: 0.74, y: 0.5 }) }, [startEvent({ x: 0.74, y: 0.5 })]));

    expect(manager.grabbedIds()).toEqual([]);
  });

  it('grabbable=false 的素材抓不住（不需要在管理器里写死特例）', () => {
    const manager = new InteractionManager();
    const object = createCenterObject('obj-locked', {
      interaction: { grabbable: false, scalable: false, rotatable: false },
    });

    run(manager, [object], gestures({ pinch: pinch(0.1, { x: 0.5, y: 0.5 }) }, [startEvent({ x: 0.5, y: 0.5 })]));

    expect(manager.grabbedIds()).toEqual([]);
  });

  it('visible=false 的素材抓不住', () => {
    const manager = new InteractionManager();
    const object = createCenterObject('obj-hidden', { visible: false });

    run(manager, [object], gestures({ pinch: pinch(0.1, { x: 0.5, y: 0.5 }) }, [startEvent({ x: 0.5, y: 0.5 })]));

    expect(manager.grabbedIds()).toEqual([]);
  });

  it('多个素材重叠时抓最上层（zIndex 最大的那个）', () => {
    const manager = new InteractionManager();
    const bottom = createCenterObject('bottom');
    const top = createCenterObject('top');
    bottom.setZIndex(0);
    top.setZIndex(5);

    run(manager, [bottom, top], gestures({ pinch: pinch(0.1, { x: 0.5, y: 0.5 }) }, [startEvent({ x: 0.5, y: 0.5 })]));

    expect(manager.grabbedIds()).toEqual(['top']);
  });

  it('同一只手松开后换抓另一个素材：先前抓着的那个被释放', () => {
    const manager = new InteractionManager();
    const a = createCenterObject('a');
    const b = SceneObject.create('b', { position: { x: 0.5, y: 0.5 }, size: { width: 0.2 } });

    run(manager, [a, b], gestures({ pinch: pinch(0.1, { x: 0.5, y: 0.5 }) }, [startEvent({ x: 0.5, y: 0.5 })]));
    expect(manager.grabbedIds()).toEqual(['b']);

    // 真实管线里"换抓"必然先经过一次 gesture-end（迟滞掉下去），再重新捏合
    run(manager, [a, b], gestures({}, [endEvent({ x: 0.5, y: 0.5 })]), { time: DT });
    expect(manager.grabbedIds()).toEqual([]);

    a.setZIndex(10);
    run(manager, [a, b], gestures({ pinch: pinch(0.1, { x: 0.5, y: 0.5 }) }, [startEvent({ x: 0.5, y: 0.5 })], DT * 2), {
      time: 2 * DT,
    });

    // 即便传入顺序没变，也应该按 zIndex 抓到 a
    expect(manager.grabbedIds()).toEqual(['a']);
    expect(manager.get('b').grabbed).toBe(false);
  });

  it('同一只手的重复 start 被忽略（真机：第二只手出现导致槽位对调，会多发一次 start）', () => {
    // 回归：抓取会话按左右手记账，捏合状态按槽位排。槽位一旦对调，
    // 抓着手的那只手会在新槽位里"第一次"触发 pinch，于是又发一次 gesture-start。
    // 以前这会先释放掉正在进行的抓取，然后因为新位置不在素材上而抓不到新的 ——
    // 结果就是"第二只手一捏上，图片就掉了"。
    const manager = new InteractionManager();
    const object = createCenterObject();

    run(manager, [object], gestures({ pinch: pinch(0.1, { x: 0.5, y: 0.5 }) }, [startEvent({ x: 0.5, y: 0.5 })]));
    expect(manager.grabbedIds()).toEqual([object.id]);
    const originalOffset = { ...manager.get(object.id).grabOffset };

    // 重复的 start，而且位置在素材之外（槽位对调时另一只手离得很远）
    run(manager, [object], gestures({ pinch: pinch(0.1, { x: 0.5, y: 0.5 }) }, [startEvent({ x: 0.95, y: 0.5 })]), {
      time: DT,
    });

    expect(manager.grabbedIds()).toEqual([object.id]);
    expect(manager.get(object.id).grabbed).toBe(true);
    // 会话没有被重开：抓取偏移保持不变
    expect(manager.get(object.id).grabOffset).toEqual(originalOffset);
  });
});

describe('InteractionManager 移到素材上才抓住（宽限窗口）', () => {
  it('捏合起点在素材外，随后手指移进素材 -> 在窗口内补抓', () => {
    const manager = new InteractionManager({ grabEntryWindowSeconds: 0.7 });
    const object = createCenterObject();

    // 起手捏在素材外（右边很远处）
    run(manager, [object], gestures({ pinch: pinch(0.1, { x: 0.95, y: 0.5 }) }, [startEvent({ x: 0.95, y: 0.5 })]));
    expect(manager.grabbedIds()).toEqual([]);

    // 手指移到素材上（0.2 秒后，仍在窗口内）
    run(manager, [object], gestures({ pinch: pinch(0.1, { x: 0.5, y: 0.5 }) }), { time: 0.2 });

    expect(manager.grabbedIds()).toEqual([object.id]);
    expect(manager.get(object.id).transition).toBe('grab');
  });

  it('超出窗口后再移进素材不会补抓（避免长时间捏着的手划过什么就粘住什么）', () => {
    const manager = new InteractionManager({ grabEntryWindowSeconds: 0.3 });
    const object = createCenterObject();

    run(manager, [object], gestures({ pinch: pinch(0.1, { x: 0.95, y: 0.5 }) }, [startEvent({ x: 0.95, y: 0.5 })]));
    // 1 秒后才移到素材上
    run(manager, [object], gestures({ pinch: pinch(0.1, { x: 0.5, y: 0.5 }) }), { time: 1.0 });

    expect(manager.grabbedIds()).toEqual([]);
  });

  it('窗口内移动但没有压到素材，也不会抓', () => {
    const manager = new InteractionManager();
    const object = createCenterObject();

    run(manager, [object], gestures({ pinch: pinch(0.1, { x: 0.95, y: 0.5 }) }, [startEvent({ x: 0.95, y: 0.5 })]));
    run(manager, [object], gestures({ pinch: pinch(0.1, { x: 0.9, y: 0.5 }) }), { time: 0.1 });

    expect(manager.grabbedIds()).toEqual([]);
  });
});

describe('InteractionManager 准星（previewTargetId）', () => {
  it('没捏合时也给出"捏下去会抓到谁"，用的是同一套命中判定', () => {
    const manager = new InteractionManager();
    const object = createCenterObject();

    // 手在素材上但还没捏合：center 为 null，只有 pinchPoint 有值
    run(manager, [object], gestures({ pinchPoint: { x: 0.5, y: 0.5 } }));

    expect(manager.get(object.id).grabbed).toBe(false);
    expect(manager.previewTargetId).toBe(object.id);
  });

  it('准星不在素材上时预览为空', () => {
    const manager = new InteractionManager();
    const object = createCenterObject();

    run(manager, [object], gestures({ pinchPoint: { x: 0.95, y: 0.05 } }));

    expect(manager.previewTargetId).toBeNull();
  });

  it('抓住之后准星指向被抓住的那个素材', () => {
    const manager = new InteractionManager();
    const object = createCenterObject();

    run(
      manager,
      [object],
      gestures({ pinch: pinch(0.1, { x: 0.5, y: 0.5 }), pinchPoint: { x: 0.5, y: 0.5 } }, [
        startEvent({ x: 0.5, y: 0.5 }),
      ]),
    );
    // 手移开后 previewTarget 仍然是被抓住的那个（不是手指下面的新目标）
    run(manager, [object], gestures({ pinch: pinch(0.1, { x: 0.9, y: 0.5 }), pinchPoint: { x: 0.9, y: 0.5 } }), {
      time: DT,
    });

    expect(manager.previewTargetId).toBe(object.id);
  });

  it('重叠时准星指向最上层（与实际抓取一致）', () => {
    const manager = new InteractionManager();
    const bottom = createCenterObject('bottom');
    const top = createCenterObject('top');
    bottom.setZIndex(0);
    top.setZIndex(3);

    run(manager, [bottom, top], gestures({ pinchPoint: { x: 0.5, y: 0.5 } }));

    expect(manager.previewTargetId).toBe('top');
  });
});

describe('InteractionManager 释放与超时', () => {
  it('捏合结束触发释放，目标位置清空但 dragDelta 保留（投掷要用）', () => {
    const manager = new InteractionManager();
    const object = createCenterObject();

    run(manager, [object], gestures({ pinch: pinch(0.1, { x: 0.4, y: 0.4 }) }, [startEvent({ x: 0.4, y: 0.4 })]));
    run(manager, [object], gestures({ pinch: pinch(0.1, { x: 0.5, y: 0.5 }) }), { time: DT });
    run(manager, [object], gestures({}, [endEvent({ x: 0.5, y: 0.5 })]), { time: 2 * DT });

    const state = manager.get(object.id);
    expect(state.grabbed).toBe(false);
    expect(state.transition).toBe('release');
    expect(state.targetPosition).toBeNull();
    expect(state.dragDelta.x).toBeCloseTo(0.1, 9);
  });

  it('一次性的 transition 只存活一帧', () => {
    const manager = new InteractionManager();
    const object = createCenterObject();

    run(manager, [object], gestures({ pinch: pinch(0.1, { x: 0.5, y: 0.5 }) }, [startEvent({ x: 0.5, y: 0.5 })]));
    expect(manager.get(object.id).transition).toBe('grab');

    run(manager, [object], gestures({ pinch: pinch(0.1, { x: 0.5, y: 0.5 }) }), { time: DT });
    expect(manager.get(object.id).transition).toBe('move');

    run(manager, [object], gestures({}, [endEvent({ x: 0.5, y: 0.5 })]), { time: 2 * DT });
    expect(manager.get(object.id).transition).toBe('release');

    run(manager, [object], gestures({}), { time: 3 * DT });
    expect(manager.get(object.id).transition).toBe('none');
  });

  it('手指短暂丢失时保持抓取（避免手甩出画面就掉）', () => {
    const manager = new InteractionManager({ releaseTimeoutSeconds: 0.3 });
    const object = createCenterObject();

    run(manager, [object], gestures({ pinch: pinch(0.1, { x: 0.5, y: 0.5 }) }, [startEvent({ x: 0.5, y: 0.5 })]));

    for (let i = 1; i <= 10; i += 1) run(manager, [object], null, { time: i * DT });
    expect(manager.get(object.id).grabbed).toBe(true);
  });

  it('手丢失期间素材被冻结；手回来时重新锚定，不跳', () => {
    const manager = new InteractionManager({ releaseTimeoutSeconds: 1 });
    const object = createCenterObject();

    run(manager, [object], gestures({ pinch: pinch(0.1, { x: 0.5, y: 0.5 }) }, [startEvent({ x: 0.5, y: 0.5 })]));
    const frozenTarget = { ...(manager.get(object.id).targetPosition ?? { x: 0, y: 0 }) };

    // 手丢了两帧
    run(manager, [object], null, { time: DT });
    run(manager, [object], null, { time: 2 * DT });
    expect(manager.get(object.id).targetPosition).toEqual(frozenTarget);

    // 手在别处回来：应该重锚，目标位置仍是原地、增量归零（而不是瞬移到手指下）
    run(manager, [object], gestures({ pinch: pinch(0.1, { x: 0.7, y: 0.5 }) }), { time: 3 * DT });
    const resumed = manager.get(object.id);
    expect(resumed.targetPosition?.x).toBeCloseTo(frozenTarget.x, 9);
    expect(resumed.dragDelta.x).toBeCloseTo(0, 9);

    // 之后继续移动就按新锚点跟随
    run(manager, [object], gestures({ pinch: pinch(0.1, { x: 0.75, y: 0.5 }) }), { time: 4 * DT });
    expect(manager.get(object.id).targetPosition?.x).toBeCloseTo(0.55, 9);
  });

  it('手指持续丢失超过超时时间后自动释放并打标记', () => {
    const manager = new InteractionManager({ releaseTimeoutSeconds: 0.1 });
    const object = createCenterObject();

    run(manager, [object], gestures({ pinch: pinch(0.1, { x: 0.5, y: 0.5 }) }, [startEvent({ x: 0.5, y: 0.5 })]));

    run(manager, [object], null, { dt: 0.05, time: 0.05 });
    expect(manager.get(object.id).grabbed).toBe(true);

    run(manager, [object], null, { dt: 0.06, time: 0.11 });
    const state = manager.get(object.id);
    expect(state.grabbed).toBe(false);
    expect(state.releasedByTimeout).toBe(true);

    // 标记同样只存活一帧
    run(manager, [object], null, { dt: 0.01, time: 0.12 });
    expect(manager.get(object.id).releasedByTimeout).toBe(false);
  });
});

describe('InteractionManager 双手缩放会话', () => {
  /** 双手状态：两只手都在捏合，center 是两手中点、distance 是两手间距 */
  const TWO_HAND_START = twoHand({ x: 0.5, y: 0.5 }, 0.4);

  it('没抓住素材时双手状态是 inactive（不会凭空缩放）', () => {
    const manager = new InteractionManager();
    const object = createCenterObject();

    run(manager, [object], gestures({ twoHand: TWO_HAND_START }));

    expect(manager.get(object.id).twoHand.active).toBe(false);
    expect(manager.get(object.id).twoHand.distanceRatio).toBe(1);
  });

  it('抓住后双手成立 -> 以"第二只手加入时"的间距为基准给出倍率', () => {
    const manager = new InteractionManager();
    const object = createCenterObject();

    // 先单手抓住素材中央
    run(manager, [object], gestures({ pinch: pinch(0.1, { x: 0.5, y: 0.5 }) }, [startEvent({ x: 0.5, y: 0.5 })]));
    expect(manager.get(object.id).grabbed).toBe(true);

    // 第二只手加入：基准 = 0.4
    run(manager, [object], gestures({ pinch: pinch(0.1, { x: 0.5, y: 0.5 }), twoHand: TWO_HAND_START }), {
      time: DT,
    });
    expect(manager.get(object.id).twoHand.active).toBe(true);
    expect(manager.get(object.id).twoHand.distanceRatio).toBeCloseTo(1, 9);

    // 两手拉开到 0.8 -> 2 倍
    run(
      manager,
      [object],
      gestures({ pinch: pinch(0.1, { x: 0.5, y: 0.5 }), twoHand: twoHand({ x: 0.5, y: 0.5 }, 0.8) }),
      { time: 2 * DT },
    );
    expect(manager.get(object.id).twoHand.distanceRatio).toBeCloseTo(2, 9);

    // 两手收拢到 0.2 -> 0.5 倍
    run(
      manager,
      [object],
      gestures({ pinch: pinch(0.1, { x: 0.5, y: 0.5 }), twoHand: twoHand({ x: 0.5, y: 0.5 }, 0.2) }),
      { time: 3 * DT },
    );
    expect(manager.get(object.id).twoHand.distanceRatio).toBeCloseTo(0.5, 9);
  });

  it('双手不成立时倍率回到 1，且素材不会被拉走', () => {
    const manager = new InteractionManager();
    const object = createCenterObject();

    run(manager, [object], gestures({ pinch: pinch(0.1, { x: 0.5, y: 0.5 }) }, [startEvent({ x: 0.5, y: 0.5 })]));
    run(manager, [object], gestures({ pinch: pinch(0.1, { x: 0.5, y: 0.5 }), twoHand: TWO_HAND_START }), {
      time: DT,
    });

    // 第二只手离开：回到单手跟手
    run(manager, [object], gestures({ pinch: pinch(0.1, { x: 0.5, y: 0.5 }) }), { time: 2 * DT });

    const state = manager.get(object.id);
    expect(state.twoHand.active).toBe(false);
    expect(state.twoHand.distanceRatio).toBe(1);
    expect(state.targetPosition).toEqual({ x: 0.5, y: 0.5 });
  });

  it('位置由两手中点控制：中点在哪儿，素材就跟着去哪儿（保持加入时的偏移）', () => {
    const manager = new InteractionManager();
    const object = createCenterObject();

    // 在素材中央抓住
    run(manager, [object], gestures({ pinch: pinch(0.1, { x: 0.5, y: 0.5 }) }, [startEvent({ x: 0.5, y: 0.5 })]));

    // 第二只手在右侧加入，两手中点在 (0.5, 0.5) -> 偏移 0，倍率基准 0.4
    run(manager, [object], gestures({ pinch: pinch(0.1, { x: 0.3, y: 0.5 }), twoHand: TWO_HAND_START }), {
      time: DT,
    });

    // 两手整体右移，中点到了 0.7，同时拉开到 0.6（比例 1.5）
    run(
      manager,
      [object],
      gestures({ pinch: pinch(0.4, { x: 0.5, y: 0.5 }), twoHand: twoHand({ x: 0.7, y: 0.5 }, 0.6) }),
      { time: 2 * DT },
    );

    const state = manager.get(object.id);
    // 位置跟的是**两手中点**，不是某一根手指 —— 这正是"位置与大小解耦"的关键
    expect(state.targetPosition).toEqual({ x: 0.7, y: 0.5 });
    expect(state.twoHand.distanceRatio).toBeCloseTo(1.5, 9);
    expect(state.cursorPosition).toEqual({ x: 0.7, y: 0.5 });
  });

  it('素材不在两手中点时，加入那一刻的偏移被保留（素材不会跳到中点下）', () => {
    const manager = new InteractionManager();
    // 素材在 (0.3, 0.5)
    const object = SceneObject.create('obj-1', { position: { x: 0.3, y: 0.5 }, size: { width: 0.4 } });

    run(manager, [object], gestures({ pinch: pinch(0.1, { x: 0.3, y: 0.5 }) }, [startEvent({ x: 0.3, y: 0.5 })]));

    // 两手加入时中点在 (0.6, 0.5) -> 偏移 (-0.3, 0)。首帧目标位置必须还是原地
    run(manager, [object], gestures({ pinch: pinch(0.1, { x: 0.4, y: 0.5 }), twoHand: twoHand({ x: 0.6, y: 0.5 }, 0.4) }), {
      time: DT,
    });
    expect(manager.get(object.id).targetPosition).toEqual({ x: 0.3, y: 0.5 });

    // 中点右移到 0.8 -> 素材跟到 0.5（偏移 -0.3 保持不变）
    run(manager, [object], gestures({ pinch: pinch(0.4, { x: 0.5, y: 0.5 }), twoHand: twoHand({ x: 0.8, y: 0.5 }, 0.4) }), {
      time: 2 * DT,
    });
    expect(manager.get(object.id).targetPosition?.x).toBeCloseTo(0.5, 9);
  });

  it('双手结束后回到单手跟手，且以当前位置重锚（不会跳一下）', () => {
    const manager = new InteractionManager();
    const object = createCenterObject();

    run(manager, [object], gestures({ pinch: pinch(0.1, { x: 0.5, y: 0.5 }) }, [startEvent({ x: 0.5, y: 0.5 })]));
    run(manager, [object], gestures({ pinch: pinch(0.1, { x: 0.3, y: 0.5 }), twoHand: TWO_HAND_START }), {
      time: DT,
    });
    // 两手中点带到 0.7
    run(
      manager,
      [object],
      gestures({ pinch: pinch(0.4, { x: 0.5, y: 0.5 }), twoHand: twoHand({ x: 0.7, y: 0.5 }, 0.4) }),
      { time: 2 * DT },
    );

    // 场景里素材真的被行为搬到了 0.7 才重锚；这里模拟行为已经把位置写回去
    object.setPosition({ x: 0.7, y: 0.5 });

    // 第二只手走人，只剩一只手还在 0.5 的位置
    run(manager, [object], gestures({ pinch: pinch(0.1, { x: 0.5, y: 0.5 }) }), { time: 3 * DT });

    // 重锚之后目标位置就是素材当前所在处，不会瞬间跳到手指下面
    expect(manager.get(object.id).targetPosition).toEqual({ x: 0.7, y: 0.5 });
    // 再移动手指时，是相对重锚点平移
    run(manager, [object], gestures({ pinch: pinch(0.1, { x: 0.6, y: 0.5 }) }), { time: 4 * DT });
    expect(manager.get(object.id).targetPosition?.x).toBeCloseTo(0.8, 9);
  });

  it('第二只手捏在同一张图上：会话仍归先抓住的那只手（拖动不会易主）', () => {
    const manager = new InteractionManager();
    const object = createCenterObject();

    run(manager, [object], gestures({ pinch: pinch(0.1, { x: 0.5, y: 0.5 }) }, [startEvent({ x: 0.5, y: 0.5 })]));
    expect(manager.get(object.id).grabbedBy).toBe('right');
    const firstOffset = { ...manager.get(object.id).grabOffset };

    // 左手也捏在同一张图上（双手缩放的主要用法）
    run(
      manager,
      [object],
      gestures(
        { pinch: pinch(0.1, { x: 0.45, y: 0.5 }, 'left'), twoHand: twoHand({ x: 0.5, y: 0.5 }, 0.4) },
        [startEvent({ x: 0.45, y: 0.5 }, 'left')],
      ),
      { time: DT },
    );

    // 抓取会话没有被抢走、也没有被重开
    expect(manager.grabbedIds()).toEqual([object.id]);
    expect(manager.get(object.id).grabbedBy).toBe('right');
    expect(manager.get(object.id).grabOffset).toEqual(firstOffset);
    expect(manager.get(object.id).twoHand.active).toBe(true);
  });

  it('两只手各抓一张图时不启用双手缩放（否则两张图会叠到同一个中点上）', () => {
    const manager = new InteractionManager();
    const a = SceneObject.create('a', { position: { x: 0.25, y: 0.5 }, size: { width: 0.2 } });
    const b = SceneObject.create('b', { position: { x: 0.75, y: 0.5 }, size: { width: 0.2 } });

    // 右手抓 b、左手抓 a
    run(manager, [a, b], gestures({ pinch: pinch(0.1, { x: 0.75, y: 0.5 }) }, [startEvent({ x: 0.75, y: 0.5 })]));
    expect(manager.grabbedIds()).toEqual(['b']);

    run(
      manager,
      [a, b],
      gestures(
        { pinch: pinch(0.1, { x: 0.25, y: 0.5 }, 'left'), twoHand: twoHand({ x: 0.5, y: 0.5 }, 0.4) },
        [startEvent({ x: 0.25, y: 0.5 }, 'left')],
      ),
      { time: DT },
    );
    expect(manager.grabbedIds().sort()).toEqual(['a', 'b']);

    // 两只手都在捏合，但**有两个素材被抓住** -> 双手缩放不生效，各拖各的
    run(
      manager,
      [a, b],
      gestures(
        {
          pinch: pinch(0.1, { x: 0.25, y: 0.5 }, 'left'),
          twoHand: twoHand({ x: 0.6, y: 0.5 }, 0.8),
        },
        [],
        DT * 2,
      ),
      { time: 2 * DT },
    );

    expect(manager.get('a').twoHand.active).toBe(false);
    expect(manager.get('b').twoHand.active).toBe(false);
    expect(manager.get('a').grabbed).toBe(true);
    expect(manager.get('b').grabbed).toBe(true);
  });

  it('倍率有绝对上下限保护（异常数据不会算出天文数字）', () => {
    const manager = new InteractionManager();
    const object = createCenterObject();

    run(manager, [object], gestures({ pinch: pinch(0.1, { x: 0.5, y: 0.5 }) }, [startEvent({ x: 0.5, y: 0.5 })]));
    run(manager, [object], gestures({ pinch: pinch(0.1, { x: 0.5, y: 0.5 }), twoHand: TWO_HAND_START }), {
      time: DT,
    });

    run(
      manager,
      [object],
      gestures({ pinch: pinch(0.1, { x: 0.5, y: 0.5 }), twoHand: twoHand({ x: 0.5, y: 0.5 }, 100) }),
      { time: 2 * DT },
    );
    expect(manager.get(object.id).twoHand.distanceRatio).toBeLessThanOrEqual(10);

    run(
      manager,
      [object],
      gestures({ pinch: pinch(0.1, { x: 0.5, y: 0.5 }), twoHand: twoHand({ x: 0.5, y: 0.5 }, 1e-9) }),
      { time: 3 * DT },
    );
    expect(manager.get(object.id).twoHand.distanceRatio).toBeGreaterThanOrEqual(0.1);
  });

  it('基准间距为 0（异常）时倍率安全地停在 1，不会除零', () => {
    const manager = new InteractionManager();
    const object = createCenterObject();

    run(manager, [object], gestures({ pinch: pinch(0.1, { x: 0.5, y: 0.5 }) }, [startEvent({ x: 0.5, y: 0.5 })]));
    run(
      manager,
      [object],
      gestures({ pinch: pinch(0.1, { x: 0.5, y: 0.5 }), twoHand: twoHand({ x: 0.5, y: 0.5 }, 0) }),
      { time: DT },
    );

    const ratio = manager.get(object.id).twoHand.distanceRatio;
    expect(Number.isFinite(ratio)).toBe(true);
    expect(ratio).toBe(1);
  });
});

describe('InteractionManager 握拳急停与重新武装（手势文法）', () => {
  it('握拳 -> 清空所有会话、标记 cancel、并要求重新武装', () => {
    const manager = new InteractionManager();
    const object = createCenterObject();

    run(manager, [object], gestures({ pinch: pinch(0.1, { x: 0.5, y: 0.5 }) }, [startEvent({ x: 0.5, y: 0.5 })]));
    expect(manager.grabbedIds()).toEqual([object.id]);

    // 捏着的那只手握拳：手势层会把 fistHands 报出来（捏合本身也可能还没结束）
    run(
      manager,
      [object],
      gestures({
        pinch: pinch(0.1, { x: 0.5, y: 0.5 }),
        fistHands: ['right'],
        pinches: [{ active: true, handedness: 'right', shape: 'fist', center: { x: 0.5, y: 0.5 }, gap: 0.4 }],
      }),
      { time: DT },
    );

    const state = manager.get(object.id);
    expect(state.grabbed).toBe(false);
    expect(state.transition).toBe('cancel'); // 行为据此清掉投掷速度
    expect(state.targetPosition).toBeNull();
    expect(manager.grabbedIds()).toEqual([]);
    expect(manager.rearmRequired).toBe(true);
    expect(manager.cancelReason).toBe('fist');
  });

  it('取消之后，手指还停在捏合位置也不能立刻抓回来（否则急停等于没用）', () => {
    const manager = new InteractionManager();
    const object = createCenterObject();

    run(manager, [object], gestures({ pinch: pinch(0.1, { x: 0.5, y: 0.5 }) }, [startEvent({ x: 0.5, y: 0.5 })]));
    run(
      manager,
      [object],
      gestures({
        fistHands: ['right'],
        pinches: [{ active: true, handedness: 'right', shape: 'fist', center: { x: 0.5, y: 0.5 }, gap: 0.4 }],
      }),
      { time: DT },
    );
    expect(manager.rearmRequired).toBe(true);

    // 手松开拳头但仍停在捏合位置、而且又发了一次 start：
    // 只要"当初挡住的那只手"还在捏合，就不许建立新会话。
    // （这一帧刻意**只**填 pinch、不填 pinches：交互层必须两个字段都看，
    //   否则"看不见的手"会把急停骗过去。）
    run(
      manager,
      [object],
      gestures({ pinch: pinch(0.1, { x: 0.5, y: 0.5 }) }, [startEvent({ x: 0.5, y: 0.5 })], 2 * DT),
      { time: 2 * DT },
    );
    expect(manager.grabbedIds()).toEqual([]);
    expect(manager.rearmRequired).toBe(true);

    // 连"移到素材上才抓住"的宽限通道也被挡住
    run(manager, [object], gestures({ pinch: pinch(0.1, { x: 0.5, y: 0.5 }) }), { time: 3 * DT });
    expect(manager.grabbedIds()).toEqual([]);
  });

  it('松开手（张开手掌）之后重新武装，再捏就能抓住', () => {
    const manager = new InteractionManager();
    const object = createCenterObject();

    run(manager, [object], gestures({ pinch: pinch(0.1, { x: 0.5, y: 0.5 }) }, [startEvent({ x: 0.5, y: 0.5 })]));
    run(
      manager,
      [object],
      gestures({ fistHands: ['right'], pinches: [{ active: true, handedness: 'right', shape: 'fist', center: { x: 0.5, y: 0.5 }, gap: 0.4 }] }),
      { time: DT },
    );
    expect(manager.rearmRequired).toBe(true);

    // 张开手掌：既不在捏合也不在握拳 -> 解除
    run(
      manager,
      [object],
      gestures({ pinches: [otherHand('open', 'right')] }, [], 2 * DT),
      { time: 2 * DT },
    );
    expect(manager.rearmRequired).toBe(false);

    // 再捏 -> 正常抓住
    run(
      manager,
      [object],
      gestures({ pinch: pinch(0.1, { x: 0.5, y: 0.5 }) }, [startEvent({ x: 0.5, y: 0.5 })], 3 * DT),
      { time: 3 * DT },
    );
    expect(manager.grabbedIds()).toEqual([object.id]);
  });

  it('旁观的手（什么都没抓）握拳**不影响**另一只手正在进行的抓取（真机反馈的干扰问题）', () => {
    /*
     * 真机反馈原话："屏幕里同时有两个手时，如果一只手握拳，自动识别为无法选取，
     * 容易干扰另一个手的抓取。"
     * 第一版是"任意一只手握拳 -> 清空一切"，那是个刻意的取舍，但真机证明取舍错了：
     * 另一只手常常只是放松搭着、容易被判成握拳。
     * 现在改成"每只手管自己的会话"，并且**什么都没抓着的手握拳不做任何事**。
     */
    const manager = new InteractionManager();
    const object = createCenterObject();

    run(manager, [object], gestures({ pinch: pinch(0.1, { x: 0.5, y: 0.5 }) }, [startEvent({ x: 0.5, y: 0.5 })]));
    expect(manager.grabbedIds()).toEqual([object.id]);

    run(
      manager,
      [object],
      gestures({
        pinch: pinch(0.1, { x: 0.5, y: 0.5 }),
        fistHands: ['left'],
        pinches: [pinch(0.1, { x: 0.5, y: 0.5 }), otherHand('fist', 'left')],
      }),
      { time: DT },
    );

    expect(manager.grabbedIds()).toEqual([object.id]);
    expect(manager.get(object.id).grabbed).toBe(true);
    expect(manager.get(object.id).transition).not.toBe('cancel');
    // 关键：旁观的手握拳**不该**顺手把应用锁成"待重新武装"
    expect(manager.rearmRequired).toBe(false);
  });

  it('两只手各抓一张图时，其中一只握拳只取消它自己那一次会话', () => {
    const manager = new InteractionManager();
    const a = SceneObject.create('a', { position: { x: 0.25, y: 0.5 }, size: { width: 0.2 } });
    const b = SceneObject.create('b', { position: { x: 0.75, y: 0.5 }, size: { width: 0.2 } });

    run(manager, [a, b], gestures({ pinch: pinch(0.1, { x: 0.75, y: 0.5 }) }, [startEvent({ x: 0.75, y: 0.5 })]));
    run(
      manager,
      [a, b],
      gestures({ pinch: pinch(0.1, { x: 0.25, y: 0.5 }, 'left') }, [startEvent({ x: 0.25, y: 0.5 }, 'left')], DT),
      { time: DT },
    );
    expect(manager.grabbedIds().sort()).toEqual(['a', 'b']);

    run(
      manager,
      [a, b],
      gestures(
        {
          pinch: pinch(0.1, { x: 0.25, y: 0.5 }, 'left'),
          fistHands: ['right'],
          pinches: [otherHand('fist', 'right'), pinch(0.1, { x: 0.25, y: 0.5 }, 'left')],
        },
        [],
        2 * DT,
      ),
      { time: 2 * DT },
    );

    expect(manager.get('b').grabbed).toBe(false);
    expect(manager.get('b').transition).toBe('cancel');
    expect(manager.get('a').grabbed).toBe(true); // 左手还抓着
    expect(manager.grabbedIds()).toEqual(['a']);
    expect(manager.rearmRequired).toBe(true); // 但握过拳的那只手要重新武装
  });

  it('手型判定万一卡在握拳上，重新武装也会超时解除（不能把应用锁死）', () => {
    // 安全阀：真机反馈过"我张开手了还判我握拳"，没有这条，用户就再也抓不住任何东西
    const manager = new InteractionManager({ rearmTimeoutSeconds: 0.5 });
    const object = createCenterObject();
    const stuckFist = (): Partial<ContinuousGestures> => ({
      fistHands: ['right'],
      pinches: [otherHand('fist', 'right')],
      pinch: otherHand('fist', 'right'),
    });

    run(manager, [object], gestures({ pinch: pinch(0.1, { x: 0.5, y: 0.5 }) }, [startEvent({ x: 0.5, y: 0.5 })]));
    run(manager, [object], gestures(stuckFist()), { time: DT });
    expect(manager.rearmRequired).toBe(true);

    run(manager, [object], gestures(stuckFist()), { time: DT + 0.3 });
    expect(manager.rearmRequired).toBe(true); // 还没到超时

    run(manager, [object], gestures(stuckFist()), { time: DT + 0.6 });
    expect(manager.rearmRequired).toBe(false); // 超时放行
  });

  it('握拳的那只手离开画面后，重新武装立刻解除（真机"张开手了还是抓不住"的回归）', () => {
    /*
     * 真机反馈："我选中后握拳，想再次选中的时候总是把我识别成握拳，但实际上我已经张开手了。"
     * 根因之一是手势层把**已经离开画面的手**的手型留成了 fist（陈旧状态），
     * 交互层拿它判断"能不能重新武装"，就永远解不开。
     * 手势层已修（看不到手 -> other）；这里钉住交互层这一侧的行为。
     */
    const manager = new InteractionManager();
    const object = createCenterObject();

    run(manager, [object], gestures({ pinch: pinch(0.1, { x: 0.5, y: 0.5 }) }, [startEvent({ x: 0.5, y: 0.5 })]));
    run(
      manager,
      [object],
      gestures({
        fistHands: ['right'],
        pinches: [otherHand('fist', 'right')],
      }),
      { time: DT },
    );
    expect(manager.rearmRequired).toBe(true);

    // 手离开画面：手型变回 other -> 重新武装立刻解除，用户马上能再抓
    run(manager, [object], gestures({ pinches: [otherHand('other', 'right')] }), { time: 2 * DT });
    expect(manager.rearmRequired).toBe(false);

    run(
      manager,
      [object],
      gestures({ pinch: pinch(0.1, { x: 0.5, y: 0.5 }) }, [startEvent({ x: 0.5, y: 0.5 })], 3 * DT),
      { time: 3 * DT },
    );
    expect(manager.grabbedIds()).toEqual([object.id]);
  });

  it('取消后素材停在原地（不被"投掷"出去），transition 只存活一帧', () => {
    const manager = new InteractionManager();
    const object = createCenterObject();

    run(manager, [object], gestures({ pinch: pinch(0.1, { x: 0.5, y: 0.5 }) }, [startEvent({ x: 0.5, y: 0.5 })]));
    run(manager, [object], gestures({ pinch: pinch(0.1, { x: 0.6, y: 0.5 }) }), { time: DT });
    const movingTarget = manager.get(object.id).targetPosition;

    run(
      manager,
      [object],
      gestures({ fistHands: ['right'], pinches: [{ active: true, handedness: 'right', shape: 'fist', center: { x: 0.7, y: 0.5 }, gap: 0.4 }] }),
      { time: 2 * DT },
    );
    expect(manager.get(object.id).targetPosition).toBeNull();
    expect(movingTarget).not.toBeNull();

    run(manager, [object], gestures({ pinches: [otherHand('open', 'right')] }), { time: 3 * DT });
    expect(manager.get(object.id).transition).toBe('none');
  });
});

describe('InteractionManager 指弹删除与撤销（手势文法）', () => {
  /** 一次指弹：指尖位置在素材上 */
  function flick(position: Vec2, hand: Handedness = 'right'): FlickEvent {
    return { gesture: 'index-flick', hand, position, direction: { x: 0, y: -1 }, speed: 2.5, frames: 1, time: 0 };
  }

  it('弹中素材 -> 进入淡出期（active + progress 递增），但还没被移除', () => {
    const manager = new InteractionManager({ deleteGraceSeconds: 2 });
    const object = createCenterObject();

    run(manager, [object], gestures({}, [], 0, [flick({ x: 0.5, y: 0.5 })]));

    const state = manager.get(object.id);
    expect(state.deleting.active).toBe(true);
    expect(state.deleting.progress).toBe(0);
    expect(manager.deletingCount).toBe(1);
    // 淡出期里还没有"到期"，所以 Scene 这一帧不该移除任何东西
    expect(manager.takeExpiredDeletions()).toEqual([]);
  });

  it('淡出期走完之后到期，交给 Scene 移除', () => {
    const manager = new InteractionManager({ deleteGraceSeconds: 1 });
    const object = createCenterObject();
    run(manager, [object], gestures({}, [], 0, [flick({ x: 0.5, y: 0.5 })]));

    run(manager, [object], null, { dt: 0.5, time: 0.5 });
    expect(manager.get(object.id).deleting.progress).toBeCloseTo(0.5, 6);
    expect(manager.takeExpiredDeletions()).toEqual([]);

    run(manager, [object], null, { dt: 0.6, time: 1.1 });
    expect(manager.takeExpiredDeletions()).toEqual([object.id]);
    expect(manager.deletingCount).toBe(0);
  });

  it('淡出期里再捏住它 = 撤销（误弹的唯一出路）', () => {
    const manager = new InteractionManager({ deleteGraceSeconds: 2 });
    const object = createCenterObject();

    run(manager, [object], gestures({}, [], 0, [flick({ x: 0.5, y: 0.5 })]));
    expect(manager.get(object.id).deleting.active).toBe(true);

    run(
      manager,
      [object],
      gestures({ pinch: pinch(0.1, { x: 0.5, y: 0.5 }) }, [startEvent({ x: 0.5, y: 0.5 })], 0.3),
      { time: 0.3 },
    );

    expect(manager.get(object.id).deleting.active).toBe(false);
    expect(manager.deletingCount).toBe(0);
    expect(manager.get(object.id).grabbed).toBe(true); // 撤销之后素材还在手上

    run(manager, [object], gestures({ pinch: pinch(0.1, { x: 0.5, y: 0.5 }) }), { dt: 3, time: 3.3 });
    expect(manager.takeExpiredDeletions()).toEqual([]);
  });

  it('弹到空处什么都不发生', () => {
    const manager = new InteractionManager();
    const object = createCenterObject();

    run(manager, [object], gestures({}, [], 0, [flick({ x: 0.02, y: 0.98 })]));

    expect(manager.deletingCount).toBe(0);
    expect(manager.get(object.id).deleting.active).toBe(false);
  });

  it('正抓着素材的那只手指弹不删它（要删先松手）', () => {
    const manager = new InteractionManager();
    const object = createCenterObject();

    run(manager, [object], gestures({ pinch: pinch(0.1, { x: 0.5, y: 0.5 }) }, [startEvent({ x: 0.5, y: 0.5 })]));
    expect(manager.get(object.id).grabbed).toBe(true);

    run(manager, [object], gestures({ pinch: pinch(0.1, { x: 0.5, y: 0.5 }) }, [], 0, [flick({ x: 0.5, y: 0.5 })]), {
      time: DT,
    });

    expect(manager.deletingCount).toBe(0);
    expect(manager.get(object.id).grabbed).toBe(true);
  });

  it('反复弹同一个素材不会刷新计时（否则永远删不掉）', () => {
    const manager = new InteractionManager({ deleteGraceSeconds: 1 });
    const object = createCenterObject();

    run(manager, [object], gestures({}, [], 0, [flick({ x: 0.5, y: 0.5 })]));
    run(manager, [object], gestures({}, [], 0, [flick({ x: 0.5, y: 0.5 })]), { dt: 0.6, time: 0.6 });
    expect(manager.get(object.id).deleting.progress).toBeCloseTo(0.6, 6);

    run(manager, [object], null, { dt: 0.5, time: 1.1 });
    expect(manager.takeExpiredDeletions()).toEqual([object.id]);
  });

  it('淡出中的素材被别的原因删掉时，记录随之清理（不会留下幽灵）', () => {
    const manager = new InteractionManager({ deleteGraceSeconds: 1 });
    const object = createCenterObject();

    run(manager, [object], gestures({}, [], 0, [flick({ x: 0.5, y: 0.5 })]));
    expect(manager.deletingCount).toBe(1);

    run(manager, [], null, { dt: 0.1, time: 0.1 });
    expect(manager.deletingCount).toBe(0);
    expect(manager.takeExpiredDeletions()).toEqual([]);
  });
});

describe('InteractionManager 生命周期', () => {
  it('素材被删除后交互状态随之清理', () => {
    const manager = new InteractionManager();
    const object = createCenterObject();

    run(manager, [object], gestures({ pinch: pinch(0.1, { x: 0.5, y: 0.5 }) }, [startEvent({ x: 0.5, y: 0.5 })]));
    expect(manager.size).toBe(1);

    run(manager, [], null, { time: DT });
    expect(manager.size).toBe(0);
    expect(manager.get(object.id).grabbed).toBe(false);
  });

  it('reset 清空所有状态', () => {
    const manager = new InteractionManager();
    const object = createCenterObject();

    run(manager, [object], gestures({ pinch: pinch(0.1, { x: 0.5, y: 0.5 }) }, [startEvent({ x: 0.5, y: 0.5 })]));
    manager.reset();

    expect(manager.size).toBe(0);
    expect(manager.grabbedIds()).toEqual([]);
  });

  it('list() 返回当前所有受管素材的交互状态', () => {
    const manager = new InteractionManager();
    const object = createCenterObject();

    run(manager, [object], gestures({ pinch: pinch(0.1, { x: 0.5, y: 0.5 }) }, [startEvent({ x: 0.5, y: 0.5 })]));

    expect(manager.list().map((state) => state.objectId)).toEqual([object.id]);
  });
});
