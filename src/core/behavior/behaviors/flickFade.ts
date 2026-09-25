import type { Behavior, BehaviorContext, BehaviorStage } from '../behavior';
import type { BehaviorManager } from '../manager';

export const FLICK_FADE_BEHAVIOR_TYPE = 'flick-fade';

/**
 * FLICK_FADE —— 被指弹弹中的素材**淡出**（而不是"啪"一下消失）。
 *
 * 它落在 `present` 阶段：位置和大小都已经定完了，这里只改"看起来怎么样"。
 *
 * 两个要点：
 *
 * 1. **淡出期就是撤销窗口。** 素材在 2 秒里逐渐变透明、但一直留在原地 ——
 *    用户在这段时间里再捏住它就可撤销（交互层负责判定，本行为只负责画出来）。
 *    如果弹中即消失，误弹一次就只能重新加图。
 * 2. **必须记住原始不透明度并在撤销时还原。** 素材的不透明度是**素材自己的状态**，
 *    淡出只是借用它一下；撤销之后如果停在 0.3，用户会以为图坏了。
 *    这里只在"淡出中"写不透明度，退出淡出时把记下的原值写回去。
 */
export interface FlickFadeConfig {
  /** 淡到最暗时保留多少不透明度（0 = 全透明） */
  minOpacity?: number;
}

const DEFAULT_MIN_OPACITY = 0.25;

export class FlickFadeBehavior implements Behavior {
  readonly type = FLICK_FADE_BEHAVIOR_TYPE;
  readonly stage: BehaviorStage = 'present';

  private readonly minOpacity: number;
  /** 进入淡出时记下的原始不透明度；null = 当前不在淡出中 */
  private opacityBeforeFade: number | null = null;

  constructor(config: FlickFadeConfig = {}) {
    const value = config.minOpacity ?? DEFAULT_MIN_OPACITY;
    if (!(value >= 0) || value > 1) {
      throw new RangeError('minOpacity 必须落在 [0, 1]');
    }
    this.minOpacity = value;
  }

  serialize(): FlickFadeConfig {
    return { minOpacity: this.minOpacity };
  }

  onDetach(): void {
    this.opacityBeforeFade = null;
  }

  update(context: BehaviorContext): void {
    const { interaction, object } = context;

    if (!interaction.deleting.active) {
      // 撤销（或从未淡出过）：把不透明度还原，然后什么都不做
      if (this.opacityBeforeFade !== null) {
        object.setOpacity(this.opacityBeforeFade);
        this.opacityBeforeFade = null;
      }
      return;
    }

    if (this.opacityBeforeFade === null) this.opacityBeforeFade = object.state.opacity;
    const progress = Math.min(1, Math.max(0, interaction.deleting.progress));
    object.setOpacity(this.opacityBeforeFade * (1 - (1 - this.minOpacity) * progress));
  }
}

export function registerFlickFadeBehavior(manager: BehaviorManager): void {
  manager.register(
    FLICK_FADE_BEHAVIOR_TYPE,
    (config) => new FlickFadeBehavior((config ?? {}) as FlickFadeConfig),
  );
}
