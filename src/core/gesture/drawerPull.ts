import type { Vec2 } from '../math/vec2';

/**
 * ============================================================================
 * 抽屉（"拉窗帘"）—— 从画面顶边把素材抽屉拉下来
 * ============================================================================
 *
 * ## 为什么是"捏合 + 往下拖"，而不是"握拳抓紧再往下拉"
 *
 * 用户最初的设想是"**张开手掌 → 抓紧 → 往下拉**"。方向是对的（拉窗帘这个隐喻很好：
 * 拉的过程本身就看得见，用户不用记新姿势，做错了也看得出来），但"抓紧"必须是**捏合**：
 *
 *   · 在这个项目里 **握拳 = 急停**（取消这只手的操作，优先级最高）——
 *     "抓紧往下拉"的那一下会先把急停触发掉，手里正抓着的素材会被松掉；
 *   · 而**捏合在没有素材的地方起手，现在本来就是什么都不做的** ——
 *     交互层有"抓取准入"（起手必须压在素材上），所以这个姿势是**空着的**，拿来开抽屉正合适。
 *
 * ## 两个必须挡住的抢姿势（都会真的发生）
 *
 * 1. **抓取准入窗口会抢**：交互层允许"起手后 0.7s 内移进素材也算抓住"。
 *    从顶边往下拖**会经过素材** —— 不管的话，拉窗帘会变成"抓住那张图"。
 *    ⇒ 拉的过程中必须屏蔽抓取（调用方按 `open`/`pulling` 与手指位置决定）。
 * 2. **松手那一帧可能被读成指弹**：拉到底松手时 `gap` 由小变大，
 *    而拉动时指尖本来就在快速移动。指弹的门槛是"gap 增量 + 指尖速度"，
 *    两个条件在这一刻可能同时成立 ⇒ **拉窗帘期间必须屏蔽指弹**（`suppressFlick`）。
 *    （顺带说明为什么指弹当初把"甩开增量"当主力判据是对的：
 *    拉窗帘时手型不变、gap 几乎不变，所以正常拉动不会误删；只有"松手"那一帧有风险。）
 *
 * ## 怎么和"点某一格"分开
 *
 * 用**位置**分：抽屉拉下来之后占据画面上方一块区域。
 *   · 捏合起手在**顶边条带**里 → 这是"拉手"，用来拉下/推上；
 *   · 捏合起手在**抽屉覆盖区之内、但不在这条带里** → 这是点某一格；
 *   · 在抽屉**下面** → 完全是正常的场景操作（抓素材、拖动…）。
 * 所以"抽屉开着就什么都不能抓"是不对的 —— 只有被抽屉盖住的那块区域归抽屉。
 */

export interface DrawerPullSample {
  /** 这一帧捏合成不成立 */
  pinching: boolean;
  /** 捏合中点（场景坐标；y 向下，0 = 画面顶边） */
  point: Vec2 | null;
  time: number;
}

export type DrawerPhase = 'idle' | 'pulling' | 'open';

export interface DrawerPullConfig {
  /**
   * "拉手条带"的高度（场景坐标，0 = 顶）。
   *
   * ⚠️ 不要取成极小值：**画面边缘是追踪最差的区域**（手被裁掉、关键点不全，
   * 项目里专门为这种情况写了宽限）。取画面上方约 1/5 那一片，判断靠"往下拖了多远"，
   * 不要卡"起手必须压在最顶上那一行"。
   */
  handleZone: number;
  /** 往下拖这么远算"拉满" */
  fullDistance: number;
  /** 松手时进度超过它才保持打开（否则弹回去） */
  keepThreshold: number;
  /** 抽屉开着时，往上推这么多就关掉 */
  closeDistance: number;
}

export const DEFAULT_DRAWER_PULL_CONFIG: Readonly<DrawerPullConfig> = Object.freeze({
  handleZone: 0.2,
  fullDistance: 0.3,
  keepThreshold: 0.45,
  closeDistance: 0.1,
});

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * 抽屉的状态机。
 *
 * 有状态、每个"操作手"一个（和 `FlickDetector` 一样），
 * 但**不碰 DOM、不碰场景** —— 它只回答"现在抽屉该拉到哪儿"，
 * 谁去画、谁去屏蔽抓取都是调用方的事。
 */
