// VENDORED_FROM: ops324/dimension@8cd37d8ffe74017acd18c1907195e36a20d9ec19 src/core/engine.ts
// STATUS: MODIFIED
//
// 変更点:
//   - `toneMapping` を ACESFilmic → **NoToneMapping**（SPEC §4.5。錨を守るため）
//   - **`portraitDolly` を移植しない**。カメラ距離の式は `src/core/fit.ts` が唯一の源で、
//     二重に持つと SPEC §5 の単一情報源の規律が壊れる
//   - `setSafeArea` は残すが、構図は `fitDistance(bandFrac)` が決める
//   - `renderOnce(steps)` を追加（rAF が絞られる環境でフレームを進める。SPEC §7.2）
//   - `pxPerWorld()` を追加（スプライト寸法の唯一の換算元）
//   - starfield / lineMaterial / afterRender / gallery 由来の口を削除
//   - コンテキストロストは `data-lens-gl="lost"` を立てて**黙って死なない**ところまで
//     （復帰と空状態 UI は Phase 1c）

import * as THREE from 'three';
import { buildPostFX, type PostFX } from '../render/postfx';
import { Capture } from './capture';

export type FrameCallback = (dt: number, t: number) => void;
export type ResizeCallback = (width: number, height: number, pixelRatio: number) => void;

const BOOT_DPR_CAP = 2;
const BOOT_SAMPLES = 4;
const RESIZE_DEBOUNCE_MS = 150;
const MAX_DELTA = 1 / 20;

/**
 * 垂直画角。**`fitDistance` に渡すのと同じ値でなければならない** ──
 * ここと `fit.ts` の呼び出し側がずれると、図が帯からはみ出す形で静かに壊れる。
 */
export const CAMERA_FOV = 50;
const CAMERA_NEAR = 0.01;
/** 透視カスケードの `safeDist` は最大でも 2.2·maxNorm 程度。余裕を見て 200 */
const CAMERA_FAR = 200;

/**
 * GL のクリアカラーは**黒でなければならない**（親から継ぐ。LENS で実測して再確認した）。
 *
 * `RenderPass` は `renderer.clear()` を直接呼び、これは GL に最後にプログラムされた
 * クリアカラーを使う。そのクリアカラーを設定する `WebGLBackground` は
 * `getUnlitUniformColorSpace()` で変換先を決める ── レンダーターゲットへ描く時は
 * working(linear)、**画面へ描く時は outputColorSpace(sRGB)**。鎖の最後のパスは画面へ
 * 描くので sRGB 値が GL に残り、次フレームの RenderPass がその sRGB 値を
 * そのままリニアの HDR バッファへクリアしてしまう。
 *
 * 親は ACES 込みで `#05060f` が `rgb(22,27,58)` として届いていた。
 * **LENS はトーンマップを切っているので漏れがそのまま出る**（実測 `rgb(38,42,69)`、
 * グレー軸で ΔE00 8.50 ── 忠実性の予算 2.0 を単独で 4 倍超過する）。
 *
 * 黒は色空間変換の不動点なのでこのリークの影響を受けない。背景に色を付けたくなったら、
 * **シーンの中でリニア値として加算する**こと（親の nebula と同じ手）。
 */
const CLEAR_COLOR = 0x000000;

