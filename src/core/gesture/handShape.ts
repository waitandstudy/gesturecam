import { HAND_LANDMARK, landmarkAt, type SceneHand, type SceneLandmark } from '../hand/handState';
import type { Vec2 } from '../math/vec2';

/**
 * ============================================================================
 * 手型判定（手势文法的手型层）
 * ============================================================================
 *
 * 规格见 `docs/手势文法.md`。这里是它的实现，四条规矩：
 *
 *   1. 手型是**静态判定**（看这一帧的手长什么样），动作是手型的组合与变化。
 *   2. 拇指+食指捏合 = 鼠标左键，是**唯一**的选择入口。
 *   3. 握拳 = 急停，**优先级最高**。
 *   4. 判定必须能分开"捏"和"拳"—— 这两个手型在"拇食指距离"这**一个**维度上是重叠的
 *      （握拳时拇指常压在食指上，两指尖距离同样很小）。
 *
 * ## 第二个维度用"食→中夹角"，而不是"其余三指是否伸展"
 *
 *    θ = angle(食指 MCP→TIP, 中指 MCP→TIP)
 *
 * 关键在于它是**相对量**：握拳时食指与中指**一起**蜷曲，共同项被抵消，
 * 所以 θ 在握拳时仍然很小；而捏合时食指屈向拇指、中指保持朝前，θ 明显变大。
 *
 *   | 姿势 | 食指向量 | 中指向量 | θ |
 *   | 张开 | 朝前 | 朝前 | 小 |
 *   | 握拳 | 卷向掌心 | 卷向掌心 | 小 |
 *   | 捏合 | 屈向拇指 | 朝前 | **大** |
 *
 * ⚠️ **参考系绝对不能用"手掌轴线"（手腕→中指 MCP）**：握拳时食指卷向掌心，
 * 相对手掌轴线会变成一个大角度，就和捏合混在一起了。
 *
 * 为什么不用"其余三指伸展"当捏合条件：真人捏合时无名指与小指常常自然半蜷，
 * 那条硬条件会拒判掉一批正常用户。现在手指蜷曲度**只**用于握拳检测。
 */

/** 手型。`other` 表示"都不像"，什么动作都不做。 */
export type HandShape = 'pinch' | 'fist' | 'open' | 'other';

export interface HandShapeThresholds {
  /** 进入捏合的 gap 阈值（越小越难触发） */
  pinchGapEnter: number;
  /** 退出捏合的 gap 阈值，必须大于 enter（迟滞） */
  pinchGapExit: number;
  /** 进入捏合的食→中夹角阈值（弧度） */
  pinchAngleEnter: number;
  /** 退出捏合的夹角阈值（弧度），必须小于 enter */
  pinchAngleExit: number;
  /** 手指"伸展"判据：|指尖-手腕| / 掌心长度（平面或三维任一成立即可） */
  fingerExtended: number;
  /**
   * 手指"蜷曲"判据（**平面**距离）。
   *
   * 从 1.15 收到 1.05：真握拳时指尖基本落回指根，读数 ≈0.95–1.05；
   * 而"松开拳头但手还半握着"的放松手是 1.2 以上。1.15 会把放松手误判成握拳 ——
   * 真机反馈"我已经张开手了，它还说我是握拳"就是这么来的。
   */
  fingerCurled: number;
  /** 手指"蜷曲"判据（**三维**距离）。握拳要求两个判据同时成立 */
  fingerCurledDepth: number;
  /** 张开手掌至少要有几根手指伸展 */
  openMinExtended: number;
  /** 握拳 / 张开手掌被承认前需要连续保持的帧数 */
  shapeHoldFrames: number;
}

