import type { Handedness } from '../hand/handState';
import type { Vec2 } from '../math/vec2';

/** 一次打响指（翻页）事件 */
export interface SnapEvent {
  /** 是哪只手打的（将来要做"左手往回翻"之类的扩展时要它） */
  hand: Handedness;
  time: number;
}

/**
 * ============================================================================
 * 打响指（snap）—— 翻到下一张素材
 * ============================================================================
 *
 * 规格：**拇指与中指贴住，再急速弹开**。用户的原话是"中指和拇指揉搓的动作"。
 *
 * ## 为什么用打响指（它解决了"不流畅"的根）
 *
 * 之前那条路（从顶边拉抽屉、再瞄准某一格）要求三件事同时成立：
 * 起手位置要对、动作要分几段、手还得一直在画面里。**"瞄准 + 多段动作"本身就是慢的**，
 * 再怎么调阈值也不会流畅。
 *
 * 打响指反过来：**手在哪儿都能打、打完就完，不用瞄准也不用拖**。
 * 配上"图固定出现在左上角"，拍摄中一个需要瞄准的动作都不剩。
 *
 * ## 它和"指弹（删除）"是同构的
 *
 * | | 贴住谁 | 弹开时什么变大 |
 * | --- | --- | --- |
 * | 指弹（删除） | 拇指 ↔ **食指** | 拇食指距离 |
 * | 打响指（翻页） | 拇指 ↔ **中指** | 拇指中指距离 |
 *
 * 所以这里的状态机（装填 → 甩开窗口 → 增量 + 速度）和 `flick.ts` 是**同一套结构**。
 *
 * ⚠️ **故意先复制一份，不合并**：合并就要改 `flick.ts`，而那是已经真机标定过、
 * 被 23 条单测钉住的代码。**在打响指还没经过真机验证之前，不动它。**
 * 等真机确认打响指能稳定判定，再把两者合成一个"以手指为参数"的检测器。
 *
 * ## 靠什么和别的姿势分开
 *
 * - **拇指贴的是中指，不是食指**：装填时要求"拇指到中指的距离 **小于** 拇指到食指的距离"。
 *   这一条把"普通捏合"挡在门外 —— 捏合是拇指贴食指，中指在旁边。
 * - 捏合判定压根不看中指，所以打响指不会误触发抓取。
 * - ⚠️ **和握拳的边界要看真机**：打响指时中指是蜷的，若食指也蜷到判据里就会变成握拳（急停）。
 */

export interface SnapSample {
  /** 拇指尖 → 中指尖的距离 ÷ 掌心长度。装填要求它**小**（贴住了） */
  thumbMiddleGap: number | null;
  /** 拇指尖 → 食指尖的距离 ÷ 掌心长度。用来确认"贴着的是中指" */
  thumbIndexGap: number | null;
  /** 中指尖位置（场景坐标） */
  tip: Vec2 | null;
  /** 场景宽高比，用于把位移换算成各向同性长度 */
  aspect: number;
  time: number;
}

export interface SnapConfig {
  /** 装填：拇指与中指贴住（距离小于它） */
  loadedMaxGap: number;
  /** 装填必须连续持续这么多帧 */
  loadedFrames: number;
  /** 张开：拇指中指要分开这么多 */
  minGapGain: number;
  /** 中指尖最小速度（各向同性场景单位/秒） */
  minTipSpeed: number;
  /** 从装填到弹开最多允许几帧 */
  releaseFrames: number;
  /**
   * 触发之后的冷却（秒）。
   *
   * ⚠️ 这个值直接决定"打得快不快"：连续打三次翻三张，如果冷却太长就会被吃掉。
   * 用户要的是"往后翻"，连打是常见动作，所以取得比指弹短。
   */
  cooldownSeconds: number;
}

