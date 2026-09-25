import type { Viewport } from '../coords/viewport';
import {
  HAND_LANDMARK,
  landmarkAt,
  toSceneHandSlots,
  type Handedness,
  type RawHand,
  type SceneHand,
} from '../hand/handState';
import type { Vec2 } from '../math/vec2';
import {
  DEFAULT_HAND_SHAPE_THRESHOLDS,
  HandShapeTracker,
  readHandShapeMetrics,
  type HandShape,
  type HandShapeMetrics,
  type HandShapeThresholds,
} from './handShape';
import { DEFAULT_FLICK_CONFIG, FlickDetector, type FlickConfig, type FlickEvent } from './flick';
import { DEFAULT_SNAP_CONFIG, SnapDetector, type SnapConfig, type SnapEvent } from './snap';
import { LandmarkSmoother, type OneEuroOptions } from './oneEuro';
import {
  createEmptyTwoHand,
  createIdleGestures,
  pinchCenterOf,
  palmPointOf,
  sceneDistance,
  type ContinuousGestures,
  type GestureEvent,
  type GestureState,
  type PinchState,
  type TwoHandState,
} from './types';

/**
 * ============================================================================
 * GestureManager —— 关键点 → 手势语义
 * ============================================================================
 *
 * 职责边界（严格按两份文档：手势层不认识素材）：
 *   ✅ 平滑 → 掌心位置/速度、**每只手的**手型判定 → 连续量 + 离散事件
 *   ❌ 不知道有没有素材、不知道命中谁 —— 那是 InteractionManager 的事
 *
 * 五个关键设计：
 *
 * 1. **捏合用"掌心长度归一化的比例"，不用绝对距离**（handy `pinch_ratio_and_midpoint`）。
 *    分母是"手腕 → 中指 MCP"，一段不受手指姿态影响的刚性骨骼，所以指标与手离摄像头
 *    的远近无关：指尖相触 ≈ 0.05–0.20，张开的手 > 1.0。
 *
 * 2. **手型判定是二维的**（`handShape.ts`）：只看"拇食指距离"无法区分捏合与握拳
 *    （握拳时拇指压在食指上，两指尖同样很近）。第二个维度是**食→中夹角** ——
 *    一个"相对量"，握拳时两指同步蜷曲、共同项抵消，所以夹角仍然很小。
 *
 * 3. **每只手一个独立的判定状态。** 双手缩放要知道"另一只手在不在捏"，
 *    握拳急停要知道"哪只手握拳"，所以判定是**按手（slot）**维护的。
 *
 * 4. **判定用原始关键点，位置用平滑关键点。** 判定要低延迟（捏下去就要抓，
 *    这是"抓取不灵敏"的修复），位置要稳（不能抖）—— 两个需求方向相反。
 *    手型量（gap / 夹角 / 伸展度）直接取自**未平滑**的关键点，
 *    `gap` 的迟滞 + `FIST`/`OPEN` 的 2 帧最短保持负责吸收抖动；
 *    素材位置与准星取自 One-Euro 平滑后的关键点。
 *    （试过给手型量单独配一条快滤波，但它会把"张开→捏合"这种大跳变拖上 2 帧，
 *      正好破坏"单帧就抓住"这条真机验证过的性质，所以不用。）
 *
 * 5. **手整只丢失时的宽限**：追踪偶发丢 1–2 帧是常态，一丢就结束 pinch 会打断拖动。
 *    所以宽限期内（默认 0.25s）仍认为按着，只是**给不出位置**（center = null），
 *    交互层据此把素材冻结。
 */

export interface GestureManagerOptions {
  /** 平滑组数（= 追踪的最大手数）。双手缩放要求 >= 2，默认就是 2。 */
  maxHands?: number;
  /** 手型判定阈值（见 `handShape.ts` 与 `docs/手势文法.md`） */
  handShape?: Partial<HandShapeThresholds>;
  /** 指弹判定阈值（见 `flick.ts` 与 `docs/手势文法.md`） */
  flick?: Partial<FlickConfig>;
  /** 打响指（翻页）判定阈值（见 `snap.ts`）。不填就用默认值 */
  snap?: Partial<SnapConfig>;
  /** 手整只丢失后，仍认为 pinch 按住的宽限时长（秒）。 */
  handLossGraceSeconds?: number;
  /** 掌心速度的指数平滑系数（0..1，越小越平滑）。 */
  palmVelocitySmoothing?: number;
  /** 位置用的平滑参数（默认偏慢：要的是不抖）。手型判定不受它影响，走原始关键点。 */
  smoothing?: OneEuroOptions;
}

/** 进入捏合的 gap 阈值（掌心长度归一化）。 */
export const DEFAULT_PINCH_ENTER_RATIO = DEFAULT_HAND_SHAPE_THRESHOLDS.pinchGapEnter;
/**
 * 退出捏合的 gap 阈值。
 *
 * 注意它现在是 **0.60**（第一版是 1.00）：当初放宽到 1.00 的**唯一**原因是
 * "单手张开手指来放大"需要余量。缩放改成双手之后这个余量没用了，
 * 收紧能显著减少误判的捏合。
 */
export const DEFAULT_PINCH_EXIT_RATIO = DEFAULT_HAND_SHAPE_THRESHOLDS.pinchGapExit;

const DEFAULT_HAND_LOSS_GRACE_SECONDS = 0.25;
const DEFAULT_VELOCITY_SMOOTHING = 0.3;

