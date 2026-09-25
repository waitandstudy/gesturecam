import { createInteractionConfig, type ObjectInteractionConfig } from '../interaction/types';
import type { Vec2 } from '../math/vec2';

/**
 * ============================================================================
 * 场景数据模型（对应需求文档第五节、第十节）
 * ============================================================================
 *
 * 设计铁律：
 * 1) **ObjectState 是纯数据**，只包含可 JSON 序列化的字段，不含任何 DOM / 引擎对象。
 *    这样"保存场景""场景模板""拍完重新编辑对象""离线重新渲染"四个未来需求
 *    全都不用改数据结构。
 * 2) **坐标约定**：position 是场景坐标（归一化 [0,1]²，见 coords/viewport.ts）。
 *    它与摄像头分辨率无关，所以导出 720p / 1080p 时素材相对位置和大小完全一致。
 * 3) **size.width 是"素材基准宽度占场景宽度的比例"**，scale 是叠加在上面的用户缩放倍率。
 *    最终渲染宽度 = size.width * scale（场景宽度比例），高度由图片宽高比推出，保证不变形。
 */

/** 需求文档第五节要求第一版预留的三种模式。 */
export type ObjectMode = 'FOLLOW_HAND' | 'FIXED' | 'TOP_HANGING';

/** 需求文档第八节的边界模式。第一版默认 CENTER_CLAMP。 */
export type BoundaryMode = 'CLAMP' | 'ALLOW_OVERFLOW' | 'CENTER_CLAMP' | 'FULL_VISIBLE' | 'NO_BOUNDARY';

/**
 * 手势绑定。第一版只做"出现/激活"和"双指缩放"，但结构上做成
 * "手势 id -> 动作名"的映射表，将来用户自定义快捷动作（需求文档第 47 项）时不用改模型。
 */
export interface GestureBinding {
  /** 激活/显隐该素材的手势 id，null 表示不绑定 */
  activate: string | null;
  /** 缩放该素材的手势 id，null 表示不绑定 */
  scale: string | null;
  /** 其它扩展绑定，避免以后频繁改结构 */
  extra: Record<string, string>;
}

export interface ObjectState {
  id: string;
  /** 素材引用，对应 AssetManager 里的 asset.id；null 表示还没绑定素材（例如文字/贴纸占位） */
  source: string | null;
  /** 锚点在场景中的位置（归一化场景坐标） */
  position: Vec2;
  /** 用户缩放倍率，叠加在 size.width 上 */
  scale: number;
  /** 旋转弧度，正值视觉上顺时针（因为 y 轴向下） */
  rotation: number;
  /** 0..1 */
  opacity: number;
  visible: boolean;
  /** 层级，数值大的画在上面。由 ObjectManager 负责分配/调整。 */
  zIndex: number;
  /** 锚点在素材自身上的归一化位置，(0.5, 0.5) = 以图片中心为定位点 */
  anchor: Vec2;
  /** 行为模式（需求文档第五节） */
  mode: ObjectMode;
  /** 手势绑定（需求文档第五节） */
  gestureBinding: GestureBinding;
  /** 物理开关。第一版恒为 false，但字段和数据通路预留（需求文档第十节） */
  physicsEnabled: boolean;
  /**
   * 交互能力开关（参考文档第五节 Object → Interaction）。
   * 把"能不能抓/能不能缩放"做成数据，InteractionManager 里就不需要任何
   * "这张图特殊"的分支 —— 需求文档反复强调的"不要写死"。
   */
  interaction: ObjectInteractionConfig;
  /** 边界模式（需求文档第八节） */
  boundaryMode: BoundaryMode;
  /** 素材基准宽度 = 占场景宽度的比例（scale 之前） */
  size: { width: number };
}

export type ObjectStatePatch = Partial<Omit<ObjectState, 'id' | 'gestureBinding' | 'interaction'>> & {
  gestureBinding?: Partial<GestureBinding>;
  interaction?: Partial<ObjectInteractionConfig>;
};

/**
 * 新素材的默认宽度：占输出画幅宽度的比例。
 *
 * 0.28 是刻意偏小的：这是口播素材相机，图片是"画中画"而不是主角，
 * 默认太大会挡住脸和手（真机反馈过"图片太大，手被盖住看不见"）。
 * 需要更大的时候用**双手**捏合放大（`TwoHandScaleBehavior`）：一只手拿住，两只手一起张开。
 */
export const DEFAULT_OBJECT_WIDTH = 0.28;

export function createGestureBinding(patch: Partial<GestureBinding> = {}): GestureBinding {
  return {
    activate: patch.activate ?? null,
    scale: patch.scale ?? null,
    extra: { ...(patch.extra ?? {}) },
  };
}

export function createObjectState(id: string, patch: ObjectStatePatch = {}): ObjectState {
  return {
    id,
    source: patch.source ?? null,
    position: { ...(patch.position ?? { x: 0.5, y: 0.5 }) },
    scale: patch.scale ?? 1,
    rotation: patch.rotation ?? 0,
    opacity: patch.opacity ?? 1,
    visible: patch.visible ?? true,
    zIndex: patch.zIndex ?? 0,
    anchor: { ...(patch.anchor ?? { x: 0.5, y: 0.5 }) },
    mode: patch.mode ?? 'FIXED',
    gestureBinding: createGestureBinding(patch.gestureBinding),
    physicsEnabled: patch.physicsEnabled ?? false,
    interaction: createInteractionConfig(patch.interaction),
    boundaryMode: patch.boundaryMode ?? 'CENTER_CLAMP',
    size: { width: patch.size?.width ?? DEFAULT_OBJECT_WIDTH },
  };
}

export function cloneObjectState(state: ObjectState): ObjectState {
  return {
    ...state,
    position: { ...state.position },
    anchor: { ...state.anchor },
    gestureBinding: createGestureBinding(state.gestureBinding),
    interaction: createInteractionConfig(state.interaction),
    size: { ...state.size },
  };
}

/** 场景序列化格式。version 用于将来的迁移。 */
export interface SceneSnapshot {
  version: 1;
  objects: ObjectState[];
  /** 场景命名，为将来的场景模板预留 */
  name?: string;
}
