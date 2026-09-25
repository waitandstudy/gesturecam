import { describe, expect, it } from 'vitest';

import type { Behavior, BehaviorContext, BehaviorStage, BehaviorViewport } from '@/core/behavior/behavior';
import { BOUNDARY_BEHAVIOR_TYPE } from '@/core/behavior/behaviors/boundary';
import { FLICK_FADE_BEHAVIOR_TYPE } from '@/core/behavior/behaviors/flickFade';
import { FIXED_BEHAVIOR_TYPE } from '@/core/behavior/behaviors/fixed';
import { FOLLOW_HAND_BEHAVIOR_TYPE } from '@/core/behavior/behaviors/followHand';
import { attachBehaviorForMode, registerCoreBehaviors } from '@/core/behavior/behaviors/modes';
import { BehaviorManager, type BehaviorEnvironment } from '@/core/behavior/manager';
import { Viewport } from '@/core/coords/viewport';
import { InteractionManager } from '@/core/interaction/interactionManager';
import { SceneObject } from '@/core/scene/object';

const VIEWPORT: BehaviorViewport = { width: 400, height: 800, aspect: 0.5, mirrored: true };
/** 交互层命中测试需要真实的 Viewport（场景坐标 <-> 屏幕坐标） */
const SCENE_VIEWPORT = new Viewport({ width: 1280, height: 720 }, { width: 400, height: 800 }, {
  mirrored: false,
  outputAspect: 0.5,
});

class RecordingBehavior implements Behavior {
  readonly type: string;
  readonly stage: BehaviorStage;
  readonly priority: number;
  attachCount = 0;
  detachCount = 0;
  updateCount = 0;
  lastContext: BehaviorContext | null = null;

  constructor(type: string, stage: BehaviorStage, priority = 0, private readonly log?: string[]) {
    this.type = type;
    this.stage = stage;
    this.priority = priority;
  }

  onAttach(): void {
    this.attachCount += 1;
    this.log?.push(`attach:${this.type}`);
  }

  onDetach(): void {
    this.detachCount += 1;
    this.log?.push(`detach:${this.type}`);
  }

  update(context: BehaviorContext): void {
    this.updateCount += 1;
    this.lastContext = context;
    this.log?.push(`update:${this.type}`);
  }
}

function createManager(log?: string[]): BehaviorManager {
  const manager = new BehaviorManager();
  for (const stage of ['input', 'simulate', 'constrain', 'present'] as const) {
    manager.register(`${stage}-behavior`, () => new RecordingBehavior(`${stage}-behavior`, stage, 0, log));
  }
  manager.register('low-priority', () => new RecordingBehavior('low-priority', 'input', 10, log));
  manager.register('high-priority', () => new RecordingBehavior('high-priority', 'input', -10, log));
  return manager;
}

function createEnvironment(
  objects: readonly SceneObject[],
  overrides: Partial<Omit<BehaviorEnvironment, 'interactions'>> = {},
): BehaviorEnvironment {
  const dt = overrides.dt ?? 1 / 60;
  const time = overrides.time ?? 0;
  const gestures = overrides.gestures ?? null;

  // 走一遍真实的交互层，保证行为拿到的交互状态和运行时一致
  const interactions = new InteractionManager();
  interactions.update({ dt, time, gestures, viewport: SCENE_VIEWPORT, objects, aspectOf: () => 1 });

  return { dt, time, frame: overrides.frame ?? 1, gestures, viewport: VIEWPORT, objects, interactions };
}

/** 只看 update 的调用顺序；onAttach 会在首帧插入，断言顺序时把它滤掉 */
function updatesOnly(log: readonly string[]): string[] {
  return log.filter((entry) => entry.startsWith('update:'));
}