/** 一只手的手型调试快照（真机标定全靠它）。 */
export interface HandShapeDebug {
  handedness: Handedness | null;
  shape: HandShape;
  /** 拇食指距离 / 掌心长度 */
  gap: number | null;
  /** 食→中夹角（度） */
  angleDeg: number | null;
  /** 四指伸展度（|指尖-手腕| / 掌心长度，平面投影） */
  reaches: HandShapeMetrics['reaches'];
  /** 同一批伸展度，但含 MediaPipe 的相对深度 z（握拳要求两者同时成立） */
  reachesDepth: HandShapeMetrics['reachesDepth'];
}

export interface GestureDebugInfo {
  /** 主手的捏合 gap（越小越像捏合） */
  pinchRatio: number | null;
  /** 掌心长度（场景单位，宽向归一化） */
  palmLength: number | null;
  /** 平滑后拿到的手数 */
  handCount: number;
  /** 当前有几只手在捏合（双手缩放要看这个数是不是 2） */
  activePinches: number;
  /** 双手是否成立（两只手都在捏合） */
  twoHandActive: boolean;
  /** 双手间距（场景单位）；不成立时为 null */
  twoHandDistance: number | null;
  /** 当前处于握拳状态的手 */
  fistHands: readonly Handedness[];
  /** 指弹是否已经装填（食指勾住）—— 真机标定时看它知不知道"我勾了" */
  flickArmed: boolean;
  /**
   * 指弹的实时读数与门槛，**并排给出来**。
   *
   * 为什么要把门槛一起暴露：真机上"姿势做了但没反应"是不透明的 ——
   * 到底是拇指没扣住、还是其余三指张开了、还是甩得不够快/不够开？
   * 只有把"读数 vs 需要满足的值"写在同一个面板上，用户才能一眼看出**是哪一条在挡**。
   */
  flick: {
    /** 读数取自哪只手（双手同时在画面里时，"是不是另一只手在扣住"一眼可辨） */
    handedness: Handedness | null;
    /** 这只手本帧的手型：`pinch` 说明拇指还捏着 —— 蓄力姿势本来就和捏合同形（见 `flick.ts`） */
    shape: HandShape;
    /** 食指伸展度（**观测用**：弹脑瓜蓄力时它是伸着的，不参与门槛） */
    indexReach: number | null;
    /** 中指伸展度（装填与弹出都要求它蜷着） */
    middleReach: number | null;
    /** 拇食指距离 ÷ 掌心长度（装填要求它**小** = 拇指扣住） */
    gap: number | null;
    /** 已经连续装填了几帧 */
    armedFrames: number;
    /** 装填/甩开期间的最快瞬时指尖速度（人感受到的那个"快"） */
    peakSpeed: number;
    /** 最近一次"甩开"的 gap 增量（标定要看"差多少"） */
    gapGain: number;
    /** 最近一次"甩开"的指尖速度（标定要看"差多少"） */
    releaseSpeed: number;
    thresholds: {
      loadedMaxGap: number;
      maxMiddleReach: number;
      minGapGain: number;
      loadedFrames: number;
      minTipSpeed: number;
    };
  } | null;
  /**
   * 打响指（翻页）的读数与门槛。
   *
   * 和指弹那两行同样的道理：真机上"打了没反应"完全不透明，必须能把
   * "拇指离中指多远、贴住了没、弹开的增量与速度多少"直接读出来。
   */
  snap: {
    handedness: Handedness | null;
    /** 拇指尖 → 中指尖的距离 ÷ 掌心长度（装填要求它**小**） */
    middleGap: number | null;
    /** 已经连续贴住了几帧 */
    armedFrames: number;
    /** 最近一次弹开的增量 / 中指尖速度 */
    gapGain: number;
    releaseSpeed: number;
    thresholds: {
      loadedMaxGap: number;
      loadedFrames: number;
      minGapGain: number;
      minTipSpeed: number;
    };
  } | null;
  /** 最近一次指弹的指尖速度（各向同性场景单位/秒）；还没弹过为 null */
  flickSpeed: number | null;
  /** 每只手的手型明细 */
  perHand: readonly HandShapeDebug[];
  /** 当前是否处于"手丢失宽限期" */
  inHandLossGrace: boolean;
}

/** 单只手的判定状态。双手缩放 / 握拳急停 / 指弹都要求按手维护。 */
interface HandSlot {
  /** 手型状态机（优先级 + 迟滞 + 最短保持） */
  shapeTracker: HandShapeTracker;
  /** 指弹检测器（动态手势：食指勾住 → 快速弹出）。有状态，所以每只手一个 */
  flickDetector: FlickDetector;
  /** 打响指（翻页）检测器：拇指＋中指贴住再弹开 */
  snapDetector: SnapDetector;
  /** 本帧是否检测到指弹（只活一帧） */
  flick: FlickEvent | null;
  /** 本帧生效的手型。**看不到手时必须是 `other`** —— 手型是对"这一帧看到了什么"的描述 */
  shape: HandShape;
  /**
   * 捏合**会话**是否按住。与 `shape` 分开是必须的：
   * 手丢失宽限期内"会话仍在，但这只手这一帧没被看到"（`shape = other`、位置为 null）。
   * 第一版把两者混成一个字段，结果**手离开画面后 `shape` 停在握拳/捏合上**，
   * 交互层拿这份陈旧手型去判断"能不能重新武装"，就再也解不开（真机反馈过）。
   */
  pinchHeld: boolean;
  /** 本帧是否看到了这只手 */
  present: boolean;
  /** 本次捏合是否已经发过 `gesture-start`（拿不到位置时会晚一帧补发） */
  pinchEmitted: boolean;
  /** 平滑后的捏合中点（仅捏合成立时有意义） */
  center: Vec2 | null;
  /** 本帧的手型原始量（调试用） */
  metrics: HandShapeMetrics;
  /** 拇指尖-食指尖中点：**有没有捏合都给**，屏幕上的准星用它 */
  pinchPoint: Vec2 | null;
  handedness: Handedness | null;
  /** 已经连续多少秒没看到这只手 */
  missingSeconds: number;
  /**
   * 已经连续多少帧判成 `other` 了（**只数 `other`**，`fist`/`open` 不算）。
   *
   * 用来给松手加一点**去抖**：`pinch → other` 的手型切换是**即时**的（只有 fist/open
   * 需要连续帧，见 `handShape.ts`），所以**一帧噪声就够发出 `gesture-end`**，
   * 而交互层收到它就立刻放手。真机反馈"拖动的时候有时候会突然松掉"就是从这来的 ——
   * 而"整只手丢了"反而有 0.25s 宽限，这个不对称没有道理。
   */
  pinchReleaseFrames: number;
}

