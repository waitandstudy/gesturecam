import type { Viewport } from '../core/coords/viewport';
import type { PinchState, TwoHandState } from '../core/gesture/types';
import { HAND_LANDMARK, type Handedness, type SceneHand } from '../core/hand/handState';
import type { Vec2 } from '../core/math/vec2';
import { computeObjectScreenCorners } from '../core/scene/geometry';
import type { RenderableObject } from './renderer';

/**
 * ============================================================================
 * 手部准星叠层（屏幕专用，**永不进成片**）
 * ============================================================================
 *
 * 解决的是一个很具体的问题：**素材盖住手之后，用户看不见自己的手指在哪**，
 * 于是没法瞄准"捏在图片上"，表现为"抓取不灵敏 / 抓不到"。
 *
 * 这块叠层只画四样东西，而且**始终开着**（不像调试叠层那样需要开关）——
 * 它相当于相机 App 里的对焦框，是操作反馈而不是调试信息：
 *
 *   1. **准星**：拇指尖与食指尖的中点。有没有捏合都画 ——
 *      "如果现在捏下去，会抓到这里"。图片盖住手时这是唯一的瞄准依据。
 *   2. **捏合连线**：把每只手的拇指尖和食指尖都连起来（双手时两只都画），
 *      让用户知道系统认到的是哪几根手指、有没有认到第二只手。
 *   3. **缩放宽轴**（双手时）：把两个捏合中点连成一条轴，标出倍率。
 *      双手缩放是"拉开/收拢这条轴"，画出轴用户立刻明白该怎么操作；
 *      不画的话大多数人第一次根本不知道要张开另一只手。
 *   4. **目标高亮**：给"现在捏下去会抓到的那个素材"描边。
 *      用的是交互层同一套命中判定（`previewTargetId`），所以提示和结果不会不一致。
 *   5. **手型与急停提示**：把系统判定的手型（捏合/握拳/张开）写在准星旁边，
 *      握拳或"已取消待重新武装"时给一条横幅。
 *      手势文法要成立，用户必须知道"系统认为我的手是什么" ——
 *      否则误判时他无从判断是自己动作不到位，还是程序认错了。
 *
 * 颜色即状态：
 *   灰蓝 = 有手但准星下面没有可抓的东西
 *   琥珀 = 准星压住了素材，捏下去就会抓到它
 *   绿色 = 已经抓住（拖动中）
 *   青色 = 双手缩放中
 *   红色 = 握拳急停 / 已取消（等用户张开手掌）
 */
export interface HandOverlayState {
  /** 平滑后的手（用来画捏合连线） */
  hands: readonly SceneHand[];
  /** 每只手的捏合/手型状态，下标与 `hands` 对应 */
  pinches: readonly PinchState[];
  /** 双手状态（位置由中点、大小由间距） */
  twoHand: TwoHandState;
  /** 双手缩放倍率（相对会话开始）；没有会话时为 null */
  twoHandRatio: number | null;
  /** 当前握拳的手（急停） */
  fistHands: readonly Handedness[];
  /** 刚被急停取消、必须先张开手才能重新抓取 */
  rearmRequired: boolean;
  /** 有几个素材正在"被弹掉、还能撤销"的淡出期 */
  deletingCount: number;
  /** 拇指尖-食指尖中点；没有手时为 null */
  pinchPoint: Vec2 | null;
  /** 捏合是否成立 */
  pinchActive: boolean;
  /** 现在捏合会抓到的素材 id（与真实抓取同一套判定） */
  previewTargetId: string | null;
  /** 用于判定的捏合 gap，显示出来让用户知道"还差多少" */
  pinchRatio: number | null;
  /** 指弹是否已经"装填"（食指勾住），标定与教学用 */
  flickArmed: boolean;
  /** 最近一次指弹的指尖速度；没弹过为 null */
  flickSpeed: number | null;
}

const COLOR_IDLE = 'rgba(150, 190, 220, 0.55)';
const COLOR_TARGET = 'rgba(255, 196, 0, 0.95)';
const COLOR_GRABBED = 'rgba(77, 255, 168, 0.98)';
const COLOR_SCALE = 'rgba(120, 236, 255, 0.98)';
const COLOR_STOP = 'rgba(255, 96, 120, 0.98)';
const TEXT_COLOR = 'rgba(255, 255, 255, 0.95)';
const FONT = '12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const FONT_BOLD = 'bold 15px system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';

