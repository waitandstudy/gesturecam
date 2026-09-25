import type { Handedness } from '../hand/handState';
import type { Vec2 } from '../math/vec2';

/**
 * ============================================================================
 * 指弹（index flick）—— 手势文法里的第一个**动态**手势
 * ============================================================================
 *
 * 规格：**拇指扣住食指尖蓄力，再急速甩开**（"弹脑瓜"那个动作）。
 * 它要解决的是"怎么删掉一张图"，而且顺手给 Phase 10 的物理留好了入口 ——
 * 同一次检测（指尖速度与方向）在编辑态里是"把这张图弹掉"，在物理里就是"给物体一个冲量"。
 *
 * ## ⚠️ 第五轮真机标定推翻了原来的模型（这一版是**重写**，不是调参）
 *
 * 原来假设"装填"是一个**独立静态姿势**：
 *     食指弯向掌心（`indexReach ≤ 1.35`）+ **拇指躲在一边**（`gap ≥ 0.60`）
 *
 * 真机实测（用户摆"弹脑瓜"蓄力姿势时，调试叠层读数）：
 *     食 1.52 · gap 0.45 · 中 0.91 · 装填 0/2 · 面板判定 `pinch ACTIVE`
 *
 * 三条门槛全不成立，而且**方向是反的**：
 *   · 弹脑瓜的蓄力是**拇指压在食指尖上**，gap 只有 0.45 —— 那恰恰是"捏合"；
 *   · 而"拇指躲开"要求 gap ≥ 0.60，是照着另一个**不存在的**姿势定的。
 *
 * 更麻烦的是它连带两处（都写在交互层）：
 *   · 装填姿势既然就是捏合，真机上"对着目标图蓄力"必然先把图**抓起来**；
 *   · 而交互层有一句"正抓着东西的那只手弹一下没有意义"直接跳过指弹，
 *     它的理由正是"装填态要求拇指不参与" —— 于是**永远删不掉**。
 *
 * ## 现在的模型：靠**动态**区分，不再找静态姿势
 *
 * > 静：**拇指扣住食指尖**（`gap` 小）+ 其余三指蜷着不动
 * > 动：**拇食指急速分离**（`gap` 变大）+ 食指指尖高速位移
 *
 * 三个量的分工：
 *   · `loadedMaxGap` —— 装填的**正面**条件：拇指扣着（原来是"躲开"，反了）；
 *   · `maxMiddleReach` —— 其余三指蜷着。它挡的是**张开手掌**（那是"释放"手势），
 *     而不是原来以为的"握拳"：握拳要求食指也深蜷，而指弹时食指是伸的（实测 1.52），
 *     两者天然不撞（真机面板显示 `fist —`）；
 *   · `minGapGain` + `minTipSpeed` —— 弹出。**`minGapGain` 才是防误触的主力**：
 *     抓着图快速拖动时指尖速度同样很高，但那只手在捏合、gap 不会变大。
 *
 * ## 已知的硬约束（写在最前面，免得后来者以为是实现不够好）
 *
 * **真机实测只有约 20fps**（tracker 46.5ms），一次指弹往往只跨 1–2 帧，
 * 所以速度和方向的估计比较粗，阈值必须真机标定 ——
 * 调试面板会把"扣住读数 / 甩开增量 / 峰值速度"全暴露出来，就是为这件事准备的。
 */

/** 指弹事件：一次完整检测的产物。 */
export interface FlickEvent {
  gesture: 'index-flick';
  /** 是哪只手弹的（交互层要按手判断"这只手是不是正抓着东西"） */
  hand: Handedness;
  /** 释放瞬间**食指指尖**的位置（场景坐标）。兜底命中测试用它 —— 指尖是整只手里跟踪最准的点 */
  position: Vec2;
  /** 弹出去的方向（单位向量，各向同性坐标：x 以画幅宽为单位，y 也换算成宽） */
  direction: Vec2;
  /** 指尖速度（各向同性场景单位/秒） */
  speed: number;
  /** 从装填到弹出跨了几帧（标定用） */
  frames: number;
  time: number;
}