/**
 * 松开去抖：连续多少帧判成 **`other`** 才算真的松手。
 *
 * ⚠️ **只对 `other` 生效**，不碰 `open` / `fist`：
 *   · `fist` 是急停，必须**立刻**生效（它另有 `fistHands` 通道，交互层当帧就取消）；
 *   · `open` 是"张开手掌＝释放"这个**主动**手势，而且它自己已经有 2 帧保持；
 *   · 只有 `other`（半开、关键点噪声、手半蜷）是**含糊**的那一类 ——
 *     而它的手型切换是**即时**的，所以一帧噪声就够把拖动打断。
 *
 * 真机 20fps 下一帧 50ms，取 3 = **能吸收连续两帧误判**（约 100ms），
 * 代价是真正松手时晚约 100ms。这个方向的代价小得多：
 * 晚放 100ms 只是手感稍钝，而误放一次就是"图掉了、得重新抓"。
 */
const PINCH_RELEASE_GRACE_FRAMES = 3;

/**
 * 双手缩放要求两手至少隔开这么多**掌长**（见 `readTwoHand`）。
 *
 * ⚠️ 这个数**不能大**。第一版取了 1 个掌长（≈0.10 画幅宽），看着很合理，
 * 结果把正常的双手姿势挡在外面了：验收脚本里"两手相距 **0.09**、再拉到 0.18 = 正好 2 倍"
 * 是**自然的起手间距** —— 门槛压在它上面，基准就被推迟到拉开之后才取，倍率凭空少了一半
 * （实测 2.0 → 1.42）。
 *
 * 取 0.35 掌长（≈0.035 画幅宽）：比自然起手间距小 2.5 倍，留足余量；
 * 而"同一只手被检出两次"那种幽灵重合远小于它，照样挡得住。
 */
const MIN_TWO_HAND_SEPARATION_PALMS = 0.35;

/** 掌长拿不到时，上面那条门槛的兜底值（单位 = 画幅宽） */
const MIN_TWO_HAND_SEPARATION_FALLBACK = 0.035;

/**
 * 槽位连续性：判定"这只手其实是上一个槽位那只"的最大位移（归一化坐标的欧氏距离）。
 *
 * 20fps 下手动得快也能到这个量级，所以给得比较宽松 —— 这条修补只在
 * "按标签认领把手塞进了一个**上一帧空着的**槽位"时才生效（见 `assignSlots`）。
 */
const SLOT_CONTINUITY_MAX_DISTANCE = 0.25;

function emptyMetrics(): HandShapeMetrics {
  return {
    gap: null,
    middleGap: null,
    indexMiddleAngle: null,
    reaches: { index: null, middle: null, ring: null, pinky: null },
    reachesDepth: { index: null, middle: null, ring: null, pinky: null },
    palmLength: null,
    pinchCenter: null,
  };
}

function createSlot(
  thresholds: HandShapeThresholds,
  flickConfig: FlickConfig,
  snapConfig: SnapConfig,
): HandSlot {
  return {
    shapeTracker: new HandShapeTracker(thresholds),
    flickDetector: new FlickDetector(flickConfig),
    snapDetector: new SnapDetector(snapConfig),
    flick: null,
    shape: 'other',
    pinchHeld: false,
    present: false,
    pinchEmitted: false,
    center: null,
    metrics: emptyMetrics(),
    pinchPoint: null,
    handedness: null,
    missingSeconds: 0,
    pinchReleaseFrames: 0,
  };
}

export class GestureManager {
  private readonly slots: HandSlot[];
  /** 上一帧各槽位的手腕位置（归一化原始坐标），用于把本帧的手对应回槽位 */
  private readonly slotAnchors: (Vec2 | null)[];
  /** 位置用的平滑器（慢：不抖） */
  private readonly smoother: LandmarkSmoother;
  private readonly maxHands: number;
  private readonly handLossGraceSeconds: number;
  private readonly velocitySmoothing: number;
  private readonly flickConfig: FlickConfig;
  private readonly snapConfig: SnapConfig;

  private _lastTime: number | null = null;
  private _palm: Vec2 | null = null;
  private _palmVelocity: Vec2 = { x: 0, y: 0 };
  private _palmLength: number | null = null;
  private _inGrace = false;
  private _handCount = 0;
  private _smoothedHands: readonly SceneHand[] = [];
  /** 最近一帧的双手状态（调试叠层与真机排查用） */
  private _lastTwoHand: TwoHandState = createEmptyTwoHand();
  private _fistHands: Handedness[] = [];
  /** 最近一次指弹的指尖速度（给调试面板与叠层读数用） */
  private _lastFlickSpeed: number | null = null;

