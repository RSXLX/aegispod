import * as THREE from "/vendor/three/three.module.js";

/**
 * AegisPod 3D Living-UI Escape Capsule (Three.js)
 * Inspired by tactile industrial hardware (Dieter Rams / living-ui.dev):
 * - Matte anodized titanium escape capsule with motorized dual hatch doors
 * - Live CanvasTexture OLED display ("AEGISPOD" + digital asset counter 00 -> 05 + status LED)
 * - Vacuum packing animation: 5 physical 3D asset tokens dive into the hatch in sequence
 * - O(1) Void shredder confetti burst for cancelled scam transfer
 * - Sealed plasma thruster liftoff to immutable Cold Wallet
 */
export class EscapePodStage {
  constructor(canvas, onPodClick) {
    this.canvas = canvas;
    this.onPodClick = onPodClick;
    this.mode = "idle"; // idle | alert | packing | launching | secured
    this.packedCount = 0;
    this.pointer = { x: 0, y: 0 };
    this.smoothPointer = { x: 0, y: 0 };
    this.time = 0;
    this.doorOpen = 0;
    this.targetDoorOpen = 0;
    this.podY = 0;
    this.podVelY = 0;
    this.shake = 0;
    this.thrusterPower = 0;
    this.flyingTokens = [];
    this.confetti = [];
    this.sparks = [];
    this.disposed = false;

    this._initScene();
    this._buildPod();
    this._bindEvents();
    this._resize();
    this._loop();
  }