/** 手型的中文名（给用户看，不用内部枚举名）。 */
const SHAPE_LABEL: Record<PinchState['shape'], string> = {
  pinch: '捏合',
  fist: '握拳',
  open: '张开',
  other: '',
};

export function drawHandOverlay(
  ctx: CanvasRenderingContext2D,
  dpr: number,
  viewport: Viewport,
  objects: readonly RenderableObject[],
  state: HandOverlayState,
): void {
  const point = state.pinchPoint ? viewport.sceneToViewport(state.pinchPoint) : null;
  const stopped = state.fistHands.length > 0;
  // 手离开画面之后仍要显示"请先张开手"的提示，所以这里不能只是没有准星就退出
  if (!point && !state.rearmRequired && !stopped) return;

  const scale = dpr > 0 ? dpr : 1;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const scaling = state.twoHand.active && state.twoHand.center !== null && state.twoHand.distance !== null;
  const grabbed = state.pinchActive && state.previewTargetId !== null;
  const overTarget = state.previewTargetId !== null && !stopped;
  const color = stopped
    ? COLOR_STOP
    : scaling
      ? COLOR_SCALE
      : grabbed
        ? COLOR_GRABBED
        : overTarget
          ? COLOR_TARGET
          : COLOR_IDLE;

  // 1) 目标素材高亮：描边 + 四角加粗，尽量不遮挡画面内容
  if (overTarget) {
    const target = objects.find((item) => item.state.id === state.previewTargetId);
    if (target) {
      const corners = computeObjectScreenCorners(target.state, target.aspect, viewport);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.setLineDash(grabbed || scaling ? [] : [7, 5]);
      ctx.beginPath();
      corners.forEach((corner, index) => {
        if (index === 0) ctx.moveTo(corner.x, corner.y);
        else ctx.lineTo(corner.x, corner.y);
      });
      ctx.closePath();
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // 2) 捏合连线：每只手都画，双手时用户能确认"第二只手也被认到了"
  const pinchCenters: Vec2[] = [];
  state.hands.forEach((hand, index) => {
    const pinch = state.pinches[index];
    const active = pinch?.active ?? false;
    const center = pinch?.center;
    if (center) pinchCenters.push(center);

    const thumb = hand.landmarks[HAND_LANDMARK.THUMB_TIP];
    const indexTip = hand.landmarks[HAND_LANDMARK.INDEX_FINGER_TIP];
    if (!thumb || !indexTip) return;

    const a = viewport.sceneToViewport(thumb.position);
    const b = viewport.sceneToViewport(indexTip.position);
    ctx.strokeStyle = active ? color : 'rgba(180, 205, 225, 0.45)';
    ctx.lineWidth = active ? 2.5 : 1.5;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();

    for (const end of [a, b]) {
      ctx.fillStyle = active ? color : 'rgba(180, 205, 225, 0.45)';
      ctx.beginPath();
      ctx.arc(end.x, end.y, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  });

  // 3) 缩放宽轴：两个捏合中点之间的连线（双手缩放就是在拉这条线）
  const [firstCenter, secondCenter] = pinchCenters;
  if (scaling && firstCenter && secondCenter) {
    const a = viewport.sceneToViewport(firstCenter);
    const b = viewport.sceneToViewport(secondCenter);
    ctx.strokeStyle = COLOR_SCALE;
    ctx.lineWidth = 3;
    ctx.setLineDash([8, 6]);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.setLineDash([]);

    if (state.twoHandRatio !== null) {
      const midX = (a.x + b.x) / 2;
      const midY = (a.y + b.y) / 2;
      const label = `缩放 ×${state.twoHandRatio.toFixed(2)}`;
      ctx.font = FONT;
      ctx.textBaseline = 'middle';
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.lineWidth = 3;
      ctx.strokeText(label, midX + 8, midY);
      ctx.fillStyle = COLOR_SCALE;
      ctx.fillText(label, midX + 8, midY);
    }
  }

  if (point) {
    // 4) 准星：外圈 + 十字 + 中心点。外圈在"压住素材"时变大，给出即时的命中反馈
    const radius = overTarget ? 15 : 11;
    ctx.strokeStyle = color;
    ctx.lineWidth = grabbed || scaling ? 3 : 2;

    ctx.beginPath();
    ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(point.x - radius - 6, point.y);
    ctx.lineTo(point.x - radius + 2, point.y);
    ctx.moveTo(point.x + radius - 2, point.y);
    ctx.lineTo(point.x + radius + 6, point.y);
    ctx.moveTo(point.x, point.y - radius - 6);
    ctx.lineTo(point.x, point.y - radius + 2);
    ctx.moveTo(point.x, point.y + radius - 2);
    ctx.lineTo(point.x, point.y + radius + 6);
    ctx.stroke();

    ctx.fillStyle = grabbed || scaling || stopped ? color : 'rgba(255,255,255,0.9)';
    ctx.beginPath();
    ctx.arc(point.x, point.y, grabbed || scaling ? 4 : 2.5, 0, Math.PI * 2);
    ctx.fill();

    /*
     * 5) 读数：把**当前手型**写出来。
     * 手势文法要求用户知道"系统认为我的手是什么"，否则误判时用户无从判断是自己做错了
     * 还是程序认错了 —— 真机反馈"很容易识别错误的手势"就是从这里开始变好的。
     */
    const shape = state.pinches[0]?.shape ?? 'other';
    const parts: string[] = [];
    const shapeLabel = SHAPE_LABEL[shape] || (state.pinchRatio === null ? '' : '');
    if (shapeLabel) parts.push(shapeLabel);
    if (state.pinchRatio !== null) parts.push(state.pinchRatio.toFixed(2));
    if (scaling) parts.push('双手缩放中');
    else if (grabbed) parts.push('抓住');
    // 指弹的中间状态也要给用户看：勾住了（装填）→ 弹出去。
    // 没有这个反馈，用户不知道自己的动作有没有被认到（真机标定也全靠它）。
    if (state.flickArmed) parts.push('食指已勾住');
    if (state.flickSpeed !== null) parts.push(`弹 ${state.flickSpeed.toFixed(1)}`);
    if (parts.length > 0) {
      const label = parts.join(' ');
      ctx.font = FONT;
      ctx.textBaseline = 'bottom';
      const textY = point.y - radius - 10;
      ctx.strokeStyle = 'rgba(0,0,0,0.75)';
      ctx.lineWidth = 3;
      ctx.strokeText(label, point.x + radius + 8, textY);
      ctx.fillStyle = stopped ? COLOR_STOP : TEXT_COLOR;
      ctx.fillText(label, point.x + radius + 8, textY);
    }
  }

  // 6) 横幅：这是"程序为什么不动了 / 刚才发生了什么"的唯一解释，必须显眼
  if (stopped || state.rearmRequired || state.deletingCount > 0) {
    // 措辞注意：握拳只停**这只手**的会话，不能说成"停止一切"（真机上另一只手还要能用）
    const message =
      state.deletingCount > 0
        ? `已弹掉 ${state.deletingCount} 张 · 捏住它可撤销`
        : stopped
          ? '握拳 · 已停止这只手的操作'
          : '已取消 · 张开手掌后可以重新抓取';
    ctx.font = FONT_BOLD;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    const textWidth = ctx.measureText(message).width;
    const boxWidth = textWidth + 36;
    const boxHeight = 40;
    const centerX = viewport.canvas.width / 2;
    // 放在画面下方 78% 处：再往下会和页面底部的状态提示叠在一起（截图过目时发现的）
    const centerY = Math.max(boxHeight, Math.min(viewport.canvas.height - 120, viewport.canvas.height * 0.78));

    ctx.fillStyle = 'rgba(20, 8, 12, 0.82)';
    ctx.beginPath();
    ctx.roundRect(centerX - boxWidth / 2, centerY - boxHeight / 2, boxWidth, boxHeight, 10);
    ctx.fill();
    ctx.strokeStyle = COLOR_STOP;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.fillStyle = 'rgba(255,255,255,0.96)';
    ctx.fillText(message, centerX, centerY);
    ctx.textAlign = 'left';
  }
}