  constructor(options: GestureManagerOptions = {}) {
    this.maxHands = options.maxHands ?? 2;
    if (!Number.isFinite(this.maxHands) || this.maxHands < 1) {
      throw new RangeError(`maxHands 必须 >= 1，收到 ${this.maxHands}`);
    }

    const thresholds: HandShapeThresholds = { ...DEFAULT_HAND_SHAPE_THRESHOLDS, ...options.handShape };
    if (!(thresholds.pinchGapEnter > 0)) throw new RangeError('pinchGapEnter 必须是正数');
    if (!(thresholds.pinchGapExit > thresholds.pinchGapEnter)) {
      throw new RangeError('要求 pinchGapExit > pinchGapEnter（迟滞必须严格成立）');
    }
    if (!(thresholds.pinchAngleEnter > thresholds.pinchAngleExit)) {
      throw new RangeError('要求 pinchAngleEnter > pinchAngleExit（迟滞必须严格成立）');
    }

    this.handLossGraceSeconds = options.handLossGraceSeconds ?? DEFAULT_HAND_LOSS_GRACE_SECONDS;
    this.velocitySmoothing = options.palmVelocitySmoothing ?? DEFAULT_VELOCITY_SMOOTHING;
    this.flickConfig = { ...DEFAULT_FLICK_CONFIG, ...options.flick };
    this.snapConfig = { ...DEFAULT_SNAP_CONFIG, ...options.snap };
    this.smoother = new LandmarkSmoother(this.maxHands, 21, options.smoothing ?? {});
    this.slots = Array.from({ length: this.maxHands }, () =>
      createSlot(thresholds, this.flickConfig, this.snapConfig),
    );
    this.slotAnchors = Array.from({ length: this.maxHands }, () => null);
  }

  /** 是否有手在捏合（主手口径，拖动/抓取用）。 */
  get pinchActive(): boolean {
    return this.slots.some((slot) => slot.pinchHeld);
  }

  /** 现在有几只手在捏合（双手缩放要 == 2）。 */
  get activePinchCount(): number {
    return this.slots.reduce((count, slot) => count + (slot.pinchHeld ? 1 : 0), 0);
  }

  /** 当前握拳的手（急停信号）。 */
  get fistHands(): readonly Handedness[] {
    return this._fistHands;
  }

  /** 最近一帧平滑后的手（场景坐标）。调试叠层用它画骨架。 */
  get smoothedHands(): readonly SceneHand[] {
    return this._smoothedHands;
  }

  get debug(): GestureDebugInfo {
    const primary = this.primarySlot();
    const flickSlot = this.flickDebugSlot() ?? primary;
    const twoHand = this._lastTwoHand;
    return {
      pinchRatio: primary?.metrics.gap ?? null,
      palmLength: this._palmLength,
      handCount: this._handCount,
      activePinches: this.activePinchCount,
      twoHandActive: twoHand.active,
      twoHandDistance: twoHand.distance,
      fistHands: [...this._fistHands],
      flickArmed: this.slots.some((slot) => slot.flickDetector.armedFrames > 0),
      flick: flickSlot
        ? {
            handedness: flickSlot.handedness,
            shape: flickSlot.shape,
            indexReach: flickSlot.metrics.reaches.index,
            middleReach: flickSlot.metrics.reaches.middle,
            gap: flickSlot.metrics.gap,
            armedFrames: flickSlot.flickDetector.armedFrames,
            peakSpeed: flickSlot.flickDetector.peakTipSpeed,
            gapGain: flickSlot.flickDetector.gapGain,
            releaseSpeed: flickSlot.flickDetector.releaseSpeed,
            thresholds: {
              loadedMaxGap: this.flickConfig.loadedMaxGap,
              maxMiddleReach: this.flickConfig.maxMiddleReach,
              minGapGain: this.flickConfig.minGapGain,
              loadedFrames: this.flickConfig.loadedFrames,
              minTipSpeed: this.flickConfig.minTipSpeed,
            },
          }
        : null,
      /*
       * 打响指的读数用**和指弹同一只手**（`flickSlot`）。
       * 两个手势都是单手动作、用户实际也就用一只手操作，没必要再各挑一次槽位。
       */
      snap: flickSlot
        ? {
            handedness: flickSlot.handedness,
            middleGap: flickSlot.metrics.middleGap,
            armedFrames: flickSlot.snapDetector.armedFrames,
            gapGain: flickSlot.snapDetector.gapGain,
            releaseSpeed: flickSlot.snapDetector.releaseSpeed,
            thresholds: {
              loadedMaxGap: this.snapConfig.loadedMaxGap,
              loadedFrames: this.snapConfig.loadedFrames,
              minGapGain: this.snapConfig.minGapGain,
              minTipSpeed: this.snapConfig.minTipSpeed,
            },
          }
        : null,
      flickSpeed: this._lastFlickSpeed,
      perHand: this.slots
        .filter((slot): boolean => slot.present || slot.pinchPoint !== null)
        .map((slot) => ({
          handedness: slot.handedness,
          shape: slot.shape,
          gap: slot.metrics.gap,
          angleDeg:
            slot.metrics.indexMiddleAngle === null
              ? null
              : (slot.metrics.indexMiddleAngle * 180) / Math.PI,
          reaches: slot.metrics.reaches,
          reachesDepth: slot.metrics.reachesDepth,
        })),
      inHandLossGrace: this._inGrace,
    };
  }

