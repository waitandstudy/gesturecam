import { mat2dMultiply, mat2dScale, type Mat2D } from '../core/coords/mat2d';
import type { Viewport } from '../core/coords/viewport';
import { computeObjectRenderGeometry } from '../core/scene/geometry';
import { palette } from '../ui/theme';
import type { RenderFrame, Renderer } from './renderer';

/** 对象还没绑定图片时的占位色 */
const PLACEHOLDER_FILL = 'rgba(255, 255, 255, 0.08)';
const PLACEHOLDER_STROKE = 'rgba(255, 255, 255, 0.35)';

/**
 * Canvas2D 渲染器。
 *
 * 变换链（全项目只有这一处做坐标合成，别处不允许自己拼矩阵）：
 *
 *   摄像头帧： 源图像素 --cover 裁切--> 局部 --镜像矩阵--> 屏幕像素 --dpr--> 设备像素
 *   素材：     局部素材空间 --M_obj--> 屏幕像素 --dpr--> 设备像素
 *
 * 注意两条链**只在摄像头帧上叠加镜像**：
 * 场景坐标已经定义在"显示后"的空间里，所以素材按场景坐标直接映射到画布即可，
 * 内容保持正向。素材矩阵在等比例的画布像素空间里构建，所以旋转也不会把图片切斜。
 */
export class Canvas2DRenderer implements Renderer {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private _cssWidth = 0;
  private _cssHeight = 0;
  private _dpr = 1;

  constructor(canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('无法获取 2D 渲染上下文。');
    this.canvas = canvas;
    this.ctx = ctx;
  }

  get cssWidth(): number {
    return this._cssWidth;
  }

  get cssHeight(): number {
    return this._cssHeight;
  }

  get dpr(): number {
    return this._dpr;
  }

  resize(cssWidth: number, cssHeight: number, dpr = globalThis.devicePixelRatio || 1): void {
    const width = Math.max(1, Math.round(cssWidth));
    const height = Math.max(1, Math.round(cssHeight));
    const ratio = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;

    this._cssWidth = width;
    this._cssHeight = height;
    this._dpr = ratio;

    const backingWidth = Math.max(1, Math.round(width * ratio));
    const backingHeight = Math.max(1, Math.round(height * ratio));
    if (this.canvas.width !== backingWidth) this.canvas.width = backingWidth;
    if (this.canvas.height !== backingHeight) this.canvas.height = backingHeight;
  }

  render(frame: RenderFrame, viewport: Viewport): void {
    const { ctx } = this;

    // 清屏（用后备缓冲区尺寸，不经过任何变换）
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // 取主题底色（品牌色 #1A1A1D），**不手抄十六进制**：
    // 它是画布铺底，和页面底色不一致时 letterbox 边缘会露出一条异色。
    // 做成运行时读取是因为 palette() 要读 DOM 样式，模块加载期可能还没就绪。
    ctx.fillStyle = palette().bg;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    if (frame.camera && frame.camera.width > 0 && frame.camera.height > 0) {
      const params = viewport.cameraDrawParams({ width: frame.camera.width, height: frame.camera.height });
      // 只有摄像头帧叠加镜像与 letterbox 偏移（自拍习惯）
      this.applyMatrix(mat2dMultiply(mat2dScale(this._dpr, this._dpr), viewport.createCameraMatrix()));
      ctx.drawImage(
        frame.camera.source,
        params.sx,
        params.sy,
        params.sw,
        params.sh,
        0,
        0,
        params.dw,
        params.dh,
      );
    }

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    for (const item of frame.objects) {
      if (!item.state.visible || item.state.opacity <= 0.001) continue;

      const geometry = computeObjectRenderGeometry(item.state, item.aspect, viewport);
      this.applyMatrix(mat2dMultiply(mat2dScale(this._dpr, this._dpr), geometry.matrix));
      ctx.globalAlpha = item.state.opacity;

      if (item.image) {
        try {
          ctx.drawImage(item.image, 0, 0, geometry.localWidth, geometry.localHeight);
        } catch {
          // 纹理还没解出尺寸时 drawImage 会抛错；跳过这一帧即可，不该让整个渲染循环挂掉
          this.drawPlaceholder(geometry.localWidth, geometry.localHeight);
        }
      } else {
        this.drawPlaceholder(geometry.localWidth, geometry.localHeight);
      }
    }

    ctx.globalAlpha = 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  private drawPlaceholder(width: number, height: number): void {
    const { ctx } = this;
    ctx.fillStyle = PLACEHOLDER_FILL;
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = PLACEHOLDER_STROKE;
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 6]);
    ctx.strokeRect(0, 0, width, height);
    ctx.setLineDash([]);
  }

  private applyMatrix(matrix: Mat2D): void {
    this.ctx.setTransform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f);
  }
}
