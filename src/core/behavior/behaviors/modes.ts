import type { ObjectMode } from '../../scene/types';
import type { SceneObject } from '../../scene/object';
import type { BehaviorManager } from '../manager';
import { BOUNDARY_BEHAVIOR_TYPE, registerBoundaryBehavior } from './boundary';
import { FIXED_BEHAVIOR_TYPE, registerFixedBehavior } from './fixed';
import { FLICK_FADE_BEHAVIOR_TYPE, registerFlickFadeBehavior } from './flickFade';
import { FOLLOW_HAND_BEHAVIOR_TYPE, registerFollowHandBehavior } from './followHand';
import { TWO_HAND_SCALE_BEHAVIOR_TYPE, registerTwoHandScaleBehavior } from './twoHandScale';

/**
 * 注册第一版全部可用的行为。新增行为时只改这里一处。
 */
export function registerCoreBehaviors(manager: BehaviorManager): void {
  registerFixedBehavior(manager);
  registerFollowHandBehavior(manager);
  registerTwoHandScaleBehavior(manager);
  registerBoundaryBehavior(manager);
  registerFlickFadeBehavior(manager);
}

/**
 * mode -> 要挂载的行为类型列表。
 *
 * 这是"素材的 mode 字段"与"行为实现"**唯一**对上的地方。
 * 需求文档第五节要求 mode 可扩展，所以用一张表而不是 if/else 链：
 * 加一种模式 = 加一行 + 注册行为，InteractionManager 和渲染层都不用改。
 *
 * FOLLOW_HAND 挂两个行为，而不是把"跟随"和"缩放"塞进一个行为里：
 * 两者是独立的关注点（一个管位置、一个管大小），分开之后
 * 「只跟随不缩放」或「只缩放不跟随」都是一行配置的事。
 *
 * 缩放是**双手**行为（`two-hand-scale`）：一只手拿住素材，两只手一起开合改大小。
 * 单手捏合同时编码位置和大小，两个自由度耦合，真机上就是"缩放一直颤、不好把控"；
 * 双手解耦且信噪比高十倍，详见 `twoHandScale.ts` 顶部的推导。
 *
 * `boundary` 与 `flick-fade` 挂在**所有**模式上，因为它们是两条对所有素材都成立的规则：
 *   · `boundary`（constrain 阶段）：素材不能被拖出画幅、而且永远抓得回来；
 *   · `flick-fade`（present 阶段）：被指弹弹中的素材要**淡出**而不是凭空消失。
 * 放在各自阶段的最后一步统一收口，跟手/缩放/将来的物理都不可能绕过它们。
 */
const MODE_BEHAVIORS: Partial<Record<ObjectMode, readonly string[]>> = {
  FIXED: [FIXED_BEHAVIOR_TYPE, BOUNDARY_BEHAVIOR_TYPE, FLICK_FADE_BEHAVIOR_TYPE],
  FOLLOW_HAND: [
    FOLLOW_HAND_BEHAVIOR_TYPE,
    TWO_HAND_SCALE_BEHAVIOR_TYPE,
    BOUNDARY_BEHAVIOR_TYPE,
    FLICK_FADE_BEHAVIOR_TYPE,
  ],
};

/**
 * 按素材的 mode 挂载对应行为。
 *
 * 尚未实现的模式（TOP_HANGING，Phase 7）刻意**不抛错也不假装生效**，
 * 只让素材保持当前位置并打一条提示 —— 这样逐阶段验证时不会误以为功能已经好了。
 */
export function attachBehaviorForMode(manager: BehaviorManager, object: SceneObject): void {
  const behaviorTypes = MODE_BEHAVIORS[object.mode];
  if (behaviorTypes) {
    for (const type of behaviorTypes) manager.attach(object, type);
    return;
  }
  console.info(
    `[GestureCam] 模式 ${object.mode} 的行为尚未实现（TOP_HANGING 属于 Phase 7），对象 ${object.id} 暂时保持静止。`,
  );
}