  /** 忘记全部历史（追踪重启、摄像头切换时用）。 */
  reset(): void {
    this.smoother.reset();
    for (const slot of this.slots) {
      slot.shapeTracker.reset();
      /*
       * 两个动作检测器也要清：它们的状态（装填帧数、起跳参考帧）都建立在
       * "这一帧看到了这只手"上。以前漏了这一步，于是"忘记全部历史"其实没忘干净。
       */
      slot.flickDetector.reset();
      slot.snapDetector.reset();
      slot.shape = 'other';
      slot.pinchHeld = false;
      slot.present = false;
      slot.pinchEmitted = false;
      slot.center = null;
      slot.metrics = emptyMetrics();
      slot.pinchPoint = null;
      slot.handedness = null;
      slot.missingSeconds = 0;
      slot.pinchReleaseFrames = 0;
    }
    for (let index = 0; index < this.slotAnchors.length; index += 1) this.slotAnchors[index] = null;
    this._lastTime = null;
    this._palm = null;
    this._palmVelocity = { x: 0, y: 0 };
    this._palmLength = null;
    this._handCount = 0;
    this._inGrace = false;
    this._smoothedHands = [];
    this._lastTwoHand = createEmptyTwoHand();
    this._fistHands = [];
  }

  /**
   * 推进一帧。
   * @param hands 追踪输出的原始手（整帧归一化坐标）
   * @param timeSeconds 单调递增的时间（秒）
   * @param viewport 场景坐标换算需要它
   */
  update(hands: readonly RawHand[], timeSeconds: number, viewport: Viewport): GestureState {
    const dt = this._lastTime === null ? 0 : Math.max(0, timeSeconds - this._lastTime);
    this._lastTime = timeSeconds;

    // 先把手分配进固定槽位，再平滑 —— 顺序不能反：
    // 平滑是"每个槽位一组滤波器"，分配错了就会把两只手的状态搅在一起。
    const slotted = this.assignSlots(hands);

    const smoothed = this.smoother.smooth(slotted, timeSeconds);
    const sceneHands = toSceneHandSlots(smoothed, viewport);
    // 手型量走**原始**关键点：捏下去就要抓，判定不能等滤波（这是"抓取不灵敏"的修复）
    const rawSceneHands = toSceneHandSlots(slotted, viewport);
    const aspect = viewport.sceneAspect;
    const events: GestureEvent[] = [];

    this._smoothedHands = sceneHands.filter((hand): hand is SceneHand => hand !== undefined);
    this._handCount = this._smoothedHands.length;
    this._inGrace = false;

    const present = sceneHands.map((hand) => hand !== undefined);
    // 记录本帧各槽位的手腕位置（**归一化原始坐标**），供下一帧把手对应回槽位。
    // 必须与 assignSlots 里的参照点同处一个坐标空间 —— 场景坐标是镜像 + 裁切之后的，
    // 拿它和原始归一化坐标比大小，在前置摄像头（默认镜像）下会把两只手认反。
    slotted.forEach((hand, index) => {
      this.slotAnchors[index] = hand ? wristPointOf(hand) : null;
    });

    const flicks: FlickEvent[] = [];
    const snaps: SnapEvent[] = [];
    this.slots.forEach((slot, index) => {
      slot.flick = null;
      const hand = sceneHands[index];
      const raw = rawSceneHands[index];
      if (!hand) {
        this.updateSlotWithoutHand(slot, dt, timeSeconds, events);
        return;
      }
      this.updateSlotWithHand(slot, hand, raw, aspect, timeSeconds, events, flicks, snaps, dt);
    });

    this._fistHands = this.slots
      .filter((slot) => slot.present && slot.shape === 'fist')
      .map((slot) => slot.handedness ?? 'unknown');

    const primaryIndex = this.resolvePrimaryIndex(present);
    const primaryHand = primaryIndex >= 0 ? sceneHands[primaryIndex] : undefined;
    if (primaryHand) {
      this.updatePalmVelocity(primaryHand, dt);
      this._palmLength = this.slots[primaryIndex]?.metrics.palmLength ?? null;
    } else {
      this._palm = null;
      this._palmVelocity = { x: 0, y: 0 };
      this._palmLength = null;
    }

    const controls = this.buildControls(aspect, primaryIndex);
    this._lastTwoHand = controls.twoHand;

    return {
      time: timeSeconds,
      controls,
      events,
      flicks,
      snaps,
    };
  }

  // ---------------------------------------------------------------- 槽位

