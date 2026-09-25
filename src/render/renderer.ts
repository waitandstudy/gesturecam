import type { Viewport } from '../core/coords/viewport';
import type { ObjectState } from '../core/scene/types';

/**
 * 渲染层接口 —— 需求文档第二条"不要把程序写死"在渲染上的落点。
 *
 * Phase 1 用 Canvas2D 实现（素材数量少、逻辑简单、drawImage 走 GPU 合成，够用）。
 * 将来要上 WebGL / PixiJS / 物理批渲染，只需要新写一个 Renderer 实现，
 * Scene、Object、Behavior 一行都不用改。
 */

export interface CameraFrameSource {
  /** 通常是 <video>，也可能是 ImageBitmap / OffscreenCanvas */
  source: CanvasImageSource;
  width: number;
  height: number;
}

export interface RenderableObject {
  state: Readonly<ObjectState>;
  /** 纹理宽高比（宽/高），geometry 用它保证不变形 */
  aspect: number;
  /** 纹理；为 null 时只画占位框（例如对象还没绑定图片） */
  image: CanvasImageSource | null;
}

export interface RenderFrame {
  camera: CameraFrameSource | null;
  /** 必须按绘制顺序（zIndex 升序）传入 */
  objects: readonly RenderableObject[];
}

export interface Renderer {
  readonly cssWidth: number;
  readonly cssHeight: number;
  readonly dpr: number;
  /** 设置逻辑尺寸（CSS 像素）；内部负责按 dpr 调整后备缓冲区 */
  resize(cssWidth: number, cssHeight: number, dpr?: number): void;
  render(frame: RenderFrame, viewport: Viewport): void;
  dispose?(): void;
}
