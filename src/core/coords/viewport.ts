import type { Rect } from '../math/rect';
import type { Vec2 } from '../math/vec2';
import { mat2dMultiply, mat2dTranslate, mat2dTranslateScale, type Mat2D } from './mat2d';

export interface Size {
  width: number;
  height: number;
}

/** 输出画幅预设（由口播发布平台决定成片比例）。 */
export const ASPECT_PRESETS = {
  /** 抖音 / TikTok / 视频号 竖屏 */
  vertical: 9 / 16,
  /** 小红书 / 朋友圈 */
  portrait: 3 / 4,
  square: 1,
  /** B 站 / YouTube 横屏 */
  landscape: 16 / 9,
} as const;

/** `'source'` = 跟随摄像头原始宽高比。 */
export type OutputAspect = number | 'source';

export interface ViewportOptions {
  /** 前置摄像头自拍习惯：画面水平翻转。只影响摄像头帧与关键点换算，不影响素材内容。 */
  mirrored?: boolean;
  /** 输出画幅宽高比（宽/高）。默认 9:16 竖屏口播。 */
  outputAspect?: OutputAspect;
}

/**
 * ============================================================================
 * 坐标系统（需求文档第九节：预览区域和交互区域要分离）
 * ============================================================================
 *
 * 全项目只有三套坐标，任何一处坐标都必须写清楚是"哪一套"：
 *
 * 1) **源图像素坐标 source px**
 *    摄像头原始帧的像素坐标，(0,0) 是整帧左上角，范围 [0, sourceW] × [0, sourceH]。
 *    手部追踪模型输出的归一化坐标就是相对这一整套帧的（未镜像）。
 *
 * 2) **场景坐标 scene**
 *    归一化到 [0, 1] × [0, 1]，左上角为原点，y 轴向下。
 *    定义：场景 = **输出画幅内、用户在屏幕上看到的那块画面**的归一化坐标。
 *    四个直接推论，每一条都很关键：
 *
 *      a. **输出画幅**（成片比例，默认 9:16）是一等概念。
 *         屏幕比例和成片比例通常不一致，所以输出画幅以 letterbox 方式居中铺在
 *         画布上，两侧或上下留黑边。场景坐标归一化在**输出画幅**上而不是整个屏幕上
 *         ——否则换个手机、转个屏幕，同一个场景里素材的相对位置就变了。
 *      b. 摄像头画面以 cover 方式填满输出画幅。被裁掉的部分坐标落在 [0,1] 之外，
 *         这就是需求文档第九节要的"画面外缓冲区域"。
 *      c. **镜像属于"显示"这一步**：前置摄像头画面会被水平翻转，所以场景坐标是
 *         "翻转之后"的坐标。但反过来，**素材内容永远不翻转** —— 否则一张写着字的图
 *         会变成反字，这对口播素材是灾难。镜像只出现在两处：
 *           · `sourceNormalizedToScene()`（未镜像的关键点 → 显示坐标）
 *           · `createCameraMatrix()`（画摄像头帧时翻转画面本身）
 *      d. 素材按场景坐标直接映射到输出画幅，**不做任何翻转**。
 *
 * 3) **画布像素坐标 canvas px**
 *    最终渲染目标（<canvas>）上的像素坐标，范围 [0, canvasW] × [0, canvasH]。
 *    画布 = 整个可见区域；输出画幅是画布内的一个子矩形（见 `displayRect`）。
 *
 * 素材自身几何的旋转必须在 **等比例（isotropic）** 的像素空间里做：
 * scene 的 [0,1]×[0,1] 在非正方形画幅上是各向异性的，直接在里面旋转会把图片
 * 切成平行四边形。所以素材矩阵统一在"输出画幅像素空间"里构建。
 *
 * 关于将来的"录制是否镜像"：目前 `mirrored` 同时决定预览与录制（自拍习惯、
 * 所见即所得）。Phase 9 若要做"录成不镜像但预览镜像"，加一个独立的 record 标志
 * 即可，素材侧不受影响。
 */

/** cover 适配结果：把源图等比放大到完全盖住目标框，并居中裁切。 */
export interface CoverFit {
  /** 源图像素 -> 目标框像素的等比缩放系数 */
  scale: number;
  /** 裁切后仍然可见的源图区域（源图像素坐标） */
  visible: Rect;
  /** 源图左上角映射到目标框上的位置（cover 时通常是负数） */
  offsetX: number;
  offsetY: number;
}

/**
 * 计算 object-fit: cover 的适配参数。
 * 尺寸非正（摄像头还没就绪）时返回一个安全的退化结果。
 */