/** 判定用的单帧采样。 */
export interface FlickSample {
  /**
   * 食指伸展度（|指尖-手腕| / 掌心长度），越小越蜷曲。
   *
   * **观测用**：弹脑瓜蓄力时它是伸着的（真机实测 1.52），
   * 所以它**不参与任何门槛** —— 面板仍然显示它，因为它是读手势最直观的一个量。
   */
  indexReach: number | null;
  /** 中指伸展度。装填与弹出都要求它**蜷着**（否则整只手是张开的，那是"释放"手势） */
  middleReach: number | null;
  /** 拇食指距离 / 掌心长度。装填要求它**小**（拇指扣着），弹出要求它**变大** */
  gap: number | null;
  /** 食指指尖位置（场景坐标） */
  tip: Vec2 | null;
  /** 场景宽高比，用于把位移换算成各向同性长度 */
  aspect: number;
  time: number;
}

export interface FlickConfig {
  /** 装填态：拇食指**扣住**（拇指压在食指尖上）⇒ gap 必须小**于**它。真机蓄力实测 0.45 */
  loadedMaxGap: number;
  /** 装填必须连续持续这么多帧 */
  loadedFrames: number;
  /** 装填与弹出都要求其余三指蜷着（伸展度不超过它）—— 用它把"张开手掌"排除掉 */
  maxMiddleReach: number;
  /** 弹出：gap 相对装填时要张开这么多（"甩开"的正面证据） */
  minGapGain: number;
  /** 指尖最小速度（各向同性场景单位/秒） */
  minTipSpeed: number;
  /** 从装填到弹出最多允许几帧 */
  releaseFrames: number;
  /** 触发之后的冷却（秒），避免一次动作连发 */
  cooldownSeconds: number;
}

export const DEFAULT_FLICK_CONFIG: Readonly<FlickConfig> = Object.freeze({
  /**
   * 装填：拇指扣住食指尖（gap 小）。
   *
   * ⚠️ **真机反馈"没和拇指贴住也能触发"，从 0.65 收到 0.50。**
   * 0.65 是我给"关键点抖动"留的余量，结果松到**根本没贴上**也算装填 ——
   * 随手一晃就把图删了。现在取 0.50，**和捏合的进入阈值同一个数**，
   * 语义变成"**真的贴上了才认**"（真机蓄力实测 0.45，还留着 0.05 的余量）。
   *
   * 和 `snap.ts` 的那个数**刻意保持一致**（同一个物理量），单测钉着不许漂开。
   */
  loadedMaxGap: 0.5,
  loadedFrames: 2,
  /**
   * 其余三指蜷着，用中指的伸展度当代表（中指不参与捏合，是最"诚实"的一根）。
   * 真机蓄力实测 0.91；1.10 与手型判定的"蜷曲"阈值同数。
   */
  maxMiddleReach: 1.1,
  /**
   * 甩开的正面证据：拇食指分离。
   *
   * **这才是防误触的主力**：抓着素材快速拖动时指尖速度同样很高，
   * 但那只手还在捏合、gap 不会变大 —— 靠这一条把"拖图"和"弹掉它"分开。
   * 真机蓄力读数 0.45，所以 0.25 要求甩开后 gap 到 0.70 以上（约 2.5cm 的分离）。
   */
  minGapGain: 0.25,
  /**
   * 指尖最小速度（各向同性场景单位/秒，x 以画幅宽为单位）。
   *
   * ⚠️ **这是整条链路里最没把握的一个数**，第五轮真机标定特意把它调低了。
   * 原来的 1.5 是按"一次指弹指尖移动画幅宽度的 10–20%"估的，但那个估计**偏大**：
   * "弹脑瓜"里食指只是从扣住的 1.52 伸到约 1.85，位移 ≈ 0.33 个**掌长**；
   * 而掌长大约只占画幅宽的 0.1–0.2 ⇒ 指尖实际只走画幅宽的 **3–7%**，
   * 20fps（一帧 50ms）下算出来约 **0.6–1.4 /秒**。1.5 会把真实指弹全挡在门外。
   *
   * 敢调低的理由：**防误触已经不由它负责了** —— 拖图由 `minGapGain` 挡、
   * 整只手张开（=放下素材）由 `maxMiddleReach` 挡。速度在这里只剩"别把慢慢松开
   * 当成甩开"这一件事。而且误删有 2 秒后悔期，弹不出来却是不可恢复的。
   *
   * 真机读数由面板的 `速` 报出（`releaseSpeed`）—— 下一次标定就靠它定这个数。
   */
  minTipSpeed: 0.8,
  releaseFrames: 3,
  cooldownSeconds: 0.35,
});