describe('BehaviorManager 注册表', () => {
  it('重复注册同名行为直接抛错', () => {
    const manager = new BehaviorManager();
    manager.register('x', () => new RecordingBehavior('x', 'present'));
    expect(() => manager.register('x', () => new RecordingBehavior('x', 'present'))).toThrow(/已经注册过/);
  });

  it('创建未注册的行为时报错并列出已注册类型', () => {
    const manager = createManager();
    expect(() => manager.create('not-there')).toThrow(/未注册的行为类型：not-there/);
    expect(manager.registeredTypes()).toContain('input-behavior');
    expect(manager.has('input-behavior')).toBe(true);
  });

  it('同一个素材不能重复挂载同类型行为', () => {
    const manager = createManager();
    const object = SceneObject.create('obj-1');

    manager.attach(object, 'input-behavior');
    expect(() => manager.attach(object, 'input-behavior')).toThrow(/已经挂载/);
  });
});

describe('BehaviorManager 执行管线', () => {
  it('按 input -> simulate -> constrain -> present 执行，与挂载顺序无关', () => {
    const log: string[] = [];
    const manager = createManager(log);
    const object = SceneObject.create('obj-1');

    manager.attach(object, 'present-behavior');
    manager.attach(object, 'constrain-behavior');
    manager.attach(object, 'simulate-behavior');
    manager.attach(object, 'input-behavior');
    log.length = 0;

    manager.update(createEnvironment([object]));

    expect(updatesOnly(log)).toEqual([
      'update:input-behavior',
      'update:simulate-behavior',
      'update:constrain-behavior',
      'update:present-behavior',
    ]);
  });

  it('同一阶段内按 priority 升序执行', () => {
    const log: string[] = [];
    const manager = createManager(log);
    const object = SceneObject.create('obj-1');

    manager.attach(object, 'low-priority');
    manager.attach(object, 'high-priority');
    log.length = 0;

    manager.update(createEnvironment([object]));

    expect(updatesOnly(log)).toEqual(['update:high-priority', 'update:low-priority']);
  });

  it('阶段优先：所有素材的 input 都跑完才进入 simulate', () => {
    const log: string[] = [];
    const manager = createManager(log);
    const a = SceneObject.create('a');
    const b = SceneObject.create('b');

    manager.attach(a, 'simulate-behavior');
    manager.attach(a, 'input-behavior');
    manager.attach(b, 'input-behavior');
    log.length = 0;

    manager.update(createEnvironment([a, b]));

    expect(updatesOnly(log)).toEqual(['update:input-behavior', 'update:input-behavior', 'update:simulate-behavior']);
  });

  it('onAttach 只调用一次，onDetach 在卸载时调用', () => {
    const manager = createManager();
    const object = SceneObject.create('obj-1');
    const behavior = manager.attach(object, 'input-behavior') as RecordingBehavior;

    manager.update(createEnvironment([object]));
    manager.update(createEnvironment([object]));
    manager.update(createEnvironment([object]));
    expect(behavior.attachCount).toBe(1);
    expect(behavior.updateCount).toBe(3);

    expect(manager.detach(object, 'input-behavior')).toBe(true);
    expect(behavior.detachCount).toBe(1);
    expect(object.behaviors).toHaveLength(0);
    expect(manager.detach(object, 'input-behavior')).toBe(false);
  });

  it('上下文里带齐了行为需要的一切（不含原始手部关键点）', () => {
    const manager = createManager();
    const object = SceneObject.create('obj-1', { position: { x: 0.25, y: 0.75 } });
    const behavior = manager.attach(object, 'present-behavior') as RecordingBehavior;

    manager.update(createEnvironment([object], { time: 2.5, frame: 42, dt: 1 / 30 }));

    const context = behavior.lastContext;
    if (!context) throw new Error('行为没有被执行');

    expect(context.time).toBe(2.5);
    expect(context.frame).toBe(42);
    expect(context.dt).toBeCloseTo(1 / 30, 12);
    expect(context.gestures).toBeNull();
    expect(context.interaction.grabbed).toBe(false);
    expect(context.interaction.targetPosition).toBeNull();
    expect(context.viewport).toEqual(VIEWPORT);
    expect(context.object.id).toBe('obj-1');
    expect(context.object.state.position).toEqual({ x: 0.25, y: 0.75 });
    expect(context.scene.size).toBe(1);
    expect(context.scene.get('obj-1')?.id).toBe('obj-1');
    expect(context.scene.get('missing')).toBeUndefined();
  });

  it('行为可以通过上下文修改素材状态', () => {
    const manager = new BehaviorManager();
    manager.register('mover', () => ({
      type: 'mover',
      stage: 'input' as const,
      update: ({ object }: BehaviorContext) => {
        object.setPosition({ x: 0.9, y: 0.1 });
        object.setOpacity(0.5);
      },
    }));

    const object = SceneObject.create('obj-1');
    manager.attach(object, 'mover');
    manager.update(createEnvironment([object]));

    expect(object.state.position).toEqual({ x: 0.9, y: 0.1 });
    expect(object.state.opacity).toBe(0.5);
  });
});

