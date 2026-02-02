import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshSurfaceSampler } from "three/addons/math/MeshSurfaceSampler.js";

const canvas = document.getElementById("scene");
const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(0x0b0e13, 1);

const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
camera.position.set(0, 0, 2);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.enablePan = true;
controls.screenSpacePanning = true;
controls.autoRotate = false;

const ambient = new THREE.AmbientLight(0xffffff, 0.7);
scene.add(ambient);

const keyLight = new THREE.DirectionalLight(0xffffff, 0.8);
keyLight.position.set(1, 2, 3);
scene.add(keyLight);

const loader = new GLTFLoader();
const modelGroup = new THREE.Group();
scene.add(modelGroup);

const raycaster = new THREE.Raycaster();
raycaster.params.Points.threshold = 0.05;
const pointer = new THREE.Vector2();
let isHovering = false;
const targetMouse = new THREE.Vector3();
const currentMouse = new THREE.Vector3();
const prevMouse = new THREE.Vector3();
const currentDir = new THREE.Vector3(1, 0, 0);
const targetDir = new THREE.Vector3(1, 0, 0);
const mouseSmooth = 0.12;
const deformMaterials = [];
const deformRadius = 0.18;
const deformStrength = 0.08;
const jitterAmplitude = 0.006;
const jitterSpeed = 0.9;
const deformPlane = new THREE.Plane();
const modelCenter = new THREE.Vector3();

const fitCameraToModel = () => {
    const box = new THREE.Box3().setFromObject(modelGroup);
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);

    modelGroup.position.sub(center);
    const maxDim = Math.max(size.x, size.y, size.z);
    const scale = 1.1 / maxDim;
    modelGroup.scale.setScalar(scale);
    modelGroup.rotation.set(-Math.PI / 2, 0, 0);

    const fittedBox = new THREE.Box3().setFromObject(modelGroup);
    const fittedCenter = new THREE.Vector3();
    const fittedSize = new THREE.Vector3();
    fittedBox.getCenter(fittedCenter);
    fittedBox.getSize(fittedSize);
    modelCenter.copy(fittedCenter);

    const fov = THREE.MathUtils.degToRad(camera.fov);
    const fitHeightDistance = (fittedSize.y / 2) / Math.tan(fov / 2);
    const fitWidthDistance = (fittedSize.x / 2) / (Math.tan(fov / 2) * camera.aspect);
    const distance = 1.05 * Math.max(fitHeightDistance, fitWidthDistance, 1);

    camera.near = Math.max(distance / 500, 0.001);
    camera.far = Math.max(distance * 500, 1000);
    camera.updateProjectionMatrix();

    controls.minDistance = distance * 0.2;
    controls.maxDistance = distance * 6;
    controls.target.copy(fittedCenter);
    camera.position.set(fittedCenter.x, fittedCenter.y, fittedCenter.z + distance);
    camera.lookAt(fittedCenter);
    controls.update();
};

const getDominantAxis = (mesh) => {
    const box = new THREE.Box3().setFromObject(mesh);
    const size = new THREE.Vector3();
    box.getSize(size);
    if (size.x >= size.y && size.x >= size.z) return 0;
    if (size.y >= size.z) return 1;
    return 2;
};