export const DEFAULT_HAND_SHAPE_THRESHOLDS: Readonly<HandShapeThresholds> = Object.freeze({
  pinchGapEnter: 0.5,
  /**
   * 退出阈值从 1.00 收紧到 0.60。
   * 原来放到 1.00 的唯一原因是"单手张开手指来放大"需要余量 ——
   * 缩放交给双手之后这个余量没用了，收紧能显著减少误判的捏合。
   */
  pinchGapExit: 0.6,
  pinchAngleEnter: (25 * Math.PI) / 180,
  pinchAngleExit: (18 * Math.PI) / 180,
  fingerExtended: 1.35,
  /**
   * 蜷曲判据（平面）：真握拳时指尖基本落回指根，读数 ≈0.95–1.05，
   * 而"松开拳头但还半握着"的放松手在 1.2 以上。取 1.10 是给真拳头留一点余量，
   * 同时把放松手挡在外面（原来的 1.15 太松，真机上把放松手判成了握拳）。
   */
  fingerCurled: 1.1,
  /** 蜷曲判据（含深度）。比平面松一点：z 的噪声更大，不该由它来卡边界 */
  fingerCurledDepth: 1.2,
  openMinExtended: 3,
  shapeHoldFrames: 2,
});

/** 一只手这一帧的全部手型原始量。缺关键点时对应项为 null。 */
export interface HandShapeMetrics {
  /** 拇食指距离 / 掌心长度（越小越像捏合） */
  gap: number | null;
  /**
   * 拇指尖 → **中指尖**的距离 ÷ 掌心长度。
   *
   * 打响指（翻页）要的就是它：拇指和中指贴住再弹开。
   * 和 `gap`（拇食指）一起看才能确认"贴着的是中指而不是食指"—— 见 `gesture/snap.ts`。
   */
  middleGap: number | null;
  /** 食→中夹角（弧度）。两向量都做了各向同性修正，所以夹角与画面宽高比无关 */
  indexMiddleAngle: number | null;
  /** 四指伸展度 |指尖 - 手腕| / 掌心长度（**平面投影**，会被透视缩短影响） */
  reaches: {
    index: number | null;
    middle: number | null;
    ring: number | null;
    pinky: number | null;
  };
  /**
   * 同一个伸展度，但用**三维**距离（含 MediaPipe 的相对深度 z）。
   *
   * 两者的分工是一条刻意的不对称：
   *   · "伸展"用 `reaches` **或** `reachesDepth` —— 任一成立就算伸展（捏合要容易成立）
   *   · "蜷曲"要**两者都**成立 —— 握拳是最危险的状态（它锁住一切操作），宁可难认
   * 于是"手指朝向镜头"这种透视缩短骗不过握拳判定（见 `isotropicDistance3d`）。
   */
  reachesDepth: {
    index: number | null;
    middle: number | null;
    ring: number | null;
    pinky: number | null;
  };
  /** 掌心长度（场景单位，宽向归一化）。追踪抖动导致关键点塌缩时不让它趋近 0 */
  palmLength: number | null;
  /** 拇食指中点（场景坐标），有没有捏合都给 */
  pinchCenter: Vec2 | null;
}

const MIN_PALM_LENGTH = 1e-6;

/** 四指的 (MCP, TIP) 关键点索引。 */
const FINGERS = {
  index: { mcp: HAND_LANDMARK.INDEX_FINGER_MCP, tip: HAND_LANDMARK.INDEX_FINGER_TIP },
  middle: { mcp: HAND_LANDMARK.MIDDLE_FINGER_MCP, tip: HAND_LANDMARK.MIDDLE_FINGER_TIP },
  ring: { mcp: HAND_LANDMARK.RING_FINGER_MCP, tip: HAND_LANDMARK.RING_FINGER_TIP },
  pinky: { mcp: HAND_LANDMARK.PINKY_MCP, tip: HAND_LANDMARK.PINKY_TIP },
} as const;

export type FingerName = keyof typeof FINGERS;

/**
 * 场景坐标下的**各向同性**向量。
 *
 * 场景坐标是 [0,1]² 但画面不是正方形，直接拿 (dx, dy) 算夹角会被宽高比拉歪
 * （竖屏 9:16 下同一个手势会被算成完全不同的角度）。把 y 除以宽高比之后
 * 两轴的单位长度一致，夹角才有物理意义。
 */
