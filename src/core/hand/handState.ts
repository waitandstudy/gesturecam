import type { Viewport } from '../coords/viewport';
import type { Vec2 } from '../math/vec2';

/**
 * ============================================================================
 * 手部追踪的**数据契约**（项目里唯一允许出现"手"的地方）
 * ============================================================================
 *
 * 需求文档（第一份）第十六节原则 3：不要让 MediaPipe 渗透到整个项目，
 * 必须通过 HandTrackingInterface 提供统一数据，将来换识别方案不需要重写程序。
 *
 * 参考文档（第二份）第四节进一步要求把管线拆成
 *   CameraManager → HandTrackingManager → GestureManager → InteractionManager → Scene ...
 * 所以这个文件只负责"原始关键点"，**派生语义（pinch / 张开 / 抓取）一律不在这里实现**，
 * 见 core/gesture/ 与 core/interaction/。
 */

/** MediaPipe 的 21 个关键点索引，先按官方命名列出，避免代码里出现魔法数字。 */
export const HAND_LANDMARK = {
  WRIST: 0,
  THUMB_CMC: 1,
  THUMB_MCP: 2,
  THUMB_IP: 3,
  THUMB_TIP: 4,
  INDEX_FINGER_MCP: 5,
  INDEX_FINGER_PIP: 6,
  INDEX_FINGER_DIP: 7,
  INDEX_FINGER_TIP: 8,
  MIDDLE_FINGER_MCP: 9,
  MIDDLE_FINGER_PIP: 10,
  MIDDLE_FINGER_DIP: 11,
  MIDDLE_FINGER_TIP: 12,
  RING_FINGER_MCP: 13,
  RING_FINGER_PIP: 14,
  RING_FINGER_DIP: 15,
  RING_FINGER_TIP: 16,
  PINKY_MCP: 17,
  PINKY_PIP: 18,
  PINKY_DIP: 19,
  PINKY_TIP: 20,
} as const;

export type HandLandmarkIndex = (typeof HAND_LANDMARK)[keyof typeof HAND_LANDMARK];

export const LANDMARK_COUNT = 21;

/**
 * 21 点骨架连线（只用于调试叠层绘制）。
 * 刻意在这里自己定义，而不是用 `HandLandmarker.HAND_CONNECTIONS` ——
 * 那样会把 MediaPipe 拖进渲染层，破坏"换识别方案不用改渲染"的约定。
 */
export const HAND_CONNECTIONS: readonly (readonly [number, number])[] = [
  // 手掌
  [0, 1], [1, 2], [2, 3], [3, 4], // 拇指
  [0, 5], [5, 6], [6, 7], [7, 8], // 食指
  [5, 9], [9, 10], [10, 11], [11, 12], // 中指
  [9, 13], [13, 14], [14, 15], [15, 16], // 无名指
  [13, 17], [17, 18], [18, 19], [19, 20], // 小指
  [0, 17], // 掌根闭合
];

export type Handedness = 'left' | 'right' | 'unknown';

export interface FrameSize {
  width: number;
  height: number;
}

/**
 * 可作为追踪输入的帧来源。
 *
 * 刻意不用 `CanvasImageSource`（含 SVGImageElement，drawImage 支持但模型不支持）
 * 也不用 `TexImageSource`（含 ImageData，能喂模型但 drawImage 不收）。
 * 这里取两者的交集，实现内部才能既 drawImage 又喂模型而不需要类型断言。
 */
export type HandTrackingFrame =
  | HTMLVideoElement
  | HTMLCanvasElement
  | HTMLImageElement
  | ImageBitmap
  | OffscreenCanvas
  | VideoFrame;

/**
 * 追踪模型直接输出的关键点：**整帧归一化坐标**
 * （[0,1]² 覆盖完整摄像头帧，左上原点，未镜像）。
 *
 * z 是模型给出的相对深度（以手腕为基准、与手大小同尺度）。
 * 目前不参与任何判定（单目深度太噪，handy 也明确忽略它），
 * 但保留在契约里，将来做"手靠近摄像头"这类手势时不用改结构。
 */
export interface NormalizedLandmark {
  position: Vec2;
  z: number;
  /** 0..1，越大越可信 */
  visibility: number;
}

/** 追踪模型直接输出的一只手。 */
export interface RawHand {
  landmarks: readonly NormalizedLandmark[];
  handedness: Handedness;
  /** 0..1 识别置信度 */
  confidence: number;
}

/** 换算到**场景坐标**后的关键点（见 coords/viewport.ts 对场景坐标的定义）。 */
export interface SceneLandmark {
  position: Vec2;
  z: number;
  visibility: number;
}

/** 换算到场景坐标后的一只手。GestureManager 只消费这个类型。 */
export interface SceneHand {
  landmarks: readonly SceneLandmark[];
  handedness: Handedness;
  confidence: number;
}

/**
 * 手部追踪接口。
 *
 * `MediaPipeHandTracker` 是它的浏览器实现；换识别方案时只需要新写一个实现。
 *
 * 约定：`detect()` 返回模型原始的整帧归一化坐标，坐标换算由 `toSceneHands()`
 * 统一完成 —— 所以镜像 / cover 裁切 / 成片画幅的逻辑全项目只存在一份，
 * 也保证这个函数可以单测。
 */
export interface HandTrackingInterface {
  readonly name: string;
  /** 初始化模型（下载 / 编译 wasm 等） */
  init(): Promise<void>;
  /**
   * 检测一帧。
   * @param source 画面来源（`TexImageSource`：video / canvas / ImageBitmap / OffscreenCanvas）
   * @param frame  source 的实际像素尺寸，实现内部据此决定是否降采样
   * @param timestampMs 单调递增的时间戳（VIDEO 模式要求严格递增）
   */
  detect(source: HandTrackingFrame, frame: FrameSize, timestampMs: number): readonly RawHand[];
  close(): void;
}

/** 整帧归一化坐标 -> 场景坐标。只做 cover 裁切与镜像换算（见 Viewport）。 */
export function toSceneHand(hand: RawHand, viewport: Viewport): SceneHand {
  return {
    landmarks: hand.landmarks.map((landmark) => ({
      position: viewport.sourceNormalizedToScene(landmark.position),
      z: landmark.z,
      visibility: landmark.visibility,
    })),
    handedness: hand.handedness,
    confidence: hand.confidence,
  };
}

export function toSceneHands(hands: readonly RawHand[], viewport: Viewport): SceneHand[] {
  return hands.map((hand) => toSceneHand(hand, viewport));
}

/**
 * 保槽位的换算：`undefined` 原样保留。
 *
 * 双手需要"slot 0 永远是同一只手"，所以中间不能把缺席的手挤掉
 * （挤掉会让右手滑进左手那个槽，滤波器状态串台）。
 */
export function toSceneHandSlots(
  hands: readonly (RawHand | undefined)[],
  viewport: Viewport,
): (SceneHand | undefined)[] {
  return hands.map((hand) => (hand ? toSceneHand(hand, viewport) : undefined));
}

/** 取第 index 个关键点；缺失时返回 undefined（不抛错，调用方决定降级策略）。 */
export function landmarkAt(hand: SceneHand, index: number): SceneLandmark | undefined {
  return hand.landmarks[index];
}

/** 兼容旧命名：整帧归一化坐标的类型别名。 */
export type RawLandmark = NormalizedLandmark;
