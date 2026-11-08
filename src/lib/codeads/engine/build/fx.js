// Build-genre FX (docs/BUILD.md): every gag gets a physical effect. Analytic particles — each particle's position is a
// pure function of its age (ballistic + drag), so a frame renders the same on its own (stills) as inside a full render.
//   const fx = makeFX(scene);
//   fx.burst('dirt', t0, { pos: [x,y,z], n: 40, dir: [0,1,0], spread: 0.6, speed: [2,5], floor: -3 });
//   fx.stream('stink', t0, t1, { pos, box: [2,1,1], rate: 12 });
//   fx.update(t, camera)   // once per frame
import * as THREE from 'three';
import { rng, clamp } from '../core.js';
import { softTex } from './anim.js';

const KINDS = {
  dirt:     { geo: 'chunk', max: 900, colors: [0x6b4426, 0x7d5230, 0x5a3a20, 0x8f6a45, 0x4f3420], size: [0.05, 0.15], life: [1.0, 1.8], g: 9.8, drag: 0.3, spin: 9 },
  rock:     { geo: 'chunk', max: 200, colors: [0x8a8a86, 0x6f6f6c, 0xa3a29c], size: [0.06, 0.16], life: [1.0, 1.6], g: 9.8, drag: 0.2, spin: 7 },
  crumb:    { geo: 'chunk', max: 200, colors: [0xd9a04e, 0xc78a3a, 0xe8b868], size: [0.03, 0.07], life: [0.9, 1.5], g: 9.8, drag: 0.4, spin: 10 },
  drops:    { geo: 'drop', max: 900, colors: [0x5ec3ef, 0x8fd8f7, 0x3fa9dd], size: [0.025, 0.06], life: [0.5, 1.1], g: 9.8, drag: 0.4 },
  rain:     { geo: 'drop', max: 1400, colors: [0xcfe9ff, 0xb4dcf7, 0xe6f4ff], size: [0.012, 0.02], life: [0.6, 0.9], g: 14, drag: 0.1, stretch: 9 },   // 025: thin streaks (a drop stretched along y)
  bill:     { geo: 'flake', max: 500, colors: [0xffffff], size: [0.26, 0.34], life: [3.5, 4.5], g: 1.6, drag: 2.0, spin: 7, map: 'bill' },   // printed banknotes (money rain)
  confetti: { geo: 'flake', max: 700, colors: [0xff4d5e, 0xffd23f, 0x3ec7ff, 0x58d36b, 0xb36bff, 0xff8a3d], size: [0.05, 0.09], life: [2.2, 3.4], g: 2.2, drag: 2.2, spin: 13 },
  dust:     { geo: 'sprite', max: 260, colors: [0xc9a57c, 0xb8946a], size: [0.5, 1.2], grow: 2.4, life: [0.9, 1.7], g: -0.25, drag: 2.6, alpha: 0.7 },
  smoke:    { geo: 'sprite', max: 160, colors: [0x6d6d6d, 0x8a8a8a], size: [0.3, 0.6], grow: 2.0, life: [1.0, 1.8], g: -1.2, drag: 1.8, alpha: 0.65 },
  stink:    { geo: 'sprite', max: 220, colors: [0x9fcf4a, 0x86b83c, 0xb8d65a], size: [0.5, 1.0], grow: 1.6, life: [2.4, 3.6], g: -0.08, drag: 1.2, alpha: 0.42 },
  mist:     { geo: 'sprite', max: 200, colors: [0xd8f0ff, 0xbfe6fb], size: [0.3, 0.7], grow: 1.8, life: [0.6, 1.2], g: 2.0, drag: 2.0, alpha: 0.55 },
  spark:    { geo: 'sprite', max: 260, colors: [0xfff1a8, 0xffd23f, 0x9fe8ff], size: [0.05, 0.13], grow: 0.2, life: [0.14, 0.38], g: 5.0, drag: 1.0, alpha: 1, additive: true },
  glow:     { geo: 'sprite', max: 60, colors: [0xffffff], size: [0.6, 1.0], grow: 0.4, life: [0.2, 0.35], g: 0, drag: 0, alpha: 0.9, additive: true },
};

function alphaPatch(m) { // per-instance alpha for instanced sprites
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = 'attribute float aAlpha;\nvarying float vAlpha;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvAlpha = aAlpha;');
    sh.fragmentShader = 'varying float vAlpha;\n' + sh.fragmentShader.replace('#include <dithering_fragment>', '#include <dithering_fragment>\ngl_FragColor.a *= vAlpha;');
  };
}