function isotropic(from: Vec2, to: Vec2, aspect: number): Vec2 {
  const safe = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  return { x: to.x - from.x, y: (to.y - from.y) / safe };
}

/** 各向同性平面距离（把 y 换算到"以画幅宽度为单位"）。 */
function isotropicDistance(from: Vec2, to: Vec2, aspect: number): number {
  const d = isotropic(from, to, aspect);
  return Math.hypot(d.x, d.y);
}

/**
 * 各向同性**三维**距离。
 *
 * `z` 是 MediaPipe 给出的相对深度，量纲"与 x 大致同尺度"（按输入图像宽度归一化），
 * 而 `y` 按图像高度归一化 —— 所以先把 y 换算成宽度单位再和 z 拼起来，三者才同尺度。
 *
 * 为什么必须引入它：**透视缩短**。
 * 只用 2D 距离时，"手指朝向镜头伸开"与"蜷曲握拳"在投影上几乎一样：
 * 指尖都落在掌心附近。真机上表现为"我明明张开手了，它还说我握着拳"，
 * 而握拳是最危险的状态（它会锁住一切操作）。加上 z 之后两者立刻分开：
 * 朝向镜头时 2D 距离塌缩、但 3D 距离不变。
 */
function isotropicDistance3d(a: SceneLandmark, b: SceneLandmark, aspect: number): number {
  const safe = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  const dx = b.position.x - a.position.x;
  const dy = (b.position.y - a.position.y) / safe;
  const dz = b.z - a.z;
  return Math.hypot(dx, dy, dz);
}

/** 两个各向同性向量的夹角（弧度，0..π）。任一长度过小时返回 null。 */
function angleBetween(a: Vec2, b: Vec2): number | null {
  const la = Math.hypot(a.x, a.y);
  const lb = Math.hypot(b.x, b.y);
  if (!(la > 1e-9) || !(lb > 1e-9)) return null;
  const cosine = Math.min(1, Math.max(-1, (a.x * b.x + a.y * b.y) / (la * lb)));
  return Math.acos(cosine);
}

/** 读出这一帧的手型原始量。纯函数，好单测。 */
export function readHandShapeMetrics(hand: SceneHand, aspect: number): HandShapeMetrics {
  const wrist = landmarkAt(hand, HAND_LANDMARK.WRIST) ?? null;
  const middleMcp = landmarkAt(hand, HAND_LANDMARK.MIDDLE_FINGER_MCP) ?? null;

  const palmLength =
    wrist && middleMcp ? Math.max(isotropicDistance(wrist.position, middleMcp.position, aspect), MIN_PALM_LENGTH) : null;

  const reaches: HandShapeMetrics['reaches'] = { index: null, middle: null, ring: null, pinky: null };
  const reachesDepth: HandShapeMetrics['reachesDepth'] = { index: null, middle: null, ring: null, pinky: null };
  if (wrist && palmLength) {
    for (const name of Object.keys(FINGERS) as FingerName[]) {
      const tip = landmarkAt(hand, FINGERS[name].tip);
      reaches[name] = tip ? isotropicDistance(wrist.position, tip.position, aspect) / palmLength : null;
      reachesDepth[name] = tip ? isotropicDistance3d(wrist, tip, aspect) / palmLength : null;
    }
  }

  const thumbTip = landmarkAt(hand, HAND_LANDMARK.THUMB_TIP) ?? null;
  const indexTipLandmark = landmarkAt(hand, HAND_LANDMARK.INDEX_FINGER_TIP) ?? null;
  const indexMcpLandmark = landmarkAt(hand, HAND_LANDMARK.INDEX_FINGER_MCP) ?? null;
  const middleTipLandmark = landmarkAt(hand, HAND_LANDMARK.MIDDLE_FINGER_TIP) ?? null;

  const thumbTipPosition = thumbTip?.position ?? null;
  const indexTip = indexTipLandmark?.position ?? null;
  const middleTip = middleTipLandmark?.position ?? null;

  const gap =
    thumbTipPosition && indexTip && palmLength
      ? isotropicDistance(thumbTipPosition, indexTip, aspect) / palmLength
      : null;
  const pinchCenter =
    thumbTipPosition && indexTip
      ? { x: (thumbTipPosition.x + indexTip.x) / 2, y: (thumbTipPosition.y + indexTip.y) / 2 }
      : null;

  const middleGap =
    thumbTipPosition && middleTip && palmLength
      ? isotropicDistance(thumbTipPosition, middleTip, aspect) / palmLength
      : null;

  const indexMiddleAngle =
    indexMcpLandmark && indexTipLandmark && middleMcp
      ? angleBetween(
          isotropic(indexMcpLandmark.position, indexTipLandmark.position, aspect),
          isotropic(middleMcp.position, middleTip ?? middleMcp.position, aspect),
        )
      : null;

  return { gap, middleGap, indexMiddleAngle, reaches, reachesDepth, palmLength, pinchCenter };
}

