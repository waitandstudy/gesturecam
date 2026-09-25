import type { Handedness } from '../hand/handState';
import type { Vec2 } from '../math/vec2';

/**
 * ============================================================================
 * 交互层的数据模型（InteractionManager）
 * ============================================================================
 *
 * 参考文档第四节的管线里，InteractionManager 夹在 GestureManager 和 SceneManager 之间。
 * 它是"手势语义"和"具体素材"第一次相遇的地方，也是**唯一**允许把两者关联起来的模块：
 *
 *   手势（捏合开始了，位置 P）
 *      ↓ InteractionManager：拿 P 去做命中测试，算出抓取偏移，维持一次"抓取会话"
 *   交互状态（object-3 被右手抓住，抓取偏移 0.03，目标位置 Q）
 *      ↓ BehaviorManager：行为按自己的策略消费它（FollowHand / 惯性 / 边界…）
 *   素材状态
 *
 * 这样拆开的好处：手势层完全不需要知道素材的存在，行为层完全不需要知道关键点的存在。
 */

/**
 * 素材自身的交互能力开关（参考文档第五节 Object → Interaction 一节：
 * Grab / Scale / Rotate / Future Interactions）。
 *
 * 做成数据而不是 if/else：将来"这张图只能看不能动""这张图只能缩放不能拖"
 * 都只是在编排时改字段，不需要动 InteractionManager 一行代码。
 */
export interface ObjectInteractionConfig {
  grabbable: boolean;
  scalable: boolean;
  rotatable: boolean;
}

export const DEFAULT_INTERACTION_CONFIG: Readonly<ObjectInteractionConfig> = Object.freeze({
  grabbable: true,
  scalable: true,
  rotatable: false,
});

export function createInteractionConfig(patch: Partial<ObjectInteractionConfig> = {}): ObjectInteractionConfig {
  return {
    grabbable: patch.grabbable ?? DEFAULT_INTERACTION_CONFIG.grabbable,
    scalable: patch.scalable ?? DEFAULT_INTERACTION_CONFIG.scalable,
    rotatable: patch.rotatable ?? DEFAULT_INTERACTION_CONFIG.rotatable,
  };
}

/** 本帧该素材上发生的变化，行为用它触发一次性动作（例如"刚被抓住"的弹一下）。 */
export type InteractionTransition = 'none' | 'grab' | 'move' | 'release' | 'cancel';

/**
 * 双手缩放会话。
 *
 * 为什么缩放交给双手，而不是"单手捏合间距"：单只手的捏合**同时**表达了位置和大小，
 * 两个自由度本质耦合（间距一变，捏合中点也跟着动 → 素材同时漂移；手一抖两个都变）。
 * 双手则是干净的解耦：一只手管位置、两手间距管大小。
 * 而且两手间距（约 0.4 画幅宽）比单手捏合间距（约 0.03）大一个数量级，
 * 同样的噪声绝对量除以大得多的基准，**相对误差小十倍** ——
 * 缩放震颤的根因就此消失，也不再需要那套脆弱的"基准冻结"逻辑。
 */
export interface TwoHandInteractionState {
  /** 两只手都在捏合、且素材被其中一只抓着 */
  active: boolean;
  /** 两手间距相对"第二只手加入时"的倍率；未激活时为 1 */
  distanceRatio: number;
}

export function createIdleTwoHandState(): TwoHandInteractionState {
  return { active: false, distanceRatio: 1 };
}

/**
 * 指弹删除的**待定状态**。
 *
 * 指弹是破坏性操作，所以刻意做得很"软"：弹中之后素材不会立刻消失，
 * 而是进入一段**淡出期**（默认 2 秒），期间：
 *   · 素材半透明留在原地（渲染层按 `progress` 降不透明度）；
 *   · **再捏住它就等于撤销**（手一弹就没了的话，误弹就只能重新加图）；
 *   · 时间到了才真正从场景里移除。
 */
export interface DeletionState {
  /** 是否正处于待删除（淡出）中 */
  active: boolean;
  /** 淡出进度 0..1（1 = 时间到） */
  progress: number;
}

export function createIdleDeletion(): DeletionState {
  return { active: false, progress: 0 };
}

export interface ObjectInteractionState {
  objectId: string;
  grabbed: boolean;
  grabbedBy: Handedness | null;
  /**
   * 抓取瞬间的「手指位置 − 素材锚点位置」。
   * 这是参考文档第三节明确点名的「抓取偏移」：不记它的话，素材会被瞬间吸到指心，
   * 手感非常差（你一捏，图就跳一下）。
   */
  grabOffset: Vec2;
  /** 本帧素材锚点应该去的位置 = 当前手指位置 − grabOffset。未抓取时 null。 */
  targetPosition: Vec2 | null;
  /** 手指/掌心当前位置（场景坐标）。未抓取时 null。 */
  cursorPosition: Vec2 | null;
  /** 本帧的位置增量（场景单位/帧）。Phase 10 的投掷要靠它的历史算释放速度。 */
  dragDelta: Vec2;
  /** 双手缩放状态（Phase 5） */
  twoHand: TwoHandInteractionState;
  /** 指弹删除的待定状态（淡出期，期间可撤销） */
  deleting: DeletionState;
  /** 本次抓取已经持续了多少秒。 */
  grabDuration: number;
  /** 本帧发生的变化。 */
  transition: InteractionTransition;
  /** 因为手消失太久而被自动释放（行为可以据此让素材"掉下去"）。 */
  releasedByTimeout: boolean;
}

export function createIdleInteractionState(objectId: string): ObjectInteractionState {
  return {
    objectId,
    grabbed: false,
    grabbedBy: null,
    grabOffset: { x: 0, y: 0 },
    targetPosition: null,
    cursorPosition: null,
    dragDelta: { x: 0, y: 0 },
    twoHand: createIdleTwoHandState(),
    deleting: createIdleDeletion(),
    grabDuration: 0,
    transition: 'none',
    releasedByTimeout: false,
  };
}

/** 未知素材 id 时统一返回的只读兜底值（不要修改它）。 */
export const IDLE_INTERACTION_STATE: Readonly<ObjectInteractionState> = Object.freeze(
  createIdleInteractionState('__idle__'),
);

/**
 * 行为系统看到的交互视图。
 *
 * 刻意做成"一定返回对象、绝不返回 null"：行为里如果到处写
 * `if (interaction && interaction.grabbed)` 很快就会变成一团浆糊。
 */
export interface InteractionSnapshot {
  /** 场景时间（秒） */
  readonly time: number;
  readonly size: number;
  /**
   * 是否处于"刚被握拳取消、必须先张开手"的状态。
   *
   * 取消的那一刻手指往往还在捏合的位置附近，如果立刻允许新的捏合，
   * 取消动作本身就会马上抓回一张图，急停等于没用。界面必须把它显示出来，
   * 否则用户会以为程序卡住了。
   */
  readonly rearmRequired: boolean;
  /** 当前有几个素材处在"弹掉了但还能撤销"的淡出期（界面提示用） */
  readonly deletingCount: number;
  get(objectId: string): Readonly<ObjectInteractionState>;
  grabbedIds(): string[];
  list(): readonly Readonly<ObjectInteractionState>[];
}
