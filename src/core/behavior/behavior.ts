import type { GestureState } from '../gesture/types';
import type { ObjectInteractionConfig, ObjectInteractionState } from '../interaction/types';
import type { Vec2 } from '../math/vec2';
import type { BoundaryMode, ObjectMode, ObjectState } from '../scene/types';

/**
 * 行为（Behavior）接口。
 *
 * 硬性约束（两份需求文档都点名了）：**禁止在渲染或交互代码里写 `if (object === image1)`
 * 这类针对具体素材的分支。** 素材的能力一律通过"挂载 Behavior"表达。
 *
 * 管线分阶段执行，保证"每帧一次、顺序确定"，将来加物理系统时不需要改动已有行为：
 *
 *   input      读手势/交互状态 → 产生意图（期望位置 / 期望缩放 / 初速度）
 *   simulate   积分与物理（惯性、重力、碰撞…）—— Phase 10
 *   constrain  边界与约束（BoundaryMode）—— Phase 8
 *   present    写回最终呈现状态（显隐、不透明度、层级、动画）
 *
 * **行为看不到原始手部关键点**，只能看到 gesture 层已经平滑+迟滞过的控制量
 * （参考文档第四节：手势 → 交互事件 → 行为 → 对象）。这不是洁癖：
 * 一旦行为能摸到关键点，各种"临时判一下手势"的代码会迅速蔓延，
 * 最后每个 Behavior 里都长出一套自己的手势逻辑，换识别方案时全盘重写。
 * 需要新语义就在 gesture 层加，而不是在行为里凑。
 */
export type BehaviorStage = 'input' | 'simulate' | 'constrain' | 'present';

export const BEHAVIOR_STAGE_ORDER: readonly BehaviorStage[] = ['input', 'simulate', 'constrain', 'present'];

/**
 * 行为执行上下文。刻意做成"只暴露需要的东西"，
 * 避免行为代码直接摸到渲染器或 DOM 从而破坏可测试性。
 */
export interface BehaviorContext {
  /** 距上一帧的秒数，已做上限保护 */
  dt: number;
  /** 场景启动至今的秒数 */
  time: number;
  /** 本帧序号 */
  frame: number;
  /** 手势层本帧输出；还没有接入手势识别时为 null */
  gestures: GestureState | null;
  /** 本素材本帧的交互状态（永不 null，空闲时是兜底值） */
  interaction: Readonly<ObjectInteractionState>;
  /** 素材自身（读写） */
  object: BehaviorObject;
  /**
   * 素材纹理的宽高比（宽 / 高）。边界约束要用它算素材**纵向**占多少，
   * 否则一张 16:9 的图会被当成正方形，纵向越界就查不出来。
   */
  assetAspect: number;
  /** 场景内其它素材的只读查询（碰撞、吸附要用） */
  scene: BehaviorSceneQuery;
  /** 渲染区域信息，坐标换算用 */
  viewport: BehaviorViewport;
}

/** 行为可读写的素材视图。 */
export interface BehaviorObject {
  readonly id: string;
  readonly state: Readonly<ObjectState>;
  setPosition(position: Vec2): void;
  translate(delta: Vec2): void;
  setScale(scale: number): void;
  multiplyScale(factor: number): void;
  setRotation(radians: number): void;
  setOpacity(opacity: number): void;
  setVisible(visible: boolean): void;
  setMode(mode: ObjectMode): void;
  setBoundaryMode(mode: BoundaryMode): void;
  setInteractionConfig(config: Partial<ObjectInteractionConfig>): void;
}

export interface BehaviorSceneQuery {
  readonly size: number;
  list(): readonly BehaviorObject[];
  get(id: string): BehaviorObject | undefined;
}

export interface BehaviorViewport {
  readonly width: number;
  readonly height: number;
  readonly aspect: number;
  readonly mirrored: boolean;
}

export interface Behavior {
  /** 全局唯一的类型名，同时也是注册表 key */
  readonly type: string;
  readonly stage: BehaviorStage;
  /** 同阶段内的执行顺序，数值小的先执行，默认 0 */
  readonly priority?: number;
  /** 挂载后的第一次 update 之前调用一次，用于初始化（例如记录起始位置） */
  onAttach?(context: BehaviorContext): void;
  /** 卸载时调用，用于清理 */
  onDetach?(): void;
  /** 每帧调用 */
  update(context: BehaviorContext): void;
  /** 行为私有状态序列化（例如物理速度），Phase 1 未使用 */
  serialize?(): unknown;
}

/**
 * 行为工厂：从"类型名 + 配置"创建实例。
 * 场景加载时用它重建行为，所以配置必须是可 JSON 序列化的。
 */
export type BehaviorFactory<TConfig = unknown> = (config: TConfig) => Behavior;
