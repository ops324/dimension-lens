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
//     （復帰は Phase 3。空状態 UI は Phase 1c で `src/ui/emptyState.ts` に入れた）
//   - **Phase 1c**: `viewportWidth/Height` を static から**インスタンスメソッド**へ移し、
//     `forcedSize` で上書きできるようにした。`resize(cssW, cssH)` と
//     `drawingBufferSize()` を追加 ── どちらも**測定器のため**である。
//     ブラウザペインの `resize_window` はページの `resize` を発火しないので、
//     canvas が古い寸法のまま「自己整合した嘘の値」を返す（1b で踏んだ）。
//     ペイン既定（buffer 1778×1718）では s0 が 4.045 になり、§7.7 のアンカー
//     2.2478 と一致しない ── アンカーの再実行には寸法の固定が要る

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

    const width = this.viewportWidth();
    const height = this.viewportHeight();
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
    const h = this.viewportHeight();
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

    const width = this.viewportWidth();
    const height = this.viewportHeight();
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
    const width = this.viewportWidth();
    const height = this.viewportHeight();
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

  /**
   * 測定用に固定した CSS 寸法。`null` なら window から取る。
   *
   * **測定器のためだけにある。** ブラウザペインの `resize_window` はページの
   * `resize` イベントを発火せず、canvas が古い寸法のまま「自己整合した嘘の値」を
   * 返す（1b で踏んだ）。`dispatchEvent(new Event('resize'))` で回避できるが、
   * それは**測定手順が測定器の外にある**ということで、手順書どおりにやっても
   * 値が一致しない事故（Phase 1c 実測: ペイン既定だと s0 が 4.045 になり、
   * §7.7 のアンカー 2.2478 と一致しない）を防げない。
   */
  private forcedSize: { width: number; height: number } | null = null;

  private viewportWidth(): number {
    if (this.forcedSize) return this.forcedSize.width;
    return Math.max(1, Math.floor(window.innerWidth));
  }

  private viewportHeight(): number {
    if (this.forcedSize) return this.forcedSize.height;
    return Math.max(1, Math.floor(window.visualViewport?.height ?? window.innerHeight));
  }

  /**
   * 描画バッファの寸法を明示的に確定させる（Phase 1c・**測定用**）。
   *
   * デバウンスを通さず**同期に**適用する ── `RESIZE_DEBOUNCE_MS` を待つあいだに
   * 測定を始めると、また古い寸法を読むことになる。
   */
  /** 実際の描画バッファ寸法。**要求値ではなく、いま GL が持っている値** */
  drawingBufferSize(): { width: number; height: number } {
    this.renderer.getDrawingBufferSize(this.bufferSize);
    return { width: this.bufferSize.x, height: this.bufferSize.y };
  }

  resize(cssWidth: number, cssHeight: number): void {
    this.forcedSize = {
      width: Math.max(1, Math.floor(cssWidth)),
      height: Math.max(1, Math.floor(cssHeight)),
    };
    if (this.resizeTimer !== 0) {
      window.clearTimeout(this.resizeTimer);
      this.resizeTimer = 0;
    }
    this.applyResize();
  }

  private pixelRatio(): number {
    return Math.min(window.devicePixelRatio || 1, this.dprCap);
  }
}
