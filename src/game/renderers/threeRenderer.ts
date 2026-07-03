import * as THREE from 'three';
import { COURT } from '../court';
import { CPU_PALETTE, PLAYER_PALETTE } from '../render';
import type { Palette } from '../render';
import type { GameRenderer } from './GameRenderer';
import type { Ball } from '../ball';
import type { PlayerEntity } from '../player';
import type { Vec3 } from '../../types';
import { isOverheadShot } from '../../types';

// ============================================================================
// SPIKE TÉCNICO — renderer alternativo en Three.js/WebGL. Objetivo: validar
// calidad visual de un salto a 3D real, NO sustituir el renderer canvas
// (render.ts) todavía. Vive aislado: implementa el mismo contrato
// (GameRenderer) que el canvas, así que el gameplay (match.ts, practice.ts,
// challenges.ts, guest.ts) no sabe ni le importa cuál de los dos está
// activo. Pose y animación aquí son deliberadamente más simples que en el
// canvas: el objetivo del spike es la calidad del volumen/luz/cámara 3D,
// no la fidelidad de la animación.
// ============================================================================

const MAX_PARTICLES = 60;
/** Vector temporal reutilizado para lecturas puntuales de posición mundial (evita asignar por fotograma). */
const _tmpVec3 = new THREE.Vector3();

interface Particle {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  life: number;
  maxLife: number;
}

interface AvatarRig {
  group: THREE.Group;
  paddleArm: THREE.Group;
  freeArm: THREE.Group;
  leftLeg: THREE.Group;
  rightLeg: THREE.Group;
  paddleHead: THREE.Mesh;
  bodyMats: THREE.MeshStandardMaterial[];
  impactFlash: THREE.Sprite;
  ghosts: THREE.Sprite[];
  groundShadow: THREE.Mesh;
  wasContact: boolean;
}

/**
 * Overlay DOM ligero con FPS / frame time en vivo. Solo se crea con
 * ?renderer=three&debug=perf — cero coste si no se pide explícitamente.
 */
class PerfHud {
  private el: HTMLDivElement;
  private samples: number[] = [];
  private readonly windowSize = 90;

  constructor(rendererLabel: string) {
    this.el = document.createElement('div');
    this.el.style.cssText =
      'position:fixed;top:8px;left:8px;z-index:99999;background:rgba(4,10,20,0.78);' +
      'color:#7CFC9B;font:12px/1.5 "SFMono-Regular",Consolas,monospace;padding:8px 11px;' +
      'border-radius:8px;pointer-events:none;white-space:pre;letter-spacing:0.02em;';
    this.el.textContent = `Renderer: ${rendererLabel}\nFPS: —`;
    document.body.appendChild(this.el);
  }

  sample(dtSeconds: number): void {
    const ms = dtSeconds * 1000;
    this.samples.push(ms);
    if (this.samples.length > this.windowSize) this.samples.shift();
    const n = this.samples.length;
    const last = this.samples[n - 1];
    const avgMs = this.samples.reduce((a, b) => a + b, 0) / n;
    const worstMs = Math.max(...this.samples);
    const instFps = 1000 / Math.max(last, 0.1);
    const avgFps = 1000 / Math.max(avgMs, 0.1);
    const minFps = 1000 / Math.max(worstMs, 0.1);
    this.el.textContent =
      `Renderer: THREE.js (WebGL)\n` +
      `FPS: ${instFps.toFixed(0)}  (avg ${avgFps.toFixed(0)} · min≈${minFps.toFixed(0)})\n` +
      `Frame: ${last.toFixed(1)}ms  (avg ${avgMs.toFixed(1)}ms)`;
  }

  dispose(): void {
    this.el.remove();
  }
}

export class ThreeRenderer implements GameRenderer {
  cpuPalette: Palette = CPU_PALETTE;
  targetZones: Array<{ x0: number; x1: number; z0: number; z1: number }> = [];

  private canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private clock = new THREE.Clock();

  private camX = 0;
  private shakeMag = 0;
  private crowdExcite = 0;
  private bulbMats: THREE.MeshStandardMaterial[] = [];

  private ballMesh: THREE.Mesh;
  private ballGlow: THREE.PointLight;
  private ballShadow: THREE.Mesh;
  private trailMeshes: THREE.Mesh[] = [];

