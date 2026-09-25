import type { Viewport } from '../core/coords/viewport';
import type { GestureDebugInfo, HandShapeDebug } from '../core/gesture/gestureManager';
import { HAND_CONNECTIONS, HAND_LANDMARK, type SceneHand } from '../core/hand/handState';
import { computeObjectRenderGeometry, computeObjectScreenCorners } from '../core/scene/geometry';
import type { RenderableObject } from './renderer';

export interface DebugOverlayOptions {
  showGrid: boolean;
  showBounds: boolean;
  showInfo: boolean;
  /** 画手部骨架与 pinch 连线（Phase 2） */
  showHands: boolean;
}

export interface DebugStats {
  fps: number;
  objectCount: number;
  sourceWidth: number;
  sourceHeight: number;
  mirrored: boolean;
  cameraFacing: string;
  /** 手势层是否识别到了手 */
  gestureActive: boolean;
  /** 手部检测耗时（毫秒） */
  detectMs: number;
  /** 检测实际输入尺寸（确认降采样生效） */
  detectInputWidth: number;
  detectInputHeight: number;
  /** GPU / CPU / 未就绪 */
  trackerDelegate: string;
  /** 捏合比例（掌心长度归一化）；拿不到关键点时为 null */
  pinchRatio: number | null;
  pinchActive: boolean;
  /** 本帧识别到几只手 */
  handCount: number;
  /** 有几只手在捏合 */
  activePinches: number;
  /** 双手缩放是否成立 */
  twoHandActive: boolean;
  /** 双手间距（场景单位） */
  twoHandDistance: number | null;
  /** 双手缩放倍率（相对会话开始）；没有会话时为 null */
  twoHandRatio: number | null;
  /** 指弹装填的实时读数与门槛（真机排查"勾了为什么不装填"全靠它） */
  flick: GestureDebugInfo['flick'];
  /** 打响指（翻页）的实时读数与门槛 —— 真机排查"打了没反应"全靠它 */
  snap: GestureDebugInfo['snap'];
  /** 每只手的手型明细（真机标定靠它） */
  perHand: readonly HandShapeDebug[];
  /** 握拳急停：当前握拳的手 */
  fistHands: readonly string[];
  /** 刚被急停取消、必须先张开手才能重新抓取 */
  rearmRequired: boolean;
  /** 是否处于"手丢失宽限期" */
  inHandLossGrace: boolean;
  /** 当前被抓住的素材 id（没有行为消费 targetPosition 这类问题，靠它一眼看出来） */
  grabbedIds: readonly string[];
  timelineFrames: number;
  note?: string;
}

const GRID_COLOR = 'rgba(120, 200, 255, 0.28)';
const BORDER_COLOR = 'rgba(120, 200, 255, 0.55)';
const BOUNDS_COLOR = 'rgba(255, 196, 0, 0.9)';
const ANCHOR_COLOR = '#ff4d6d';
const TEXT_COLOR = 'rgba(255, 255, 255, 0.92)';
/**
 * 信息面板背景。
 * 0.55 的不透明度不够：素材的标签会从面板底下透出来，把参数行糊掉 ——
 * 而真机标定恰恰要读这些行（人工过目截图时发现的）。
 */
const PANEL_BG = 'rgba(0, 0, 0, 0.86)';
/** 字号与字体栈分开写：面板要按画布宽度自适应缩放字号（见 `showInfo` 分支） */
const FONT_PX = 12;
/** 缩放下限：再小就没法读了，宁可让窄屏上的长行溢出 */
const FONT_MIN_PX = 8;
const FONT_STACK = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const FONT = `${FONT_PX}px ${FONT_STACK}`;

/**
 * 调试叠层。
 *
 * 需求文档第十八节要求"每完成一个阶段都先运行测试"。摄像头 / 手势这类东西没法靠
 * 单元测试验收手感，所以 Phase 1 就把叠层做出来：网格、素材包围盒、锚点、实时参数
 * 一眼可见，Phase 2 接入手部关键点后直接往这里加点就行。
 *
 * 注意：叠层坐标全部用 **屏幕像素**（已含镜像），所以它画出来的框和用户看到的素材
 * 一定重合 —— 如果哪次重构把镜像搞重复了，这里会立刻露馅。
 */
