import type { Behavior, BehaviorContext, BehaviorStage } from '../behavior';
import type { BehaviorManager } from '../manager';

export const FIXED_BEHAVIOR_TYPE = 'fixed';

/**
 * FIXED —— 素材停在编排时设定的位置（需求文档第五节 mode 之一）。
 *
 * 这个行为的 update 是**有意为之的空实现**：位置完全由 ObjectState 决定、
 * 不受任何手势和物理影响，这就是 FIXED 的语义。
 *
 * 它存在的价值：
 *   1) 作为行为管线的基准实现，证明"素材的行为差异通过挂载不同 Behavior 表达"，
 *      而不是在渲染/交互代码里写 `if (object.id === 'image1')`；
 *   2) 将来打开物理系统后，FIXED（不受力）与 PhysicsBehavior（受力）的差异
 *      恰好就体现在这个空实现上。
 */
export class FixedBehavior implements Behavior {
  readonly type = FIXED_BEHAVIOR_TYPE;
  readonly stage: BehaviorStage = 'present';

  update(_context: BehaviorContext): void {
    // 有意为之：不做任何事。
  }
}

export function registerFixedBehavior(manager: BehaviorManager): void {
  manager.register(FIXED_BEHAVIOR_TYPE, () => new FixedBehavior());
}
