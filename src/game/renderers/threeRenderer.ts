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
  upperBody: THREE.Group;
  paddleArm: THREE.Group;
  freeArm: THREE.Group;
  leftLeg: THREE.Group;
  rightLeg: THREE.Group;
  paddleGroup: THREE.Group;
  paddleHead: THREE.Mesh;
  bodyMats: THREE.MeshStandardMaterial[];
  impactFlash: THREE.Sprite;
  ghosts: THREE.Sprite[];
  groundShadow: THREE.Mesh;
  wasContact: boolean;
  // Anticipación (solo lectura visual, igual criterio que el canvas):
  // da la fase de "preparación" antes de que el swing arranque de verdad.
  prepBlend: number;
  prepSide: number;
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

  private _playerPalette: Palette = PLAYER_PALETTE;
  /** Aspecto del jugador: recolorea los materiales del rig ya construido. */
  get playerPalette(): Palette {
    return this._playerPalette;
  }
  set playerPalette(pal: Palette) {
    this._playerPalette = pal;
    if (!this.playerRig) return; // aún construyéndose
    const [skinMat, shirtMat, shortsMat, hairMat] = this.playerRig.bodyMats;
    skinMat.color.set(pal.skin);
    shirtMat.color.set(pal.shirt);
    shirtMat.emissive.set(pal.shirt);
    shortsMat.color.set(pal.shorts);
    hairMat.color.set(pal.hair);
  }

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
    // Sobre-escala arcade del rival: a distancia real (perspectiva pura)
    // se lee pequeño y poco expresivo, sobre todo en móvil. Igual criterio
    // que el canvas, que también agranda al rival más que al jugador
    // cercano (facingCamera ? 1.4 : 1.3 en render.ts) en vez de dejarlo al
    // tamaño "correcto" que daría la cámara.
    this.cpuRig.group.scale.setScalar(1.3);
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
    this.updateAvatar(this.playerRig, player, false, ball, dt);
    this.updateAvatar(this.cpuRig, cpu, true, ball, dt);
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
      new THREE.MeshStandardMaterial({ color: 0xe4ec3a, emissive: 0xc7d61a, emissiveIntensity: 0.95, roughness: 0.35 }),
    );
    // Sobre-escala puramente visual (igual que hace el canvas): la bola
    // física sigue teniendo el radio real del juego, solo se DIBUJA más
    // grande para que se lea con claridad en pantallas pequeñas. Más
    // grande que en el spike 2 (1.55 -> 1.85): en la posición "en mano"
    // antes de sacar, muy cerca de la cadera del jugador, se perdía
    // contra el cuerpo.
    mesh.scale.setScalar(1.85);
    this.scene.add(mesh);
    // Halo suave alrededor de la bola: la separa visualmente de lo que
    // tenga detrás (torso, pista) igual que hacen los focos del estadio,
    // en vez de depender solo de la luz puntual para destacar.
    const haloSprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: ThreeRenderer.glowTex, color: 0xf4f79a, transparent: true, opacity: 0.55, depthWrite: false,
    }));
    haloSprite.scale.set(0.55, 0.55, 1);
    mesh.add(haloSprite);
    const glow = new THREE.PointLight(0xe8ee6a, 2.1, 5.5, 2);
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

    // Piernas: cápsulas verticales colgando de la cadera, más separadas
    // que en la v1 (0.12 -> 0.19) y con flexión de rodilla base más
    // marcada (ver updateAvatar) para una base atlética real, no un
    // "poste" con dos cilindros pegados.
    const legGeo = new THREE.CapsuleGeometry(0.095, 0.6, 4, 8);
    const makeLeg = (side: -1 | 1): THREE.Group => {
      const g = new THREE.Group();
      g.position.set(side * 0.19, HIP_Y, 0);
      const mesh = new THREE.Mesh(legGeo, skinMat);
      mesh.position.y = -0.39;
      // Zapatilla más ancha y con leve giro hacia fuera: lee como apoyo
      // real en el suelo, no como la punta redondeada de un cilindro.
      const shoe = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.085, 0.27), new THREE.MeshStandardMaterial({ color: 0xf4f7fa }));
      shoe.position.set(side * 0.015, -0.82, 0.04);
      shoe.rotation.y = side * 0.12;
      g.add(mesh, shoe);
      return g;
    };
    const leftLeg = makeLeg(-1);
    const rightLeg = makeLeg(1);
    group.add(leftLeg, rightLeg);

    // Torso hacia arriba (torso, pantalón, cabeza, brazos, pala) vive en
    // un pivote propio a la altura de la cadera, con una inclinación
    // hacia delante constante — así el jugador se dobla desde la cintura
    // como en una postura de espera real, sin desanclar los pies del
    // suelo (que siguen verticales, fuera de este grupo).
    const upperBody = new THREE.Group();
    upperBody.position.set(0, HIP_Y, 0);
    upperBody.rotation.x = 0.16; // inclinación atlética hacia delante
    group.add(upperBody);

    // Torso: cápsula ancha
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.32, 4, 10), shirtMat);
    torso.position.set(0, 0.36, 0);
    torso.scale.set(1.15, 1, 0.75);
    upperBody.add(torso);

    // Pantalón corto
    const shorts = new THREE.Mesh(new THREE.CapsuleGeometry(0.2, 0.08, 4, 8), shortsMat);
    shorts.position.set(0, 0.05, 0);
    shorts.scale.set(1.1, 1, 0.8);
    upperBody.add(shorts);

    // Cabeza + pelo (cubre toda la nuca: vista trasera real, sin cara)
    const headGroup = new THREE.Group();
    headGroup.position.set(0, 0.74, 0);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.13, 14, 14), skinMat);
    const hair = new THREE.Mesh(new THREE.SphereGeometry(0.135, 14, 14, 0, Math.PI * 2, 0, Math.PI * 0.62), hairMat);
    hair.position.y = 0.015;
    headGroup.add(head, hair);
    upperBody.add(headGroup);

    // Brazo libre y brazo de la pala: la posición de reposo asume diestro
    // (pala en +X) como geometría de construcción, pero updateAvatar
    // reposiciona ambos hombros (position.x) cada fotograma según
    // p.dominantHand — así el mismo rig sirve para ambas lateralidades sin
    // duplicar geometría ni tener que reconstruir el avatar al vuelo.
    // Hombros más separados que en la v1 (0.3 -> 0.34) para que los
    // brazos no queden pegados al torso.
    const armGeo = new THREE.CapsuleGeometry(0.058, 0.3, 4, 8);
    const handGeo = new THREE.SphereGeometry(0.065, 10, 8);
    const freeArm = new THREE.Group();
    freeArm.position.set(-0.34, 0.6, 0);
    const freeArmMesh = new THREE.Mesh(armGeo, shirtMat);
    freeArmMesh.position.y = -0.16;
    const freeHand = new THREE.Mesh(handGeo, skinMat);
    freeHand.position.y = -0.34;
    freeArm.add(freeArmMesh, freeHand);
    upperBody.add(freeArm);

    // Brazo de la pala: pivote en el hombro, rota según prep/swing
    const paddleArm = new THREE.Group();
    paddleArm.position.set(0.34, 0.6, 0);
    const paddleArmMesh = new THREE.Mesh(armGeo, shirtMat);
    paddleArmMesh.position.y = -0.16;
    const paddleHand = new THREE.Mesh(handGeo, skinMat);
    paddleHand.position.y = -0.32;
    paddleArm.add(paddleArmMesh, paddleHand);
    upperBody.add(paddleArm);

    // Pala: grupo propio al final del brazo, inclinado hacia fuera para
    // que se separe visualmente del cuerpo en vez de quedar plana contra
    // el torso ("pegada y flotante" reportado). Esfera achatada en vez
    // de disco fino: un disco muy delgado se vuelve casi invisible de
    // canto (justo lo que pasa a media parte del swing); una esfera
    // aplastada siempre muestra una sección de color sea cual sea el
    // ángulo, así que no "desaparece" durante el golpe.
    const paddleGroup = new THREE.Group();
    paddleGroup.position.set(0, -0.34, 0);
    paddleGroup.rotation.set(0.25, 0, 0.55); // inclinación fija hacia fuera/abajo
    const paddleRim = new THREE.Mesh(
      new THREE.SphereGeometry(0.23, 16, 12),
      new THREE.MeshStandardMaterial({ color: 0x14202f, roughness: 0.6 }),
    );
    paddleRim.scale.set(1, 1, 0.4);
    paddleRim.position.set(0, -0.13, 0.01);
    const paddleHead = new THREE.Mesh(
      new THREE.SphereGeometry(0.185, 16, 12),
      new THREE.MeshStandardMaterial({ color: 0xff9a4d, emissive: 0xb44f10, emissiveIntensity: 0.9, roughness: 0.3 }),
    );
    paddleHead.scale.set(1, 1, 0.45);
    paddleHead.position.set(0, -0.13, 0.04);
    const handle = new THREE.Mesh(
      new THREE.CylinderGeometry(0.026, 0.026, 0.16, 8),
      new THREE.MeshStandardMaterial({ color: 0x1c242f }),
    );
    handle.position.set(0, -0.03, 0);
    paddleGroup.add(handle, paddleRim, paddleHead);
    paddleArm.add(paddleGroup);

    // Destello de impacto: sprite oculto que se enciende justo al golpear
    // (mismo criterio que el canvas: swingT cerca de 0 durante el golpe).
    // Va directo a la escena (espacio mundo): iba colgado del avatar,
    // que ya tiene su propia posición/rotación, así que la posición
    // mundial que se le asigna cada fotograma quedaba doblemente
    // transformada y el destello aparecía descolocado.
    const impactFlash = new THREE.Sprite(new THREE.SpriteMaterial({
      map: ThreeRenderer.glowTex, color: 0xffffff, transparent: true, opacity: 0, depthWrite: false,
    }));
    impactFlash.scale.set(0.01, 0.01, 1);
    this.scene.add(impactFlash);

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
      new THREE.CircleGeometry(0.36, 20),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.32 }),
    );
    groundShadow.rotation.x = -Math.PI / 2;
    groundShadow.position.y = 0.01;
    this.scene.add(groundShadow);

    return {
      group,
      upperBody,
      paddleArm,
      freeArm,
      leftLeg,
      rightLeg,
      paddleGroup,
      paddleHead,
      bodyMats: [skinMat, shirtMat, shortsMat, hairMat],
      impactFlash,
      ghosts,
      groundShadow,
      wasContact: false,
      prepBlend: 0,
      prepSide: 1,
    };
  }

  /**
   * Deriva hacia qué lado y con cuánta antelación debería prepararse el
   * jugador a partir de la posición/velocidad real de la bola (solo
   * lectura visual, no toca ningún estado de gameplay). Mismo criterio
   * que usa el canvas (render.ts) para su fase de "preparación".
   */
  private anticipate(p: PlayerEntity, ball: Ball, isCpu: boolean): { blend: number; side: number } {
    if (!ball.active) return { blend: 0, side: 0 };
    const incoming = isCpu ? ball.vel.z < -0.4 : ball.vel.z > 0.4;
    if (!incoming) return { blend: 0, side: 0 };
    const dz = Math.abs(ball.pos.z - p.z);
    const blend = Math.min(Math.max(1 - dz / 10, 0), 0.85);
    const dx = ball.pos.x - p.x;
    const side = (isCpu ? -dx : dx) >= 0 ? 1 : -1;
    return { blend, side };
  }

  private updateAvatar(rig: AvatarRig, p: PlayerEntity, isCpu: boolean, ball: Ball, dt: number): void {
    rig.group.position.set(p.x, 0, p.z);
    // El jugador cercano da la espalda a cámara (juega hacia -z, el rival
    // juega hacia +z): rotación base fija según el lado, sin "frente falso".
    const baseFacing = isCpu ? 0 : Math.PI;
    const swinging = p.swingType !== null;
    const isBackhand = swinging && (p.swingType === 'backhand' || p.swingType === 'volleyBh');
    const swingDir = isBackhand ? -1 : 1;
    const t = swinging ? Math.min(p.swingT, 1) : 0;
    const swingK = swinging ? Math.sin(t * Math.PI) : 0;

    // Mano dominante: viene del estado del jugador (perfil), NUNCA fijada
    // en el renderer. La geometría del rig se construyó con la pala en
    // +X local, que anatómicamente es la mano IZQUIERDA del personaje
    // (verificado con la cámara del rival, que no lleva el giro de 180°:
    // ahí +X local cae en pantalla-derecha, que es la mano izquierda de
    // alguien que mira de frente a cámara — el bug reportado). handSign
    // espeja el hombro/brazo al lado anatómico correcto según
    // dominantHand, sin tocar la clasificación de golpe (forehand/backhand
    // la sigue decidiendo match.ts por el lado geométrico de la bola; eso
    // es gameplay y no se toca aquí, solo qué brazo se dibuja).
    const handSign = p.dominantHand === 'left' ? 1 : -1;

    // Preparación: igual que el canvas, blend/side se derivan de la bola
    // real y se suavizan; side solo se reevalúa cerca de blend bajo para
    // no producir una pala "a medio cruzar" que no se lea como nada.
    const ease = Math.min(dt * 7, 1);
    if (swinging) {
      rig.prepBlend += (1 - rig.prepBlend) * ease;
      rig.prepSide = swingDir;
    } else {
      const ant = this.anticipate(p, ball, isCpu);
      rig.prepBlend += (ant.blend - rig.prepBlend) * ease;
      if (rig.prepBlend < 0.2 && ant.blend > 0.05) rig.prepSide = ant.side;
    }
    const prepSideSigned = rig.prepSide >= 0 ? 1 : -1;

    // Giro de hombros/torso: deliberadamente MODESTO y solo en upperBody
    // (las piernas no giran con él). Con la cámara casi en el eje de
    // espaldas del jugador, un giro grande de todo el cuerpo termina
    // apuntando el brazo de la pala hacia/desde la cámara (foreshortening)
    // y lo hace desaparecer — por eso en la v1 del spike la pala "no se
    // veía" durante el golpe. Fuera del golpe, un giro sutil ya orienta
    // el torso hacia el lado anticipado ("mirar hacia la bola").
    const turn = swinging
      ? swingK * 0.22 * swingDir * handSign
      : rig.prepBlend * 0.14 * prepSideSigned * handSign;
    rig.group.rotation.y = baseFacing;
    rig.upperBody.rotation.y = turn * (isCpu ? -1 : 1);

    // Ligero balanceo de respiración/espera para que no parezca estático.
    const idleBob = Math.sin(performance.now() / 480 + (isCpu ? 2 : 0)) * 0.012;
    rig.group.position.y = idleBob;
    rig.groundShadow.position.set(p.x, 0.01, p.z);

    // Piernas: flexión de rodilla base bien marcada (pose atlética, no un
    // "poste") + un poco más al preparar/golpear + paso al moverse.
    const kneeBend = 0.22 + rig.prepBlend * 0.08 + swingK * 0.06;
    const moveSwing = Math.sin(p.runPhase) * 0.22 * p.moveAmount;
    rig.leftLeg.rotation.x = kneeBend + moveSwing;
    rig.rightLeg.rotation.x = kneeBend - moveSwing;

    // Brazo de la pala — corrección clave del spike 2: el eje que barre
    // ROTATION.X mueve el brazo en profundidad (hacia/desde cámara), que
    // desde una cámara casi de espaldas se ve en escorzo y apenas se lee
    // (esto era el bug de la v1: la pala "desaparecía" en pleno golpe).
    // ROTATION.Z, en cambio, barre el brazo de lado a lado en pantalla:
    // ese es el eje que de verdad se lee.
    //
    // Tres fases visuales (spike 3):
    //  a) preparación: sin swing activo pero con anticipación (prepBlend),
    //     la pala se lleva atrás/lateral hacia el lado de la bola.
    //  b) impacto: el juego real ya golpeó en swingT≈0 (la velocidad de
    //     la bola se fija al iniciar el swing, ver match.ts), así que t=0
    //     debe leerse como "la pala está junto al cuerpo, cerca de donde
    //     estaba la bola" — no como "atrás", que confundiría impacto con
    //     preparación.
    //  c) follow-through: t->1 cruza el brazo hacia delante/al otro lado.
    let lateralAngle = 0; // barrido principal (rotation.z): visible de lado a lado
    let depthAngle = 0.4; // inclinación secundaria (rotation.x): sutil, hacia delante
    if (swinging && p.swingType !== null && isOverheadShot(p.swingType)) {
      depthAngle = -1.7 + t * 3.1; // golpes altos: el brazo sube por encima (eje correcto: x)
      lateralAngle = 0.15 * swingK * swingDir;
    } else if (swinging) {
      // Impacto (t=0, junto al cuerpo) -> follow-through (cruza delante).
      lateralAngle = isBackhand ? -0.75 + t * 1.55 : 0.75 - t * 1.55;
      depthAngle = 0.15 + swingK * 0.35;
    } else {
      // Reposo <-> preparación real, según la anticipación de la bola.
      const restLateral = 0.42;
      const prepLateral = 1.15 * prepSideSigned;
      lateralAngle = restLateral + (prepLateral - restLateral) * rig.prepBlend;
      depthAngle = 0.35 + rig.prepBlend * 0.1;
    }
    // Espeja qué brazo sostiene la pala: posición del hombro (pala en el
    // lado dominante, libre en el otro) y el arco lateral, en función de
    // handSign. rotation.x (profundidad) no se espeja: subir/bajar el
    // brazo no depende de qué mano sea la dominante. Hombros más
    // separados (0.3 -> 0.34, ver buildAvatar) para que los brazos no
    // queden pegados al torso.
    rig.paddleArm.position.x = 0.34 * handSign;
    rig.freeArm.position.x = -0.34 * handSign;
    rig.paddleArm.rotation.z = lateralAngle * handSign;
    rig.paddleArm.rotation.x = -depthAngle;
    // Brazo libre claramente separado del cuerpo, para equilibrio visual
    // (antes quedaba pegado a la cadera y se confundía con un objeto
    // redondo — reportado como "bola/indicador verde" pegado a la
    // espalda). Un poco más abierto todavía durante el golpe, como un
    // brazo real que contrapesa el giro.
    const freeArmOpen = swinging ? 0.55 : 0.4;
    rig.freeArm.rotation.z = -freeArmOpen * handSign;
    rig.freeArm.rotation.x = -0.05;

    // Contacto: la pala "destella" con un aumento de escala más marcado,
    // más un flash de luz y una breve estela que dejan claro EL INSTANTE
    // y LA DIRECCIÓN del golpe — la señal más legible en pantallas pequeñas.
    // Ventana más ajustada (0.18 -> 0.12) para que el flash lea como un
    // instante, no como un tercio del swing.
    const contact = swinging && p.swingT < 0.12;
    rig.paddleHead.scale.setScalar(contact ? 1.4 : 1);

    const paddleWorldPos = rig.paddleHead.getWorldPosition(_tmpVec3);
    if (contact) {
      const k = 1 - p.swingT / 0.12; // 1 en el instante del golpe -> 0 al terminar
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
    // `group.position` ya es mundial (su padre es la escena, sin
    // transform intermedio) — no hace falta otro getWorldPosition.
    if (swinging && t > 0.02 && t < 0.7) {
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
    // Un poco más lejos/alto que en el spike 2: la pose atlética (piernas
    // y brazos más separados, torso inclinado) ocupa más ancho de
    // silueta, y con el encuadre anterior el jugador quedaba cortado en
    // los laterales (p.ej. de pie en la posición de saque).
    const behind = portrait ? 6.6 : 7.6;
    const height = portrait ? 3.05 : 3.4;
    // Paneo más agresivo que en el spike 2: con la pala extendida bien
    // hacia fuera del cuerpo, en los laterales de la pista (p.ej. de pie
    // en la posición de saque) se salía del encuadre por el lado de la
    // pala aunque el resto del cuerpo sí cupiera.
    const panFactor = portrait ? 0.82 : 0.42;

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
    // El objetivo de mirada seguía camX solo al 40%: a paneos grandes (p.ej.
    // jugador pegado a la banda) la cámara se quedaba mirando muy a la
    // izquierda/derecha de sí misma y el jugador salía del encuadre por
    // completo (bug real, no solo cosmético). Ahora el target sigue casi
    // 1:1 la posición de la cámara, así siempre mira más o menos al frente.
    const lookTarget = new THREE.Vector3(this.camX * 0.92, 1.3, COURT.netZ - 1.5);
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