  /**
   * 把本帧识别到的手放进固定槽位（0/1…）。
   *
   * 为什么不能直接按下标用：MediaPipe 输出的**手序不稳定**（它内部按跟踪 id 排，
   * 两只手交叉、一进一出时顺序会变），而下标直接决定了用哪一组滤波器。
   * 一换序，右手的位置就会从左手上一帧的位置"滑"过来，双手缩放时表现为间距突然跳一下。
   *
   * 认领顺序（真机上踩过坑，顺序不能反）：
   *   1. **先按左右手标签认领**。标签是比"离上一帧最近"更稳的身份信号。
   *      只按就近匹配会出事：第二只手刚出现时，两只手到旧锚点的距离可能几乎相等
   *      （对称站姿正好是平局），于是两只手对调槽位 —— 紧接着旧槽位的判定状态
   *      会被新手继承，而抓着手的那只手在新槽位里"第一次"触发 pinch，
   *      交互层就会把它当成一次新的抓取，先释放掉正在进行的抓取（真机复现：
   *      第二只手一捏上，图片就掉了）。
   *   2. 剩下的按上一帧位置就近归位（标签缺失/翻转时的兜底）。
   *   3. 全新出现的手按识别顺序填空槽位（下一帧就会稳定下来）。
   */
  private assignSlots(hands: readonly RawHand[]): (RawHand | undefined)[] {
    const slots: (RawHand | undefined)[] = Array.from({ length: this.maxHands }, () => undefined);
    const available = [...hands];

    // 第一轮：按左右手标签认领（槽位记住自己上一帧是哪只手）
    for (let slot = 0; slot < this.maxHands; slot += 1) {
      const known = this.slots[slot]?.handedness;
      if (!known || known === 'unknown') continue;
      const index = available.findIndex((hand) => hand.handedness === known);
      if (index < 0) continue;
      slots[slot] = available[index];
      available.splice(index, 1);
    }

    /*
     * 第一轮的修补：**别让"上一帧空着的槽位"凭标签把手抢走**。
     *
     * 场景：slot0 一直拿着你的右手（正在拖图），你的左手早先出现过、走了，
     * 但 slot1 仍然**记得**自己是 `left`（`handedness` 不会因为手走了就清空）。
     * 这时右手只要被 MediaPipe 的标签翻一次（前置摄像头镜像下并不罕见），
     * 第一轮就会把它塞进 slot1 —— slot0 于是"手丢了"，而"正在抓着哪张图"
     * 正是绑在 slot0 的判定状态上的，接着就是 0.25s 后放手（真机"突然松掉"的候选之一）。
     *
     * 判据很克制：**只有**"认领它的槽位上一帧是空的"**且**"另一个槽位上一帧有手、
     * 现在空着、而且离这只手足够近"同时成立时才搬回去 —— 也就是"手没怎么动，是标签变了"。
     */
    for (let slot = 0; slot < this.maxHands; slot += 1) {
      const hand = slots[slot];
      if (!hand) continue;
      // 认领它的槽位上一帧也有手 -> 这就是正常的标签认领，不动
      if (this.slotAnchors[slot]) continue;

      const reference = wristPointOf(hand);
      if (!reference) continue;

      let bestSlot = -1;
      let bestDistance = SLOT_CONTINUITY_MAX_DISTANCE * SLOT_CONTINUITY_MAX_DISTANCE;
      for (let other = 0; other < this.maxHands; other += 1) {
        if (other === slot || slots[other]) continue;
        const anchor = this.slotAnchors[other];
        if (!anchor) continue;
        const dx = reference.x - anchor.x;
        const dy = reference.y - anchor.y;
        const squared = dx * dx + dy * dy;
        if (squared <= bestDistance) {
          bestDistance = squared;
          bestSlot = other;
        }
      }

      if (bestSlot >= 0) {
        slots[bestSlot] = hand;
        slots[slot] = undefined;
      }
    }

    // 第二轮：按上一帧位置就近归位
    for (let slot = 0; slot < this.maxHands; slot += 1) {
      if (slots[slot]) continue;
      const anchor = this.slotAnchors[slot];
      if (!anchor) continue;

      let bestIndex = -1;
      let bestDistance = Number.POSITIVE_INFINITY;
      available.forEach((hand, index) => {
        const reference = wristPointOf(hand);
        if (!reference) return;
        const dx = reference.x - anchor.x;
        const dy = reference.y - anchor.y;
        const distance = dx * dx + dy * dy;
        if (distance < bestDistance) {
          bestDistance = distance;
          bestIndex = index;
        }
      });

      if (bestIndex >= 0) {
        slots[slot] = available[bestIndex];
        available.splice(bestIndex, 1);
      }
    }

    // 第三轮：剩下的手填进空槽位
    for (const hand of available) {
      const free = slots.indexOf(undefined);
      if (free < 0) break;
      slots[free] = hand;
    }

    return slots;
  }

  /** 主手：第一只**捏合中**的手；没有捏合的则取第一只有手的槽位；都没有返回 -1。 */
  private resolvePrimaryIndex(present: readonly boolean[]): number {
    const pinching = this.slots.findIndex((slot) => slot.pinchHeld);
    if (pinching >= 0) return pinching;
    return present.findIndex((has) => has);
  }

  private primarySlot(): HandSlot | null {
    const present = this.slots.map((slot) => slot.present);
    const index = this.resolvePrimaryIndex(present);
    return index >= 0 ? (this.slots[index] ?? null) : null;
  }

  /**
   * 调试面板该显示哪只手的指弹读数。
   *
   * 优先给**正在装填**的那只手：双手同时在画面里时，用户实际勾住的那只手不一定是
   * primary（primary 优先给捏合中的手）。面板如果只盯着 primary，会出现
   * "我明明勾住了，面板读数却纹丝不动"的假象 —— 排查时最容易被带偏。
   */
  private flickDebugSlot(): HandSlot | null {
    const armed = this.slots.find((slot) => slot.flickDetector.armedFrames > 0);
    if (armed) return armed;
    return this.primarySlot();
  }

  // ---------------------------------------------------------------- 单槽位

