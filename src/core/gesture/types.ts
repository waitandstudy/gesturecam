import { HAND_LANDMARK, landmarkAt, type Handedness, type SceneHand } from '../hand/handState';
import type { Vec2 } from '../math/vec2';
import type { FlickEvent } from './flick';
import type { HandShape } from './handShape';
import type { SnapEvent } from './snap';

/**
 * ============================================================================
 * 手势层（GestureManager 的数据契约）
 * ============================================================================
 *
 * 参考文档第四节的核心原则：
 *   **「手势不要直接修改图片属性，而应该采用 手势 → 交互事件 → 行为 → 对象 的解耦方式」**
 *   第九节又强调「不要让 GestureManager 直接操作 ImageObject 的位置、缩放等属性」。
 *
 * 所以这一层的输出被刻意限制成两份**纯数据**：
 *   1) `controls`：本帧的连续控制量（掌心位置、捏合距离…），已经过平滑；
 *   2) `events`  ：本帧新发生的**离散事件**（捏合开始/结束…）。
 *
 * 它不认识 Scene，也不认识素材 —— 甚至连"命中哪个对象"都不知道，那是
 * InteractionManager 的职责。Phase 2 会用 MediaPipe 关键点 + 规则实现它。
 *
 * 之所以把离散事件和连续量分开：它们的消抖策略完全不同。连续量靠滤波（One-Euro），
 * 离散量靠迟滞（见 hysteresis.ts）。混在一起写会导致后面加"抓取/甩出"时必须推倒重来。
 */

export type GestureId = 'pinch' | 'open-palm' | 'fist' | 'two-hand-pinch' | 'index-flick';

export interface PinchState {
  /** 迟滞后的捏合是否成立 */
  active: boolean;
  /**
   * 这一捏合属于哪只手。
   *
   * 为什么必须带上：抓取会话是按**左右手**记账的（`grabbedBy`），而捏合状态是按**槽位**排的。
   * 槽位一旦对调（第二只手刚出现时两只手到旧锚点的距离可能几乎相等），
   * "取第一个捏合槽位当光标"就会让素材跳到另一只手下面。
   * 有了这个字段，交互层能明确地"找到正在抓着素材的那只手"。
   */
  handedness: Handedness | null;
  /**
   * 本帧判定出来的**手型**（捏合 / 握拳 / 张开 / 其他）。
   *
   * 与 `active` 的区别：`active` 是"捏合会话是否按住"（含手丢失宽限），
   * 而 `shape` 是这一帧看到的手长什么样、**不管有没有在抓东西**。
   * 握拳急停、张开手掌释放、取消后的重新武装都靠它。
   */
  shape: HandShape;
  /** 拇指尖与食指尖的中点（场景坐标） */
  center: Vec2 | null;
  /**
   * 捏合比例（= 拇食指距离 ÷ 掌心长度），取自**快速滤波**后的关键点。
   *
   * 它现在只剩下两个用途：给用户看的读数、以及调试叠层。
   * 判定已经不再只看它 —— 单看它无法区分捏合与握拳（见 `handShape.ts`）。
   */
  gap: number | null;
}

export interface TwoHandState {
  /** 两只手**都在捏合** —— 这是双手缩放的触发条件 */
  active: boolean;
  /** 两个捏合中点的中点（场景坐标，平滑后） */
  center: Vec2 | null;
  /** 两个捏合中点之间的距离（等比例、场景单位，**平滑后**）—— 缩放的实时倍率 */
  distance: number | null;
  /**
   * 同一个间距，但取自**未平滑**的捏合中点。
   *
   * 为什么必须单独给一个：缩放的**基准**要用无滞后的测量。
   * "张开 → 捏合"时捏合中点本身会移动约 3–4% 掌长（两指从分开到接触，中点跟着走），
   * 而平滑值要 ~2τ（约 0.26 秒）才追到位 —— 基准正好在这段时间被采样，
   * 于是素材会**自己变大 6%**（真机表现为"第二只手一捏上，图就自己变大了"）。
   * 用原始值定基准、用平滑值算当前倍率：两边在静止时收敛到同一个物理量，
   * 倍率精确落在 1；运动时留一点滞后，那只是手感上的阻尼。
   */
  rawDistance: number | null;
}

export interface ContinuousGestures {
  /** 主手参考点（掌心）场景坐标；没有手时为 null */
  palm: Vec2 | null;
  /** 掌心速度（场景单位/秒），Phase 10「投掷/惯性」的初速度来源 */
  palmVelocity: Vec2;
  /**
   * 每只手的捏合状态，**下标与追踪到的手一一对应**。
   *
   * 双手缩放必须知道"另一只手在不在捏"，所以这里给的是数组而不是单独一只。
   * 单手时长度为 1。
   */
  pinches: readonly PinchState[];
  /**
   * 主手（第一只**捏合中**的手，没有则在捏的就取第一只）的捏合状态。
   * 拖动、准星、抓取判定都用它。
   */
  pinch: PinchState;
  /**
   * 拇指尖与食指尖的中点 —— **不管有没有捏合都给**（只要关键点拿得到）。
   * 给用户看的**准星**："如果现在捏合，会抓到这里"。
   */
  pinchPoint: Vec2 | null;
  /** 双手捏合状态：位置由两手中点控制、大小由两手间距控制 */
  twoHand: TwoHandState;
  /**
   * 当前处于**握拳**状态的手（可能同时有两只）。
   *
   * 这是"急停"信号的载体，刻意做成**状态而不是事件**：
   * 取消是"此刻有没有手握拳"这件事，用状态表达天然幂等 ——
   * 事件一旦被合并/丢失，急停就失效了（合成输入脚本里踩过六次同类问题）。
   */
  fistHands: readonly Handedness[];
  /** 本帧识别到的手数量 */
  handCount: number;
  /** 主手左右 */
  primaryHandedness: Handedness | null;
}