describe('mode -> 行为的挂载规则', () => {
  it('registerCoreBehaviors 之后 FOLLOW_HAND 挂上"跟随 + 缩放 + 边界 + 淡出"四个行为', () => {
    const manager = new BehaviorManager();
    registerCoreBehaviors(manager);

    const object = SceneObject.create('obj-1', { mode: 'FOLLOW_HAND' });
    attachBehaviorForMode(manager, object);

    // 前两个是两个独立关注点（位置 / 大小）；
    // 后两个是**与模式正交**的通用规则：
    //   boundary   —— 素材不能被拖出画幅（constrain 阶段）
    //   flick-fade —— 被指弹弹中的素材要淡出而不是凭空消失（present 阶段）
    expect(object.behaviors.map((behavior) => behavior.type)).toEqual([
      FOLLOW_HAND_BEHAVIOR_TYPE,
      'two-hand-scale',
      BOUNDARY_BEHAVIOR_TYPE,
      FLICK_FADE_BEHAVIOR_TYPE,
    ]);
  });

  it('边界约束挂在 constrain 阶段（跑在跟随/缩放之后，统一收口）', () => {
    const manager = new BehaviorManager();
    registerCoreBehaviors(manager);

    const object = SceneObject.create('obj-1', { mode: 'FOLLOW_HAND' });
    attachBehaviorForMode(manager, object);

    const boundary = object.behaviors.find((behavior) => behavior.type === BOUNDARY_BEHAVIOR_TYPE);
    expect(boundary?.stage).toBe('constrain');
  });

  it('FIXED 只挂空行为 + 边界约束，不挂跟随也不挂缩放', () => {
    const manager = new BehaviorManager();
    registerCoreBehaviors(manager);

    const object = SceneObject.create('obj-1', { mode: 'FIXED' });
    attachBehaviorForMode(manager, object);

    // 顺序按 (阶段, priority) 排：boundary 在 constrain、fixed 与 flick-fade 在 present
    expect(object.behaviors.map((behavior) => behavior.type)).toEqual([
      BOUNDARY_BEHAVIOR_TYPE,
      FIXED_BEHAVIOR_TYPE,
      FLICK_FADE_BEHAVIOR_TYPE,
    ]);
  });

  it('FIXED 空行为不改变素材状态（位置完全由编排决定）', () => {
    const manager = new BehaviorManager();
    registerCoreBehaviors(manager);

    const object = SceneObject.create('obj-1', { mode: 'FIXED', position: { x: 0.2, y: 0.3 } });
    attachBehaviorForMode(manager, object);

    for (let i = 0; i < 10; i += 1) manager.update(createEnvironment([object]));

    // 画幅内的合法位置不该被边界约束动到
    expect(object.state.position).toEqual({ x: 0.2, y: 0.3 });
    expect(object.state.scale).toBe(1);
  });

  it('尚未实现的模式（TOP_HANGING，Phase 7）不会挂载行为，也不会抛错', () => {
    const manager = new BehaviorManager();
    registerCoreBehaviors(manager);

    const object = SceneObject.create('obj-1', { mode: 'TOP_HANGING' });
    expect(() => attachBehaviorForMode(manager, object)).not.toThrow();
    expect(object.behaviors).toHaveLength(0);
  });
});