  private updateSlotWithHand(
    slot: HandSlot,
    hand: SceneHand,
    raw: SceneHand | undefined,
    aspect: number,
    timeSeconds: number,
    events: GestureEvent[],
    flicks: FlickEvent[],
    snaps: SnapEvent[],
    dt: number,
  ): void {
    slot.present = true;
    slot.missingSeconds = 0;
    slot.handedness = hand.handedness;

    // 手型量（gap / 夹角 / 伸展度）取自**未平滑**的关键点：判定要低延迟
    const metrics = readHandShapeMetrics(raw ?? hand, aspect);
    slot.metrics = metrics;
    // 准星与拖动位置取自平滑后的关键点：位置要的是不抖
    slot.pinchPoint = pinchCenterOf(hand);

    const wasPinching = slot.pinchHeld;
    const shape = slot.shapeTracker.update(metrics);
    slot.shape = shape;
    slot.pinchHeld = shape === 'pinch';
    const center = metrics.pinchCenter === null ? null : pinchCenterOf(hand);

    /*
     * 指弹（动态手势）：喂的是**原始**关键点上的食指伸展度/拇食指距离/指尖位置。
     * 和手型判定用同一份原始数据 —— 它们都在回答"这一帧手在做什么"，
     * 都要求低延迟；位置那一路才需要平滑。
     */
    slot.flick = slot.flickDetector.update(
      {
        indexReach: metrics.reaches.index,
        middleReach: metrics.reaches.middle,
        gap: metrics.gap,
        tip: landmarkAt(raw ?? hand, HAND_LANDMARK.INDEX_FINGER_TIP)?.position ?? null,
        aspect,
        time: timeSeconds,
      },
      dt,
    );
    if (slot.flick) {
      this._lastFlickSpeed = slot.flick.speed;
      flicks.push({ ...slot.flick, hand: hand.handedness });
    }

    /*
     * 打响指（翻页）：喂**中指**指尖与"拇指→中指"的距离。
     *
     * 它和指弹（拇指↔食指）是两条独立的手势 —— 按**哪根手指**分开，
     * 所以同一次动作不会两边都触发（见 `snap.ts` 顶部）。
     */
    const snapped = slot.snapDetector.update(
      {
        thumbMiddleGap: metrics.middleGap,
        thumbIndexGap: metrics.gap,
        tip: landmarkAt(raw ?? hand, HAND_LANDMARK.MIDDLE_FINGER_TIP)?.position ?? null,
        aspect,
        time: timeSeconds,
      },
      dt,
    );
    if (snapped) snaps.push({ hand: hand.handedness, time: timeSeconds });

    if (shape === 'pinch') {
      slot.pinchReleaseFrames = 0;
      slot.center = center;
      if (center === null) {
        // 判定成立但关键点不全（手在画面边缘被裁掉等）：按"按着但不知道在哪"处理，
        // 交互层会冻结素材；start 事件等拿到位置那一帧再补发。
        this._inGrace = true;
        return;
      }
      if (!slot.pinchEmitted) {
        slot.pinchEmitted = true;
        events.push(this.makeEvent(true, hand.handedness, center, timeSeconds));
      }
      return;
    }

    /*
     * 判成 `other`（含糊的那一类）—— **先别急着结束会话**（见 `PINCH_RELEASE_GRACE_FRAMES`）。
     * 但 `fist` / `open` 不走这条：前者是急停必须立刻停，后者是主动的"张开手掌＝释放"。
     *
     * 宽限期内继续算"按着"，并且**保留上一帧的 center**：清空 center 会让交互层
     * 按"按着但不知道在哪"把素材冻结，拖动会一顿一顿的。
     */
    if (
      shape === 'other' &&
      slot.pinchEmitted &&
      slot.pinchReleaseFrames + 1 < PINCH_RELEASE_GRACE_FRAMES
    ) {
      slot.pinchReleaseFrames += 1;
      slot.pinchHeld = true;
      return;
    }

    const position = slot.center ?? center ?? metrics.pinchCenter ?? { x: 0.5, y: 0.5 };
    slot.center = null;
    if (wasPinching && slot.pinchEmitted) {
      slot.pinchEmitted = false;
      events.push(this.makeEvent(false, hand.handedness, position, timeSeconds));
    }
  }

  private updateSlotWithoutHand(
    slot: HandSlot,
    dt: number,
    timeSeconds: number,
    events: GestureEvent[],
  ): void {
    slot.present = false;
    slot.pinchPoint = null;
    slot.metrics = emptyMetrics();
    slot.missingSeconds += dt;
    /*
     * 指弹检测器也要喂一帧"没有手"。
     *
     * 它的装填状态与起跳参考帧都建立在"这一帧看到了这只手"上，而 `update(null, dt)`
     * 正是它自己的"手丢了"分支。以前没人喂 null，于是那个分支**在生产里根本到不了** ——
     * 手离开画面后检测器**一直停在"已扣住"**，调试面板挂着上一次的读数骗人。
     * 浏览器验收抓到的正是这个：面板同时报 `装填=true` 与 `扣=null 中=null 手型=other`，
     * 自相矛盾（判据里 gap 为 null 根本不可能装填）。
     */
    slot.flickDetector.update(null, dt);
    slot.snapDetector.update(null, dt);
    /*
     * **看不到手时手型必须是 `other`**（这条是修 bug 的关键）。
     * 第一版在这里对非 pinch 的手型直接 return，于是"手已经离开画面了，
     * 槽位里还留着上一次的 fist" —— 交互层拿这份陈旧手型去判断"能不能重新武装"，
     * 就永远解不开（真机反馈"张开手了还是抓不住"）。
     * 手型是对"这一帧看到了什么"的描述，看不到就是 other；
     * "捏合会话还按着"是另一件事，由 `pinchHeld` 单独记。
     */
    slot.shape = 'other';

    if (!slot.pinchHeld) {
      slot.center = null;
      return;
    }

    if (slot.missingSeconds >= this.handLossGraceSeconds) {
      const position = slot.center ?? { x: 0.5, y: 0.5 };
      const hand: Handedness = slot.handedness ?? 'unknown';
      slot.shapeTracker.reset();
      slot.pinchHeld = false;
      slot.center = null;
      if (slot.pinchEmitted) {
        slot.pinchEmitted = false;
        events.push(this.makeEvent(false, hand, position, timeSeconds));
      }
    } else {
      // 宽限期内：仍认为按着，但给不出位置 -> 交互层会把素材冻结
      this._inGrace = true;
      slot.center = null;
    }
  }