  private playerRig: AvatarRig;
  private cpuRig: AvatarRig;

  private particles: Particle[] = [];
  private particlePool: THREE.Mesh[] = [];

  private zoneGroup = new THREE.Group();
  private zonesCache = '';

  private perfHud: PerfHud | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = false; // spike: luces sin sombras dinámicas por rendimiento móvil

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x030711);
    this.scene.fog = new THREE.Fog(0x030711, 18, 42);

    this.camera = new THREE.PerspectiveCamera(55, 1, 0.1, 100);

    if (new URLSearchParams(location.search).get('debug') === 'perf') {
      this.perfHud = new PerfHud('THREE.js (WebGL)');
    }

    this.buildCourt();
    this.buildLights();
    const ball = this.buildBall();
    this.ballMesh = ball.mesh;
    this.ballGlow = ball.glow;
    this.ballShadow = ball.shadow;

    this.playerRig = this.buildAvatar(PLAYER_PALETTE);
    this.cpuRig = this.buildAvatar(this.cpuPalette);
    this.scene.add(this.playerRig.group, this.cpuRig.group);

    this.scene.add(this.zoneGroup);


    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, true);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  shake(mag: number): void {
    this.shakeMag = Math.max(this.shakeMag, mag);
  }

  exciteCrowd(amount: number): void {
    this.crowdExcite = Math.min(1, this.crowdExcite + amount);
  }

  burst(pos: Vec3, color: string, count = 8, speed = 2.2): void {
    const [r, g, b] = color.split(',').map((n) => parseInt(n.trim(), 10) / 255);
    for (let i = 0; i < count; i++) {
      const mesh = this.particlePool.pop() ?? new THREE.Mesh(
        new THREE.SphereGeometry(0.045, 6, 6),
        new THREE.MeshBasicMaterial({ color: new THREE.Color(r, g, b), transparent: true }),
      );
      (mesh.material as THREE.MeshBasicMaterial).color.setRGB(r, g, b);
      (mesh.material as THREE.MeshBasicMaterial).opacity = 1;
      mesh.position.set(pos.x, Math.max(pos.y, 0.05), pos.z);
      this.scene.add(mesh);
      const a = Math.random() * Math.PI * 2;
      const v = speed * (0.4 + Math.random() * 0.8);
      this.particles.push({
        mesh,
        vel: new THREE.Vector3(Math.cos(a) * v, Math.random() * v * 0.8, Math.sin(a) * v * 0.5),
        life: 0.35 + Math.random() * 0.25,
        maxLife: 0.6,
      });
      if (this.particles.length > MAX_PARTICLES) {
        const dead = this.particles.shift()!;
        this.scene.remove(dead.mesh);
        this.particlePool.push(dead.mesh);
      }
    }
  }

  draw(ball: Ball, player: PlayerEntity, cpu: PlayerEntity, showBall: boolean): void {
    const rawDt = this.clock.getDelta();
    const dt = Math.min(rawDt, 0.05);
    const now = this.clock.elapsedTime;

    this.updateCamera(player, dt);
    this.updateAvatar(this.playerRig, player, false, dt);
    this.updateAvatar(this.cpuRig, cpu, true, dt);
    this.updateBall(ball, showBall);
    this.updateParticles(dt);
    this.updateZones();
    this.updateLights(dt, now);

    this.renderer.render(this.scene, this.camera);

    // Frame time real (sin recortar) para que el HUD refleje bajones de
    // rendimiento reales, no el dt ya suavizado que usa la animación.
    this.perfHud?.sample(rawDt);
  }

  // --------------------------------------------------------------------
  // Pista, cristales, red
  // --------------------------------------------------------------------

  private buildCourt(): void {
    const hw = COURT.halfWidth;
    const L = COURT.length;

    // Deck exterior oscuro
    const deck = new THREE.Mesh(
      new THREE.PlaneGeometry(hw * 4, L + 10),
      new THREE.MeshStandardMaterial({ color: 0x0a1424, roughness: 0.95 }),
    );
    deck.rotation.x = -Math.PI / 2;
    deck.position.set(0, -0.01, L / 2);
    this.scene.add(deck);

    // Suelo de pista
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(hw * 2, L),
      new THREE.MeshStandardMaterial({ color: 0x1f6bab, roughness: 0.75, metalness: 0.05 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, 0, L / 2);
    this.scene.add(floor);

    // Líneas blancas (bandas finas)
    const lineMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const hLine = (z: number, width = hw * 2): void => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(width, 0.08), lineMat);
      m.rotation.x = -Math.PI / 2;
      m.position.set(0, 0.01, z);
      this.scene.add(m);
    };
    const vLine = (x: number, z0: number, z1: number): void => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(0.08, z1 - z0), lineMat);
      m.rotation.x = -Math.PI / 2;
      m.position.set(x, 0.01, (z0 + z1) / 2);
      this.scene.add(m);
    };
    hLine(0.05);
    hLine(L - 0.05);
    hLine(COURT.serviceLineCpu);
    hLine(COURT.serviceLinePlayer);
    vLine(-hw, 0, L);
    vLine(hw, 0, L);
    vLine(0, COURT.serviceLineCpu, COURT.serviceLinePlayer);

    // Cristales: fondo + laterales, translúcidos pero con un borde marcado
    // (remate superior claro) para que se lean como paneles reales y no
    // desaparezcan contra el fondo oscuro.
    const glassMat = new THREE.MeshPhysicalMaterial({
      color: 0x9fd0f5,
      transparent: true,
      opacity: 0.22,
      roughness: 0.08,
      metalness: 0,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const rimMat = new THREE.MeshStandardMaterial({ color: 0xd7eaff, emissive: 0x1a3350, emissiveIntensity: 0.4 });
    const wallHeight = COURT.wallHeight;
    const glassPanel = (w: number): THREE.Group => {
      const g = new THREE.Group();
      const pane = new THREE.Mesh(new THREE.PlaneGeometry(w, wallHeight), glassMat);
      pane.position.y = wallHeight / 2;
      const rim = new THREE.Mesh(new THREE.BoxGeometry(w, 0.1, 0.04), rimMat);
      rim.position.y = wallHeight;
      g.add(pane, rim);
      return g;
    };
    const backWall = glassPanel(hw * 2);
    backWall.position.set(0, 0, 0);
    this.scene.add(backWall);
    const frontWall = glassPanel(hw * 2);
    frontWall.position.set(0, 0, L);
    frontWall.rotation.y = Math.PI;
    this.scene.add(frontWall);
    for (const side of [-1, 1] as const) {
      const wall = glassPanel(L);
      wall.position.set(side * hw, 0, L / 2);
      wall.rotation.y = side > 0 ? -Math.PI / 2 : Math.PI / 2;
      this.scene.add(wall);
    }

    // Red: cuerpo + banda superior + postes
    const netMat = new THREE.MeshBasicMaterial({ color: 0x0a1420, transparent: true, opacity: 0.55, side: THREE.DoubleSide });
    const netBody = new THREE.Mesh(new THREE.PlaneGeometry(hw * 2, COURT.netHeight), netMat);
    netBody.position.set(0, COURT.netHeight / 2, COURT.netZ);
    this.scene.add(netBody);
    const netBand = new THREE.Mesh(
      new THREE.BoxGeometry(hw * 2, 0.06, 0.02),
      new THREE.MeshStandardMaterial({ color: 0xf2f6fa }),
    );
    netBand.position.set(0, COURT.netHeight, COURT.netZ);
    this.scene.add(netBand);
    for (const px of [-hw, hw]) {
      const post = new THREE.Mesh(
        new THREE.CylinderGeometry(0.045, 0.045, COURT.netHeight + 0.1, 8),
        new THREE.MeshStandardMaterial({ color: 0xc7d3e0, metalness: 0.4, roughness: 0.4 }),
      );
      post.position.set(px, (COURT.netHeight + 0.1) / 2, COURT.netZ);
      this.scene.add(post);
    }
  }

  private static _glowTex: THREE.Texture | null = null;
  /** Textura de degradado radial (glow suave) generada por canvas, sin
   *  assets externos, compartida por focos/destello de impacto/estela. */
  private static get glowTex(): THREE.Texture {
    if (!ThreeRenderer._glowTex) {
      const c = document.createElement('canvas');
      c.width = 64;
      c.height = 64;
      const ctx = c.getContext('2d')!;
      const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
      g.addColorStop(0, 'rgba(255,246,216,0.95)');
      g.addColorStop(0.4, 'rgba(255,242,192,0.45)');
      g.addColorStop(1, 'rgba(255,242,192,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 64, 64);
      ThreeRenderer._glowTex = new THREE.CanvasTexture(c);
    }
    return ThreeRenderer._glowTex;
  }

  private buildLights(): void {
    this.scene.add(new THREE.AmbientLight(0x3a4d72, 1.3));
    const hemi = new THREE.HemisphereLight(0x9fc4f0, 0x0a1220, 0.85);
    this.scene.add(hemi);

    // Relleno general cenital: cubre pista y jugadores por igual (evita
    // que el rival lejano quede casi negro al salir del cono de los focos).
    const fill = new THREE.DirectionalLight(0xcfe0ff, 0.55);
    fill.position.set(2, 14, 12);
    fill.target.position.set(0, 0, 10);
    this.scene.add(fill, fill.target);

    // Focos de estadio: 4 luminarias visibles (bulbo + halo, coste ínfimo)
    // pero solo 2 SpotLight dinámicos reales (coste por fragmento) — el
    // relleno cenital ya cubre el resto de la pista. Menos luces dinámicas
    // = más margen en GPUs móviles modestas.
    const glowTex = ThreeRenderer.glowTex;
    const lightX = [-6.2, 6.2];
    const lightZ = [4, 15];
    for (const lx of lightX) {
      for (const lz of lightZ) {
        if (lz === 4) {
          const spot = new THREE.SpotLight(0xfff2cf, 55, 30, Math.PI / 4.2, 0.55, 1.2);
          spot.position.set(lx, 6.6, lz);
          spot.target.position.set(lx * 0.3, 0, lz);
          this.scene.add(spot, spot.target);
        }

        const bulbMat = new THREE.MeshStandardMaterial({ color: 0xfff6d8, emissive: 0xfff2b0, emissiveIntensity: 1.6 });
        const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.2, 8, 8), bulbMat);
        bulb.position.set(lx, 6.6, lz);
        this.scene.add(bulb);
        this.bulbMats.push(bulbMat);

        const halo = new THREE.Sprite(new THREE.SpriteMaterial({
          map: glowTex, transparent: true, opacity: 0.8, depthWrite: false,
        }));
        halo.scale.set(1.8, 1.8, 1);
        halo.position.copy(bulb.position);
        this.scene.add(halo);
      }
    }

    // Luz de relleno fría desde el fondo, para separar la escena del cielo
    const rim = new THREE.DirectionalLight(0x6f9fe0, 0.3);
    rim.position.set(0, 6, -4);
    this.scene.add(rim);
  }

  private buildBall(): { mesh: THREE.Mesh; glow: THREE.PointLight; shadow: THREE.Mesh } {
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.12, 16, 16),
      new THREE.MeshStandardMaterial({ color: 0xe4ec3a, emissive: 0xc7d61a, emissiveIntensity: 0.75, roughness: 0.4 }),
    );
    // Sobre-escala puramente visual (igual que hace el canvas): la bola
    // física sigue teniendo el radio real del juego, solo se DIBUJA más
    // grande para que se lea con claridad en pantallas pequeñas.
    mesh.scale.setScalar(1.55);
    this.scene.add(mesh);
    const glow = new THREE.PointLight(0xe8ee6a, 1.6, 5, 2);
    mesh.add(glow);
    const shadow = new THREE.Mesh(
      new THREE.CircleGeometry(0.22, 16),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.4 }),
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.01;
    this.scene.add(shadow);
    for (let i = 0; i < 6; i++) {
      const t = new THREE.Mesh(
        new THREE.SphereGeometry(0.1, 8, 8),
        new THREE.MeshBasicMaterial({ color: 0xf1f77a, transparent: true, opacity: 0 }),
      );
      this.scene.add(t);
      this.trailMeshes.push(t);
    }
    return { mesh, glow, shadow };
  }

  // --------------------------------------------------------------------
  // Avatar: rig de cápsulas — más volumen que las siluetas planas del canvas
  // --------------------------------------------------------------------

  private buildAvatar(pal: Palette): AvatarRig {
    const group = new THREE.Group();
    const skinMat = new THREE.MeshStandardMaterial({ color: pal.skin, roughness: 0.7 });
    // Emisión sutil del color de la camiseta: ayuda a que el torso "salga"
    // de la pista/fondo oscuro en pantallas pequeñas sin depender solo de
    // la luz ambiente (contraste jugador/pista/fondo pedido en el spike 2).
    const shirtMat = new THREE.MeshStandardMaterial({
      color: pal.shirt, roughness: 0.55,
      emissive: new THREE.Color(pal.shirt), emissiveIntensity: 0.18,
    });
    const shortsMat = new THREE.MeshStandardMaterial({ color: pal.shorts, roughness: 0.7 });
    const hairMat = new THREE.MeshStandardMaterial({ color: pal.hair, roughness: 0.8 });

    const HIP_Y = 0.92;

    // Piernas: cápsulas verticales colgando de la cadera. El pivote vive
    // en la cadera misma (no desplazado) para que la pierna toque el
    // pantalón sin dejar un hueco flotante entre torso y piernas.
    const legGeo = new THREE.CapsuleGeometry(0.09, 0.62, 4, 8);
    const makeLeg = (side: -1 | 1): THREE.Group => {
      const g = new THREE.Group();
      g.position.set(side * 0.12, HIP_Y, 0);
      const mesh = new THREE.Mesh(legGeo, skinMat);
      mesh.position.y = -0.4;
      const shoe = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.08, 0.24), new THREE.MeshStandardMaterial({ color: 0xf4f7fa }));
      shoe.position.set(0, -0.84, 0.03);
      g.add(mesh, shoe);
      return g;
    };
    const leftLeg = makeLeg(-1);
    const rightLeg = makeLeg(1);
    group.add(leftLeg, rightLeg);

    // Torso: cápsula ancha
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.32, 4, 10), shirtMat);
    torso.position.set(0, HIP_Y + 0.36, 0);
    torso.scale.set(1.15, 1, 0.75);
    group.add(torso);

    // Pantalón corto
    const shorts = new THREE.Mesh(new THREE.CapsuleGeometry(0.2, 0.08, 4, 8), shortsMat);
    shorts.position.set(0, HIP_Y + 0.05, 0);
    shorts.scale.set(1.1, 1, 0.8);
    group.add(shorts);

    // Cabeza + pelo (cubre toda la nuca: vista trasera real, sin cara)
    const headGroup = new THREE.Group();
    headGroup.position.set(0, HIP_Y + 0.74, 0);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.13, 14, 14), skinMat);
    const hair = new THREE.Mesh(new THREE.SphereGeometry(0.135, 14, 14, 0, Math.PI * 2, 0, Math.PI * 0.62), hairMat);
    hair.position.y = 0.015;
    headGroup.add(head, hair);
    group.add(headGroup);

    // Brazo libre: cuelga hacia afuera, sin cruzar hacia el centro (evita
    // que se funda visualmente con el brazo de la pala desde atrás).
    const armGeo = new THREE.CapsuleGeometry(0.055, 0.32, 4, 8);
    const freeArm = new THREE.Group();
    freeArm.position.set(-0.3, HIP_Y + 0.6, 0);
    const freeArmMesh = new THREE.Mesh(armGeo, shirtMat);
    freeArmMesh.position.y = -0.17;
    freeArm.add(freeArmMesh);
    freeArm.rotation.z = -0.18;
    freeArm.rotation.x = -0.1;
    group.add(freeArm);

    // Brazo de la pala: pivote en el hombro, rota según prep/swing
    const paddleArm = new THREE.Group();
    paddleArm.position.set(0.3, HIP_Y + 0.6, 0);
    const paddleArmMesh = new THREE.Mesh(armGeo, shirtMat);
    paddleArmMesh.position.y = -0.17;
    paddleArm.add(paddleArmMesh);
    group.add(paddleArm);

    // Pala: esfera achatada en vez de disco fino. Un disco (cilindro muy
    // delgado) se vuelve casi invisible cuando el brazo lo pone de canto
    // a cámara (justo lo que pasa a media parte del swing) — un volumen
    // esférico aplastado, en cambio, SIEMPRE muestra una sección de color
    // sea cual sea el ángulo, así que no "desaparece" durante el golpe.
    const paddleRim = new THREE.Mesh(
      new THREE.SphereGeometry(0.2, 16, 12),
      new THREE.MeshStandardMaterial({ color: 0x14202f, roughness: 0.6 }),
    );
    paddleRim.scale.set(1, 1, 0.4);
    paddleRim.position.set(0, -0.44, 0.005);
    const paddleHead = new THREE.Mesh(
      new THREE.SphereGeometry(0.16, 16, 12),
      new THREE.MeshStandardMaterial({ color: 0xff9a4d, emissive: 0xb44f10, emissiveIntensity: 0.9, roughness: 0.3 }),
    );
    paddleHead.scale.set(1, 1, 0.45);
    paddleHead.position.set(0, -0.44, 0.02);
    const handle = new THREE.Mesh(
      new THREE.CylinderGeometry(0.024, 0.024, 0.16, 8),
      new THREE.MeshStandardMaterial({ color: 0x1c242f }),
    );
    handle.position.set(0, -0.34, 0);
    paddleArm.add(handle, paddleRim, paddleHead);

    group.add(paddleArm);

    // Destello de impacto: sprite oculto que se enciende justo al golpear
    // (mismo criterio que el canvas: swingT cerca de 0 durante el golpe).
    const impactFlash = new THREE.Sprite(new THREE.SpriteMaterial({
      map: ThreeRenderer.glowTex, color: 0xffffff, transparent: true, opacity: 0, depthWrite: false,
    }));
    impactFlash.scale.set(0.01, 0.01, 1);
    group.add(impactFlash);

    // Estela de la pala durante el golpe: 2 "fantasmas" que van dejando
    // rastro de las últimas posiciones — da lectura de dirección/velocidad
    // del swing incluso con una animación de brazo simple.
    const ghosts = [0, 1].map(() => {
      const g = new THREE.Sprite(new THREE.SpriteMaterial({
        map: ThreeRenderer.glowTex, color: 0xffb066, transparent: true, opacity: 0, depthWrite: false,
      }));
      g.scale.set(0.001, 0.001, 1);
      this.scene.add(g);
      return g;
    });

    // Sombra de contacto bajo los pies: separa la silueta del jugador de
    // la pista (grounding), igual función que la sombra de la bola.
    const groundShadow = new THREE.Mesh(
      new THREE.CircleGeometry(0.34, 20),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.32 }),
    );
    groundShadow.rotation.x = -Math.PI / 2;
    groundShadow.position.y = 0.01;
    this.scene.add(groundShadow);

    return {
      group,
      paddleArm,
      freeArm,
      leftLeg,
      rightLeg,
      paddleHead,
      bodyMats: [skinMat, shirtMat, shortsMat, hairMat],
      impactFlash,
      ghosts,
      groundShadow,
      wasContact: false,
    };
  }

  private updateAvatar(rig: AvatarRig, p: PlayerEntity, isCpu: boolean, dt: number): void {
    rig.group.position.set(p.x, 0, p.z);
    // El jugador cercano da la espalda a cámara (juega hacia -z, el rival
    // juega hacia +z): rotación base fija según el lado, sin "frente falso".
    const baseFacing = isCpu ? 0 : Math.PI;
    const swinging = p.swingType !== null;
    const isBackhand = swinging && (p.swingType === 'backhand' || p.swingType === 'volleyBh');
    const swingDir = isBackhand ? -1 : 1;
    const t = swinging ? Math.min(p.swingT, 1) : 0;
    const swingK = swinging ? Math.sin(t * Math.PI) : 0;

    // Giro de hombros: deliberadamente MODESTO. Con la cámara casi en el
    // eje de espaldas del jugador, un giro de cuerpo grande termina
    // apuntando el brazo de la pala hacia/desde la cámara (foreshortening)
    // y lo hace desaparecer — por eso en la v1 del spike la pala "no se
    // veía" durante el golpe. La lectura del golpe la da el brazo (abajo),
    // no una rotación grande de todo el cuerpo.
    const turn = swinging ? swingK * 0.22 * swingDir : 0;
    rig.group.rotation.y = baseFacing + turn * (isCpu ? -1 : 1);

    // Ligero balanceo de respiración/espera para que no parezca estático.
    const idleBob = Math.sin(performance.now() / 480 + (isCpu ? 2 : 0)) * 0.012;
    rig.group.position.y = idleBob;
    rig.groundShadow.position.set(p.x, 0.01, p.z);

    // Piernas: flexión ligera fija (pose lista) + pequeño paso si se mueve.
    const moveSwing = Math.sin(p.runPhase) * 0.22 * p.moveAmount;
    rig.leftLeg.rotation.x = 0.08 + moveSwing;
    rig.rightLeg.rotation.x = 0.08 - moveSwing;

    // Brazo de la pala — corrección clave del spike 2: el eje que barre
    // ROTATION.X mueve el brazo en profundidad (hacia/desde cámara), que
    // desde una cámara casi de espaldas se ve en escorzo y apenas se lee
    // (esto era el bug de la v1: la pala "desaparecía" en pleno golpe).
    // ROTATION.Z, en cambio, barre el brazo de lado a lado en pantalla:
    // ese es el eje que de verdad se lee. Derecha/revés ahora usan
    // rotation.z como arco principal (amplio, visible) y rotation.x solo
    // para una inclinación hacia delante sutil. Los golpes altos siguen
    // usando rotation.x porque ahí SÍ es el eje correcto (el brazo sube).
    let lateralAngle = 0; // barrido principal (rotation.z): visible de lado a lado
    let depthAngle = 0.4; // inclinación secundaria (rotation.x): sutil, hacia delante
    if (swinging && p.swingType !== null && isOverheadShot(p.swingType)) {
      depthAngle = -1.7 + t * 3.1; // golpes altos: el brazo sube por encima (eje correcto: x)
      lateralAngle = 0.15 * swingK * swingDir;
    } else if (swinging) {
      // Derecha: preparación atrás del lado dominante -> extendida, cruzando
      // ligeramente delante del cuerpo al terminar (arco amplio y lateral).
      // Revés: mismo arco, con el signo invertido (empieza cruzado).
      lateralAngle = isBackhand ? -1.3 + t * 2.0 : 1.3 - t * 2.0;
      depthAngle = 0.15 + swingK * 0.35;
    } else {
      lateralAngle = 0.55; // reposo: pala delante, ligeramente hacia su lado
      depthAngle = 0.35;
    }
    rig.paddleArm.rotation.z = lateralAngle;
    rig.paddleArm.rotation.x = -depthAngle;

    // Contacto: la pala "destella" con un aumento de escala más marcado,
    // más un flash de luz y una breve estela que dejan claro EL INSTANTE
    // y LA DIRECCIÓN del golpe — la señal más legible en pantallas pequeñas.
    const contact = swinging && p.swingT < 0.18;
    rig.paddleHead.scale.setScalar(contact ? 1.4 : 1);

    const paddleWorldPos = rig.paddleHead.getWorldPosition(_tmpVec3);
    if (contact) {
      const k = 1 - p.swingT / 0.18; // 1 en el instante del golpe -> 0 al terminar
      rig.impactFlash.position.copy(paddleWorldPos);
      rig.impactFlash.scale.setScalar(0.25 + k * 0.55);
      (rig.impactFlash.material as THREE.SpriteMaterial).opacity = k * 0.9;
    } else {
      (rig.impactFlash.material as THREE.SpriteMaterial).opacity = 0;
    }

    // Estela de la pala: solo mientras dura el swing rápido (no en el
    // reposo ni la preparación), para leer la trayectoria del golpe.
    // Aproximación barata: cada fantasma es la posición actual de la pala
    // desplazada un poco hacia el cuerpo (sin re-evaluar toda la
    // jerarquía de nodos con un ángulo pasado), suficiente para una estela
    // corta y legible sin coste extra de cómputo por fotograma.
    if (swinging && t > 0.05 && t < 0.75) {
      for (let i = 0; i < rig.ghosts.length; i++) {
        const ghost = rig.ghosts[i];
        const lag = (i + 1) * 0.16;
        ghost.position.copy(paddleWorldPos).lerp(rig.group.position, lag);
        ghost.scale.setScalar(0.16 - i * 0.04);
        (ghost.material as THREE.SpriteMaterial).opacity = (1 - i * 0.4) * 0.32;
      }
    } else {
      for (const ghost of rig.ghosts) (ghost.material as THREE.SpriteMaterial).opacity = 0;
    }
  }

  // --------------------------------------------------------------------
  // Cámara deportiva: detrás del jugador, elevada, sigue en horizontal
  // --------------------------------------------------------------------

  private updateCamera(player: PlayerEntity, dt: number): void {
    const portrait = window.innerHeight > window.innerWidth * 1.1;
    const behind = portrait ? 5.2 : 6.6;
    const height = portrait ? 2.7 : 3.1;
    const panFactor = portrait ? 0.6 : 0.3;

    const targetCamX = player.x * panFactor;
    this.camX += (targetCamX - this.camX) * Math.min(dt * 3.5, 1);

    let shakeX = 0;
    let shakeY = 0;
    if (this.shakeMag > 0.3) {
      shakeX = (Math.random() - 0.5) * this.shakeMag * 0.05;
      shakeY = (Math.random() - 0.5) * this.shakeMag * 0.05;
      this.shakeMag *= Math.exp(-dt * 9);
    } else {
      this.shakeMag = 0;
    }

    this.camera.position.set(this.camX + shakeX, height + shakeY, player.z + behind);
    const lookTarget = new THREE.Vector3(this.camX * 0.4, 1.3, COURT.netZ - 1.5);
    this.camera.lookAt(lookTarget);
  }

  // --------------------------------------------------------------------
  // Pelota, partículas, zonas, luces
  // --------------------------------------------------------------------

  private updateBall(ball: Ball, showBall: boolean): void {
    this.ballMesh.visible = showBall;
    this.ballShadow.visible = showBall;
    if (!showBall) {
      for (const t of this.trailMeshes) t.visible = false;
      return;
    }
    this.ballMesh.position.set(ball.pos.x, ball.pos.y, ball.pos.z);
    this.ballShadow.position.set(ball.pos.x, 0.01, ball.pos.z);
    const shadowScale = Math.max(0.4, 1 - ball.pos.y * 0.12);
    this.ballShadow.scale.setScalar(shadowScale);

    const tr = ball.trail;
    for (let i = 0; i < this.trailMeshes.length; i++) {
      const src = tr[tr.length - 1 - i];
      const mesh = this.trailMeshes[i];
      if (!src) {
        mesh.visible = false;
        continue;
      }
      mesh.visible = true;
      mesh.position.set(src.x, src.y, src.z);
      const k = 1 - i / this.trailMeshes.length;
      mesh.scale.setScalar(0.5 + k * 0.5);
      (mesh.material as THREE.MeshBasicMaterial).opacity = k * 0.35;
    }
  }

  private updateParticles(dt: number): void {
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const pt = this.particles[i];
      pt.life -= dt;
      if (pt.life <= 0) {
        this.scene.remove(pt.mesh);
        this.particlePool.push(pt.mesh);
        this.particles.splice(i, 1);
        continue;
      }
      pt.vel.y -= 6 * dt;
      pt.mesh.position.addScaledVector(pt.vel, dt);
      if (pt.mesh.position.y < 0.03) pt.mesh.position.y = 0.03;
      (pt.mesh.material as THREE.MeshBasicMaterial).opacity = Math.min(pt.life / pt.maxLife, 1) * 0.85;
    }
  }

  private updateZones(): void {
    const key = JSON.stringify(this.targetZones);
    if (key === this.zonesCache) return;
    this.zonesCache = key;
    while (this.zoneGroup.children.length) {
      const c = this.zoneGroup.children.pop()!;
      (c as THREE.Mesh).geometry.dispose();
      this.zoneGroup.remove(c);
    }
    for (const z of this.targetZones) {
      const w = Math.abs(z.x1 - z.x0);
      const d = Math.abs(z.z1 - z.z0);
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(w, d),
        new THREE.MeshBasicMaterial({ color: 0x34d399, transparent: true, opacity: 0.28, side: THREE.DoubleSide }),
      );
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set((z.x0 + z.x1) / 2, 0.02, (z.z0 + z.z1) / 2);
      this.zoneGroup.add(mesh);
    }
  }

  private updateLights(dt: number, now: number): void {
    this.crowdExcite *= Math.exp(-dt * 0.8);
    const pulse = 1.4 + this.crowdExcite * 0.8 + Math.sin(now * 4) * 0.05 * this.crowdExcite;
    for (const m of this.bulbMats) m.emissiveIntensity = pulse;
  }
}