export class DrawerPullDetector {
  private readonly config: DrawerPullConfig;
  private phase: DrawerPhase = 'idle';
  private wasPinching = false;
  /** 本次拖动的起点（"pulling" 阶段） */
  private start: Vec2 | null = null;
  /** 已经拉开的比例 0..1 */
  private progress = 0;
  /** 抽屉开着时，这一次捏合是不是在往上推（推手） */
  private closing = false;

  constructor(config: Partial<DrawerPullConfig> = {}) {
    this.config = { ...DEFAULT_DRAWER_PULL_CONFIG, ...config };
    if (!(this.config.handleZone > 0 && this.config.handleZone < 1)) {
      throw new RangeError('handleZone 必须落在 (0,1) 之间');
    }
    if (!(this.config.fullDistance > 0)) throw new RangeError('fullDistance 必须大于 0');
    if (!(this.config.closeDistance > 0)) throw new RangeError('closeDistance 必须大于 0');
  }

  get isOpen(): boolean {
    return this.phase === 'open';
  }

  get isPulling(): boolean {
    return this.phase === 'pulling';
  }

  /** 抽屉露出来的比例：0 = 完全收起，1 = 完全拉下。UI 直接拿它做位移。 */
  get pull(): number {
    return this.phase === 'open' ? 1 : this.progress;
  }

  /**
   * 这一帧要不要**屏蔽指弹**。
   *
   * 只在自己人操作抽屉的时候屏蔽（拉的过程中 / 推回去的过程中）——
   * 抽屉开着时在**下面**比划指弹是正常操作，不该被牵连。
   */
  get suppressFlick(): boolean {
    return this.phase === 'pulling' || this.closing;
  }

  /** 捏合起手点算不算"拉手条带"（调用方也用它判断"这一下是操作抽屉还是操作场景"）。 */
  isInHandleZone(point: Vec2 | null): boolean {
    return point !== null && point.y <= this.config.handleZone;
  }

  reset(): void {
    this.phase = 'idle';
    this.wasPinching = false;
    this.start = null;
    this.progress = 0;
    this.closing = false;
  }

  /** 强制打开/关闭（UI 上的"收起"按钮走这里）。 */
  setOpen(open: boolean): void {
    this.phase = open ? 'open' : 'idle';
    this.progress = open ? 1 : 0;
    this.start = null;
    this.closing = false;
  }

  update(sample: DrawerPullSample): void {
    const pinching = sample.pinching && sample.point !== null;
    const point = sample.point;
    const rising = pinching && !this.wasPinching;
    this.wasPinching = pinching;

    if (!pinching || !point) {
      // 松手：拉够了就保持打开，没拉够就弹回去
      if (this.phase === 'pulling') {
        this.phase = this.progress >= this.config.keepThreshold ? 'open' : 'idle';
        this.progress = this.phase === 'open' ? 1 : 0;
      }
      this.closing = false;
      this.start = null;
      return;
    }

    if (this.phase === 'pulling') {
      if (this.start) {
        const dragged = point.y - this.start.y;
        this.progress = clamp01(dragged / this.config.fullDistance);
      }
      return;
    }

    if (this.phase === 'open') {
      // 开着的时候：在拉手条带里起手 = 想推回去
      if (rising && this.isInHandleZone(point)) {
        this.closing = true;
        this.start = point;
        return;
      }
      if (this.closing && this.start) {
        if (this.start.y - point.y >= this.config.closeDistance) {
          this.phase = 'idle';
          this.progress = 0;
          this.closing = false;
          this.start = null;
        }
        return;
      }
      return;
    }

    // idle：只有在拉手条带里起手才算"要拉抽屉"
    if (rising && this.isInHandleZone(point)) {
      this.phase = 'pulling';
      this.start = point;
      this.progress = 0;
    }
  }
}
