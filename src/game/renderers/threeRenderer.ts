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

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = false; // spike: luces sin sombras dinámicas por rendimiento móvil

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x030711);
    this.scene.fog = new THREE.Fog(0x030711, 18, 42);

    this.camera = new THREE.PerspectiveCamera(55, 1, 0.1, 100);

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
    const dt = Math.min(this.clock.getDelta(), 0.05);
    const now = this.clock.elapsedTime;

    this.updateCamera(player, dt);
    this.updateAvatar(this.playerRig, player, false, dt);
    this.updateAvatar(this.cpuRig, cpu, true, dt);
    this.updateBall(ball, showBall);
    this.updateParticles(dt);
    this.updateZones();
    this.updateLights(dt, now);

    this.renderer.render(this.scene, this.camera);
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

  /** Textura de degradado radial (glow suave) generada por canvas, sin assets externos. */
  private static makeGlowTexture(): THREE.Texture {
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 64;
    const ctx = c.getContext('2d')!;
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,246,216,0.9)');
    g.addColorStop(0.4, 'rgba(255,242,192,0.4)');
    g.addColorStop(1, 'rgba(255,242,192,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
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
    const glowTex = ThreeRenderer.makeGlowTexture();
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
      new THREE.MeshStandardMaterial({ color: 0xe4ec3a, emissive: 0xc7d61a, emissiveIntensity: 0.55, roughness: 0.5 }),
    );
    this.scene.add(mesh);
    const glow = new THREE.PointLight(0xe8ee6a, 1.1, 4, 2);
    mesh.add(glow);
    const shadow = new THREE.Mesh(
      new THREE.CircleGeometry(0.2, 16),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35 }),
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.01;
    this.scene.add(shadow);
    for (let i = 0; i < 6; i++) {
      const t = new THREE.Mesh(
        new THREE.SphereGeometry(0.09, 8, 8),
        new THREE.MeshBasicMaterial({ color: 0xdee628, transparent: true, opacity: 0 }),
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
    const shirtMat = new THREE.MeshStandardMaterial({ color: pal.shirt, roughness: 0.6 });
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

    // Pala: mango + cara ovalada, al final del brazo
    const paddleHead = new THREE.Mesh(
      new THREE.CylinderGeometry(0.1, 0.1, 0.025, 16),
      new THREE.MeshStandardMaterial({ color: 0xe8823f, roughness: 0.4 }),
    );
    paddleHead.rotation.x = Math.PI / 2;
    paddleHead.position.set(0, -0.42, 0.02);
    const handle = new THREE.Mesh(
      new THREE.CylinderGeometry(0.022, 0.022, 0.14, 8),
      new THREE.MeshStandardMaterial({ color: 0x1c242f }),
    );
    handle.position.set(0, -0.34, 0);
    paddleArm.add(handle, paddleHead);

    group.add(paddleArm);

    return {
      group,
      paddleArm,
      freeArm,
      leftLeg,
      rightLeg,
      paddleHead,
      bodyMats: [skinMat, shirtMat, shortsMat, hairMat],
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

    // Giro de hombros: sutil en preparación, más marcado en el golpe.
    const turn = swinging ? swingK * 0.55 * swingDir : Math.sin(dt * 0) * 0; // placeholder, sin turn en reposo
    rig.group.rotation.y = baseFacing + turn * (isCpu ? -1 : 1);

    // Ligero balanceo de respiración/espera para que no parezca estático.
    const idleBob = Math.sin(performance.now() / 480 + (isCpu ? 2 : 0)) * 0.012;
    rig.group.position.y = idleBob;

    // Piernas: flexión ligera fija (pose lista) + pequeño paso si se mueve.
    const moveSwing = Math.sin(p.runPhase) * 0.22 * p.moveAmount;
    rig.leftLeg.rotation.x = 0.08 + moveSwing;
    rig.rightLeg.rotation.x = 0.08 - moveSwing;

    // Brazo de la pala: ángulo de reposo -> preparación/golpe.
    let armAngle: number;
    if (swinging && p.swingType !== null && isOverheadShot(p.swingType)) {
      armAngle = -1.6 + t * 2.6; // golpes altos: brazo sube por encima
    } else if (swinging) {
      armAngle = isBackhand ? -0.9 + t * 1.7 : 0.9 - t * 1.7;
    } else {
      armAngle = 0.4; // reposo: pala delante, brazo ligeramente adelantado
    }
    rig.paddleArm.rotation.x = -armAngle;
    // Sin giro extra hacia el centro en reposo: el brazo se separa del
    // torso hacia su propio lado, así no se funde con el brazo libre.
    rig.paddleArm.rotation.z = isBackhand && swinging ? 0.35 : -0.1;

    // Contacto: la pala "destella" con un ligero aumento de escala.
    const flash = swinging && p.swingT < 0.18 ? 1.25 : 1;
    rig.paddleHead.scale.setScalar(flash);
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