export const DEFAULT_SNAP_CONFIG: Readonly<SnapConfig> = Object.freeze({
  /**
   * "贴住"的判据：拇指尖到中指尖的距离。
   *
   * ⚠️ **真机反馈"没和拇指贴住也能触发"，从 0.65 收到 0.50。**
   * 取 0.50 的语义是"**真的贴上了才认**"；和 `flick.ts` 里那个数
   * **刻意保持一致**（同一个物理量），单测钉着不许漂开。
   */
  loadedMaxGap: 0.5,
  loadedFrames: 2,
  /**
   * 弹开的**增量**门槛（拇指↔中指要分开这么多）。
   *
   * 真机两点读数：贴着拇指移动（误触发）= **0.3**；真响指 = **0.6**。
   * 取 0.45 卡在中间 —— 原来的 0.25 **比误触发那组数还低**，等于这道关根本没起作用。
   */
  minGapGain: 0.45,
  /**
   * 中指指尖最小速度 —— **这两件事的主力判据**。
   *
   * 真机两点读数：贴着拇指移动（误触发）= **0.6**；真响指 = **3.0**，差 5 倍。
   * 取 **1.2**：比误触发高 2 倍、比真响指低 2.5 倍，两边都留了余量。
   *
   * ⚠️ 历史（值得记）：一开始定 0.8，用户反馈"打不响"后降到 0.4 ——
   * 但 **0.4 比误触发读数 0.6 还低**，于是"拇指中指贴着移动"也能触发换页。
   * 回头看，"0.8 打不响"很可能是当时**贴住门槛太松（0.65）**、
   * 起跳那一帧取错了、把速度算小了；把贴住收紧到 0.50 之后，
   * 真实读数变成了健康的 3.0。**读数不可信时，先怀疑取数的那一步，别急着调门槛。**
   */
  minTipSpeed: 1.2,
  releaseFrames: 3,
  /** 比指弹的 0.35 短：连打是常见动作，冷却太长会"吃掉"第二下 */
  cooldownSeconds: 0.22,
});

/** 各向同性位移（x 以画幅宽为单位，y 换算成同一尺度） */
function isotropicDelta(from: Vec2, to: Vec2, aspect: number): Vec2 {
  const safe = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  return { x: to.x - from.x, y: (to.y - from.y) / safe };
}

type SnapPhase = 'idle' | 'loaded' | 'releasing';

/**
 * 单只手的打响指检测器。**有状态**，每个槽位一个（和 `FlickDetector` 一样）。
 */
export class SnapDetector {
  private readonly config: SnapConfig;
  private readonly history: SnapSample[] = [];
  private phase: SnapPhase = 'idle';
  private loadedFrames = 0;
  private releaseFramesLeft = 0;
  private cooldown = 0;
  private takeoff: SnapSample | null = null;
  private peakSpeed = 0;
  /** 标定观测：最近一次"弹开"的增量与速度（不随阶段清零，供调试面板读数） */
  private lastGapGain = 0;
  private lastReleaseSpeed = 0;

  constructor(config: Partial<SnapConfig> = {}) {
    this.config = { ...DEFAULT_SNAP_CONFIG, ...config };
    if (!(this.config.loadedFrames >= 1)) throw new RangeError('loadedFrames 必须 >= 1');
    if (!(this.config.releaseFrames >= 1)) throw new RangeError('releaseFrames 必须 >= 1');
    if (!(this.config.minTipSpeed > 0)) throw new RangeError('minTipSpeed 必须是正数');
    if (!(this.config.minGapGain >= 0)) throw new RangeError('minGapGain 不能是负数');
  }

  /** 调试用：当前连续"贴住"了多少帧 */
  get armedFrames(): number {
    return this.phase === 'loaded' ? this.loadedFrames : 0;
  }

  /** 调试用：最近一次弹开的拇指中指增量 */
  get gapGain(): number {
    return this.lastGapGain;
  }

  /** 调试用：最近一次弹开的中指尖速度 */
  get releaseSpeed(): number {
    return this.lastReleaseSpeed;
  }

  /** 调试用：峰值瞬时速度（保持显示，方便抬眼看） */
  get peakTipSpeed(): number {
    return this.peakSpeed;
  }

  reset(): void {
    this.clearState();
    this.cooldown = 0;
  }

