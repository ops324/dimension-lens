/**
 * 点群のうち、**WebGL 無しで落とせる部分**。
 *
 * three のジオメトリ・マテリアル・属性は node で構築できる（GL コンテキストが要るのは
 * 描画のときだけ）。だから「1 画素も描かれないのに GL エラーも出ない」という
 * 最悪の壊れ方は、**描く前に**ここで捕まえられる。
 */

import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { ColorPointBatch } from '../render/colorPointBatch';
import { F, K_SPRITE, gainFor } from '../image/spriteGain';

describe('ColorPointBatch', () => {
  /**
   * ## この 1 本がこのファイルの存在理由
   *
   * `InstancedBufferGeometry` の既定は `instanceCount = Infinity`。
   * per-instance 属性が無いと three は `maxInstanceCount` を決められず、
   * `gl.drawArraysInstanced(POINTS, 0, n, Infinity)` が発行される。
   * WebIDL の `GLsizei` 変換で `Infinity` は **0** になるので:
   *
   *   - 点が 1 つも描かれない
   *   - `gl.getError()` は 0（NO_ERROR）
   *   - `renderer.info.render.calls` は 1（ドローコールは出ている）
   *   - シェーダのコンパイルも成功する
   *
   * デバッグの取っ掛かりが 1 つも無い。**`=== 1` で見る**（`!== Infinity` だと
   * 2 や 0 のような誤った有限値を通してしまう）。
   */
  it('instanceCount が厳密に 1（既定の Infinity なら 1 画素も描かれない）', () => {
    const b = new ColorPointBatch(16);
    expect(b.geometry.instanceCount).toBe(1);
    expect(b.geometry.instanceCount).not.toBe(Infinity);
    expect(b.geometry).toBeInstanceOf(THREE.InstancedBufferGeometry);
    b.dispose();
  });

  it('バッファは 5 ではなく 3 f32/点（投影後の R³）と 3 f32/点の色', () => {
    const b = new ColorPointBatch(100);
    expect(b.positions.length).toBe(300);
    expect(b.colors.length).toBe(300);
    expect(b.geometry.getAttribute('position').itemSize).toBe(3);
    expect(b.geometry.getAttribute('aColor').itemSize).toBe(3);
    b.dispose();
  });

  it('commit が drawRange を設定し、上限と 0 でクランプする', () => {
    const b = new ColorPointBatch(10);
    expect(b.geometry.drawRange.count).toBe(0);
    b.commit(7);
    expect(b.geometry.drawRange.count).toBe(7);
    b.commit(999);
    expect(b.geometry.drawRange.count).toBe(10);
    b.commit(-1);
    expect(b.geometry.drawRange.count).toBe(0);
    b.dispose();
  });

  /**
   * ゲインは `spriteGain.ts` の較正をそのまま使う。ここで別の式を書くと、
   * 「平坦場が本来の値で出る」という主張の根拠が 2 か所に分かれる。
   */
  it('configure が spriteGain の較正をそのまま反映する', () => {
    const b = new ColorPointBatch(16);
    const cellWorld = 0.008;
    const pxPerWorld = 800;
    const distance = 2.5;
    const r = b.configure({ cellWorld, pxPerWorld, distance, maxPointSize: 511 });

    const s0 = (cellWorld * pxPerWorld) / distance;
    expect(r.s0).toBeCloseTo(s0, 12);
    expect(r.spritePx).toBeCloseTo(K_SPRITE * s0, 12);
    expect(r.gain).toBeCloseTo(gainFor(s0), 12);

    const u = b.material.uniforms;
    expect(u.uSpriteWorld.value).toBeCloseTo(cellWorld * K_SPRITE, 12);
    expect(u.uPxPerWorld.value).toBe(pxPerWorld);
    expect(u.uGain.value).toBeCloseTo(gainFor(s0), 12);
    expect(u.uF.value).toBe(F);
    b.dispose();
  });

  it('GL の gl_PointSize 上限でクランプする', () => {
    const b = new ColorPointBatch(4);
    b.configure({ cellWorld: 1, pxPerWorld: 1e6, distance: 1, maxPointSize: 64 });
    expect(b.material.uniforms.uMaxSize.value).toBe(64);
    b.dispose();
  });

  /**
   * 重みを `uGain` へ掛けてはいけない ── `configure()` が `uGain` を上書きするので、
   * 「リサイズしたら点群が復活する」という時々しか出ない壊れ方をする。
   */
  it('重みは uGain とは別の uniform（configure に上書きされない）', () => {
    const b = new ColorPointBatch(4);
    b.configure({ cellWorld: 0.01, pxPerWorld: 500, distance: 2, maxPointSize: 511 });
    b.setWeight(0);
    expect(b.material.uniforms.uWeight.value).toBe(0);
    expect(b.object.visible).toBe(false);

    // リサイズ相当（configure の再実行）でも重みは 0 のまま
    b.configure({ cellWorld: 0.02, pxPerWorld: 900, distance: 2, maxPointSize: 511 });
    expect(b.material.uniforms.uWeight.value).toBe(0);

    b.setWeight(1);
    expect(b.object.visible).toBe(true);
    b.setWeight(2);
    expect(b.material.uniforms.uWeight.value).toBe(1);
    b.dispose();
  });

  it('加算合成・深度書き込み無し・トーンマップ無し', () => {
    const b = new ColorPointBatch(4);
    expect(b.material.blending).toBe(THREE.AdditiveBlending);
    expect(b.material.depthWrite).toBe(false);
    // 板と同一平面（dimLevel=2 で z が厳密に 0）。1 ULP の差に結果を依存させない
    expect(b.material.depthTest).toBe(false);
    expect(b.material.toneMapped).toBe(false);
    b.dispose();
  });

  /**
   * `discard` の閾値と減衰は `spriteGain.ts` の較正が前提にしている形そのもの。
   * シェーダ側だけ書き換わると、ゲインの表が黙って別の関数の較正になる。
   */
  it('シェーダが w(r)=exp(−F·r²) と r²>0.25 の discard を持つ', () => {
    const b = new ColorPointBatch(4);
    expect(b.material.fragmentShader).toContain('if (r2 > 0.25) discard;');
    expect(b.material.fragmentShader).toContain('exp(-uF * r2)');
    // 色は**リニア光**のまま出す（sRGB エンコードは鎖の最後で 1 回だけ）
    expect(b.material.fragmentShader).toContain('uGain * uWeight * w');
    b.dispose();
  });
});