const createPointMaterial = ({ size, opacity, depthWrite }) => {
    const material = new THREE.ShaderMaterial({
        transparent: opacity < 1,
        depthWrite,
        depthTest: true,
        uniforms: {
            uSize: { value: size },
            uOpacity: { value: opacity },
            uMouse: { value: new THREE.Vector3(0, 0, 0) },
            uRadius: { value: deformRadius },
            uStrength: { value: deformStrength },
            uActive: { value: 0 },
            uDir: { value: new THREE.Vector3(1, 0, 0) },
            uTime: { value: 0 },
            uJitterAmp: { value: jitterAmplitude },
            uJitterSpeed: { value: jitterSpeed },
            uMaskPhase: { value: 0 },
            uScanSpeed: { value: 0.7 },
            uScanWidth: { value: 1.4 },
            uScanStrength: { value: 0.7 },
            uMorph: { value: 0 },
            uMorphMode: { value: 0 },
            uSlicePos: { value: 0 },
            uSliceWidth: { value: 0.28 },
            uDensityPulse: { value: 0.0 },
            uEdgePulse: { value: 0.0 },
        },
        vertexShader: `
            precision highp float;
            attribute vec3 color;
            attribute vec3 base;
            varying vec3 vColor;
            varying vec3 vPos;
            uniform float uSize;
            uniform vec3 uMouse;
            uniform float uRadius;
            uniform float uStrength;
            uniform float uActive;
            uniform vec3 uDir;
            uniform float uTime;
            uniform float uJitterAmp;
            uniform float uJitterSpeed;
            uniform float uMaskPhase;
            uniform float uScanSpeed;
            uniform float uScanWidth;
            uniform float uScanStrength;
            uniform float uMorph;
            uniform float uMorphMode;
            uniform float uSlicePos;
            uniform float uSliceWidth;
            uniform float uDensityPulse;
            uniform float uEdgePulse;

            float hash(vec3 p) {
                p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
                p *= 17.0;
                return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
            }

            void main() {
                float h1 = hash(base + vec3(1.0, 0.0, 0.0));
                float h2 = hash(base + vec3(0.0, 1.0, 0.0));
                float h3 = hash(base + vec3(0.0, 0.0, 1.0));
                float theta = h1 * 6.2831853;
                float phi = acos(1.0 - 2.0 * h2);
                vec3 sphere = vec3(
                    sin(phi) * cos(theta),
                    cos(phi),
                    sin(phi) * sin(theta)
                ) * 0.9;
                float u = h1 * 6.2831853;
                float v = h2 * 6.2831853;
                float R = 0.7;
                float r = 0.25;
                vec3 torus = vec3(
                    (R + r * cos(v)) * cos(u),
                    r * sin(v),
                    (R + r * cos(v)) * sin(u)
                );
                vec3 line = vec3((h2 - 0.5) * 0.12, (h1 * 2.0 - 1.0) * 1.1, (h3 - 0.5) * 0.12);
                vec3 target = sphere;
                if (uMorphMode > 0.5 && uMorphMode < 1.5) {
                    target = torus;
                } else if (uMorphMode >= 1.5) {
                    target = line;
                }

                vec3 displaced = base;
                float h = hash(position);
                vec3 jitter = vec3(
                    sin(uTime * uJitterSpeed + h * 6.2831),
                    sin(uTime * uJitterSpeed * 1.3 + h * 9.4247),
                    sin(uTime * uJitterSpeed * 1.7 + h * 12.566)
                );
                displaced += jitter * uJitterAmp;
                if (uActive > 0.5) {
                    float d = distance(displaced, uMouse);
                    float f = clamp(1.0 - d / uRadius, 0.0, 1.0);
                    vec3 pushDir = normalize(uDir + vec3(1e-6));
                    displaced += pushDir * (f * f) * uStrength;
                }
                vec3 base = color * 0.75;
                float mask = exp(-pow((displaced.y - uMaskPhase) * 1.2, 2.0));
                base = mix(base, base * 1.2, mask);
                float scanCenter = sin(uTime * uScanSpeed) * 0.9;
                float scan = exp(-pow((displaced.y - scanCenter) * uScanWidth, 2.0));
                base = mix(base, base * 1.35, scan * uScanStrength);
                float edgeEcho = exp(-pow((abs(displaced.x) - 0.35) * 3.2, 2.0));
                base = mix(base, base * 1.35, edgeEcho * uEdgePulse);
                float drift = 0.04 * sin(uTime * 0.7 + displaced.y * 2.0);
                vec3 darkBlue = vec3(0.18, 0.26, 0.45);
                vec3 darkTeal = vec3(0.14, 0.34, 0.38);
                float g = clamp((displaced.y + 0.9) / 1.8, 0.0, 1.0);
                vec3 tint = mix(darkBlue, darkTeal, g);
                vColor = mix(base, tint, 0.35) + vec3(drift);
                vPos = displaced;
                vec4 mvPosition = modelViewMatrix * vec4(displaced, 1.0);
                gl_PointSize = uSize * (300.0 / -mvPosition.z);
                gl_Position = projectionMatrix * mvPosition;
            }
        `,
        fragmentShader: `
            precision highp float;
            varying vec3 vColor;
            varying vec3 vPos;
            uniform float uOpacity;
            uniform float uSlicePos;
            uniform float uSliceWidth;
            uniform float uDensityPulse;
            void main() {
                vec2 c = gl_PointCoord - vec2(0.5);
                float r = length(c);
                float slice = smoothstep(uSliceWidth, 0.0, abs(vPos.y - uSlicePos));
                float alpha = smoothstep(0.5, 0.0, r) * uOpacity * (0.7 + uDensityPulse) * slice;
                gl_FragColor = vec4(vColor, alpha);
            }
        `,
    });
    deformMaterials.push(material);
    return material;
};

