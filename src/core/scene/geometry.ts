import type { Viewport } from '../coords/viewport';
import { mat2dApply, mat2dInvert, mat2dMultiplyAll, mat2dRotate, mat2dTranslate, type Mat2D } from '../coords/mat2d';
import { rectFromPoints, type Rect } from '../math/rect';
import type { Vec2 } from '../math/vec2';
import type { ObjectState } from './types';

/**
 * 素材几何计算。
 *
 * 全部是纯函数，输入 (状态, 纹理宽高比, viewport)，不碰任何 DOM —— 所以可以直接单测，
 * 也可以在没有浏览器的情况下用于离线合成/服务端渲染（未来的"拍完离线重合成"路线）。
 *
 * 局部坐标空间：素材自身为 [0, localWidth] × [0, localHeight]，
 * 左上角是原图左上角，单位是"画布像素"。在等比例空间里做旋转，图片不会变形。
 */

/** 素材纹理宽高比 = 纹理像素宽 / 纹理像素高。非正数时退化为 1（正方形）。 */
export function normalizeAspect(aspect: number): number {
  return Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
}

/**
 * 素材在**输出画幅**像素空间中的尺寸。
 *
 * 用 `viewport.frame`（输出画幅，默认 9:16）而不是 `viewport.canvas`（整个屏幕）：
 * 屏幕上可能有 letterbox 黑边，素材尺寸必须相对成片画幅，否则换个屏幕尺寸
 * 素材的相对大小就变了。
 */
export function computeObjectPixelSize(
  state: ObjectState,
  assetAspect: number,
  viewport: Viewport,
): { width: number; height: number } {
  const frame = viewport.frame;
  const width = Math.max(0, state.size.width * state.scale * frame.width);
  const height = width / normalizeAspect(assetAspect);
  return { width, height };
}

/** 局部空间 -> 未镜像画布像素。 */
export function computeObjectMatrix(state: ObjectState, assetAspect: number, viewport: Viewport): Mat2D {
  const { width, height } = computeObjectPixelSize(state, assetAspect, viewport);
  const position = viewport.sceneToViewport(state.position);

  return mat2dMultiplyAll(
    mat2dTranslate(position.x, position.y),
    mat2dRotate(state.rotation),
    mat2dTranslate(-state.anchor.x * width, -state.anchor.y * height),
  );
}

export interface ObjectRenderGeometry {
  /** 局部绘制尺寸：drawImage(img, 0, 0, localWidth, localHeight) */
  localWidth: number;
  localHeight: number;
  /** 局部空间 -> 屏幕像素 */
  matrix: Mat2D;
}

/**
 * 素材的渲染几何。
 *
 * **不含镜像**：场景坐标已经定义在"显示后"的空间里，所以素材内容永远保持正向。
 * 把镜像也套到素材上会让一张写着字的图变成反字 —— 这是必须避免的产品级错误。
 */
export function computeObjectRenderGeometry(
  state: ObjectState,
  assetAspect: number,
  viewport: Viewport,
): ObjectRenderGeometry {
  const size = computeObjectPixelSize(state, assetAspect, viewport);
  return {
    localWidth: size.width,
    localHeight: size.height,
    matrix: computeObjectMatrix(state, assetAspect, viewport),
  };
}

export function computeObjectScreenCorners(
  state: ObjectState,
  assetAspect: number,
  viewport: Viewport,
): [Vec2, Vec2, Vec2, Vec2] {
  const geometry = computeObjectRenderGeometry(state, assetAspect, viewport);
  const { localWidth: w, localHeight: h, matrix } = geometry;
  return [
    mat2dApply(matrix, { x: 0, y: 0 }),
    mat2dApply(matrix, { x: w, y: 0 }),
    mat2dApply(matrix, { x: w, y: h }),
    mat2dApply(matrix, { x: 0, y: h }),
  ];
}

/** 素材在屏幕上的轴对齐包围盒（旋转后会比素材本身大）。 */
export function computeObjectScreenBounds(
  state: ObjectState,
  assetAspect: number,
  viewport: Viewport,
): Rect {
  return rectFromPoints(computeObjectScreenCorners(state, assetAspect, viewport));
}

/**
 * 命中测试：屏幕上的某个点是否落在素材上（考虑旋转与锚点）。
 *
 * `marginPx` 是**宽容边距**（像素）：在素材局部空间里把矩形四边各外扩这么多。
 * 这是从 handy 的 `GRAB_HIT_MARGIN_FRAC = 0.06` 学来的 —— 手指中点要精确落在
 * 小素材上很别扭，精确命中会让"差一点点"的捏合白白消费掉（用户得松手重捏）。
 * 手机上手指更粗、素材更小，这个宽容边距比桌面上更重要。
 */
export function hitTestObject(
  state: ObjectState,
  assetAspect: number,
  viewport: Viewport,
  screenPoint: Vec2,
  marginPx = 0,
): boolean {
  const geometry = computeObjectRenderGeometry(state, assetAspect, viewport);
  const inverse = mat2dInvert(geometry.matrix);
  if (!inverse) return false;
  const local = mat2dApply(inverse, screenPoint);
  const margin = Number.isFinite(marginPx) && marginPx > 0 ? marginPx : 0;
  return (
    local.x >= -margin &&
    local.x <= geometry.localWidth + margin &&
    local.y >= -margin &&
    local.y <= geometry.localHeight + margin
  );
}