/**
 * 单只手的**手型状态机**（每个槽位一个）。
 *
 * 三件事都在这里：优先级（握拳最优先）、迟滞（进入/退出阈值不同）、
 * 最短保持（`FIST`/`OPEN` 必须连续 2 帧才被承认）。
 *
 * 为什么 `PINCH` 不要求最短保持、`FIST`/`OPEN` 要求：
 * 误判一次捏合的代价已经被"第二只手不参与抓取"降到"多进一次缩放态"，
 * 而取消类动作误判的代价是"正在拖的图突然掉"，更疼，所以给它 2 帧确认。
 */
export class HandShapeTracker {
  private readonly thresholds: HandShapeThresholds;
  private _shape: HandShape = 'other';
  /** 连续多少帧满足当前候选手型（只对 fist/open 有意义） */
  private candidateFrames = 0;
  private candidate: HandShape | null = null;

  constructor(thresholds: HandShapeThresholds = DEFAULT_HAND_SHAPE_THRESHOLDS) {
    this.thresholds = thresholds;
  }

  get shape(): HandShape {
    return this._shape;
  }

  /** 忘记历史（手丢失、追踪重启）。 */
  reset(): void {
    this._shape = 'other';
    this.candidate = null;
    this.candidateFrames = 0;
  }

  /**
   * 推进一帧。返回**本帧生效**的手型。
   * 关键点不全（metrics 里关键项为 null）时退化成 `other`，不产生任何动作。
   */
  update(metrics: HandShapeMetrics): HandShape {
    const next = this.classify(metrics);

    if (next === this._shape) {
      this.candidate = null;
      this.candidateFrames = 0;
      return this._shape;
    }

    // 取消类手型（fist/open）要连续几帧才算数
    const needsHold = next === 'fist' || next === 'open';
    if (needsHold) {
      this.candidateFrames = this.candidate === next ? this.candidateFrames + 1 : 1;
      this.candidate = next;
      if (this.candidateFrames >= Math.max(1, this.thresholds.shapeHoldFrames)) {
        this._shape = next;
        this.candidate = null;
        this.candidateFrames = 0;
      }
      return this._shape;
    }

    // pinch / other 立即生效
    this._shape = next;
    this.candidate = null;
    this.candidateFrames = 0;
    return this._shape;
  }

