import type { Behavior, BehaviorContext, BehaviorStage } from '../behavior';
import type { BehaviorManager } from '../manager';
import type { BoundaryMode } from '../../scene/types';

export const BOUNDARY_BEHAVIOR_TYPE = 'boundary';

/**
 * BOUNDARY —— 边界约束（Phase 8）。
 *
 * 它落在行为管线的 **`constrain` 阶段**：这个阶段从 Phase 1 就预留着，一直是空的。
 * 位置放在这里是有道理的 —— 所有会改位置的东西（跟手、双手缩放、将来的物理）
 * 都跑在它前面，所以**只在最后一步统一约束**，才不会有哪条路径把素材漏到画面外。
 *
 * ## 为什么必须有它（真机/评审都指出过的体验缺口）
 *
 * `state.boundaryMode` 这个字段一直**只存不执行**：没有任何行为读它。
 * 结果是手一滑把素材拖出成片画幅，它就飘在外面 —— 看得见（画幅外是 letterbox 暗区）、
 * 但**命中测试也算得到**，可是用户很难瞄准，实际体验就是"素材丢了，只能清空重来"。
 * 录到一半丢掉素材，这一条视频就废了。
 *
 * ## 五种模式的语义
 *
 * | 模式 | 约束 |
 * | --- | --- |
 * | `CENTER_CLAMP`（默认）/ `CLAMP` | **锚点**必须留在画幅内 → 素材中心永远可见，永远抓得回来 |
 * | `FULL_VISIBLE` | 整个素材（含缩放与旋转的外框）必须留在画幅内 |
 * | `ALLOW_OVERFLOW` | 允许越界，但至少 `minVisibleFrac` 的自身尺寸要露在画幅里 |
 * | `NO_BOUNDARY` | 不约束（预留给"扔出画面"这类玩法） |
 *
 * 另外还有一条**兜底**：任何模式下（除 `NO_BOUNDARY`）只要发现素材外框与画幅
 * **完全没有交集**，就把它拉回画幅中心。理论上前面的钳制已经保证了不会发生，
 * 但这条兜底把"素材彻底丢失"这个体验从"不可能"变成"结构上不可能" ——
 * 它同时也是我自己写错钳制数学时的安全网。
 */
export interface BoundaryConfig {
  /** `ALLOW_OVERFLOW` 下至少要露出的比例（占素材自身尺寸），默认 0.15 */
  minVisibleFrac?: number;
}

const DEFAULT_MIN_VISIBLE_FRAC = 0.15;

/** 画幅在场景坐标里就是 [0,1]²（场景坐标的定义见 coords/viewport.ts）。 */
const FRAME_MIN = 0;
const FRAME_MAX = 1;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 素材外框相对**锚点**的四个边偏移（场景单位）。 */
interface Extents {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export class BoundaryBehavior implements Behavior {
  readonly type = BOUNDARY_BEHAVIOR_TYPE;
  readonly stage: BehaviorStage = 'constrain';

  private readonly minVisibleFrac: number;

  constructor(config: BoundaryConfig = {}) {
    this.minVisibleFrac = config.minVisibleFrac ?? DEFAULT_MIN_VISIBLE_FRAC;
    if (!(this.minVisibleFrac > 0) || this.minVisibleFrac >= 1) {
      throw new RangeError('minVisibleFrac 必须落在 (0, 1) 之间');
    }
  }

  serialize(): BoundaryConfig {
    return { minVisibleFrac: this.minVisibleFrac };
  }

  update(context: BehaviorContext): void {
    const { object } = context;
    const state = object.state;
    const mode = state.boundaryMode;
    if (mode === 'NO_BOUNDARY') return;

    const extents = this.computeExtents(context);
    const position = { x: state.position.x, y: state.position.y };

    const next = {
      x: this.constrainAxis(position.x, extents.left, extents.right, mode),
      y: this.constrainAxis(position.y, extents.top, extents.bottom, mode),
    };

    // 兜底：外框与画幅完全没有交集 -> 拉回中心（结构上保证素材不会彻底丢失）
    if (!overlapsFrame(next.x, extents.left, extents.right)) {
      next.x = FRAME_MAX / 2 - (extents.left + extents.right) / 2;
    }
    if (!overlapsFrame(next.y, extents.top, extents.bottom)) {
      next.y = FRAME_MAX / 2 - (extents.top + extents.bottom) / 2;
    }

    if (next.x !== position.x || next.y !== position.y) object.setPosition(next);
  }

