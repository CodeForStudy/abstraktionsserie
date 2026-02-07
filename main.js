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