export function computeCoverFit(source: Size, target: Size): CoverFit {
  if (source.width <= 0 || source.height <= 0 || target.width <= 0 || target.height <= 0) {
    return { scale: 1, visible: { x: 0, y: 0, width: 0, height: 0 }, offsetX: 0, offsetY: 0 };
  }

  const scale = Math.max(target.width / source.width, target.height / source.height);
  const visibleWidth = target.width / scale;
  const visibleHeight = target.height / scale;

  return {
    scale,
    visible: {
      x: (source.width - visibleWidth) / 2,
      y: (source.height - visibleHeight) / 2,
      width: visibleWidth,
      height: visibleHeight,
    },
    offsetX: (target.width - source.width * scale) / 2,
    offsetY: (target.height - source.height * scale) / 2,
  };
}

/**
 * 在画布内居中放一个指定宽高比的矩形（letterbox / pillarbox）。
 * 手机竖屏 + 9:16 输出时基本铺满；平板或桌面横屏时会看到两侧黑边 ——
 * 这是对的，成片本来就是 9:16。
 */
export function computeLetterbox(canvas: Size, aspect: number): Rect {
  if (canvas.width <= 0 || canvas.height <= 0) return { x: 0, y: 0, width: 0, height: 0 };
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : canvas.width / canvas.height;

  const canvasAspect = canvas.width / canvas.height;
  if (canvasAspect > safeAspect) {
    // 画布比画幅更宽 -> 按高度铺满，左右留边
    const width = canvas.height * safeAspect;
    return { x: (canvas.width - width) / 2, y: 0, width, height: canvas.height };
  }
  // 画布比画幅更高 -> 按宽度铺满，上下留边
  const height = canvas.width / safeAspect;
  return { x: 0, y: (canvas.height - height) / 2, width: canvas.width, height };
}