const buildPointCloud = (mesh, options) => {
    const {
        count = 160000,
        inner = false,
        edgeOnly = false,
        size = 0.003,
        opacity = 0.9,
        edgeThreshold = 0.65,
        colorBoost = 1,
        gamma = 1,
        edgeContrast = 0,
    } = options;
    if (!mesh.geometry.hasAttribute("normal")) {
        mesh.geometry.computeVertexNormals();
    }
    const sampler = new MeshSurfaceSampler(mesh);
    if (mesh.geometry.hasAttribute("color")) {
        sampler.setColorAttribute("color");
    }
    sampler.build();
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const tempPosition = new THREE.Vector3();
    const tempNormal = new THREE.Vector3();
    const tempColor = new THREE.Color();
    const fallbackColor = new THREE.Color(
        mesh.material?.color ?? 0x8fd3ff
    );

    const bbox = new THREE.Box3().setFromObject(mesh);
    const bboxSize = new THREE.Vector3();
    bbox.getSize(bboxSize);
    const innerDepth = 0.03 * Math.max(bboxSize.x, bboxSize.y, bboxSize.z);

    const axis = getDominantAxis(mesh);
    let i = 0;
    let attempts = 0;
    const maxAttempts = count * 25;
    while (i < count && attempts < maxAttempts) {
        attempts += 1;
        let depthNormalized = 0;
        if (mesh.geometry.hasAttribute("color")) {
            sampler.sample(tempPosition, tempNormal, tempColor);
        } else {
            sampler.sample(tempPosition, tempNormal);
            tempColor.copy(fallbackColor);
        }

        const axisComponent = Math.abs(tempNormal.getComponent(axis));
        const normalPerp = Math.sqrt(Math.max(0, 1 - axisComponent * axisComponent));
        if (edgeOnly) {
            if (normalPerp < edgeThreshold) {
                continue;
            }
        }
        if (inner) {
            const depth = innerDepth * (0.1 + Math.pow(Math.random(), 2.2) * 0.9);
            depthNormalized = depth / innerDepth;
            tempPosition.addScaledVector(tempNormal, -depth);
        }
        const normalShade = 0.75 + 0.25 * (tempNormal.y * 0.5 + 0.5);
        const depthShade = Math.pow(1 - depthNormalized, 2.4);
        const contourBoost = 1 + edgeContrast * normalPerp;
        tempColor.multiplyScalar(normalShade * (0.35 + 0.65 * depthShade) * colorBoost * contourBoost);
        tempColor.r = Math.pow(tempColor.r, gamma);
        tempColor.g = Math.pow(tempColor.g, gamma);
        tempColor.b = Math.pow(tempColor.b, gamma);
        positions[i * 3] = tempPosition.x;
        positions[i * 3 + 1] = tempPosition.y;
        positions[i * 3 + 2] = tempPosition.z;
        colors[i * 3] = tempColor.r;
        colors[i * 3 + 1] = tempColor.g;
        colors[i * 3 + 2] = tempColor.b;
        i += 1;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute("base", new THREE.BufferAttribute(positions.slice(), 3));

    const material = createPointMaterial({
        size,
        opacity,
        depthWrite: opacity === 1,
    });

    const points = new THREE.Points(geometry, material);
    return points;
};

const offsetPoints = (points, offset) => {
    const posAttr = points.geometry.getAttribute("position");
    for (let i = 0; i < posAttr.count; i += 1) {
        const ix = i * 3;
        posAttr.array[ix] += offset.x;
        posAttr.array[ix + 1] += offset.y;
        posAttr.array[ix + 2] += offset.z;
    }
    posAttr.needsUpdate = true;
};

loader.load(
    "feder.glb",
    (gltf) => {
        modelGroup.clear();
        deformMaterials.length = 0;
        let sourceMesh = null;
        gltf.scene.traverse((child) => {
            if (child.isMesh && !sourceMesh) {
                sourceMesh = child;
            }
        });

        if (!sourceMesh) {
            console.error("Kein Mesh in feder.glb gefunden.");
            return;
        }

        const surfacePoints = buildPointCloud(sourceMesh, {
            count: 120000,
            inner: false,
            size: 0.0042,
            opacity: 1,
            colorBoost: 1.1,
            gamma: 0.9,
            edgeContrast: 0.35,
        });
        const edgePoints = buildPointCloud(sourceMesh, {
            count: 70000,
            inner: false,
            edgeOnly: true,
            edgeThreshold: 0.55,
            size: 0.0052,
            opacity: 1,
            colorBoost: 1.45,
            gamma: 0.8,
            edgeContrast: 0.75,
        });
        const innerPoints = buildPointCloud(sourceMesh, {
            count: 45000,
            inner: true,
            size: 0.0036,
            opacity: 0.3,
            colorBoost: 0.9,
            gamma: 1,
        });
        const ghostPoints = buildPointCloud(sourceMesh, {
            count: 80000,
            inner: false,
            size: 0.0044,
            opacity: 0.22,
            colorBoost: 0.7,
            gamma: 1.1,
        });
        offsetPoints(ghostPoints, new THREE.Vector3(0.02, -0.02, 0.03));
        modelGroup.add(surfacePoints);
        modelGroup.add(edgePoints);
        modelGroup.add(innerPoints);
        modelGroup.add(ghostPoints);
        fitCameraToModel();
    },
    undefined,
    (error) => {
        console.error("GLB konnte nicht geladen werden:", error);
    }
);

const updatePointer = (event) => {
    const rect = canvas.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    pointer.set(x * 2 - 1, -(y * 2 - 1));
};

const updateDeformTarget = () => {
    raycaster.setFromCamera(pointer, camera);
    const intersects = raycaster.intersectObjects(modelGroup.children, false);
    if (!intersects.length) return false;
    const hit = intersects[0].point;
    const localHit = modelGroup.worldToLocal(hit.clone());
    prevMouse.copy(targetMouse);
    targetMouse.copy(localHit);
    const dir = targetMouse.clone().sub(prevMouse);
    if (dir.lengthSq() > 1e-6) {
        targetDir.copy(dir.normalize());
    }
    return true;
};

const resize = () => {
    const width = canvas.clientWidth || window.innerWidth;
    const height = canvas.clientHeight || window.innerHeight;
    const aspect = width / height || 1;

    camera.aspect = aspect;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
};

const animate = () => {
    controls.update();
    if (isHovering) {
        updateDeformTarget();
    }
    currentMouse.lerp(targetMouse, mouseSmooth);
    currentDir.lerp(targetDir, 0.18).normalize();
    deformMaterials.forEach((mat) => {
        mat.uniforms.uMouse.value.copy(currentMouse);
        mat.uniforms.uActive.value = isHovering ? 1 : 0;
        mat.uniforms.uDir.value.copy(currentDir);
        const time = performance.now() * 0.001;
        mat.uniforms.uTime.value = time;
        mat.uniforms.uMaskPhase.value = Math.sin(time * 0.6) * 0.8;
        mat.uniforms.uScanSpeed.value = 0.6 + 0.2 * Math.sin(time * 0.2);
        mat.uniforms.uScanStrength.value = 0.6 + 0.3 * Math.sin(time * 0.4);
        mat.uniforms.uMorph.value = 0;
        mat.uniforms.uMorphMode.value = 0;
        mat.uniforms.uSlicePos.value = Math.sin(time * 0.35) * 0.35;
        mat.uniforms.uDensityPulse.value = 0.25 + 0.25 * Math.sin(time * 0.9);
        mat.uniforms.uEdgePulse.value = 0.35 + 0.35 * Math.sin(time * 0.7);
    });
    renderer.render(scene, camera);
    requestAnimationFrame(animate);
};

window.addEventListener("resize", resize);
canvas.addEventListener("pointerdown", (event) => {
    if (event.button === 2) {
        controls.enabled = true;
        return;
    }
});
canvas.addEventListener("pointermove", (event) => {
    updatePointer(event);
    isHovering = true;
});
canvas.addEventListener("pointerleave", () => {
    isHovering = false;
});

canvas.addEventListener("contextmenu", (event) => event.preventDefault());
resize();
animate();

/*
document.addEventListener("DOMContentLoaded", async () => {
    const sceneEl = document.getElementById('scene');
    const overlay = document.getElementById('overlay');
    const baseImage = new Image();
    const FEATHER_URL = 'scene.gltf'; // nutzt die importierte Sketchfab-Szene (scene.gltf + scene.bin im selben Ordner)
    const FEATHER_NAME_MATCH = '';     // optional: Teilstring, z.B. "Object_2" für eine bestimmte Feder
    const FEATHER_MESH_INDEX = null;   // null = Auto; Zahl = fester Mesh-Index
    const AUTO_CYCLE_ENABLED = true;   // rotiert automatisch durch alle Meshes, damit du den passenden siehst
    const MANUAL_CYCLE_KEYS = { next: 'ArrowRight', prev: 'ArrowLeft' }; // Tastatur zum Durchsteppen
    baseImage.src = "schritt5.webp";  // nur noch Fallback, falls GLTF nicht lädt

    if (!sceneEl) {
        console.error('Scene Element fehlt.');
        return;
    }

    async function loadThree() {
        const sources = [
            'https://unpkg.com/three@0.161.0/build/three.module.js',
            'https://cdn.jsdelivr.net/npm/three@0.161.0/build/three.module.js',
            'https://esm.sh/three@0.161.0',
        ];
        let lastError = null;
        for (const src of sources) {
            try {
                return await import(src);
            } catch (err) {
                lastError = err;
                console.warn(`Three.js Quelle fehlgeschlagen: ${src}`, err);
            }
        }
        throw lastError || new Error('Three.js konnte aus keiner Quelle geladen werden');
    }

    async function loadNoise() {
        const sources = [
            'https://esm.sh/simplex-noise@4.0.1',
            'https://cdn.jsdelivr.net/npm/simplex-noise@4.0.1',
        ];
        let lastError = null;
        for (const src of sources) {
            try {
                return await import(src);
            } catch (err) {
                lastError = err;
                console.warn(`Simplex Noise Quelle fehlgeschlagen: ${src}`, err);
            }
        }
        throw lastError || new Error('Simplex Noise konnte nicht geladen werden');
    }

    async function loadGltfHelpers() {
        const loaders = [
            'https://unpkg.com/three@0.161.0/examples/jsm/loaders/GLTFLoader.js?module',
            'https://cdn.jsdelivr.net/npm/three@0.161.0/examples/jsm/loaders/GLTFLoader.js?module'
        ];
        const samplers = [
            'https://unpkg.com/three@0.161.0/examples/jsm/math/MeshSurfaceSampler.js?module',
            'https://cdn.jsdelivr.net/npm/three@0.161.0/examples/jsm/math/MeshSurfaceSampler.js?module'
        ];

        let GLTFLoader = null;
        let MeshSurfaceSampler = null;
        let lastError = null;

        for (const src of loaders) {
            try {
                const mod = await import(src);
                GLTFLoader = mod.GLTFLoader;
                break;
            } catch (err) {
                lastError = err;
                console.warn(`GLTFLoader Quelle fehlgeschlagen: ${src}`, err);
            }
        }
        for (const src of samplers) {
            try {
                const mod = await import(src);
                MeshSurfaceSampler = mod.MeshSurfaceSampler;
                break;
            } catch (err) {
                lastError = err;
                console.warn(`MeshSurfaceSampler Quelle fehlgeschlagen: ${src}`, err);
            }
        }
        if (!GLTFLoader || !MeshSurfaceSampler) {
            throw lastError || new Error('GLTF Tools konnten nicht geladen werden');
        }
        return { GLTFLoader, MeshSurfaceSampler };
    }

    let THREE = null;
    let noise3D = null;
    try {
        THREE = await loadThree();
        const noiseModule = await loadNoise();
        noise3D = noiseModule.createNoise3D();
        if (overlay) {
            overlay.querySelector('.subtitle').textContent = 'Jeder Pixel der Feder als Punkt im Raum · Maus bewegen zum Neigen · Klick = Morph';
        }
    } catch (err) {
        if (overlay) {
            overlay.querySelector('.subtitle').textContent = 'Three.js oder Noise blockiert. Bitte Adblock/Shields aus oder lokal erneut laden.';
        }
        return;
    }

    // --- Three.js state ---
    let renderer = null;
    let scene = null;
    let camera = null;
    let points = null;
    let pointsMaterial = null;
    let anim = null;
    let targetRotX = 0;
    let targetRotY = 0;
    let targetZoom = 420;
    let baseFeatherPositions = null;
    let startPositions = null;
    let driftOffsets = null;
    let driftPhase = null;
    let driftFreq = null;
    let driftAmp = null;
    let morphStart = performance.now();
    let morphFrom = null;
    let morphTo = null;
    let formations = ['feder', 'torus', 'shell'];
    let formationIndex = 0;

    // GLTF cache & Auswahl
    let cachedGltf = null;
    let cachedMeshes = null;
    let meshInfoCache = null;
    let currentMeshInfo = null;
    let cycleIndex = 0;
    let cycleTimer = null;
    const autoCycleMs = 5200;
    let selectedMesh = null;
    let selectedMeshCenter = null;
    let selectedMeshScale = 1;
    let meshObject = null;
    let showMeshMode = false;

    // zentrale Stellschrauben für Bewegung/Tempo
    const motionConfig = {
        morphDuration: 2200,     // ms für Form-Morph
        timeScale: 0.00038,      // globales Zeitscaling für Noise/Wiggle
        flowStrength: 2.8,       // weniger Drift für mehr Detail-Ruhe
        noiseScale: 0.0016,      // feinere Noise
        wiggleFreqMin: 0.05,     // min individuelle Frequenz
        wiggleFreqMax: 0.18,     // max individuelle Frequenz
        wiggleAmpMin: 0.05,      // min Wiggle-Amplitude
        wiggleAmpMax: 0.15,      // max Wiggle-Amplitude
        driftOffsetRange: 7      // geringere Auslenkung für mehr Schärfe
    };

    async function sampleFeatherFromGLTF(url, count = 20000, selectIndex = null) {
        const { GLTFLoader, MeshSurfaceSampler } = await loadGltfHelpers();
        const loader = new GLTFLoader();
        loader.setCrossOrigin('anonymous');
        if (!cachedGltf) {
            cachedGltf = await loader.loadAsync(url);
            cachedMeshes = [];
            cachedGltf.scene.traverse((child) => {
                if (child.isMesh && child.geometry) {
                    cachedMeshes.push(child);
                }
            });
        }
        const meshes = cachedMeshes;
        if (!meshes.length) throw new Error('GLTF enthält keine Meshes');

        if (!meshInfoCache) {
            meshInfoCache = meshes.map((m, idx) => {
                m.geometry.computeBoundingBox();
                const bbox = m.geometry.boundingBox;
                const size = bbox.getSize(new THREE.Vector3());
                return {
                    idx,
                    name: m.name || '(ohne Name)',
                    verts: m.geometry.attributes.position.count,
                    size,
                    aspectScore: size.y - 0.4 * size.x - 0.3 * size.z, // lang + schlank bevorzugen
                    volume: size.x * size.y * size.z
                };
            });
            console.table(meshInfoCache.map((i) => ({ idx: i.idx, name: i.name, verts: i.verts, sx: i.size.x.toFixed(2), sy: i.size.y.toFixed(2), sz: i.size.z.toFixed(2), score: i.aspectScore.toFixed(2), vol: i.volume.toFixed(2) })));
        }

        let baseMesh = null;
        if (FEATHER_NAME_MATCH) {
            baseMesh = meshes.find((m) => m.name && m.name.includes(FEATHER_NAME_MATCH)) || null;
        }
        if (!baseMesh && Number.isInteger(FEATHER_MESH_INDEX)) {
            baseMesh = meshes[FEATHER_MESH_INDEX] || null;
        }
        if (!baseMesh && Number.isInteger(selectIndex)) {
            baseMesh = meshes[selectIndex] || null;
        }
        if (!baseMesh) {
            const best = meshInfoCache
                .slice()
                .sort((a, b) => {
                    const scoreA = a.aspectScore - 0.15 * Math.log10(a.volume + 1);
                    const scoreB = b.aspectScore - 0.15 * Math.log10(b.volume + 1);
                    return scoreB - scoreA;
                })[0];
            baseMesh = meshes[best.idx];
            currentMeshInfo = best;
        } else {
            const info = meshInfoCache.find((i) => meshes[i.idx] === baseMesh);
            currentMeshInfo = info || { idx: selectIndex ?? 0, name: baseMesh.name || '(ohne Name)', verts: baseMesh.geometry.attributes.position.count };
        }

        if (overlay && currentMeshInfo) {
            const total = meshInfoCache ? meshInfoCache.length : null;
            const totalDisplay = total ? `${currentMeshInfo.idx}/${total - 1}` : `${currentMeshInfo.idx}`;
            overlay.querySelector('.subtitle').textContent = `Mesh ${totalDisplay} (${currentMeshInfo.name}) · Punkte: ${currentMeshInfo.verts} · [Space] Wolke/Modell · ${AUTO_CYCLE_ENABLED ? 'Auto-Cycle an' : 'Auto-Cycle aus'}`;
        }

        // bounding box für zentrierung & Farbausprägung
        baseMesh.geometry.computeBoundingBox();
        const bbox = baseMesh.geometry.boundingBox;
        const size = bbox.getSize(new THREE.Vector3());
        const center = bbox.getCenter(new THREE.Vector3());
        const sampler = new MeshSurfaceSampler(baseMesh).build();

        const positions = new Float32Array(count * 3);
        const colors = new Float32Array(count * 3);

        const tmpPos = new THREE.Vector3();
        const tmpNormal = new THREE.Vector3();
        const tmpColor = new THREE.Color();

        // skaliere auf angenehme Größe im Raum
        const uniformScale = 320 / Math.max(size.x, size.y, size.z);
        selectedMesh = baseMesh;
        selectedMeshCenter = center.clone();
        selectedMeshScale = uniformScale;

        for (let i = 0; i < count; i++) {
            sampler.sample(tmpPos, tmpNormal);
            tmpPos.sub(center).multiplyScalar(uniformScale);

            // Rotate feather to stand upright (was lying in x/z plane)
            const px = tmpPos.x;
            const py = tmpPos.y;
            const pz = tmpPos.z;
            tmpPos.set(px, pz, -py);

            // Farbschema: warmer Kiel, kühler Flaum + Noise für Körnung
            const t = THREE.MathUtils.clamp((tmpPos.y - (-size.y * 0.5 * uniformScale)) / (size.y * uniformScale), 0, 1);
            const shaftMask = Math.exp(-Math.pow(tmpPos.x / (size.x * uniformScale * 0.2), 2) * 3);
            const hue = 0.58 - 0.15 * t + 0.05 * shaftMask;
            const sat = 0.48 + 0.28 * (1 - t) + 0.14 * shaftMask;
            const val = 0.62 + 0.16 * t + 0.14 * shaftMask;
            tmpColor.setHSL(hue, sat, val);

            const i3 = i * 3;
            positions[i3] = tmpPos.x + (Math.random() - 0.5) * 0.8; // weniger Jitter für mehr Schärfe
            positions[i3 + 1] = tmpPos.y + (Math.random() - 0.5) * 0.8;
            positions[i3 + 2] = tmpPos.z + (Math.random() - 0.5) * 0.8;
            colors[i3] = tmpColor.r;
            colors[i3 + 1] = tmpColor.g;
            colors[i3 + 2] = tmpColor.b;
        }
        return { positions, colors, source: 'gltf', meta: { mesh: currentMeshInfo } };
    }

    function sampleImagePixels(sampleStep = 1) {
        const img = baseImage;
        if (!img.width || !img.height) return [];
        const maxW = 420;
        const scale = Math.min(1, maxW / img.width);
        const w = Math.floor(img.width * scale);
        const h = Math.floor(img.height * scale);
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const cctx = c.getContext('2d');
        cctx.drawImage(img, 0, 0, w, h);
        const data = cctx.getImageData(0, 0, w, h).data;
        const pts = [];
        for (let y = 0; y < h; y += sampleStep) {
            for (let x = 0; x < w; x += sampleStep) {
                const i = (y * w + x) * 4;
                const a = data[i + 3];
                if (a < 12) continue;
                const r = data[i];
                const g = data[i + 1];
                const b = data[i + 2];
                const brightness = (r + g + b) / 3;
                const nx = (x - w / 2);
                const ny = (h / 2 - y);
                const nz = (brightness - 128) * 0.45 + (Math.random() - 0.5) * 10; // keep shallow depth so silhouette stays readable
                pts.push({ x: nx, y: ny, z: nz, r, g, b });
            }
        }
        return pts;
    }

    function buildBuffersFromPixels(pts, scale = 1.4) {
        const positions = new Float32Array(pts.length * 3);
        const colors = new Float32Array(pts.length * 3);
        pts.forEach((p, idx) => {
            const i = idx * 3;
            positions[i] = p.x * scale;
            positions[i + 1] = p.y * scale;
            positions[i + 2] = p.z;
            colors[i] = p.r / 255;
            colors[i + 1] = p.g / 255;
            colors[i + 2] = p.b / 255;
        });
        return { positions, colors, source: 'image' };
    }

    async function preparePointCloud(selectIndex = null) {
        if (FEATHER_URL) {
            try {
                return await sampleFeatherFromGLTF(FEATHER_URL, 12000, selectIndex);
            } catch (err) {
                console.warn('Feder-GLTF konnte nicht geladen werden, fallback zu Bildsampling.', err);
            }
        }
        let pts = sampleImagePixels(1);
        if (!pts.length) {
            console.warn('Keine Bildpunkte gefunden, nutze Fallback-Wolke.');
            pts = buildFallbackPoints();
        }
        if (pts.length && !pts[0].r) {
            // fallbackPoints liefern bereits rgb im 0-255 Bereich
            pts = pts.map((p) => ({ ...p }));
        }
        if (overlay) {
            overlay.querySelector('.subtitle').textContent = 'Fallback: 2D-Bild als Punktwolke geladen.';
        }
        return buildBuffersFromPixels(pts, 1.4);
    }

    function buildFormation(type, count) {
        if (type === 'feder' && baseFeatherPositions) return baseFeatherPositions.slice();
        const out = new Float32Array(count * 3);
        const TWO_PI = Math.PI * 2;
        for (let i = 0; i < count; i++) {
            const t = i / count;
            const i3 = i * 3;
            if (type === 'torus') {
                const ringR = 190;
                const tubeR = 60;
                const u = TWO_PI * t;
                const v = TWO_PI * ((i * 13) % count) / count;
                const r = ringR + tubeR * Math.cos(v);
                out[i3] = r * Math.cos(u);
                out[i3 + 1] = tubeR * Math.sin(v) * 1.2;
                out[i3 + 2] = r * Math.sin(u);
            } else if (type === 'shell') {
                const phi = Math.acos(1 - 2 * t);
                const theta = TWO_PI * t * 1.7;
                const r = 230 + 28 * Math.sin(t * 18);
                out[i3] = r * Math.sin(phi) * Math.cos(theta);
                out[i3 + 1] = r * Math.sin(phi) * Math.sin(theta);
                out[i3 + 2] = r * Math.cos(phi) * 0.9;
            }
        }
        return out;
    }

    function setFormation(type) {
        if (!points) return;
        const count = points.geometry.getAttribute('position').count;
        morphFrom = morphTo ? morphTo.slice() : startPositions.slice();
        morphTo = buildFormation(type, count);
        morphStart = performance.now();
    }

    function buildFallbackPoints(count = 2500) {
        const pts = [];
        for (let i = 0; i < count; i++) {
            const nx = (Math.random() - 0.5) * 400;
            const ny = (Math.random() - 0.5) * 250;
            const nz = (Math.random() - 0.5) * 320;
            const hue = Math.random();
            const sat = 0.6 + Math.random() * 0.4;
            const val = 0.6 + Math.random() * 0.35;
            // simple hsv to rgb
            const h6 = hue * 6;
            const c = val * sat;
            const x = c * (1 - Math.abs((h6 % 2) - 1));
            let r = 0, g = 0, b = 0;
            if (h6 < 1) { r = c; g = x; }
            else if (h6 < 2) { r = x; g = c; }
            else if (h6 < 3) { g = c; b = x; }
            else if (h6 < 4) { g = x; b = c; }
            else if (h6 < 5) { r = x; b = c; }
            else { r = c; b = x; }
            const m = val - c;
            r = (r + m) * 255;
            g = (g + m) * 255;
            b = (b + m) * 255;
            pts.push({ x: nx, y: ny, z: nz, r, g, b });
        }
        return pts;
    }

    async function buildScene(selectIndex = null) {
        if (!sceneEl || typeof THREE === 'undefined') return;
        const width = sceneEl.clientWidth;
        const height = sceneEl.clientHeight;

        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        renderer.setPixelRatio(window.devicePixelRatio || 1);
        renderer.setSize(width, height);
        sceneEl.innerHTML = '';
        sceneEl.appendChild(renderer.domElement);

        scene = new THREE.Scene();
        // Lichtsetup für Mesh-Rendering (Points brauchen kein Licht)
        const amb = new THREE.AmbientLight(0xffffff, 0.45);
        const dir1 = new THREE.DirectionalLight(0xffffff, 1.0);
        dir1.position.set(1.5, 2.2, 1.2);
        const dir2 = new THREE.DirectionalLight(0xa0c8ff, 0.6);
        dir2.position.set(-1.3, 1.1, -1.4);
        scene.add(amb, dir1, dir2);
        camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 2000);
        camera.position.z = 480;
        const cloud = await preparePointCloud(selectIndex);
        const geo = new THREE.BufferGeometry();
        const positions = cloud.positions.slice(); // Kopie damit wir Startwerte separat anpassen können
        geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geo.setAttribute('color', new THREE.BufferAttribute(cloud.colors, 3));

        baseFeatherPositions = positions.slice();
        startPositions = positions.slice();
        driftOffsets = new Float32Array(positions.length);
        for (let i = 0; i < startPositions.length; i++) {
            startPositions[i] *= 0.015;
            driftOffsets[i] = (Math.random() - 0.5) * motionConfig.driftOffsetRange;
        }
        driftPhase = new Float32Array(positions.length / 3);
        driftFreq = new Float32Array(positions.length / 3);
        driftAmp = new Float32Array(positions.length / 3);
        for (let i = 0; i < driftPhase.length; i++) {
            driftPhase[i] = Math.random() * Math.PI * 2;
            driftFreq[i] = motionConfig.wiggleFreqMin + Math.random() * (motionConfig.wiggleFreqMax - motionConfig.wiggleFreqMin);
            driftAmp[i] = motionConfig.wiggleAmpMin + Math.random() * (motionConfig.wiggleAmpMax - motionConfig.wiggleAmpMin);
        }
        morphFrom = startPositions.slice();
        morphTo = baseFeatherPositions.slice();
        morphStart = performance.now();

        if (!pointsMaterial) {
            pointsMaterial = new THREE.PointsMaterial({
                size: 2.2,
                sizeAttenuation: true,
                vertexColors: true,
                transparent: true,
                opacity: 1,
                depthWrite: false,
                blending: THREE.AdditiveBlending
            });
        }

        points = new THREE.Points(geo, pointsMaterial);
        scene.add(points);

        scene.fog = new THREE.FogExp2(0x050712, 0.0018);

        const handleMouse = (e) => {
            const rect = sceneEl.getBoundingClientRect();
            const mx = (e.clientX - rect.left) / rect.width;
            const my = (e.clientY - rect.top) / rect.height;
            targetRotY = (mx - 0.5) * 0.9;
            targetRotX = (my - 0.5) * 0.6;
        };
        const handleClick = () => {
            if (!points || !driftOffsets) return;
            formationIndex = (formationIndex + 1) % formations.length;
            setFormation(formations[formationIndex]);
            for (let i = 0; i < driftOffsets.length; i++) {
                driftOffsets[i] += (Math.random() - 0.5) * 18;
            }
        };
        const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
        const handleWheel = (e) => {
            e.preventDefault();
            targetZoom = clamp(targetZoom + e.deltaY * 0.6, 220, 900);
        };
        sceneEl.addEventListener('pointermove', handleMouse);
        sceneEl.addEventListener('click', handleClick);
        sceneEl.addEventListener('wheel', handleWheel, { passive: false });

        startAutoCycle();

        window.addEventListener('keydown', async (e) => {
            if (e.key === MANUAL_CYCLE_KEYS.next) {
                e.preventDefault();
                await cycleMesh(1);
            } else if (e.key === MANUAL_CYCLE_KEYS.prev) {
                e.preventDefault();
                await cycleMesh(-1);
            } else if (e.key === ' ') {
                e.preventDefault();
                showMeshMode = !showMeshMode;
                if (overlay && currentMeshInfo) {
                    const total = meshInfoCache ? meshInfoCache.length : null;
                    const totalDisplay = total ? `${currentMeshInfo.idx}/${total - 1}` : `${currentMeshInfo.idx}`;
                    overlay.querySelector('.subtitle').textContent = `Mesh ${totalDisplay} (${currentMeshInfo.name}) · Punkte: ${currentMeshInfo.verts} · [Space] Wolke/Modell · ${AUTO_CYCLE_ENABLED ? 'Auto-Cycle an' : 'Auto-Cycle aus'}`;
                }
                if (showMeshMode) {
                    await ensureMeshObject();
                } else {
                    if (meshObject) {
                        scene.remove(meshObject);
                        if (meshObject.geometry) meshObject.geometry.dispose();
                        if (meshObject.material && meshObject.material.dispose) meshObject.material.dispose();
                        meshObject = null;
                    }
                    if (points && !scene.children.includes(points)) {
                        scene.add(points);
                    }
                }
            }
        });
    }

    async function applyCloud(cloud) {
        if (!scene || !THREE) return;
        const positions = cloud.positions.slice();
        const colors = cloud.colors.slice();

        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

        baseFeatherPositions = positions.slice();
        startPositions = positions.slice();
        driftOffsets = new Float32Array(positions.length);
        for (let i = 0; i < startPositions.length; i++) {
            startPositions[i] *= 0.015;
            driftOffsets[i] = (Math.random() - 0.5) * motionConfig.driftOffsetRange;
        }
        driftPhase = new Float32Array(positions.length / 3);
        driftFreq = new Float32Array(positions.length / 3);
        driftAmp = new Float32Array(positions.length / 3);
        for (let i = 0; i < driftPhase.length; i++) {
            driftPhase[i] = Math.random() * Math.PI * 2;
            driftFreq[i] = motionConfig.wiggleFreqMin + Math.random() * (motionConfig.wiggleFreqMax - motionConfig.wiggleFreqMin);
            driftAmp[i] = motionConfig.wiggleAmpMin + Math.random() * (motionConfig.wiggleAmpMax - motionConfig.wiggleAmpMin);
        }
        morphFrom = startPositions.slice();
        morphTo = baseFeatherPositions.slice();
        morphStart = performance.now();

        if (points) {
            scene.remove(points);
            if (points.geometry) points.geometry.dispose();
        }
        points = new THREE.Points(geo, pointsMaterial || new THREE.PointsMaterial({
            size: 2.2,
            sizeAttenuation: true,
            vertexColors: true,
            transparent: true,
            opacity: 1,
            depthWrite: false,
            blending: THREE.AdditiveBlending
        }));
        if (showMeshMode && meshObject) {
            scene.remove(meshObject);
            meshObject = null;
        }
        scene.add(points);
        if (showMeshMode) {
            await ensureMeshObject();
        }
    }

    function startAutoCycle() {
        if (cycleTimer) {
            clearInterval(cycleTimer);
            cycleTimer = null;
        }
        if (!AUTO_CYCLE_ENABLED) return;
        if (!meshInfoCache || meshInfoCache.length < 2) return;
        cycleTimer = setInterval(async () => {
            cycleIndex = (cycleIndex + 1) % meshInfoCache.length;
            const cloud = await preparePointCloud(cycleIndex);
            await applyCloud(cloud);
        }, autoCycleMs);
    }

    async function cycleMesh(delta) {
        if (!meshInfoCache || !meshInfoCache.length) return;
        cycleIndex = (cycleIndex + delta + meshInfoCache.length) % meshInfoCache.length;
        const cloud = await preparePointCloud(cycleIndex);
        await applyCloud(cloud);
    }

    async function ensureMeshObject() {
        if (!scene || !THREE || !selectedMesh || !selectedMeshCenter) return;
        if (meshObject) {
            scene.remove(meshObject);
            if (meshObject.geometry) meshObject.geometry.dispose();
            if (meshObject.material && meshObject.material.dispose) meshObject.material.dispose();
            meshObject = null;
        }
        const geom = selectedMesh.geometry.clone();
        geom.computeBoundingBox();
        const c = selectedMeshCenter;
        geom.translate(-c.x, -c.y, -c.z);
        geom.scale(selectedMeshScale, selectedMeshScale, selectedMeshScale);
        // rotate -90° um X: (x, y, z) -> (x, z, -y)
        const rot = new THREE.Matrix4().makeRotationX(-Math.PI / 2);
        geom.applyMatrix4(rot);

        const mat = new THREE.MeshStandardMaterial({
            color: 0xf2f2f2,
            metalness: 0.0,
            roughness: 0.55,
            emissive: 0x111111,
            emissiveIntensity: 0.25,
            side: THREE.DoubleSide
        });

        meshObject = new THREE.Mesh(geom, mat);
        scene.add(meshObject);

        if (points) {
            scene.remove(points);
        }
    }

    function animate() {
        if (!renderer || !scene || !camera || (!points && !meshObject)) return;
        anim = requestAnimationFrame(animate);
        const t = performance.now();
        const morphProgress = Math.min(1, (t - morphStart) / motionConfig.morphDuration);
        const easedMorph = morphProgress * (2 - morphProgress);
        const tSec = t * motionConfig.timeScale;

        if (points) {
            const pos = points.geometry.getAttribute('position');
            if (morphFrom && morphTo && driftOffsets) {
                const noiseScale = motionConfig.noiseScale;
                const flowStrength = motionConfig.flowStrength;
                for (let i = 0; i < pos.count; i++) {
                    const i3 = i * 3;
                    const baseX = morphFrom[i3] + (morphTo[i3] - morphFrom[i3]) * easedMorph;
                    const baseY = morphFrom[i3 + 1] + (morphTo[i3 + 1] - morphFrom[i3 + 1]) * easedMorph;
                    const baseZ = morphFrom[i3 + 2] + (morphTo[i3 + 2] - morphFrom[i3 + 2]) * easedMorph;

                    const nx = baseX * noiseScale;
                    const ny = baseY * noiseScale;
                    const nz = baseZ * noiseScale;
                    const flowX = noise3D ? noise3D(nx, ny, tSec) * flowStrength : 0;
                    const flowY = noise3D ? noise3D(ny, nz, tSec) * flowStrength : 0;
                    const flowZ = noise3D ? noise3D(nz, nx, tSec) * flowStrength * 0.7 : 0;

                    const wiggle = driftAmp ? driftAmp[i] : 0.25;
                    const freq = driftFreq ? driftFreq[i] : 0.6;
                    const phase = driftPhase ? driftPhase[i] : 0;
                    const localMix = wiggle * Math.sin(tSec * freq + phase);

                    pos.array[i3] = baseX + driftOffsets[i3] * localMix + flowX;
                    pos.array[i3 + 1] = baseY + driftOffsets[i3 + 1] * localMix + flowY;
                    pos.array[i3 + 2] = baseZ + driftOffsets[i3 + 2] * localMix + flowZ;
                }
                pos.needsUpdate = true;
            }

            points.rotation.y += 0.002;
            points.rotation.x += (targetRotX - points.rotation.x) * 0.08;
            points.rotation.y += (targetRotY - points.rotation.y) * 0.06;
        }

        if (meshObject) {
            meshObject.rotation.y += 0.002;
            meshObject.rotation.x += (targetRotX - meshObject.rotation.x) * 0.08;
            meshObject.rotation.y += (targetRotY - meshObject.rotation.y) * 0.06;
        }

        camera.position.z += (targetZoom - camera.position.z) * 0.08;
        renderer.render(scene, camera);
    }

    function resize() {
        if (!renderer || !camera || !sceneEl) return;
        const w = sceneEl.clientWidth;
        const h = sceneEl.clientHeight;
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
    }

    const artReady = new Promise((resolve) => {
        baseImage.onload = () => resolve();
        baseImage.onerror = () => {
            console.error('schritt1.webp konnte nicht geladen werden, nutze Fallback.');
            resolve();
        };
    }).then(async () => {
        if (overlay) {
            overlay.querySelector('.subtitle').textContent = 'Lädt 3D-Feder …';
        }
        await buildScene(FEATHER_MESH_INDEX);
        if (overlay) {
            overlay.querySelector('.subtitle').textContent = '3D-Feder als Datenwolke · Maus = Neigen · Klick = Morph';
        }
        animate();
    });

    window.addEventListener('resize', resize);
});
*/