function billTex() { // a cartoon banknote: green, pale border, a big $
  const c = document.createElement('canvas'); c.width = 128; c.height = 70; const g = c.getContext('2d');
  g.fillStyle = '#e9f5df'; g.fillRect(0, 0, 128, 70); g.fillStyle = '#5fae4c'; g.fillRect(6, 6, 116, 58); g.strokeStyle = '#d7efc8'; g.lineWidth = 3; g.strokeRect(12, 12, 104, 46);
  g.fillStyle = '#e9f5df'; g.beginPath(); g.arc(64, 35, 17, 0, 7); g.fill(); g.fillStyle = '#3c7f30'; g.font = 'bold 28px Arial'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('$', 64, 37);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

export function makeFX(parent) {
  const pools = {}, parts = [];
  let seedN = 1;
  const tex = softTex('255,255,255', 128);
  function pool(kind) {
    if (pools[kind]) return pools[kind];
    const K = KINDS[kind]; let geo, m;
    if (K.geo === 'chunk') { geo = new THREE.IcosahedronGeometry(1, 0); m = new THREE.MeshStandardMaterial({ roughness: 0.95, flatShading: true }); }
    else if (K.geo === 'drop') { geo = new THREE.SphereGeometry(1, 8, 6); m = new THREE.MeshStandardMaterial({ roughness: 0.08, transparent: true, opacity: 0.88 }); }
    else if (K.geo === 'flake') { geo = new THREE.PlaneGeometry(1, 0.55); m = new THREE.MeshStandardMaterial({ roughness: 0.6, side: THREE.DoubleSide, map: K.map === 'bill' ? billTex() : null }); }
    else {
      geo = new THREE.PlaneGeometry(1, 1); geo.setAttribute('aAlpha', new THREE.InstancedBufferAttribute(new Float32Array(K.max), 1));
      m = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, blending: K.additive ? THREE.AdditiveBlending : THREE.NormalBlending, toneMapped: !K.additive });
      alphaPatch(m);
    }
    const mesh = new THREE.InstancedMesh(geo, m, K.max);
    mesh.frustumCulled = false; mesh.castShadow = K.geo === 'chunk'; mesh.receiveShadow = false; mesh.count = 0;
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(K.max * 3), 3);
    if (K.geo === 'sprite') mesh.renderOrder = 5;
    parent.add(mesh);
    return (pools[kind] = { K, mesh, live: 0 });
  }
  const pick = (R, a) => a[Math.floor(R() * a.length) % a.length];
  const range = (R, r) => (Array.isArray(r) ? r[0] + R() * (r[1] - r[0]) : r);
  function spawn(kind, tb, o, R) {
    const P = pool(kind), K = P.K;
    const dir = new THREE.Vector3(...(o.dir || [0, 1, 0])).normalize();
    // random direction inside a cone of half-angle `spread` around dir
    const sp = o.spread ?? 0.5, th = R() * Math.PI * 2, ph = Math.acos(1 - R() * (1 - Math.cos(sp)));
    const a = Math.abs(dir.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    const u = new THREE.Vector3().crossVectors(dir, a).normalize(), w = new THREE.Vector3().crossVectors(dir, u);
    const d = dir.clone().multiplyScalar(Math.cos(ph)).addScaledVector(u, Math.sin(ph) * Math.cos(th)).addScaledVector(w, Math.sin(ph) * Math.sin(th));
    const box = o.box || [0, 0, 0];
    const p0 = new THREE.Vector3(...o.pos).add(new THREE.Vector3((R() - 0.5) * box[0], (R() - 0.5) * box[1], (R() - 0.5) * box[2]));
    const col = new THREE.Color(o.color ?? pick(R, K.colors));
    if (o.tint) col.lerp(new THREE.Color(o.tint), 0.5);
    parts.push({ kind, tb, p0, v0: d.multiplyScalar(range(R, o.speed ?? [1, 3])), life: range(R, o.life ?? K.life), size: range(R, o.size ?? K.size),
      g: o.g ?? K.g, drag: o.drag ?? K.drag, floor: o.floor ?? -1e9, spin: (R() - 0.5) * 2 * (K.spin || 0), axis: new THREE.Vector3(R() - 0.5, R() - 0.5, R() - 0.5).normalize(),
      col, alpha: o.alpha ?? K.alpha ?? 1, grow: o.grow ?? K.grow ?? 0, ph: R() * 6.28 });
  }
  const api = {
    burst(kind, t0, o) { const R = rng((o.seed ?? seedN++) * 7919 + 13); for (let i = 0; i < (o.n ?? 20); i++) spawn(kind, t0 + (o.jitter ? R() * o.jitter : 0), o, R); },
    stream(kind, t0, t1, o) { const R = rng((o.seed ?? seedN++) * 104729 + 7); const n = Math.round((t1 - t0) * (o.rate ?? 10)); for (let i = 0; i < n; i++) spawn(kind, t0 + (i + R()) * (t1 - t0) / n, o, R); },
    update(t, camera) {
      for (const k in pools) pools[k].live = 0;
      const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
      for (const P of parts) {
        const a = t - P.tb; if (a < 0 || a > P.life) continue;
        const Pl = pools[P.kind]; if (Pl.live >= Pl.K.max) continue;
        const k = Math.max(P.drag, 1e-4), e = (1 - Math.exp(-k * a)) / k;
        p.copy(P.p0).addScaledVector(P.v0, e);
        p.y -= (P.g / k) * (a - e);
        if (p.y < P.floor) p.y = P.floor;
        const fade = clamp((P.life - a) / (P.life * 0.25));
        if (Pl.K.geo === 'sprite') {
          q.copy(camera.quaternion);
          const sz = P.size * (1 + P.grow * a / P.life);
          s.set(sz, sz, sz);
          // never let a puff fill the lens: sprites fade out as they get within ~2.5 m of the camera
          const near = clamp((p.distanceTo(camera.position) - sz * 0.6 - 0.4) / 2.0);
          Pl.mesh.geometry.attributes.aAlpha.array[Pl.live] = P.alpha * fade * clamp(a / 0.08) * near;
        } else if (Pl.K.geo === 'flake') {
          p.x += Math.sin(a * 5 + P.ph) * 0.12 * clamp(a); p.z += Math.cos(a * 4 + P.ph) * 0.08 * clamp(a);
          q.setFromAxisAngle(P.axis, P.spin * a + P.ph); s.setScalar(P.size * Math.min(1, fade * 3));
        } else {
          q.setFromAxisAngle(P.axis, p.y <= P.floor + 1e-3 ? P.spin * 0.3 : P.spin * a); s.setScalar(P.size * Math.min(1, fade * 2.5));
          if (Pl.K.geo === 'drop') s.y *= Pl.K.stretch ?? 1.35;
        }
        m4.compose(p, q, s); Pl.mesh.setMatrixAt(Pl.live, m4); Pl.mesh.setColorAt(Pl.live, P.col);
        Pl.live++;
      }
      for (const k in pools) {
        const Pl = pools[k]; Pl.mesh.count = Pl.live;
        Pl.mesh.instanceMatrix.needsUpdate = true; if (Pl.mesh.instanceColor) Pl.mesh.instanceColor.needsUpdate = true;
        if (Pl.K.geo === 'sprite') Pl.mesh.geometry.attributes.aAlpha.needsUpdate = true;
      }
    },
  };
  return api;
}