  private updatePalmVelocity(hand: SceneHand, dt: number): void {
    const palm = palmPointOf(hand);
    if (!palm) {
      this._palm = null;
      this._palmVelocity = { x: 0, y: 0 };
      return;
    }

    if (this._palm && dt > 0) {
      const instantaneous = {
        x: (palm.x - this._palm.x) / dt,
        y: (palm.y - this._palm.y) / dt,
      };
      const k = this.velocitySmoothing;
      this._palmVelocity = {
        x: this._palmVelocity.x + (instantaneous.x - this._palmVelocity.x) * k,
        y: this._palmVelocity.y + (instantaneous.y - this._palmVelocity.y) * k,
      };
    }

    this._palm = palm;
  }

  private buildControls(aspect: number, primaryIndex: number): ContinuousGestures {
    const pinches: PinchState[] = this.slots.map((slot) => {
      const active = slot.pinchHeld;
      return {
        active,
        handedness: slot.handedness,
        shape: slot.shape,
        // 宽限期内 active 为 true 但 center 为 null —— 这是刻意的契约：
        // "按着，但不知道在哪"，交互层据此冻结素材而不是乱跟。
        center: active ? slot.center : null,
        gap: slot.metrics.gap,
      };
    });

    const primarySlot = primaryIndex >= 0 ? this.slots[primaryIndex] : undefined;
    const idle = createIdleGestures();

    return {
      palm: this._palm,
      palmVelocity: { ...this._palmVelocity },
      pinches,
      pinch: pinches[primaryIndex] ?? idle.pinch,
      pinchPoint: primarySlot?.pinchPoint ? { ...primarySlot.pinchPoint } : null,
      twoHand: this.readTwoHand(aspect),
      fistHands: [...this._fistHands],
      handCount: this._handCount,
      primaryHandedness: primarySlot?.handedness ?? null,
    };
  }

  /**
   * 双手状态：**两只手都在捏合**才算成立。
   *
   * 用两个捏合中点（而不是掌心）来算中点和间距：缩放的时候手指就是在这两个点上，
   * 间距变化直接对应用户"拉开/收拢"的动作直觉。
   *
   * 间距给两份：`distance` 用平滑后的中点（做实时倍率，稳），
   * `rawDistance` 用**原始**中点（做基准，无滞后）——
   * 只用平滑值当基准会让素材在第二只手捏上时自己变大 6%（详见 `TwoHandState`）。
   */
  private readTwoHand(aspect: number): TwoHandState {
    const a = this.slots[0];
    const b = this.slots[1];
    if (!a?.shape || !b?.shape) return createEmptyTwoHand();
    if (a.shape !== 'pinch' || b.shape !== 'pinch') return createEmptyTwoHand();
    if (!a.center || !b.center) return createEmptyTwoHand();

    const distance = sceneDistance(a.center, b.center, aspect);
    /*
     * 两手必须**真的分得开**才算双手。
     *
     * 缺这条护栏时，如果两个"捏合中点"几乎重合（同一只手被检出两次、或两只手叠在一起），
     * 基准间距就接近 0，之后**子像素级的抖动**会被 `distance / start` 放大成剧烈缩放
     * （交互层把倍率 clamp 在 0.1–10，也就是允许抖出 10 倍）。
     * 用**掌长**当尺子，天生与人的手大小无关。
     */
    const palm = Math.max(a.metrics.palmLength ?? 0, b.metrics.palmLength ?? 0);
    const minSeparation =
      palm > 0 ? palm * MIN_TWO_HAND_SEPARATION_PALMS : MIN_TWO_HAND_SEPARATION_FALLBACK;
    if (distance < minSeparation) return createEmptyTwoHand();

    const rawA = a.metrics.pinchCenter;
    const rawB = b.metrics.pinchCenter;
    const rawDistance = rawA && rawB ? sceneDistance(rawA, rawB, aspect) : null;

    return {
      active: true,
      center: { x: (a.center.x + b.center.x) / 2, y: (a.center.y + b.center.y) / 2 },
      distance,
      /*
       * 基准间距同样要过这道尺子：`rawDistance` 是没平滑的，更容易被单帧噪声压得很小，
       * 而它正是交互层的缩放**基准**（基准小 → 倍率爆掉）。太小就退回平滑值。
       */
      rawDistance:
        rawDistance !== null && rawDistance >= minSeparation ? rawDistance : distance,
    };
  }

  private makeEvent(active: boolean, hand: Handedness, position: Vec2, time: number): GestureEvent {
    return {
      type: active ? 'gesture-start' : 'gesture-end',
      gesture: 'pinch',
      hand,
      position: { x: position.x, y: position.y },
      time,
    };
  }
}

/** 手腕位置（整帧归一化坐标）；关键点缺失时返回 null。用作槽位对应的锚点。 */
function wristPointOf(hand: RawHand): Vec2 | null {
  const wrist = hand.landmarks[HAND_LANDMARK.WRIST];
  return wrist ? { x: wrist.position.x, y: wrist.position.y } : null;
}
