import { Canvas2DRenderer } from './canvas2dRenderer';
import type { RenderFrame } from './renderer';
import { Viewport, type OutputAspect } from '../core/coords/viewport';

/**
 * 离屏导出画布 —— 录制时真正被录的那块画布。
 *
 * 为什么不直接录屏幕上那块画布：
 *   1. 屏幕画布带着 letterbox 黑边，录出来会得到一条黑边烧进成片的视频；
 *   2. 屏幕画布尺寸随手机型号变（400×800 / 496×720 …），成片分辨率不可控；
 *   3. 屏幕上还画着调试叠层（骨架、包围盒），绝不能进成片。
 *
 * 所以导出画布是独立的：固定成片分辨率、不含黑边、只画摄像头帧 + 素材。
 * 它拥有**自己的 Viewport**（同一套源尺寸/镜像/画幅，但画布尺寸是成片尺寸），
 * 于是 `geometry.ts` 里那套坐标换算原封不动地复用到导出画布上 ——
 * 素材在成片里的相对位置与屏幕上完全一致，这也是"所见即所得"的依据。
 *
 * 顺带满足需求文档"导出不同分辨率"：换一个 height 就是换导出分辨率，
 * 素材状态不需要任何改动（场景坐标本来就是分辨率无关的）。
 */
export interface ExportSurfaceOptions {
  source: { width: number; height: number };
  outputAspect: OutputAspect;
  mirrored: boolean;
  /** 成片高度（像素），宽度按输出画幅比例推出 */
  height: number;
}

export class ExportSurface {
  readonly canvas: HTMLCanvasElement;
  readonly viewport: Viewport;
  private readonly renderer: Canvas2DRenderer;

  constructor(options: ExportSurfaceOptions) {
    this.canvas = document.createElement('canvas');
    this.viewport = new Viewport(
      options.source,
      { width: 1, height: 1 },
      { mirrored: options.mirrored, outputAspect: options.outputAspect },
    );
    // dpr 固定为 1：导出画布的像素就是成片像素，不掺设备像素比
    this.renderer = new Canvas2DRenderer(this.canvas);
    this.resize(options.height);
  }

  get width(): number {
    return this.viewport.frame.width;
  }

  get height(): number {
    return this.viewport.frame.height;
  }

  resize(height: number): void {
    const size = this.viewport.exportSize(height);
    this.renderer.resize(size.width, size.height, 1);
    this.viewport.setCanvasSize(size.width, size.height);
  }

  /** 与屏幕视口对齐源尺寸、镜像与画幅（摄像头切换 / 用户改画幅时调用）。 */
  syncFrom(source: Viewport): void {
    const sourceSize = source.source;
    if (sourceSize.width !== this.viewport.source.width || sourceSize.height !== this.viewport.source.height) {
      this.viewport.setSourceSize(sourceSize.width, sourceSize.height);
    }
    if (source.mirrored !== this.viewport.mirrored) {
      this.viewport.setMirrored(source.mirrored);
    }
    if (source.outputAspectSetting !== this.viewport.outputAspectSetting) {
      this.viewport.setOutputAspect(source.outputAspectSetting);
      this.resize(this.height);
    }
  }

  /** 用同一份 RenderFrame 渲染到导出画布（帧数据与屏幕渲染共用，不额外拷贝）。 */
  render(frame: RenderFrame): void {
    this.renderer.render(frame, this.viewport);
  }
}