/** 各向同性位移（x 以画幅宽为单位，y 换算成同一尺度）。 */
function isotropicDelta(from: Vec2, to: Vec2, aspect: number): Vec2 {
  const safe = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  return { x: to.x - from.x, y: (to.y - from.y) / safe };
}

/**
 * 检测阶段。
 *
 * 为什么要有 `releasing` 这一段，而不是"脱离装填态的那一帧判一次"：
 * 真机只有约 20fps，常常是**拇指先松开一帧、食指下一帧才飞出去**
 * （关键点跟踪也有一帧延迟）。只在脱离那一帧判，会漏掉真正快的那一帧。
 */
type FlickPhase = 'idle' | 'loaded' | 'releasing';

/**
 * 单只手的指弹检测器。**有状态**（要记住装填与起跳参考帧），每个槽位一个。
 */
export class FlickDetector {
  private readonly config: FlickConfig;
  /** 最近若干帧的采样（最多 `loadedFrames + releaseFrames + 2` 个），用来算瞬时速度 */
  private readonly history: FlickSample[] = [];
  private phase: FlickPhase = 'idle';
  /** 已经连续装填了多少帧 */
  private loadedFrames = 0;
  /** 甩开窗口还剩几帧（阶段为 `releasing` 时有效） */
  private releaseFramesLeft = 0;
  private cooldown = 0;
  /** 起跳参考帧 = 最后一个仍处于装填态的采样。增量与位移都从它算起 */
  private takeoff: FlickSample | null = null;
  /**
   * 最近一次装填/甩开期间的最快指尖瞬时速度（各向同性场景单位/秒）。
   *
   * 为什么单独记一个"峰值"：触发判定用的是**跨帧平均速度**（起跳到当前 ÷ 时间），
   * 而真机上人感受到的是**某一帧的瞬时速度**。两者差得不小，于是会出现
   * "我弹得很快啊"但判定说不够快的情况 —— 用户没有任何办法知道差多少。
   */
  private peakSpeed = 0;
  /** 标定观测：最近一次"甩开"的 gap 增量（不随阶段清零，供面板读数） */
  private lastGapGain = 0;
  /** 标定观测：最近一次"甩开"的指尖速度（不随阶段清零，供面板读数） */
  private lastReleaseSpeed = 0;

  constructor(config: Partial<FlickConfig> = {}) {
    this.config = { ...DEFAULT_FLICK_CONFIG, ...config };
    if (!(this.config.loadedFrames >= 1)) throw new RangeError('loadedFrames 必须 >= 1');
    if (!(this.config.releaseFrames >= 1)) throw new RangeError('releaseFrames 必须 >= 1');
    if (!(this.config.minTipSpeed > 0)) throw new RangeError('minTipSpeed 必须是正数');
    if (!(this.config.minGapGain >= 0)) throw new RangeError('minGapGain 不能是负数');
  }

  /** 调试用：当前连续装填了多少帧（>0 表示手指正处于"扣住"状态）。 */
  get armedFrames(): number {
    return this.phase === 'loaded' ? this.loadedFrames : 0;
  }

  /**
   * 调试用：最近一次装填/甩开期间的峰值瞬时指尖速度。
   *
   * ⚠️ 这里**故意不随"退出装填"归零**。曾经写成 `loadedFrames > 0 ? peakSpeed : 0`，
   * 那是个真 bug：峰值恰恰出现在**甩开的那一帧**，而那一帧走完阶段已经变了，
   * 于是面板上永远显示 `弹速 0.00` —— 用户想读"我到底弹了多快"根本读不到。
   * 实测（单测钉住）：指尖一帧走 0.12，真实瞬时速度 3.6，而面板读数是 0.00。
   */
  get peakTipSpeed(): number {
    return this.peakSpeed;
  }

  /** 调试用：最近一次"甩开"的 gap 增量（面板报"差多少"用）。 */
  get gapGain(): number {
    return this.lastGapGain;
  }

  /** 调试用：最近一次"甩开"的指尖速度（面板报"差多少"用）。 */
  get releaseSpeed(): number {
    return this.lastReleaseSpeed;
  }

  /** 调试用：是否在冷却中。 */
  get isCoolingDown(): boolean {
    return this.cooldown > 0;
  }

  reset(): void {
    this.clearState();
    this.cooldown = 0;
  }