/** Chevrons that flow along a polyline (air flow, force paths, "this way" arrows). update(t, alpha). */
export function makeArrows(parent, path, { color = 0xffffff, count = 8, size = 0.35, speed = 1.6, emissive = 0.6 } = {}) {
  const shape = new THREE.Shape();
  shape.moveTo(-0.5, 0.45); shape.lineTo(0, 0); shape.lineTo(-0.5, -0.45); shape.lineTo(-0.25, -0.45); shape.lineTo(0.25, 0); shape.lineTo(-0.25, 0.45); shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.12, bevelEnabled: false }); geo.translate(0, 0, -0.06);
  const m = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: emissive, roughness: 0.5, transparent: true });
  const pts = path.map((p) => new THREE.Vector3(...p)), seg = [], L = [0];
  for (let i = 0; i < pts.length - 1; i++) { seg.push(pts[i + 1].clone().sub(pts[i])); L.push(L[i] + seg[i].length()); }
  const total = L[L.length - 1];
  const arrows = Array.from({ length: count }, () => { const a = new THREE.Mesh(geo, m); a.scale.setScalar(size); parent.add(a); return a; });
  return {
    update(t, alpha = 1) {
      m.opacity = alpha;
      arrows.forEach((a, i) => {
        a.visible = alpha > 0.01;
        if (!a.visible) return;
        const d = (((t * speed + (i * total) / count) % total) + total) % total;
        let j = 0; while (j < seg.length - 1 && d > L[j + 1]) j++;
        const f = (d - L[j]) / (L[j + 1] - L[j]);
        a.position.copy(pts[j]).addScaledVector(seg[j], f);
        a.rotation.set(0, 0, Math.atan2(seg[j].y, seg[j].x));
        const edge = clamp(Math.min(d, total - d) / 0.4);
        a.scale.setScalar(size * edge);
      });
    },
  };
}

/** Cartoon dizzy stars circling a point. update(t, on, [x,y,z]). */
export function makeDizzy(parent, { r = 0.32, n = 4, size = 0.09, color = 0xffd23f } = {}) {
  const s = new THREE.Shape();
  for (let i = 0; i < 10; i++) { const a = (i / 10) * Math.PI * 2 + Math.PI / 2, rr = i % 2 ? 0.45 : 1; const x = Math.cos(a) * rr, y = Math.sin(a) * rr; i ? s.lineTo(x, y) : s.moveTo(x, y); }
  const geo = new THREE.ExtrudeGeometry(s, { depth: 0.25, bevelEnabled: false }); geo.center();
  const m = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.5, roughness: 0.4 });
  const g = new THREE.Group(); parent.add(g);
  const stars = Array.from({ length: n }, () => { const st = new THREE.Mesh(geo, m); st.scale.setScalar(size); g.add(st); return st; });
  return {
    g,
    update(t, on, pos) {
      g.visible = on > 0.01; if (!g.visible) return;
      g.position.set(...pos);
      stars.forEach((st, i) => { const a = t * 5 + (i / n) * Math.PI * 2; st.position.set(Math.cos(a) * r, 0.04 * Math.sin(a * 2), Math.sin(a) * r); st.rotation.set(0, -a, t * 3); st.scale.setScalar(size * on); });
    },
  };
}