function assertPositive(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} 必须是非负有限数，收到 ${value}`);
  }
}

export class Viewport {
  private _source: Size;
  private _canvas: Size;
  private _mirrored: boolean;
  private _outputAspect: OutputAspect;
  private _fit: CoverFit;
  private _displayRect: Rect;

  constructor(
    source: Size = { width: 0, height: 0 },
    canvas: Size = { width: 0, height: 0 },
    options: ViewportOptions = {},
  ) {
    assertPositive(source.width, 'source.width');
    assertPositive(source.height, 'source.height');
    assertPositive(canvas.width, 'canvas.width');
    assertPositive(canvas.height, 'canvas.height');
    this._source = { ...source };
    this._canvas = { ...canvas };
    this._mirrored = options.mirrored ?? false;
    this._outputAspect = options.outputAspect ?? ASPECT_PRESETS.vertical;
    this._displayRect = computeLetterbox(this._canvas, this.effectiveOutputAspect());
    this._fit = computeCoverFit(this._source, this.outputFrameSize());
  }

  // ---------------------------------------------------------------- 基本属性

  get source(): Size {
    return { ...this._source };
  }

  /** 整个渲染目标（屏幕可见区域）的尺寸。 */
  get canvas(): Size {
    return { ...this._canvas };
  }

  get mirrored(): boolean {
    return this._mirrored;
  }

  get outputAspectSetting(): OutputAspect {
    return this._outputAspect;
  }

  /** 实际生效的输出画幅宽高比（`'source'` 时解析为摄像头宽高比）。 */
  get outputAspect(): number {
    return this.effectiveOutputAspect();
  }

  /**
   * 输出画幅在画布内的位置（letterbox 之后的实际矩形）。
   * 成片就是这块矩形的内容，Phase 9 录制按它裁切。
   */
  get displayRect(): Rect {
    return { ...this._displayRect };
  }

  /** 输出画幅的像素尺寸。素材的尺寸与位置都以它为基准。 */
  get frame(): Size {
    return { width: this._displayRect.width, height: this._displayRect.height };
  }

  /** 输出画幅的宽高比。素材高度按它换算，保证图片不变形。 */
  get sceneAspect(): number {
    return this.effectiveOutputAspect();
  }

  /** 摄像头就绪且画布尺寸有效时才算就绪。 */
  get isReady(): boolean {
    return this._source.width > 0 && this._source.height > 0 && this._displayRect.width > 0;
  }

  get fit(): CoverFit {
    return this._fit;
  }

  get coverScale(): number {
    return this._fit.scale;
  }

  /** 输出画幅里可见的那块源图区域（源图像素坐标，尚未镜像）。 */
  get visibleSourceRect(): Rect {
    return { ...this._fit.visible };
  }

  // ---------------------------------------------------------------- 设置

  setSourceSize(width: number, height: number): void {
    assertPositive(width, 'width');
    assertPositive(height, 'height');
    if (this._source.width === width && this._source.height === height) return;
    this._source = { width, height };
    this.recompute();
  }

  setCanvasSize(width: number, height: number): void {
    assertPositive(width, 'width');
    assertPositive(height, 'height');
    if (this._canvas.width === width && this._canvas.height === height) return;
    this._canvas = { width, height };
    this.recompute();
  }

  setMirrored(mirrored: boolean): void {
    this._mirrored = mirrored;
  }

  /** 切换输出画幅（`'source'` = 跟随摄像头原始比例）。只影响布局，不改素材场景坐标。 */
  setOutputAspect(aspect: OutputAspect): void {
    this._outputAspect = aspect;
    this.recompute();
  }

  private effectiveOutputAspect(): number {
    if (this._outputAspect === 'source') {
      if (this._source.width > 0 && this._source.height > 0) return this._source.width / this._source.height;
      return ASPECT_PRESETS.vertical;
    }
    return Number.isFinite(this._outputAspect) && this._outputAspect > 0
      ? this._outputAspect
      : ASPECT_PRESETS.vertical;
  }

  /** 输出画幅的等比例尺寸（只用于推 cover 裁切，取画布宽度为基准）。 */
  private outputFrameSize(): Size {
    const aspect = this.effectiveOutputAspect();
    const width = this._canvas.width > 0 ? this._canvas.width : 1;
    return { width, height: width / aspect };
  }

  private recompute(): void {
    this._displayRect = computeLetterbox(this._canvas, this.effectiveOutputAspect());
    this._fit = computeCoverFit(this._source, this.outputFrameSize());
  }

  // ---------------------------------------------------------------- scene <-> canvas

  /**
   * 场景坐标 -> 画布像素。含输出画幅的 letterbox 偏移，**不含镜像**
   * （素材内容永远正向）。
   */
  sceneToViewport(p: Vec2): Vec2 {
    const rect = this._displayRect;
    return { x: rect.x + p.x * rect.width, y: rect.y + p.y * rect.height };
  }

  /** 画布像素 -> 场景坐标。 */
  viewportToScene(p: Vec2): Vec2 {
    const rect = this._displayRect;
    if (rect.width <= 0 || rect.height <= 0) return { x: 0, y: 0 };
    return { x: (p.x - rect.x) / rect.width, y: (p.y - rect.y) / rect.height };
  }

  /**
   * 绘制摄像头帧用的矩阵：把"输出画幅局部坐标 (0,0)-(frameW,frameH)"映射到画布上的
   * `displayRect`，并在画幅内做水平镜像（自拍习惯）。
   *
   * **只有画摄像头帧时用它，素材不要用。**
   */
  createCameraMatrix(): Mat2D {
    const rect = this._displayRect;
    const toDisplay = mat2dTranslate(rect.x, rect.y);
    if (!this._mirrored) return toDisplay;
    return mat2dMultiply(toDisplay, mat2dTranslateScale(rect.width, 0, -1, 1));
  }

  // ------------------------------------------------- scene <-> source-normalized

  /**
   * 手部追踪输出的"整帧归一化坐标"([0,1]² over 完整源帧，未镜像) -> 场景坐标。
   *
   * 两件事：按输出画幅的 cover 裁切换算 + 镜像换算。这是**全项目唯一**把
   * "未镜像的关键点"变成"用户在画面上看到的位置"的地方。
   */
  sourceNormalizedToScene(p: Vec2): Vec2 {
    const visible = this._fit.visible;
    if (visible.width <= 0 || visible.height <= 0) return { x: 0, y: 0 };

    let x = (p.x * this._source.width - visible.x) / visible.width;
    if (this._mirrored) x = 1 - x;

    return {
      x,
      y: (p.y * this._source.height - visible.y) / visible.height,
    };
  }

  /** 场景坐标 -> 整帧归一化坐标（sourceNormalizedToScene 的逆）。 */
  sceneToSourceNormalized(p: Vec2): Vec2 {
    const visible = this._fit.visible;
    if (this._source.width <= 0 || this._source.height <= 0) return { x: 0, y: 0 };

    const sceneX = this._mirrored ? 1 - p.x : p.x;
    const sourceX = sceneX * visible.width + visible.x;
    const sourceY = p.y * visible.height + visible.y;
    return { x: sourceX / this._source.width, y: sourceY / this._source.height };
  }

  /**
   * 绘制摄像头帧所需的 drawImage 裁剪参数。
   * 目标位置与镜像由 `createCameraMatrix()` 负责，所以 dw/dh 就是输出画幅尺寸。
   */
  cameraDrawParams(source: Size): { sx: number; sy: number; sw: number; sh: number; dw: number; dh: number } {
    const fit = computeCoverFit(source, this.outputFrameSize());
    const frame = this.frame;
    return {
      sx: fit.visible.x,
      sy: fit.visible.y,
      sw: fit.visible.width,
      sh: fit.visible.height,
      dw: frame.width,
      dh: frame.height,
    };
  }

  /** 导出尺寸：给定成片高度，返回成片宽高（timeline 模型与分辨率无关，所以随时可换）。 */
  exportSize(height: number): Size {
    const aspect = this.effectiveOutputAspect();
    return { width: Math.round(height * aspect), height: Math.round(height) };
  }
}