export function drawDebugOverlay(
  ctx: CanvasRenderingContext2D,
  dpr: number,
  viewport: Viewport,
  objects: readonly RenderableObject[],
  hands: readonly SceneHand[],
  stats: DebugStats,
  options: DebugOverlayOptions,
): void {
  const canvas = viewport.canvas;
  const previousTransform = ctx.getTransform();

  // 叠层统一在 CSS 像素空间里画
  const scale = dpr > 0 ? dpr : 1;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.lineWidth = 1;

  if (options.showGrid) {
    const rect = viewport.displayRect;

    // 先压暗 letterbox 黑边，让"成片画幅"一目了然
    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    if (rect.x > 0) {
      ctx.fillRect(0, 0, rect.x, canvas.height);
      ctx.fillRect(rect.x + rect.width, 0, canvas.width - rect.x - rect.width, canvas.height);
    }
    if (rect.y > 0) {
      ctx.fillRect(0, 0, canvas.width, rect.y);
      ctx.fillRect(0, rect.y + rect.height, canvas.width, canvas.height - rect.y - rect.height);
    }

    // 成片画幅的边框
    ctx.strokeStyle = BORDER_COLOR;
    ctx.lineWidth = 1;
    ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.width - 1, rect.height - 1);

    // 三分线
    ctx.strokeStyle = GRID_COLOR;
    ctx.beginPath();
    for (let i = 1; i <= 2; i += 1) {
      const x = Math.round(rect.x + (rect.width * i) / 3) + 0.5;
      const y = Math.round(rect.y + (rect.height * i) / 3) + 0.5;
      ctx.moveTo(x, rect.y);
      ctx.lineTo(x, rect.y + rect.height);
      ctx.moveTo(rect.x, y);
      ctx.lineTo(rect.x + rect.width, y);
    }
    ctx.stroke();
  }

  if (options.showBounds) {
    ctx.font = FONT;
    ctx.textBaseline = 'top';

    for (const item of objects) {
      const corners = computeObjectScreenCorners(item.state, item.aspect, viewport);
      const geometry = computeObjectRenderGeometry(item.state, item.aspect, viewport);

      const grabbed = stats.grabbedIds.includes(item.state.id);

      ctx.strokeStyle = grabbed
        ? 'rgba(77, 255, 168, 0.95)'
        : item.state.visible
          ? BOUNDS_COLOR
          : 'rgba(255,255,255,0.25)';
      ctx.lineWidth = grabbed ? 2.5 : 1.5;
      ctx.beginPath();
      corners.forEach((corner, index) => {
        if (index === 0) ctx.moveTo(corner.x, corner.y);
        else ctx.lineTo(corner.x, corner.y);
      });
      ctx.closePath();
      ctx.stroke();

      const anchor = viewport.sceneToViewport(item.state.position);
      ctx.fillStyle = ANCHOR_COLOR;
      ctx.beginPath();
      ctx.arc(anchor.x, anchor.y, 3.5, 0, Math.PI * 2);
      ctx.fill();

      const label = `${item.state.id} · ${item.state.mode}${grabbed ? ' · GRABBED' : ''}`;
      const detail = `x${item.state.position.x.toFixed(2)} y${item.state.position.y.toFixed(2)} s${item.state.scale.toFixed(2)} ${(item.state.rotation * (180 / Math.PI)).toFixed(0)}°`;
      const textX = corners[0].x;
      const textY = corners[0].y - 4;

      ctx.fillStyle = TEXT_COLOR;
      ctx.strokeStyle = 'rgba(0,0,0,0.75)';
      ctx.lineWidth = 3;
      ctx.strokeText(label, textX, textY);
      ctx.fillText(label, textX, textY);
      ctx.strokeText(detail, textX, textY + 14);
      ctx.fillText(detail, textX, textY + 14);

      // 局部尺寸，用来核对"图片有没有被拉伸"
      if (geometry.localWidth > 0) {
        const ratio = geometry.localWidth / geometry.localHeight;
        ctx.strokeText(`tex ${item.aspect.toFixed(3)} → px ${ratio.toFixed(3)}`, textX, textY + 28);
        ctx.fillText(`tex ${item.aspect.toFixed(3)} → px ${ratio.toFixed(3)}`, textX, textY + 28);
      }
    }
  }

  if (options.showHands && hands.length > 0) {
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (const [handIndex, hand] of hands.entries()) {
      // 骨架连线
      ctx.strokeStyle = stats.pinchActive ? 'rgba(120, 255, 170, 0.9)' : 'rgba(120, 200, 255, 0.75)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (const [from, to] of HAND_CONNECTIONS) {
        const a = hand.landmarks[from];
        const b = hand.landmarks[to];
        if (!a || !b) continue;
        const pa = viewport.sceneToViewport(a.position);
        const pb = viewport.sceneToViewport(b.position);
        ctx.moveTo(pa.x, pa.y);
        ctx.lineTo(pb.x, pb.y);
      }
      ctx.stroke();

      // 关键点
      ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
      for (const landmark of hand.landmarks) {
        const point = viewport.sceneToViewport(landmark.position);
        ctx.beginPath();
        ctx.arc(point.x, point.y, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }

      // pinch 连线（拇指尖 ↔ 食指尖）：手上最值得盯的一根线
      const thumb = hand.landmarks[HAND_LANDMARK.THUMB_TIP];
      const index = hand.landmarks[HAND_LANDMARK.INDEX_FINGER_TIP];
      if (thumb && index) {
        const a = viewport.sceneToViewport(thumb.position);
        const b = viewport.sceneToViewport(index.position);
        ctx.strokeStyle = stats.pinchActive ? '#4dffa8' : '#ffc400';
        ctx.lineWidth = stats.pinchActive ? 3 : 1.5;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();

        for (const point of [a, b]) {
          ctx.fillStyle = stats.pinchActive ? '#4dffa8' : '#ffc400';
          ctx.beginPath();
          ctx.arc(point.x, point.y, 5, 0, Math.PI * 2);
          ctx.fill();
        }

        if (stats.pinchRatio !== null) {
          ctx.font = FONT;
          /*
           * 标签贴在**手腕下方**，而不是捏合点上方。
           * 手部叠层已经在准星旁边写了"手型 + gap"，两条都挤在指尖附近会互相压住
           * （两张手同时出现时更明显 —— 人工过目截图时发现的）。
           * 手腕在手的另一端，天然离得开。
           */
          const info = stats.perHand[handIndex];
          const label = info
            ? `${info.shape} ${info.gap === null ? '—' : info.gap.toFixed(3)}`
            : `pinch ${stats.pinchRatio.toFixed(3)}`;
          const wrist = hand.landmarks[HAND_LANDMARK.WRIST];
          const anchor = wrist
            ? viewport.sceneToViewport(wrist.position)
            : { x: (a.x + b.x) / 2, y: Math.max(a.y, b.y) };
          const textX = anchor.x + 8;
          const textY = anchor.y + 12;
          ctx.textBaseline = 'top';
          ctx.strokeStyle = 'rgba(0,0,0,0.75)';
          ctx.lineWidth = 3;
          ctx.strokeText(label, textX, textY);
          ctx.fillStyle = info?.shape === 'fist' ? '#ff6078' : stats.pinchActive ? '#4dffa8' : '#ffc400';
          ctx.fillText(label, textX, textY);
        }
      }
    }
  }

  if (options.showInfo) {
    const rect = viewport.displayRect;
    const frame = viewport.frame;
    const lines = [
      `fps        ${stats.fps.toFixed(1)}`,
      `camera     ${stats.cameraFacing}${stats.mirrored ? ' (mirrored)' : ''}`,
      `source     ${stats.sourceWidth}×${stats.sourceHeight}`,
      `canvas     ${canvas.width}×${canvas.height} (dpr ${scale})`,
      `frame      ${frame.width.toFixed(0)}×${frame.height.toFixed(0)} @ ${viewport.outputAspect.toFixed(4)}`,
      `display    x${rect.x.toFixed(0)} y${rect.y.toFixed(0)}`,
      `visible    ${fmtRect(viewport.visibleSourceRect)}`,
      `coverScale ${viewport.coverScale.toFixed(4)}`,
      `objects    ${stats.objectCount}`,
      `grabbed    ${stats.grabbedIds.length > 0 ? stats.grabbedIds.join(', ') : '—'}`,
      `hand       ${stats.gestureActive ? `${stats.handCount} hand(s)` : 'none'}${stats.inHandLossGrace ? ' (grace)' : ''}`,
      `pinch      ${stats.pinchRatio === null ? '—' : stats.pinchRatio.toFixed(3)}${stats.pinchActive ? ' ACTIVE' : ''} · ${stats.activePinches}/2 手捏合`,
      `two-hand   ${
        stats.twoHandActive
          ? `ON · 间距 ${stats.twoHandDistance === null ? '—' : stats.twoHandDistance.toFixed(3)} · 倍率 ${
              stats.twoHandRatio === null ? '—' : `×${stats.twoHandRatio.toFixed(2)}`
            }`
          : 'off'
      }`,
      `fist       ${stats.fistHands.length > 0 ? `${stats.fistHands.join(', ')} 握拳` : '—'}${stats.rearmRequired ? ' · 已取消待张开手' : ''}`,
      `tracker    ${stats.trackerDelegate} · ${stats.detectMs.toFixed(1)}ms · in ${stats.detectInputWidth}×${stats.detectInputHeight}`,
      `timeline   ${stats.timelineFrames} frames`,
    ];
    lines.push(...fmtFlick(stats.flick));
    lines.push(...fmtSnap(stats.snap));
    if (stats.note) lines.push(`note       ${stats.note}`);

    // 每只手一行：gap / 食→中夹角 / 四指伸展度（平面+深度）/ 手型。真机标定直接看这几行。
    stats.perHand.forEach((hand, index) => {
      const reaches = hand.reaches;
      const depth = hand.reachesDepth;
      const fmtReach = (value: number | null): string => (value === null ? '—' : value.toFixed(2));
      lines.push(
        `hand${index}      ${hand.handedness ?? '?'} ${hand.shape} · gap ${fmt(
          hand.gap,
        )} · θ ${hand.angleDeg === null ? '—' : `${hand.angleDeg.toFixed(1)}°`}`,
      );
      // 平面与深度两把尺子分开列：判"蜷曲"要求两者同时成立，标定时要看是哪一把在说不
      lines.push(
        `          伸展 2D ${fmtReach(reaches.index)}/${fmtReach(reaches.middle)}/${fmtReach(
          reaches.ring,
        )}/${fmtReach(reaches.pinky)} · 3D ${fmtReach(depth.index)}/${fmtReach(depth.middle)}/${fmtReach(
          depth.ring,
        )}/${fmtReach(depth.pinky)}`,
      );
    });

    ctx.font = FONT;
    ctx.textBaseline = 'top';

    let maxWidth = 0;
    for (const line of lines) maxWidth = Math.max(maxWidth, ctx.measureText(line).width);

    /*
     * 自适应字号：面板最宽只能到画布右边再留 8px。
     *
     * 手机竖屏上画布宽度就是屏幕宽度（约 500px 左右），而调试面板里最宽的一行
     * （每只手的"伸展 2D …/…/…/… · 3D …"）超过这个宽度 —— 最早是直接被右边缘**切掉**，
     * 于是标定要读的那几个数字恰好看不见（人工过目截图时发现的）。
     * 与其删信息，不如把字号按比例缩到放得下：调试叠层是给标定看的，信息完整比字号重要。
     * 下限 8px 只是防止极端窄屏缩成不可读。
     */
    const available = Math.max(120, canvas.width - 8 - 18);
    let fontPx = FONT_PX;
    if (maxWidth > available) {
      fontPx = Math.max(FONT_MIN_PX, FONT_PX * (available / maxWidth));
      ctx.font = `${fontPx}px ${FONT_STACK}`;
      maxWidth = 0;
      for (const line of lines) maxWidth = Math.max(maxWidth, ctx.measureText(line).width);
    }
    const lineHeight = Math.ceil(fontPx * 1.34);

    const panelWidth = maxWidth + 20;
    const panelHeight = lines.length * lineHeight + 14;

    ctx.fillStyle = PANEL_BG;
    ctx.fillRect(8, 8, panelWidth, panelHeight);
    ctx.strokeStyle = BORDER_COLOR;
    ctx.lineWidth = 1;
    ctx.strokeRect(8.5, 8.5, panelWidth, panelHeight);

    ctx.fillStyle = TEXT_COLOR;
    lines.forEach((line, index) => {
      ctx.fillText(line, 18, 15 + index * lineHeight);
    });
  }

  ctx.setTransform(
    previousTransform.a,
    previousTransform.b,
    previousTransform.c,
    previousTransform.d,
    previousTransform.e,
    previousTransform.f,
  );
}