  /**
   * 素材外框相对锚点的偏移。
   *
   * 三件事都要算对，否则"约束住了"是错觉：
   *   1. **缩放**参与（`size.width × scale`）；
   *   2. **纹理宽高比**参与纵向：画面高度与宽度单位不同，纵向尺寸要按
   *      `宽 / 纹理比 × 场景比` 换算（见 scene/geometry.ts 的同一套换算）；
   *   3. **旋转**参与：旋转是在像素空间做的（各向同性），所以先在"各向同性场景坐标"
   *      里转，再换回场景的 y 单位。
   */
  private computeExtents(context: BehaviorContext): Extents {
    const state = context.object.state;
    const aspect = context.viewport.aspect > 0 ? context.viewport.aspect : 1;
    const assetAspect = context.assetAspect > 0 ? context.assetAspect : 1;

    // 各向同性单位（都以画幅宽度为单位）：宽 = size.width × scale，高 = 宽 / 纹理比
    const width = Math.max(0, state.size.width * state.scale);
    const height = width / assetAspect;

    const anchorX = clamp(state.anchor.x, 0, 1);
    const anchorY = clamp(state.anchor.y, 0, 1);
    const corners = [
      { x: -anchorX * width, y: -anchorY * height },
      { x: (1 - anchorX) * width, y: -anchorY * height },
      { x: (1 - anchorX) * width, y: (1 - anchorY) * height },
      { x: -anchorX * width, y: (1 - anchorY) * height },
    ];

    const theta = Number.isFinite(state.rotation) ? state.rotation : 0;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    const rotated = corners.map((corner) => ({
      x: corner.x * cos - corner.y * sin,
      y: corner.x * sin + corner.y * cos,
    }));

    const xs = rotated.map((point) => point.x);
    const ys = rotated.map((point) => point.y);

    // 各向同性 y -> 场景 y 单位（乘画幅宽高比）。这里的 aspect 就是 sceneAspect。
    return {
      left: Math.min(...xs),
      right: Math.max(...xs),
      top: Math.min(...ys) * aspect,
      bottom: Math.max(...ys) * aspect,
    };
  }

  /** 单个轴的钳制。`min`/`max` 是外框相对锚点的偏移。 */
  private constrainAxis(value: number, min: number, max: number, mode: BoundaryMode): number {
    const extent = max - min;

    // FULL_VISIBLE：整个素材都要在画幅里。素材比画幅还大时只能居中（唯一合理的选择）
    if (mode === 'FULL_VISIBLE') {
      if (extent >= FRAME_MAX - FRAME_MIN) return FRAME_MAX / 2 - (min + max) / 2;
      return clamp(value, FRAME_MIN - min, FRAME_MAX - max);
    }

    // ALLOW_OVERFLOW：允许越界，但至少露出 minVisibleFrac 的自身尺寸
    if (mode === 'ALLOW_OVERFLOW') {
      if (extent >= FRAME_MAX - FRAME_MIN) return FRAME_MAX / 2 - (min + max) / 2;
      const margin = this.minVisibleFrac * extent;
      return clamp(value, margin - max, FRAME_MAX - margin - min);
    }

    // CENTER_CLAMP / CLAMP：锚点留在画幅内
    return clamp(value, FRAME_MIN, FRAME_MAX);
  }
}

/** 外框是否与画幅有交集（用于兜底判断）。 */
function overlapsFrame(position: number, min: number, max: number): boolean {
  const boxMin = position + min;
  const boxMax = position + max;
  return boxMax > FRAME_MIN && boxMin < FRAME_MAX;
}

export function registerBoundaryBehavior(manager: BehaviorManager): void {
  manager.register(BOUNDARY_BEHAVIOR_TYPE, (config) => new BoundaryBehavior((config ?? {}) as BoundaryConfig));
}