  /**
   * 纯判定（不含迟滞以外的时间维度）：按**优先级顺序**试每种手型，先命中先算。
   * 优先级 `FIST > PINCH > OPEN > OTHER` —— 握拳是急停，任何时候都优先。
   */
  private classify(metrics: HandShapeMetrics): HandShape {
    const { gap, indexMiddleAngle, reaches, reachesDepth } = metrics;

    if (gap === null || metrics.palmLength === null) return 'other';

    const t = this.thresholds;
    /**
     * 伸展：平面**或**三维任一成立。
     * 取"或"是刻意的 —— 手指朝向镜头时平面读数会塌缩，但它确实是伸开的，
     * 不能因此判成蜷曲（那会拒判正常捏合）。
     */
    const extended = (name: FingerName): boolean => {
      const flat = reaches[name];
      const deep = reachesDepth[name];
      return (flat !== null && flat >= t.fingerExtended) || (deep !== null && deep >= t.fingerExtended);
    };
    /**
     * 蜷曲：平面**且**三维都成立。
     * 取"与"也是刻意的 —— 握拳会锁住一切操作，是最不该误判的状态；
     * 透视缩短（手指指向镜头）只能骗过平面那一个，骗不过三维那一个。
     */
    const curled = (name: FingerName): boolean => {
      const flat = reaches[name];
      const deep = reachesDepth[name];
      return flat !== null && deep !== null && flat <= t.fingerCurled && deep <= t.fingerCurledDepth;
    };

    /*
     * 1) 握拳：**食指 + 中指**深蜷（急停，优先级最高）
     *
     * 为什么不是"四指全部蜷曲"（第一版就是四指，真机上出了两个问题）：
     *
     *   · 捏得紧的时候，无名指与小指会**自然蜷进掌心** —— 那不是握拳，是捏。
     *     要求四指全蜷就会把"深层捏合"读成握拳，而握拳优先级高于捏合，
     *     于是用户"选中之后想再选，却被一直判成握拳"（真机反馈原话）。
     *   · 握拳的诚实信号是**中指**：捏合根本不用中指，所以中指深蜷 =
     *     这只手没有在做捏合。食指与中指这两根才是判别手型的关键，
     *     无名指与小指太容易跟着姿势漂。
     */
    /*
     * ⚠️ 这里**刻意**只认"食指 + 中指深蜷"，**不看食→中夹角**。
     *
     * 我（审计时）试过加一条"夹角大就不算握拳"，想治"紧捏被误判成握拳 -> 急停 -> 图掉了"。
     * 但那是**反着改**：本项目有一条明确的优先级决定 ——
     * **同时像捏合又像握拳时，握拳优先（急停优先于选中）**（§1.2，`handShape.test.ts:136` 钉着）。
     * 而且真握拳时中指深蜷 → MCP→TIP 向量很短 → 夹角本来就不可靠，
     * 拿它当否决条件等于在**最该急停的时候**把急停关掉（实测：一改就有 10 个测试红）。
     *
     * 两种"修法"都试过、**都退回了**（审计真机"拖动时突然松掉"时）：
     *   · 加"夹角大就不算握拳" —— 直接推翻上面的优先级（10 个测试红）；
     *   · 把 `pinch -> fist` 的保持帧数从 2 提到 4 —— 撞上"握拳/张开要连续 2 帧"
     *     这条既有约定，还把急停从 100ms 拖到 200ms。
     * 而且真要在捏合中途出现握拳，食指得从 ~1.5 蜷到 ≤1.10 —— 那不是"一帧抖动"，
     * 是真的换了姿势。**所以这条保持原样，等真机数据再说。**
     */
    if (curled('index') && curled('middle')) return 'fist';

    // 2) 捏合：拇食指靠得近，**且**（食指伸展 或 食→中夹角明显）
    //    两个条件用"或"：食指屈向拇指的常规捏靠夹角，拇指去碰伸直食指的"直捏"靠伸展度，
    //    任一成立即可 —— 这样不会拒判任何一种常见捏法。
    //    夹角拿不到（中指关键点缺失）时直接不认捏合：读不全的手不该产生动作。
    if (indexMiddleAngle !== null) {
      const pinching =
        indexMiddleAngle >= (this._shape === 'pinch' ? t.pinchAngleExit : t.pinchAngleEnter);
      const gapLimit = this._shape === 'pinch' ? t.pinchGapExit : t.pinchGapEnter;
      if (gap < gapLimit && (extended('index') || pinching)) return 'pinch';
    }

    // 3) 张开手掌：多数手指伸展且拇食指分开
    const extendedCount = (['index', 'middle', 'ring', 'pinky'] as FingerName[]).filter(extended).length;
    if (extendedCount >= t.openMinExtended && gap > t.pinchGapExit) return 'open';

    return 'other';
  }
}