function fmtRect(r: { x: number; y: number; width: number; height: number }): string {
  return `${r.x.toFixed(1)},${r.y.toFixed(1)} ${r.width.toFixed(1)}×${r.height.toFixed(1)}`;
}

function fmt(value: number | null): string {
  return value === null ? '—' : value.toFixed(3);
}

/**
 * 指弹的诊断行（两行）。
 *
 * 这几行存在的唯一理由：真机上"姿势做了却没反应"是完全不透明的。
 * 把每条门槛的**读数与判定并排写出来**，用户就能直接报出是"拇指没扣住"、
 * "其余三指张开了"还是"甩得不够快/不够开"，而不是只能描述手感。
 * 达标标 `+`、没达标标 `-`。
 *
 * 第五轮真机标定后这两行的含义变了（见 `flick.ts` 文件头）：
 *   · 第一行是**扣住**（装填）：`扣` = 拇食指距离，要求**小**；`中` = 其余三指蜷着；
 *     `食` 挪到最后且**没有达标标记** —— 它现在纯粹是观测，不参与门槛
 *     （弹脑瓜蓄力时食指本来就是伸的，实测 1.52）；
 *   · 第二行是**甩开**（弹出）：`增` = gap 相对扣住时张开多少，`速` = 指尖速度。
 *     这两个数在甩开之后**保持不动**，供人抬眼读数（标定就靠它们）。
 *
 * ⚠️ 两个都是踩过的坑：
 *   · **宽度**：真机竖屏画布只有约 **360px** 宽（截图实测 360×630 @ dpr 3.5），
 *     最早那版把门槛全写出来（"食指 1.30✓需≤1.35 · gap 0.70✓需≥0.60 …"），
 *     整行被画布右边缘切掉 —— 恰恰是要读的数字看不见（人工过目截图时发现的）。
 *     所以这里只写"名称 读数+/-"，门槛另用**当前挡路的那一条**短提示给出；
 *   · **字形**：`✓`/`✗` 在等宽字体里没有字形，真机与无头浏览器上都会渲染成豆腐块
 *     （同样是人工过目截图时发现的）。标记一律用 ASCII 的 `+`/`-`。
 */