  _initScene() {
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: true,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;

    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(34, 1, 0.1, 100);
    this.camera.position.set(0, 1.35, 6.2);
    this.camera.lookAt(0, 0.1, 0);

    // Tactile warm studio lighting
    const hemi = new THREE.HemisphereLight(0xfffaf2, 0xcbd5e1, 1.35);
    this.scene.add(hemi);

    const key = new THREE.DirectionalLight(0xffffff, 2.0);
    key.position.set(4, 7, 5);
    this.scene.add(key);

    const rim = new THREE.DirectionalLight(0x38bdf8, 0.9);
    rim.position.set(-5, 3, -4);
    this.scene.add(rim);

    this.coreLight = new THREE.PointLight(0x10b981, 0.0, 5);
    this.coreLight.position.set(0, 0.9, 0.5);
    this.scene.add(this.coreLight);

    // Soft studio contact shadow beneath the capsule
    const shadowCanvas = document.createElement("canvas");
    shadowCanvas.width = 256;
    shadowCanvas.height = 256;
    const sctx = shadowCanvas.getContext("2d");
    const grad = sctx.createRadialGradient(128, 128, 18, 128, 128, 122);
    grad.addColorStop(0, "rgba(15, 23, 42, 0.34)");
    grad.addColorStop(0.55, "rgba(15, 23, 42, 0.12)");
    grad.addColorStop(1, "rgba(15, 23, 42, 0)");
    sctx.fillStyle = grad;
    sctx.fillRect(0, 0, 256, 256);

    const shadowTex = new THREE.CanvasTexture(shadowCanvas);
    this.shadowMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(3.4, 3.4),
      new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false })
    );
    this.shadowMesh.rotation.x = -Math.PI / 2;
    this.shadowMesh.position.y = -1.25;
    this.scene.add(this.shadowMesh);

    // Minimalist magnetic launch pad ring on the desk
    this.padRing = new THREE.Mesh(
      new THREE.RingGeometry(1.18, 1.28, 64),
      new THREE.MeshBasicMaterial({
        color: 0x94a3b8,
        transparent: true,
        opacity: 0.35,
        side: THREE.DoubleSide,
      })
    );
    this.padRing.rotation.x = -Math.PI / 2;
    this.padRing.position.y = -1.24;
    this.scene.add(this.padRing);
  }

  _createOledTexture(countStr, statusColor, labelText) {
    if (!this.oledCanvas) {
      this.oledCanvas = document.createElement("canvas");
      this.oledCanvas.width = 512;
      this.oledCanvas.height = 160;
      this.oledTex = new THREE.CanvasTexture(this.oledCanvas);
      this.oledTex.colorSpace = THREE.SRGBColorSpace;
    }
    const ctx = this.oledCanvas.getContext("2d");
    ctx.fillStyle = "#0e1015";
    ctx.fillRect(0, 0, 512, 160);

    // Subtle brushed bezel border
    ctx.strokeStyle = "#262a34";
    ctx.lineWidth = 6;
    ctx.strokeRect(4, 4, 504, 152);

    // Left engraved brand
    ctx.fillStyle = "#94a3b8";
    ctx.font = "600 32px -apple-system, BlinkMacSystemFont, Inter, sans-serif";
    ctx.textBaseline = "middle";
    ctx.fillText("AegisPod", 36, 66);

    ctx.fillStyle = "#64748b";
    ctx.font = "600 18px ui-monospace, SFMono-Regular, monospace";
    ctx.fillText(labelText, 36, 112);

    // Recessed digital counter box (Shredline homage!)
    ctx.fillStyle = "#05070a";
    ctx.fillRect(322, 36, 108, 88);
    ctx.strokeStyle = "#1f2430";
    ctx.lineWidth = 3;
    ctx.strokeRect(322, 36, 108, 88);

    ctx.fillStyle = statusColor;
    ctx.font = "700 54px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.textAlign = "center";
    ctx.fillText(countStr, 376, 84);
    ctx.textAlign = "left";

    // Hardware LED indicator dot
    ctx.beginPath();
    ctx.arc(466, 80, 14, 0, Math.PI * 2);
    ctx.fillStyle = statusColor;
    ctx.shadowColor = statusColor;
    ctx.shadowBlur = 18;
    ctx.fill();
    ctx.shadowBlur = 0;

    this.oledTex.needsUpdate = true;
    return this.oledTex;
  }

  _buildPod() {
    this.podGroup = new THREE.Group();
    this.scene.add(this.podGroup);

    const darkMetal = new THREE.MeshStandardMaterial({
      color: 0x1d2027,
      roughness: 0.34,
      metalness: 0.62,
    });
    const satinAlloy = new THREE.MeshStandardMaterial({
      color: 0x2c313d,
      roughness: 0.46,
      metalness: 0.65,
    });
    const innerChamberMat = new THREE.MeshStandardMaterial({
      color: 0x090b10,
      roughness: 0.6,
      metalness: 0.3,
    });

    // Main horizontal sleek capsule chassis (tactile Dieter Rams hardware silhouette)
    const chassisGeo = new THREE.BoxGeometry(2.55, 1.18, 1.38);
    // Bevel visual via layered rounded caps + central core
    const body = new THREE.Mesh(chassisGeo, darkMetal);
    body.position.y = -0.15;
    this.podGroup.add(body);

    // Side cylindrical capsule end-caps for true escape-pod silhouette
    const sideCapGeo = new THREE.CylinderGeometry(0.59, 0.59, 1.38, 32);
    sideCapGeo.rotateX(Math.PI / 2);
    const leftCap = new THREE.Mesh(sideCapGeo, darkMetal);
    leftCap.position.set(-1.27, -0.15, 0);
    this.podGroup.add(leftCap);

    const rightCap = new THREE.Mesh(sideCapGeo, darkMetal);
    rightCap.position.set(1.27, -0.15, 0);
    this.podGroup.add(rightCap);

    // Metallic titanium structural bands
    const bandGeo = new THREE.TorusGeometry(0.62, 0.045, 16, 40);
    const bandL = new THREE.Mesh(bandGeo, satinAlloy);
    bandL.rotation.y = Math.PI / 2;
    bandL.position.set(-1.05, -0.15, 0);
    this.podGroup.add(bandL);

    const bandR = new THREE.Mesh(bandGeo, satinAlloy);
    bandR.rotation.y = Math.PI / 2;
    bandR.position.set(1.05, -0.15, 0);
    this.podGroup.add(bandR);

    // Top intake slot cavity (recessed glowing intake like Shredline slot!)
    const slotCavity = new THREE.Mesh(
      new THREE.BoxGeometry(1.92, 0.22, 0.58),
      innerChamberMat
    );
    slotCavity.position.set(0, 0.38, 0);
    this.podGroup.add(slotCavity);

    this.intakeGlowMat = new THREE.MeshBasicMaterial({
      color: 0x10b981,
      transparent: true,
      opacity: 0.22,
    });
    this.intakeGlow = new THREE.Mesh(
      new THREE.PlaneGeometry(1.82, 0.44),
      this.intakeGlowMat
    );
    this.intakeGlow.rotation.x = -Math.PI / 2;
    this.intakeGlow.position.set(0, 0.46, 0);
    this.podGroup.add(this.intakeGlow);

    // Motorized dual armored hatch doors
    const doorGeo = new THREE.BoxGeometry(0.98, 0.1, 0.56);
    this.doorLeft = new THREE.Mesh(doorGeo, satinAlloy);
    this.doorLeft.position.set(-0.49, 0.49, 0);
    this.podGroup.add(this.doorLeft);

    this.doorRight = new THREE.Mesh(doorGeo, satinAlloy);
    this.doorRight.position.set(0.49, 0.49, 0);
    this.podGroup.add(this.doorRight);

    // Front recessed OLED display panel
    const oledTex = this._createOledTexture("00", "#10b981", "ARMED · 60S BRAKE");
    const oledPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(2.05, 0.64),
      new THREE.MeshBasicMaterial({ map: oledTex })
    );
    oledPlane.position.set(0, -0.16, 0.701);
    this.podGroup.add(oledPlane);

    // Twin bottom plasma thrusters
    const nozzleGeo = new THREE.CylinderGeometry(0.22, 0.32, 0.28, 24);
    const nozzleL = new THREE.Mesh(nozzleGeo, satinAlloy);
    nozzleL.position.set(-0.72, -0.82, 0);
    this.podGroup.add(nozzleL);

    const nozzleR = new THREE.Mesh(nozzleGeo, satinAlloy);
    nozzleR.position.set(0.72, -0.82, 0);
    this.podGroup.add(nozzleR);

    // Plasma flame cones (hidden until launch)
    const flameGeo = new THREE.ConeGeometry(0.28, 1.35, 20);
    flameGeo.rotateX(Math.PI);
    this.flameMat = new THREE.MeshBasicMaterial({
      color: 0x34d399,
      transparent: true,
      opacity: 0,
    });
    this.flameL = new THREE.Mesh(flameGeo, this.flameMat);
    this.flameL.position.set(-0.72, -1.55, 0);
    this.podGroup.add(this.flameL);

    this.flameR = new THREE.Mesh(flameGeo, this.flameMat);
    this.flameR.position.set(0.72, -1.55, 0);
    this.podGroup.add(this.flameR);

    // Clickable raycaster hit target
    this.raycaster = new THREE.Raycaster();
  }

  _bindEvents() {
    this._onResize = () => this._resize();
    window.addEventListener("resize", this._onResize);

    this._onPointerMove = (e) => {
      const rect = this.canvas.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      this.pointer.y = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
    };
    window.addEventListener("pointermove", this._onPointerMove);

    this._onClick = (e) => {
      if (!this.onPodClick) return;
      const rect = this.canvas.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      const y = -(((e.clientY - rect.top) / rect.height) * 2 - 1);
      this.raycaster.setFromCamera({ x, y }, this.camera);
      const hits = this.raycaster.intersectObject(this.podGroup, true);
      if (hits.length > 0) {
        this.onPodClick();
      }
    };
    this.canvas.addEventListener("click", this._onClick);
  }

  _resize() {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const w = parent.clientWidth || 640;
    const h = parent.clientHeight || 360;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // Slight zoom out on narrow portrait phones so the capsule never clips
    this.camera.position.z = w < 560 ? 8.1 : 6.1;
    this.camera.updateProjectionMatrix();
  }

  setMode(newMode, count = this.packedCount) {
    if (this.mode === "packing" || this.mode === "launching") {
      if (newMode === "idle" || newMode === "alert") return; // don't interrupt active launch animation
    }
    this.mode = newMode;
    this.packedCount = count;

    if (newMode === "idle") {
      this.targetDoorOpen = 0;
      this.thrusterPower = 0;
      this.podY = 0;
      this.podVelY = 0;
      this.intakeGlowMat.color.setHex(0x10b981);
      this.coreLight.color.setHex(0x10b981);
      this._createOledTexture("00", "#10b981", "ARMED · 60S BRAKE");
    } else if (newMode === "alert") {
      this.targetDoorOpen = 1;
      this.thrusterPower = 0;
      this.podY = 0;
      this.podVelY = 0;
      this.intakeGlowMat.color.setHex(0xef4444);
      this.coreLight.color.setHex(0xef4444);
      this._createOledTexture("!!", "#ef4444", "BRAKE LOCKED · PULL");
    } else if (newMode === "secured") {
      this.targetDoorOpen = 0;
      this.thrusterPower = 0;
      this.podY = 0;
      this.podVelY = 0;
      this.intakeGlowMat.color.setHex(0x10b981);
      this.coreLight.color.setHex(0x10b981);
      const padded = String(Math.max(5, count)).padStart(2, "0");
      this._createOledTexture(padded, "#34d399", "COLD VAULT · SAFE");
    }
  }

  /**
   * Triggers the signature Shredline-inspired vacuum packing + shred confetti + plasma liftoff!
   */
  playEscapeSequence(onTickSound, onLaunchSound, onComplete) {
    this.mode = "packing";
    this.packedCount = 0;
    this.targetDoorOpen = 1;
    this.intakeGlowMat.color.setHex(0x22d3ee);
    this.coreLight.color.setHex(0x22d3ee);
    this._createOledTexture("00", "#22d3ee", "PACKING 5 ASSETS...");

    // Spawn 5 physical 3D asset tokens from outer desk coordinates diving into the capsule slot!
    const tokenConfigs = [
      { color: 0x26a17b, start: [-3.2, 1.35, 0.3], label: "mUSDT" },
      { color: 0x627eea, start: [3.1, 1.4, 0.2], label: "mWETH" },
      { color: 0xf7931a, start: [-2.8, -0.9, 0.5], label: "mWBTC" },
      { color: 0x836ef9, start: [2.9, -0.85, 0.5], label: "MON" },
      { color: 0xf59e0b, start: [0.0, 2.3, 0.4], label: "NFT" },
    ];

    tokenConfigs.forEach((cfg, idx) => {
      setTimeout(() => {
        const mesh = new THREE.Mesh(
          new THREE.BoxGeometry(0.62, 0.42, 0.08),
          new THREE.MeshStandardMaterial({
            color: cfg.color,
            roughness: 0.25,
            metalness: 0.4,
            emissive: cfg.color,
            emissiveIntensity: 0.25,
          })
        );
        mesh.position.set(cfg.start[0], cfg.start[1], cfg.start[2]);
        this.scene.add(mesh);
        this.flyingTokens.push({
          mesh,
          start: new THREE.Vector3(...cfg.start),
          progress: 0,
          idx: idx + 1,
          counted: false,
          onCount: () => {
            this.packedCount = idx + 1;
            this.shake = 0.08;
            this._createOledTexture(`0${this.packedCount}`, "#34d399", `PACKED ${this.packedCount}/5`);
            if (onTickSound) onTickSound(this.packedCount);
          },
        });
      }, idx * 140);
    });

    // Spawn Shredline-style voided scam paper shreds falling from underneath!
    setTimeout(() => {
      this._spawnScamConfetti();
    }, 280);

    // Seal armored hatch doors & ignite plasma thrusters!
    setTimeout(() => {
      this.targetDoorOpen = 0;
      this._createOledTexture("05", "#34d399", "SEALED · IGNITING");
    }, 1050);

    setTimeout(() => {
      this.mode = "launching";
      this.thrusterPower = 1;
      this.podVelY = 0.02;
      this._createOledTexture("05", "#34d399", "HYPER-JUMPING...");
      if (onLaunchSound) onLaunchSound();
    }, 1350);

    // Dock safely in secured state (returns cleanly into view as Emerald Cold Pod)
    setTimeout(() => {
      this.mode = "secured";
      this.thrusterPower = 0;
      this.podY = 3.6; // gently descend back in as docked Cold Vault confirmation
      this.podVelY = 0;
      this._createOledTexture("05", "#34d399", "COLD VAULT · SAFE");
      if (onComplete) onComplete();
    }, 2400);
  }

  _spawnScamConfetti() {
    const stripGeo = new THREE.PlaneGeometry(0.11, 0.34);
    for (let i = 0; i < 28; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: i % 3 === 0 ? 0xef4444 : i % 3 === 1 ? 0xfca5a5 : 0xfef2f2,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.95,
      });
      const mesh = new THREE.Mesh(stripGeo, mat);
      mesh.position.set((Math.random() - 0.5) * 1.6, -0.65, (Math.random() - 0.5) * 0.5);
      this.scene.add(mesh);
      this.confetti.push({
        mesh,
        vx: (Math.random() - 0.5) * 0.045,
        vy: -0.02 - Math.random() * 0.04,
        vz: (Math.random() - 0.5) * 0.03,
        rx: (Math.random() - 0.5) * 0.2,
        ry: (Math.random() - 0.5) * 0.25,
        life: 1.0,
      });
    }
  }

  _loop() {
    if (this.disposed) return;
    requestAnimationFrame(() => this._loop());

    this.time += 0.016;

    // Smooth parallax follow
    this.smoothPointer.x += (this.pointer.x - this.smoothPointer.x) * 0.06;
    this.smoothPointer.y += (this.pointer.y - this.smoothPointer.y) * 0.06;

    // Smooth motorized hatch doors
    this.doorOpen += (this.targetDoorOpen - this.doorOpen) * 0.14;
    this.doorLeft.position.x = -0.49 - this.doorOpen * 0.52;
    this.doorRight.position.x = 0.49 + this.doorOpen * 0.52;

    // Pod vertical motion & hover
    let hover = Math.sin(this.time * 2.1) * 0.06;
    if (this.mode === "launching") {
      this.podVelY += 0.011;
      this.podY += this.podVelY;
      hover = 0;
      this.shake = 0.045;
    } else if (this.mode === "secured") {
      this.podY += (0 - this.podY) * 0.08;
    } else {
      this.podY += (0 - this.podY) * 0.12;
    }

    // Decay mechanical shake
    this.shake *= 0.88;
    const shakeX = (Math.random() - 0.5) * this.shake;
    const shakeY = (Math.random() - 0.5) * this.shake;

    this.podGroup.position.set(shakeX, this.podY + hover + shakeY, 0);
    this.podGroup.rotation.y = this.smoothPointer.x * 0.24;
    this.podGroup.rotation.x = -this.smoothPointer.y * 0.14 + (this.mode === "alert" ? 0.16 : 0.08);

    // Shadow shrinks as pod lifts off
    const shadowScale = Math.max(0.25, 1 - Math.max(0, this.podY) * 0.22);
    this.shadowMesh.scale.set(shadowScale, shadowScale, 1);
    this.shadowMesh.material.opacity = Math.max(0.05, shadowScale);

    // Intake & core pulsing glow
    if (this.mode === "alert") {
      const pulse = 0.55 + Math.sin(this.time * 10) * 0.45;
      this.intakeGlowMat.opacity = 0.35 + pulse * 0.55;
      this.coreLight.intensity = 1.6 + pulse * 2.4;
      this.padRing.material.color.setHex(0xef4444);
      this.padRing.material.opacity = 0.4 + pulse * 0.45;
    } else if (this.mode === "packing" || this.mode === "launching") {
      this.intakeGlowMat.opacity = 0.85;
      this.coreLight.intensity = 3.2;
      this.padRing.material.color.setHex(0x10b981);
      this.padRing.material.opacity = 0.7;
    } else if (this.mode === "secured") {
      this.intakeGlowMat.opacity = 0.25;
      this.coreLight.intensity = 1.0;
      this.padRing.material.color.setHex(0x10b981);
      this.padRing.material.opacity = 0.5;
    } else {
      this.intakeGlowMat.opacity = 0.15;
      this.coreLight.intensity = 0.4;
      this.padRing.material.color.setHex(0x94a3b8);
      this.padRing.material.opacity = 0.28;
    }

    // Plasma thruster flames
    if (this.thrusterPower > 0.01) {
      const flicker = 0.85 + Math.random() * 0.4;
      this.flameMat.opacity = 0.85;
      this.flameL.scale.set(1, flicker, 1);
      this.flameR.scale.set(1, flicker, 1);
    } else {
      this.flameMat.opacity = 0;
    }

    // Animate 5 vacuum-sucked asset tokens curving into the top hatch
    for (let i = this.flyingTokens.length - 1; i >= 0; i--) {
      const t = this.flyingTokens[i];
      t.progress += 0.055;
      const p = Math.min(1, t.progress);
      // Cubic ease-in suction curve
      const ease = p * p * (3 - 2 * p);
      const arcY = Math.sin(p * Math.PI) * 1.15;
      t.mesh.position.set(
        THREE.MathUtils.lerp(t.start.x, 0, ease),
        THREE.MathUtils.lerp(t.start.y, 0.35, ease) + arcY,
        THREE.MathUtils.lerp(t.start.z, 0, ease)
      );
      t.mesh.rotation.x += 0.18;
      t.mesh.rotation.y += 0.24;
      const s = Math.max(0.05, 1 - ease * 0.85);
      t.mesh.scale.set(s, s, s);

      if (p >= 1) {
        if (!t.counted) {
          t.counted = true;
          t.onCount();
        }
        this.scene.remove(t.mesh);
        t.mesh.geometry.dispose();
        t.mesh.material.dispose();
        this.flyingTokens.splice(i, 1);
      }
    }

    // Animate Shredline-style voided scam paper confetti
    for (let i = this.confetti.length - 1; i >= 0; i--) {
      const c = this.confetti[i];
      c.mesh.position.x += c.vx;
      c.mesh.position.y += c.vy;
      c.mesh.position.z += c.vz;
      c.vy -= 0.0012;
      c.mesh.rotation.x += c.rx;
      c.mesh.rotation.y += c.ry;
      c.life -= 0.014;
      c.mesh.material.opacity = Math.max(0, c.life);
      if (c.life <= 0) {
        this.scene.remove(c.mesh);
        c.mesh.geometry.dispose();
        c.mesh.material.dispose();
        this.confetti.splice(i, 1);
      }
    }

    this.renderer.render(this.scene, this.camera);
  }
}