  /** 清掉检测状态（冷却不动 —— 手晃一下不该绕过冷却）。 */
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
   * 这一帧算不算装填态：**拇指扣住食指尖**（gap 小）+ **其余三指蜷着**。
   *
   * 注意这里**不看食指**：弹脑瓜蓄力时食指是伸着的（真机实测 1.52）。
   */
  private isLoaded(sample: FlickSample): boolean {
    return (
      sample.gap !== null &&
      sample.gap <= this.config.loadedMaxGap &&
      (sample.middleReach === null || sample.middleReach <= this.config.maxMiddleReach)
    );
  }

  /**
   * 推进一帧。返回非 null 表示这一帧检测到了一次指弹。
   * @param dt 距上一帧的秒数（用来走冷却）
   */
  update(sample: FlickSample | null, dt: number): FlickEvent | null {
    this.cooldown = Math.max(0, this.cooldown - Math.max(0, dt));

    // 手丢了：状态与历史一起作废（不然"离开画面再回来"会凑出一次假指弹）
    if (!sample || sample.gap === null || sample.middleReach === null || !sample.tip) {
      this.clearState();
      return null;
    }

    const maxHistory = this.config.loadedFrames + this.config.releaseFrames + 2;
    this.history.push(sample);
    while (this.history.length > maxHistory) this.history.shift();

    /*
     * 峰值瞬时速度：装填期与甩开期都统计，用相邻两帧算。
     * 它纯属**观测**（不参与判定），唯一用途是让面板回答"我弹得够快吗"。
     * 位置放在状态机之前：甩开的那一帧正是峰值所在的那一帧。
     */
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

    const loaded = this.isLoaded(sample);

    if (loaded) {
      if (this.phase !== 'loaded') {
        // 从 idle 或 releasing 重新扣住：重开一次（上一次的观测量也一并清掉）
        this.phase = 'loaded';
        this.loadedFrames = 1;
        this.peakSpeed = 0;
        this.lastGapGain = 0;
        this.lastReleaseSpeed = 0;
      } else {
        this.loadedFrames += 1;
      }
      this.takeoff = sample;
      return null;
    }

    // ---- 当前这一帧不在装填态 ----
    if (this.phase === 'loaded') {
      // 刚脱离装填：刚才那一下够不够"扣住过"？
      if (this.loadedFrames < this.config.loadedFrames) {
        this.clearState();
        return null;
      }
      this.phase = 'releasing';
      this.releaseFramesLeft = this.config.releaseFrames;
    } else if (this.phase === 'idle') {
      return null;
    }

    const start = this.takeoff;
    if (!start || start.gap === null || start.tip === null) {
      this.clearState();
      return null;
    }

    // 甩开窗口：增量与位移都相对起跳参考帧算
    const gapGain = sample.gap - start.gap;
    const dtSeconds = sample.time - start.time;
    const delta = dtSeconds > 0 ? isotropicDelta(start.tip, sample.tip, sample.aspect) : { x: 0, y: 0 };
    const distance = Math.hypot(delta.x, delta.y);
    const speed = dtSeconds > 0 ? distance / dtSeconds : 0;
    const frames = this.config.releaseFrames - this.releaseFramesLeft + 1;

    // 观测：不管成不成功都记下来，面板要看"差多少"
    this.lastGapGain = gapGain;
    this.lastReleaseSpeed = speed;

    this.releaseFramesLeft -= 1;
    const expired = this.releaseFramesLeft <= 0;

    const fired =
      this.cooldown <= 0 &&
      gapGain >= this.config.minGapGain &&
      // 其余三指仍蜷着：整只手张开不算指弹（那是"释放"手势）
      sample.middleReach <= this.config.maxMiddleReach &&
      speed >= this.config.minTipSpeed;

    if (fired) {
      this.cooldown = this.config.cooldownSeconds;
      this.phase = 'idle';
      this.loadedFrames = 0;
      this.releaseFramesLeft = 0;
      this.takeoff = null;
      return {
        gesture: 'index-flick',
        // 由调用方（GestureManager）填上具体是哪只手；检测器本身不认识左右手
        hand: 'unknown',
        position: { x: sample.tip.x, y: sample.tip.y },
        // 位移过小时方向没有意义（速度门槛已经挡住了，这里只是兜底）
        direction: distance > 1e-6 ? { x: delta.x / distance, y: delta.y / distance } : { x: 0, y: -1 },
        speed,
        frames,
        time: sample.time,
      };
    }

    if (expired) {
      this.phase = 'idle';
      this.loadedFrames = 0;
      this.takeoff = null;
    }
    return null;
  }
}