function fmtFlick(info: DebugStats['flick']): string[] {
  if (!info) return ['flick      —（画面里没有手）'];
  const t = info.thresholds;
  const mark = (ok: boolean): string => (ok ? '+' : '-');
  const index = info.indexReach;
  const gap = info.gap;
  const middle = info.middleReach;
  const armed = info.armedFrames >= t.loadedFrames;

  // 只报**当前挡路的那一条**，比把门槛都列一遍短得多，也更有用
  const fix = armed
    ? '已扣住'
    : gap !== null && gap > t.loadedMaxGap
      ? `拇指扣住(≤${t.loadedMaxGap.toFixed(2)})`
      : middle !== null && middle > t.maxMiddleReach
        ? `三指别张开(≤${t.maxMiddleReach.toFixed(2)})`
        : '手丢了';

  return [
    `flick      ${info.handedness ?? '?'} ${info.shape} · 扣 ${gap === null ? '—' : gap.toFixed(2)}${mark(gap !== null && gap <= t.loadedMaxGap)}` +
      ` · 中 ${middle === null ? '—' : middle.toFixed(2)}${mark(middle !== null && middle <= t.maxMiddleReach)}` +
      ` · 装填 ${info.armedFrames}/${t.loadedFrames} · ${fix}`,
    `           甩开 增${info.gapGain.toFixed(2)}${mark(info.gapGain >= t.minGapGain)}` +
      ` 速${info.releaseSpeed.toFixed(2)}${mark(info.releaseSpeed >= t.minTipSpeed)}` +
      ` · 食 ${index === null ? '—' : index.toFixed(2)}` +
      ` · 需增≥${t.minGapGain.toFixed(2)} 速≥${t.minTipSpeed.toFixed(2)}`,
  ];
}