export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly camera: THREE.PerspectiveCamera;
  readonly postfx: PostFX;
  readonly capture: Capture;

  private readonly frameCallbacks: FrameCallback[] = [];
  private readonly resizeCallbacks: ResizeCallback[] = [];
  private readonly bufferSize = new THREE.Vector2();

  private scene: THREE.Scene;
  private rafId = 0;
  private resizeTimer = 0;
  private prevTime = 0;
  private elapsed = 0;
  private running = false;
  private contextLost = false;
  private dprCap = BOOT_DPR_CAP;
  private safeTop = 0;
  private safeBottom = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false, // AA は composer 側の MSAA レンダーターゲットが担当
      powerPreference: 'high-performance',
    });
    /**
     * **トーンマップを入れない**（SPEC §4.5、実測）。
     * `NeutralToneMapping` はブラックポイント減算が早期 return の前にあるので恒等ではなく、
     * sRGB 128 → 116 / 63 → 33 になる。忠実性テストは読み戻して元 RGB と比べる設計なので、
     * トーンマップを入れると**正しく実装しても必ず落ちる**。
     * 1.0 を超える加算の圧縮は `CompressPass`（リニア空間・OutputPass の前）が担う。
     */
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.setClearColor(CLEAR_COLOR, 1);

    const width = Engine.viewportWidth();
    const height = Engine.viewportHeight();
    const pixelRatio = this.pixelRatio();

    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(width, height, false);

    this.camera = new THREE.PerspectiveCamera(
      CAMERA_FOV,
      width / height,
      CAMERA_NEAR,
      CAMERA_FAR,
    );
    this.camera.position.set(0, 0, 3);

    this.scene = new THREE.Scene();

    this.renderer.getDrawingBufferSize(this.bufferSize);
    this.capture = new Capture(this.bufferSize.x, this.bufferSize.y);

    this.postfx = buildPostFX(this.renderer, this.scene, this.camera, {
      samples: Math.min(BOOT_SAMPLES, this.renderer.capabilities.maxSamples),
      capturePass: this.capture.pass,
    });

    canvas.addEventListener('webglcontextlost', this.handleContextLost, false);
    window.addEventListener('resize', this.requestResize);
    window.addEventListener('orientationchange', this.requestResize);
    window.visualViewport?.addEventListener('resize', this.requestResize);
  }

  get currentScene(): THREE.Scene {
    return this.scene;
  }

  get time(): number {
    return this.elapsed;
  }

  get isContextLost(): boolean {
    return this.contextLost;
  }

  /**
   * 深度 1 でのワールド→device px 倍率。**スプライト寸法の唯一の換算元。**
   *
   * `gl_PointSize` は device px なので drawingBuffer の高さで割り出す。
   * ここを CSS px で計算すると DPR 2 の端末でスプライトが半分の大きさになり、
   * 平坦場の被覆数が変わって `gainFor` の較正が外れる。
   */
  pxPerWorld(): number {
    this.renderer.getDrawingBufferSize(this.bufferSize);
    return this.bufferSize.y / (2 * Math.tan((CAMERA_FOV * Math.PI) / 360));
  }

  /** GL が許す `gl_PointSize` の上限（環境で 64〜1024 と幅がある） */
  maxPointSize(): number {
    const gl = this.renderer.getContext();
    const range = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE) as Float32Array | null;
    return range && range.length >= 2 ? range[1] : 64;
  }

  setScene(scene: THREE.Scene): void {
    this.scene = scene;
    this.postfx.renderPass.scene = scene;
  }

  setQuality(quality: { samples: number; dpr: number }): void {
    this.dprCap = Math.max(1, quality.dpr);
    this.postfx.setSamples(Math.min(quality.samples, this.renderer.capabilities.maxSamples));
    this.applyResize();
  }

  setSafeArea(topPx: number, bottomPx: number): void {
    const top = topPx > 0 ? topPx : 0;
    const bottom = bottomPx > 0 ? bottomPx : 0;
    if (top === this.safeTop && bottom === this.safeBottom) return;
    this.safeTop = top;
    this.safeBottom = bottom;
    this.applySafeArea();
  }

  /** 非遮蔽帯の高さ比。`fitDistance({ bandFrac })` に渡す値と同じ源から出す */
  bandFrac(): number {
    const h = Engine.viewportHeight();
    const free = h - this.safeTop - this.safeBottom;
    return free > 0 ? free / h : 1;
  }

  onFrame(cb: FrameCallback): void {
    this.frameCallbacks.push(cb);
  }

  onResize(cb: ResizeCallback): void {
    this.resizeCallbacks.push(cb);
  }

  start(): void {
    if (this.running || this.contextLost) return;
    this.running = true;
    this.prevTime = performance.now();
    this.rafId = requestAnimationFrame(this.tick);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  /**
   * rAF に依らずフレームを進める。**測定はこれで駆動する。**
   *
   * ブラウザペインが非表示だと rAF は 1 回も発火しない（実測: 1.5 秒待って 0 回）。
   * `renderOnce` が無いと「フレームが進まないまま読み戻して黒を得る」という、
   * 壊れていても緑になる形の測定になる。
   *
   * `dt` は実時間ではなく固定刻みにする ── 測定を再現可能にするため。
   */
  renderOnce(steps = 1, dt = 1 / 60): void {
    if (this.contextLost) return;
    const n = steps > 0 ? Math.min(steps | 0, 600) : 1;
    for (let s = 0; s < n; s++) {
      this.elapsed += dt;
      for (let i = 0; i < this.frameCallbacks.length; i++) {
        this.frameCallbacks[i](dt, this.elapsed);
      }
      this.postfx.setTime(this.elapsed);
      this.postfx.composer.render();
    }
  }

  /** capture パスを立てて 1 フレーム描き、読み戻せる状態にする */
  renderForCapture(steps = 1): void {
    this.capture.setSize(this.renderer.getDrawingBufferSize(this.bufferSize).x, this.bufferSize.y);
    if (steps > 1) this.renderOnce(steps - 1);
    this.capture.frameInto(() => this.renderOnce(1));
  }

  private readonly tick = (now: number): void => {
    this.rafId = requestAnimationFrame(this.tick);
    const dt = Math.min((now - this.prevTime) / 1000, MAX_DELTA);
    this.prevTime = now;
    this.elapsed += dt;

    for (let i = 0; i < this.frameCallbacks.length; i++) {
      this.frameCallbacks[i](dt, this.elapsed);
    }
    this.postfx.setTime(this.elapsed);
    this.postfx.composer.render();
  };

  private readonly requestResize = (): void => {
    if (this.resizeTimer !== 0) window.clearTimeout(this.resizeTimer);
    this.resizeTimer = window.setTimeout(this.applyResize, RESIZE_DEBOUNCE_MS);
  };

  private readonly applyResize = (): void => {
    this.resizeTimer = 0;
    if (this.contextLost) return;

    const width = Engine.viewportWidth();
    const height = Engine.viewportHeight();
    const pixelRatio = this.pixelRatio();

    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(width, height, false);

    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.applySafeArea();

    this.postfx.setSize(width, height, pixelRatio);
    this.renderer.getDrawingBufferSize(this.bufferSize);
    this.capture.setSize(this.bufferSize.x, this.bufferSize.y);

    for (let i = 0; i < this.resizeCallbacks.length; i++) {
      this.resizeCallbacks[i](width, height, pixelRatio);
    }
  };

  private readonly applySafeArea = (): void => {
    const camera = this.camera;
    if (this.safeTop === 0 && this.safeBottom === 0) {
      camera.clearViewOffset();
      return;
    }
    const width = Engine.viewportWidth();
    const height = Engine.viewportHeight();
    const offsetY = (this.safeBottom - this.safeTop) / 2;
    camera.setViewOffset(width, height, 0, offsetY, width, height);
  };

  private readonly handleContextLost = (event: Event): void => {
    event.preventDefault();
    this.contextLost = true;
    this.stop();
    // 黙って死なないことだけが 1a-iii の責務。復帰と空状態 UI は Phase 1c
    document.documentElement.dataset.lensGl = 'lost';
    console.error('[LENS] WebGL コンテキストを失いました。ページを再読み込みしてください。');
  };

  private static viewportWidth(): number {
    return Math.max(1, Math.floor(window.innerWidth));
  }

  private static viewportHeight(): number {
    return Math.max(1, Math.floor(window.visualViewport?.height ?? window.innerHeight));
  }

  private pixelRatio(): number {
    return Math.min(window.devicePixelRatio || 1, this.dprCap);
  }
}