  private clearState(): void {
    this.history.length = 0;
    this.phase = 'idle';
    this.loadedFrames = 0;
    this.releaseFramesLeft = 0;
    this.takeoff = null;
    this.peakSpeed = 0;
    this.lastGapGain = 0;
    this.lastReleaseSpeed = 0;
  }

  /**
   * 这一帧算不算"拇指和中指贴住了"。
   *
   * 除了距离够小，还要求**拇指离中指比离食指更近** —— 否则普通的捏合
   * （拇指贴食指，中指在附近）也会被算成装填。
   */
  private isLoaded(sample: SnapSample): boolean {
    if (sample.thumbMiddleGap === null) return false;
    if (sample.thumbMiddleGap > this.config.loadedMaxGap) return false;
    if (sample.thumbIndexGap !== null && sample.thumbMiddleGap >= sample.thumbIndexGap) return false;
    return true;
  }

  update(sample: SnapSample | null, dt: number): boolean {
    this.cooldown = Math.max(0, this.cooldown - Math.max(0, dt));

    // 手丢了：状态与历史一起作废（不然"离开画面再回来"会凑出一次假响指）
    if (!sample || sample.thumbMiddleGap === null || !sample.tip) {
      this.clearState();
      return false;
    }

    const maxHistory = this.config.loadedFrames + this.config.releaseFrames + 2;
    this.history.push(sample);
    while (this.history.length > maxHistory) this.history.shift();

    // 峰值瞬时速度：纯观测，位置放在状态机之前（弹开那一帧正是峰值所在帧）
    if (this.phase !== 'idle') {
      const previous = this.history[this.history.length - 2];
      if (previous && previous.tip) {
        const dtSeconds = sample.time - previous.time;
        if (dtSeconds > 0) {
          const step = isotropicDelta(previous.tip, sample.tip, sample.aspect);
          const speed = Math.hypot(step.x, step.y) / dtSeconds;
          if (speed > this.peakSpeed) this.peakSpeed = speed;
        }
      }
    }

    if (this.isLoaded(sample)) {
      if (this.phase !== 'loaded') {
        this.phase = 'loaded';
        this.loadedFrames = 1;
        this.peakSpeed = 0;
        this.lastGapGain = 0;
        this.lastReleaseSpeed = 0;
      } else {
        this.loadedFrames += 1;
      }
      this.takeoff = sample;
      return false;
    }

    if (this.phase === 'loaded') {
      if (this.loadedFrames < this.config.loadedFrames) {
        // 只贴了一帧就分开 —— 顺手碰一下，不算
        this.clearState();
        return false;
      }
      this.phase = 'releasing';
      this.releaseFramesLeft = this.config.releaseFrames;
    } else if (this.phase === 'idle') {
      return false;
    }

    const start = this.takeoff;
    if (!start || start.thumbMiddleGap === null || start.tip === null) {
      this.clearState();
      return false;
    }

    const gapGain = sample.thumbMiddleGap - start.thumbMiddleGap;
    const dtSeconds = sample.time - start.time;
    const delta = dtSeconds > 0 ? isotropicDelta(start.tip, sample.tip, sample.aspect) : { x: 0, y: 0 };
    const distance = Math.hypot(delta.x, delta.y);
    const speed = dtSeconds > 0 ? distance / dtSeconds : 0;

    this.lastGapGain = gapGain;
    this.lastReleaseSpeed = speed;

    this.releaseFramesLeft -= 1;
    const expired = this.releaseFramesLeft <= 0;

    const fired =
      this.cooldown <= 0 &&
      gapGain >= this.config.minGapGain &&
      speed >= this.config.minTipSpeed;

    if (fired) {
      this.cooldown = this.config.cooldownSeconds;
      this.phase = 'idle';
      this.loadedFrames = 0;
      this.releaseFramesLeft = 0;
      this.takeoff = null;
      return true;
    }

    if (expired) {
      this.phase = 'idle';
      this.loadedFrames = 0;
      this.takeoff = null;
    }
    return false;
  }
}