/**
 * 打响指（翻页）的诊断行。
 *
 * 和指弹同一个理由：真机上"打了没反应"完全不透明 ——
 * 必须能直接读出"拇指离中指多远、贴住了没、弹开的增量与速度多少"。
 * 真机标定打响指就靠这一行（一轮就能定，不用来回猜）。
 */
function fmtSnap(info: DebugStats['snap']): string[] {
  if (!info) return ['snap       —（画面里没有手）'];
  const t = info.thresholds;
  const mark = (ok: boolean): string => (ok ? '+' : '-');
  const gap = info.middleGap;
  const armed = info.armedFrames >= t.loadedFrames;
  const fix = armed
    ? '已贴住'
    : gap === null
      ? '手丢了'
      : `拇指贴中指(≤${t.loadedMaxGap.toFixed(2)})`;

  return [
    `snap       ${info.handedness ?? '?'} · 中 ${gap === null ? '—' : gap.toFixed(2)}${mark(gap !== null && gap <= t.loadedMaxGap)}` +
      ` · 装 ${info.armedFrames}/${t.loadedFrames}` +
      ` · 增${info.gapGain.toFixed(2)}${mark(info.gapGain >= t.minGapGain)}` +
      ` 速${info.releaseSpeed.toFixed(2)}${mark(info.releaseSpeed >= t.minTipSpeed)}` +
      ` · 需增≥${t.minGapGain.toFixed(2)} 速≥${t.minTipSpeed.toFixed(2)} · ${fix}`,
  ];
}