export function createEmptyTwoHand(): TwoHandState {
  return { active: false, center: null, distance: null, rawDistance: null };
}

export function createIdleGestures(): ContinuousGestures {
  const pinch = createEmptyPinch();
  return {
    palm: null,
    palmVelocity: { x: 0, y: 0 },
    pinches: [pinch],
    pinch,
    pinchPoint: null,
    twoHand: createEmptyTwoHand(),
    fistHands: [],
    handCount: 0,
    primaryHandedness: null,
  };
}

export type GestureEventType = 'gesture-start' | 'gesture-end';

export interface GestureEvent {
  type: GestureEventType;
  gesture: GestureId;
  hand: Handedness;
  /** 事件发生的位置（场景坐标） */
  position: Vec2;
  time: number;
}

/** 每一帧手势层的完整输出。Scene.update() 消费它。 */
export interface GestureState {
  /** 场景时间（秒） */
  time: number;
  controls: ContinuousGestures;
  /** **仅包含本帧新发生**的事件，不做累积 */
  events: readonly GestureEvent[];
  /**
   * 本帧新发生的**指弹**（同样是"只活一帧"）。
   *
   * 单独一个数组而不是塞进 `events`：指弹是**动态手势**，
   * 它比"捏合开始/结束"多带方向和速度（删除要用它选目标，物理要用它当冲量），
   * 硬塞进统一的 `GestureEvent` 会让那个类型长出三个只有它用得到的可选字段。
   */
  flicks: readonly FlickEvent[];
  /**
   * 本帧响了几次**响指**（翻页用的那个动作）。
   *
   * 和 `flicks` 一样是"只活一帧"的一次性事件 —— 拿到就该消费掉，不要跨帧沿用，
   * 否则 60fps 的渲染循环会把同一次响指翻好几次页。
   */
  snaps: readonly SnapEvent[];
}

export function createEmptyPinch(): PinchState {
  return { active: false, handedness: null, shape: 'other', center: null, gap: null };
}

export function createIdleGestureState(time = 0): GestureState {
  return { time, controls: createIdleGestures(), events: [], flicks: [], snaps: [] };
}

/**
 * 场景坐标下的**等比例**距离。
 *
 * 场景坐标是 [0,1]² 但画布不是正方形，所以 x 和 y 的单位像素长度不同；
 * 直接 hypot(dx, dy) 会算出一个没有物理意义的"斜向距离"，
 * 用在缩放倍率上会导致"斜着捏比竖着捏缩放更快"。
 *
 * 这里把 y 换算成"以画布宽度为单位"再求距离，结果与分辨率无关。
 * @param aspect 画布宽高比（宽 / 高）
 */
export function sceneDistance(a: Vec2, b: Vec2, aspect: number): number {
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const dx = b.x - a.x;
  const dy = (b.y - a.y) / safeAspect;
  return Math.hypot(dx, dy);
}

const PALM_ANCHORS = [
  HAND_LANDMARK.WRIST,
  HAND_LANDMARK.INDEX_FINGER_MCP,
  HAND_LANDMARK.MIDDLE_FINGER_MCP,
  HAND_LANDMARK.RING_FINGER_MCP,
  HAND_LANDMARK.PINKY_MCP,
] as const;

/** 掌心参考点 = 手腕 + 四个掌指关节的平均。缺关键点时返回 null。 */
export function palmPointOf(hand: SceneHand): Vec2 | null {
  let x = 0;
  let y = 0;
  let count = 0;

  for (const index of PALM_ANCHORS) {
    const landmark = landmarkAt(hand, index);
    if (!landmark) continue;
    x += landmark.position.x;
    y += landmark.position.y;
    count += 1;
  }

  if (count === 0) return null;
  return { x: x / count, y: y / count };
}

/** 拇指尖与食指尖的中点。缺关键点时返回 null。 */
export function pinchCenterOf(hand: SceneHand): Vec2 | null {
  const thumb = landmarkAt(hand, HAND_LANDMARK.THUMB_TIP);
  const index = landmarkAt(hand, HAND_LANDMARK.INDEX_FINGER_TIP);
  if (!thumb || !index) return null;
  return {
    x: (thumb.position.x + index.position.x) / 2,
    y: (thumb.position.y + index.position.y) / 2,
  };
}

/** 拇指尖与食指尖的等比例距离。缺关键点时返回 null。 */
export function pinchDistanceOf(hand: SceneHand, aspect: number): number | null {
  const thumb = landmarkAt(hand, HAND_LANDMARK.THUMB_TIP);
  const index = landmarkAt(hand, HAND_LANDMARK.INDEX_FINGER_TIP);
  if (!thumb || !index) return null;
  return sceneDistance(thumb.position, index.position, aspect);
}
