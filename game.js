// Simulator Global variables
let scene, camera, renderer;
let droneMesh, rotors = [];
let gates = [], activeGateIndex = 0;
let pillars = [];
let particles = [];
let activeTrack = 'neon_grid';

// Flight sticks (smoothed keyboard state mapping -1 to 1)
const sticks = {
    throttle: 0.0,
    yaw: 0.0,
    pitch: 0.0,
    roll: 0.0
};

// Target keyboard sticks (actual key states)
const keyState = {
    space: false, control: false, // throttle
    q: false, e: false,           // yaw
    w: false, s: false,           // pitch
    a: false, d: false            // roll
};

// Simulator State
let isSimRunning = false;
let isPaused = false;
let cameraView = 'CHASE'; // 'FPV' or 'CHASE'
let flightTimer = 0;
let flightTimerInterval = null;
let lastTime = 0;
let maxSpeedReached = 0;

// Rates Canvas Reference
let ratesCanvas, ratesCtx;

// Wind vector
const windVector = new THREE.Vector3(0, 0, 0);

// Chase camera zoom (scroll wheel)
let chaseZoomTarget = 2.4;  // target distance behind drone
let chaseZoomCurrent = 2.4; // smoothed current distance
const CHASE_ZOOM_MIN = 1.0;
const CHASE_ZOOM_MAX = 12.0;
const CHASE_ZOOM_STEP = 0.6;

// Initialize Web Page Tab switching and Setup DOM events
window.addEventListener('load', () => {
    ratesCanvas = document.getElementById('rates-plot-canvas');
    if (ratesCanvas) {
        ratesCtx = ratesCanvas.getContext('2d');
    }
    
    // Bind rates slider events
    const sliders = [
        'rate-roll-rc', 'rate-roll-super', 'rate-roll-expo',
        'rate-pitch-rc', 'rate-pitch-super', 'rate-pitch-expo',
        'rate-yaw-rc', 'rate-yaw-super', 'rate-yaw-expo',
        'setting-angle-limit', 'setting-wind'
    ];
    
    sliders.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener('input', () => {
                updateUIValues();
                if (id.startsWith('rate-')) {
                    updateRatesPlot();
                }
            });
        }
    });

    // Keyboard controls listeners
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);

    // Mouse wheel zoom for chase camera
    window.addEventListener('wheel', (e) => {
        if (!isSimRunning || isPaused || cameraView === 'FPV') return;
        e.preventDefault();
        if (e.deltaY > 0) {
            chaseZoomTarget = Math.min(CHASE_ZOOM_MAX, chaseZoomTarget + CHASE_ZOOM_STEP);
        } else {
            chaseZoomTarget = Math.max(CHASE_ZOOM_MIN, chaseZoomTarget - CHASE_ZOOM_STEP);
        }
    }, { passive: false });
    
    // Initial draw of rates plot
    updateRatesPlot();
    updateUIValues();
});

// Switch UI Tabs in menu
function switchTab(tabId) {
    // Play subtle audio sound
    if (window.audioEngine) {
        audio.playMenuClick();
    }

    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(panel => panel.classList.remove('active'));
    
    document.getElementById(`tab-${tabId}`).classList.add('active');
    document.getElementById(`panel-${tabId}`).classList.add('active');
    
    if (tabId === 'rates') {
        setTimeout(updateRatesPlot, 50); // Short delay to ensure visible canvas dimensions
    }
}

// Update text readouts next to range sliders
function updateUIValues() {
    const ids = [
        ['rate-roll-rc', 'val-roll-rc', ''],
        ['rate-roll-super', 'val-roll-super', ''],
        ['rate-roll-expo', 'val-roll-expo', ''],
        ['rate-pitch-rc', 'val-pitch-rc', ''],
        ['rate-pitch-super', 'val-pitch-super', ''],
        ['rate-pitch-expo', 'val-pitch-expo', ''],
        ['rate-yaw-rc', 'val-yaw-rc', ''],
        ['rate-yaw-super', 'val-yaw-super', ''],
        ['rate-yaw-expo', 'val-yaw-expo', ''],
        ['setting-angle-limit', 'val-angle-limit', '°'],
        ['setting-wind', 'val-wind', ' m/s']
    ];
    
    ids.forEach(([sliderId, valId, suffix]) => {
        const slider = document.getElementById(sliderId);
        const valSpan = document.getElementById(valId);
        if (slider && valSpan) {
            valSpan.innerText = parseFloat(slider.value).toFixed(2) + suffix;
        }
    });
}

// Draw the rates graph
function updateRatesPlot() {
    if (!ratesCanvas) return;
    
    const rollRc = parseFloat(document.getElementById('rate-roll-rc').value);
    const rollSuper = parseFloat(document.getElementById('rate-roll-super').value);
    const rollExpo = parseFloat(document.getElementById('rate-roll-expo').value);
    
    const pitchRc = parseFloat(document.getElementById('rate-pitch-rc').value);
    const pitchSuper = parseFloat(document.getElementById('rate-pitch-super').value);
    const pitchExpo = parseFloat(document.getElementById('rate-pitch-expo').value);

    const yawRc = parseFloat(document.getElementById('rate-yaw-rc').value);
    const yawSuper = parseFloat(document.getElementById('rate-yaw-super').value);
    const yawExpo = parseFloat(document.getElementById('rate-yaw-expo').value);

    // Update global rates config object
    rates.roll = { rcRate: rollRc, superRate: rollSuper, expo: rollExpo };
    rates.pitch = { rcRate: pitchRc, superRate: pitchSuper, expo: pitchExpo };
    rates.yaw = { rcRate: yawRc, superRate: yawSuper, expo: yawExpo };

    // Update Max rate displays
    document.getElementById('max-rate-roll').innerText = rates.getMaxRate(rollRc, rollSuper);
    document.getElementById('max-rate-pitch').innerText = rates.getMaxRate(pitchRc, pitchSuper);
    document.getElementById('max-rate-yaw').innerText = rates.getMaxRate(yawRc, yawSuper);

    // Draw graph for Roll rates (cyan)
    rates.drawRatesPlot(ratesCanvas, rollRc, rollSuper, rollExpo, '#00f0ff');
}

// Keyboard Input Handlers
function handleKeyDown(e) {
    if (e.key === 'Escape' || e.key === 'Esc') {
        if (isSimRunning) {
            togglePause();
        }
    }
    
    if (!isSimRunning || isPaused) return;

    // Prevent default browser behavior for game controls (e.g., Space scrolling page,
    // Space/Enter activating focused buttons)
    const gameKeys = [' ', 'w', 'W', 's', 'S', 'a', 'A', 'd', 'D', 'q', 'Q', 'e', 'E', 'Control'];
    if (gameKeys.includes(e.key)) {
        e.preventDefault();
    }

    if (e.key === 'c' || e.key === 'C') {
        cameraView = cameraView === 'CHASE' ? 'FPV' : 'CHASE';
        showAlert(`CAMERA MODE: ${cameraView}`);
    }
    if (e.key === 'm' || e.key === 'M') {
        dronePhysics.flightMode = dronePhysics.flightMode === 'ANGLE' ? 'ACRO' : 'ANGLE';
        showAlert(`FLIGHT MODE: ${dronePhysics.flightMode}`, dronePhysics.flightMode === 'ACRO' ? 'warning' : '');
    }
    if (e.key === 'r' || e.key === 'R') {
        resetFlight();
    }

    // Capture standard control keys (Remapped to custom layout)
    if (e.key === 'w' || e.key === 'W') keyState.w = true;
    if (e.key === 's' || e.key === 'S') keyState.s = true;
    if (e.key === 'a' || e.key === 'A') keyState.a = true;
    if (e.key === 'd' || e.key === 'D') keyState.d = true;
    if (e.key === 'q' || e.key === 'Q') keyState.q = true;
    if (e.key === 'e' || e.key === 'E') keyState.e = true;
    if (e.key === ' ') keyState.space = true;
    if (e.key === 'Control') keyState.control = true;
}

function handleKeyUp(e) {
    if (e.key === 'w' || e.key === 'W') keyState.w = false;
    if (e.key === 's' || e.key === 'S') keyState.s = false;
    if (e.key === 'a' || e.key === 'A') keyState.a = false;
    if (e.key === 'd' || e.key === 'D') keyState.d = false;
    if (e.key === 'q' || e.key === 'Q') keyState.q = false;
    if (e.key === 'e' || e.key === 'E') keyState.e = false;
    if (e.key === ' ') keyState.space = false;
    if (e.key === 'Control') keyState.control = false;
}

// Smooth keyboard stick input mapping (simulates analog joysticks)
function smoothSticksInput(dt) {
    // Throttle: Space increases, Control decreases.
    // Throttle is un-centered, maps 0.0 to 1.0
    const throttleSpeed = 1.8;
    if (keyState.space) {
        sticks.throttle = Math.min(1.0, sticks.throttle + throttleSpeed * dt);
    } else if (keyState.control) {
        sticks.throttle = Math.max(0.0, sticks.throttle - throttleSpeed * dt);
    }

    // Pitch, Roll, Yaw map from -1.0 to 1.0 (centered sticks)
    // Dynamic sensitivity values for responsiveness
    const stickCenteringSpeed = 6.0;
    const stickIncreaseSpeed = 5.0;

    // Pitch: W tilts forward (-1.0 pitch), S tilts backward (+1.0 pitch)
    if (keyState.w) {
        sticks.pitch = Math.max(-1.0, sticks.pitch - stickIncreaseSpeed * dt);
    } else if (keyState.s) {
        sticks.pitch = Math.min(1.0, sticks.pitch + stickIncreaseSpeed * dt);
    } else {
        // Auto-center stick
        if (sticks.pitch > 0.01) sticks.pitch = Math.max(0.0, sticks.pitch - stickCenteringSpeed * dt);
        else if (sticks.pitch < -0.01) sticks.pitch = Math.min(0.0, sticks.pitch + stickCenteringSpeed * dt);
        else sticks.pitch = 0.0;
    }

    // Roll: A rolls left (-1.0), D rolls right (+1.0)
    if (keyState.a) {
        sticks.roll = Math.max(-1.0, sticks.roll - stickIncreaseSpeed * dt);
    } else if (keyState.d) {
        sticks.roll = Math.min(1.0, sticks.roll + stickIncreaseSpeed * dt);
    } else {
        // Auto-center stick
        if (sticks.roll > 0.01) sticks.roll = Math.max(0.0, sticks.roll - stickCenteringSpeed * dt);
        else if (sticks.roll < -0.01) sticks.roll = Math.min(0.0, sticks.roll + stickCenteringSpeed * dt);
        else sticks.roll = 0.0;
    }

    // Yaw: Q rotates left (-1.0), E rotates right (+1.0)
    if (keyState.q) {
        sticks.yaw = Math.max(-1.0, sticks.yaw - stickIncreaseSpeed * dt);
    } else if (keyState.e) {
        sticks.yaw = Math.min(1.0, sticks.yaw + stickIncreaseSpeed * dt);
    } else {
        // Auto-center stick
        if (sticks.yaw > 0.01) sticks.yaw = Math.max(0.0, sticks.yaw - stickCenteringSpeed * dt);
        else if (sticks.yaw < -0.01) sticks.yaw = Math.min(0.0, sticks.yaw + stickCenteringSpeed * dt);
        else sticks.yaw = 0.0;
    }
}

// Launch Three.js simulator
function launchSimulator() {
    // 1. Initialize Audio Context
    audio.start();

    // 2. Hide Menu Overlay, Show HUD
    document.getElementById('menu-overlay').classList.add('hidden');
    document.getElementById('hud-overlay').classList.remove('hidden');

    // Blur any focused button so Space key doesn't re-trigger it
    if (document.activeElement) document.activeElement.blur();

    // 3. Track Selection
    const selectedTrack = document.querySelector('input[name="track"]:checked').value;
    activeTrack = selectedTrack;

    // 4. Setup 3D Scene if not setup yet
    if (!renderer) {
        initThreeJS();
        createEnvironment();
    } else {
        // Re-generate environment for track change
        clearTracks();
        createEnvironment();
    }

    // 5. Update physics config from user selections
    const config = {
        weight: document.getElementById('setting-weight').value,
        powerRatio: document.getElementById('setting-power').value,
        batteryCells: document.getElementById('setting-battery').value,
        angleLimit: document.getElementById('setting-angle-limit').value
    };
    dronePhysics.updateConfig(config);
    
    // Set Wind Speed from slider
    const windSliderVal = parseFloat(document.getElementById('setting-wind').value);
    windVector.set(0, 0, windSliderVal); // blows in Z direction

    // 6. Reset flight states
    resetFlight();
    
    isSimRunning = true;
    isPaused = false;
    lastTime = performance.now();
    
    // Start stopwatch
    startTimer();
    
    // Trigger loop
    animate();
}

function initThreeJS() {
    const container = document.getElementById('app-container');
    
    // Scene
    scene = new THREE.Scene();
    // Fog and background are set per-track in createEnvironment

    // Renderer
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(renderer.domElement);

    // Camera
    camera = new THREE.PerspectiveCamera(80, window.innerWidth / window.innerHeight, 0.1, 1000);

    // Resize Handler
    window.addEventListener('resize', onWindowResize);

    // Drone 3D Mesh creation
    createDroneMesh();
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

// Generate the 3D Drone Visual Model (X-Configuration)
function createDroneMesh() {
    droneMesh = new THREE.Group();
    
    // Hull/Central Pod (glowing glass-morphic capsule)
    const hullGeom = new THREE.SphereGeometry(0.12, 16, 16);
    hullGeom.scale(1, 0.6, 1.8);
    const hullMat = new THREE.MeshStandardMaterial({
        color: 0x00f0ff,
        roughness: 0.1,
        metalness: 0.8,
        emissive: 0x004050
    });
    const hull = new THREE.Mesh(hullGeom, hullMat);
    droneMesh.add(hull);

    // Camera Lens on nose (facing forward)
    const lensGeom = new THREE.CylinderGeometry(0.04, 0.04, 0.05, 12);
    lensGeom.rotateX(Math.PI / 2);
    const lensMat = new THREE.MeshBasicMaterial({ color: 0xff007f });
    const lens = new THREE.Mesh(lensGeom, lensMat);
    lens.position.set(0, 0, 0.22);
    droneMesh.add(lens);

    // 4 Carbon Fiber Arms in X shape
    const armMat = new THREE.MeshStandardMaterial({ color: 0x1f242d, roughness: 0.5, metalness: 0.9 });
    const armRadius = 0.015;
    const armLength = 0.35;
    
    const armAngles = [Math.PI/4, 3*Math.PI/4, 5*Math.PI/4, 7*Math.PI/4];
    
    armAngles.forEach((angle, i) => {
        const armGeom = new THREE.CylinderGeometry(armRadius, armRadius, armLength, 8);
        armGeom.rotateZ(Math.PI / 2);
        
        const arm = new THREE.Mesh(armGeom, armMat);
        
        // Position arm so it extends from center
        const distance = armLength / 2;
        arm.position.set(Math.cos(angle) * distance, 0, Math.sin(angle) * distance);
        arm.rotation.y = -angle;
        
        droneMesh.add(arm);
        
        // Motors (Cylinder on the end of arms)
        const motorGeom = new THREE.CylinderGeometry(0.025, 0.025, 0.05, 8);
        const motorMat = new THREE.MeshStandardMaterial({ color: 0x334155, metalness: 0.9 });
        const motor = new THREE.Mesh(motorGeom, motorMat);
        motor.position.set(Math.cos(angle) * armLength, 0.02, Math.sin(angle) * armLength);
        droneMesh.add(motor);
        
        // Rotors/Propellers (Flat Cross mesh)
        const rotorGroup = new THREE.Group();
        
        const bladeGeom = new THREE.BoxGeometry(0.24, 0.002, 0.02);
        const bladeMat = new THREE.MeshStandardMaterial({ 
            color: (i < 2) ? 0x00f0ff : 0xff007f, // front cyan, rear pink
            transparent: true,
            opacity: 0.8
        });
        
        const blade1 = new THREE.Mesh(bladeGeom, bladeMat);
        const blade2 = blade1.clone();
        blade2.rotation.y = Math.PI / 2;
        
        rotorGroup.add(blade1);
        rotorGroup.add(blade2);
        
        // position rotor on top of motor
        rotorGroup.position.set(Math.cos(angle) * armLength, 0.045, Math.sin(angle) * armLength);
        
        droneMesh.add(rotorGroup);
        rotors.push(rotorGroup);
    });

    // Add search light pointing slightly down
    const light = new THREE.SpotLight(0xffffff, 3, 20, Math.PI/4, 0.5, 1);
    light.position.set(0, 0, 0.2);
    light.target.position.set(0, -1, 4);
    droneMesh.add(light);
    droneMesh.add(light.target);

    scene.add(droneMesh);
}

// Track all dynamically added scene objects for cleanup
let dynamicSceneObjects = [];

// Clear environment nodes for restarts/track shifts
function clearTracks() {
    gates.forEach(g => scene.remove(g.mesh));
    gates = [];
    pillars.forEach(p => scene.remove(p));
    pillars = [];
    
    // Remove all dynamically added objects (trees, buildings, roads, etc.)
    dynamicSceneObjects.forEach(obj => {
        scene.remove(obj);
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) {
            if (Array.isArray(obj.material)) obj.material.forEach(m => m.dispose());
            else obj.material.dispose();
        }
    });
    dynamicSceneObjects = [];
    
    // Clean up particles to prevent memory leaks and performance decay
    if (particles && particles.mesh) {
        scene.remove(particles.mesh);
        if (particles.geom) particles.geom.dispose();
        if (particles.mesh.material) particles.mesh.material.dispose();
        particles = null;
    }
}

// Generate scenery, rings, sky box, lighting
function createEnvironment() {
    // Clear ambient & directional lights first
    const lightsToRemove = [];
    scene.traverse(child => {
        if (child.isLight) lightsToRemove.push(child);
    });
    lightsToRemove.forEach(l => scene.remove(l));

    if (activeTrack === 'open_world') {
        // --- Open World: sunny outdoor environment ---
        scene.background = new THREE.Color(0x87CEEB);
        scene.fog = new THREE.FogExp2(0x87CEEB, 0.003);

        // Warm sunlight
        const ambientLight = new THREE.HemisphereLight(0xffffff, 0x444444, 1.2);
        scene.add(ambientLight);

        const sun = new THREE.DirectionalLight(0xffffff, 1.8);
        sun.position.set(20, 30, 10);
        sun.castShadow = true;
        scene.add(sun);

        // Green ground plane
        const ground = new THREE.Mesh(
            new THREE.PlaneGeometry(400, 400),
            new THREE.MeshPhongMaterial({ color: 0x55aa55 })
        );
        ground.rotation.x = -Math.PI / 2;
        scene.add(ground);
        dynamicSceneObjects.push(ground);

        // Landing pad (flat circle on the grass)
        const padGeom = new THREE.CylinderGeometry(3, 3, 0.05, 32);
        const padMat = new THREE.MeshPhongMaterial({ color: 0x888888 });
        const pad = new THREE.Mesh(padGeom, padMat);
        pad.position.set(0, 0.03, 0);
        scene.add(pad);
        dynamicSceneObjects.push(pad);

        generateOpenWorldTrack();

    } else {
        // --- Neon Cyberpunk tracks ---
        scene.background = new THREE.Color(0x07080c);
        scene.fog = new THREE.FogExp2(0x07080c, 0.007);

        // Ambient Lighting
        const ambientLight = new THREE.AmbientLight(0x0a0c14, 0.8);
        scene.add(ambientLight);

        // Cyber directional light (adds highlights)
        const dirLight = new THREE.DirectionalLight(0x00f0ff, 0.3);
        dirLight.position.set(20, 100, 10);
        scene.add(dirLight);

        // Ground Floor: Large dark grid
        const floorSize = 1000;
        const gridHelper = new THREE.GridHelper(floorSize, 200, 0x00f0ff, 0x1f242d);
        gridHelper.position.y = 0;
        scene.add(gridHelper);

        // Glowing Launch Pad
        const padGeom = new THREE.CylinderGeometry(3, 3, 0.05, 32);
        const padMat = new THREE.MeshStandardMaterial({
            color: 0x0f172a,
            roughness: 0.4,
            metalness: 0.8,
            emissive: 0x002030
        });
        const pad = new THREE.Mesh(padGeom, padMat);
        pad.position.set(0, 0.02, 0);
        scene.add(pad);

        // Launch pad border ring
        const ringGeom = new THREE.RingGeometry(2.9, 3, 32);
        ringGeom.rotateX(-Math.PI / 2);
        const ringMat = new THREE.MeshBasicMaterial({ color: 0x00f0ff, side: THREE.DoubleSide });
        const padRing = new THREE.Mesh(ringGeom, ringMat);
        padRing.position.set(0, 0.05, 0);
        scene.add(padRing);

        // Generate tracks
        if (activeTrack === 'neon_grid') {
            generateNeonGridTrack();
        } else {
            generateMegaPillarTrack();
        }
    }

    // Dynamic Dust Particles setup
    createParticleSystem();
}

function generateNeonGridTrack() {
    // Coordinates for 10 gates in a large circuit
    const gateCoords = [
        { x: 0, y: 8, z: 25, rotY: 0 },
        { x: 15, y: 12, z: 50, rotY: Math.PI/6 },
        { x: 40, y: 15, z: 70, rotY: Math.PI/3 },
        { x: 75, y: 18, z: 65, rotY: Math.PI/2 },
        { x: 95, y: 12, z: 30, rotY: 2*Math.PI/3 },
        { x: 80, y: 10, z: -10, rotY: Math.PI },
        { x: 45, y: 8, z: -35, rotY: -Math.PI/1.2 },
        { x: 10, y: 12, z: -55, rotY: -Math.PI/1.5 },
        { x: -25, y: 14, z: -30, rotY: -Math.PI/2 },
        { x: -15, y: 8, z: 5, rotY: -Math.PI/4 }
    ];

    gateCoords.forEach((coord, index) => {
        createGate(coord.x, coord.y, coord.z, coord.rotY, index);
    });
}

function generateMegaPillarTrack() {
    // Generate pillars
    const pillarCoords = [
        { x: 25, z: 25 }, { x: -25, z: 25 }, { x: 50, z: 0 },
        { x: -50, z: 0 }, { x: 25, z: -50 }, { x: -25, z: -50 },
        { x: 0, z: 75 }, { x: 0, z: -75 }
    ];

    pillarCoords.forEach(c => {
        createPillar(c.x, c.z);
    });

    // Coordinates for gates winding around pillars
    const gateCoords = [
        { x: 0, y: 6, z: 20, rotY: 0 },
        { x: 25, y: 10, z: 0, rotY: -Math.PI/4 },
        { x: 38, y: 15, z: -25, rotY: 0 },
        { x: 12, y: 18, z: -62, rotY: Math.PI/2 },
        { x: -25, y: 12, z: -40, rotY: Math.PI/4 },
        { x: -38, y: 8, z: -15, rotY: 0 },
        { x: -25, y: 10, z: 25, rotY: -Math.PI/4 },
        { x: 0, y: 12, z: 55, rotY: Math.PI/2 }
    ];

    gateCoords.forEach((coord, index) => {
        createGate(coord.x, coord.y, coord.z, coord.rotY, index);
    });
}

function generateOpenWorldTrack() {
    // --- Trees scattered around the map ---
    for (let i = 0; i < 150; i++) {
        const x = (Math.random() - 0.5) * 360;
        const z = (Math.random() - 0.5) * 360;

        // Leave space around the launch pad
        if (Math.abs(x) < 15 && Math.abs(z) < 15) continue;

        const tree = new THREE.Group();

        // Trunk
        const trunk = new THREE.Mesh(
            new THREE.CylinderGeometry(0.2, 0.3, 2),
            new THREE.MeshPhongMaterial({ color: 0x8b5a2b })
        );
        trunk.position.y = 1;
        tree.add(trunk);

        // Leaves
        const leaves = new THREE.Mesh(
            new THREE.ConeGeometry(1, 2.5, 8),
            new THREE.MeshPhongMaterial({ color: 0x1e7d32 })
        );
        leaves.position.y = 3;
        tree.add(leaves);

        tree.position.set(x, 0, z);
        scene.add(tree);
        dynamicSceneObjects.push(tree);
    }

    // --- Buildings in a cluster ---
    const buildingColors = [0x7f8c8d, 0x95a5a6, 0xbdc3c7, 0x636e72, 0xdfe6e9, 0x2d3436, 0xa29bfe, 0x74b9ff];
    for (let i = 0; i < 30; i++) {
        const width = 3 + Math.random() * 5;
        const depth = 3 + Math.random() * 5;
        const height = 5 + Math.random() * 20;

        const x = 30 + Math.random() * 60;
        const z = 30 + Math.random() * 60;

        const building = new THREE.Mesh(
            new THREE.BoxGeometry(width, height, depth),
            new THREE.MeshPhongMaterial({ color: buildingColors[i % buildingColors.length] })
        );
        building.position.set(x, height / 2, z);
        scene.add(building);
        dynamicSceneObjects.push(building);
    }

    // --- Road running through the center ---
    const road = new THREE.Mesh(
        new THREE.PlaneGeometry(8, 400),
        new THREE.MeshPhongMaterial({ color: 0x333333 })
    );
    road.rotation.x = -Math.PI / 2;
    road.position.y = 0.01;
    scene.add(road);
    dynamicSceneObjects.push(road);

    // --- Freestyle gates scattered loosely (optional waypoints) ---
    const gateCoords = [
        { x: 0, y: 6, z: 30, rotY: 0 },
        { x: 20, y: 10, z: 60, rotY: Math.PI / 6 },
        { x: -15, y: 8, z: 90, rotY: -Math.PI / 8 },
        { x: 35, y: 14, z: 45, rotY: Math.PI / 3 },
        { x: -30, y: 10, z: 20, rotY: -Math.PI / 4 },
    ];

    gateCoords.forEach((coord, index) => {
        createGate(coord.x, coord.y, coord.z, coord.rotY, index);
    });
}

function createPillar(x, z) {
    const height = 60;
    const radius = 4;
    const geom = new THREE.CylinderGeometry(radius, radius, height, 16);
    
    // Dark core with neon outline stripes
    const mat = new THREE.MeshStandardMaterial({
        color: 0x090d16,
        roughness: 0.6,
        metalness: 0.9,
        flatShading: true
    });
    
    const mesh = new THREE.Mesh(geom, mat);
    mesh.position.set(x, height / 2, z);
    scene.add(mesh);
    pillars.push(mesh);

    // Glowing Neon accent rings on pillar
    for (let h = 5; h < height; h += 15) {
        const ringGeom = new THREE.CylinderGeometry(radius + 0.05, radius + 0.05, 0.2, 16, 1, true);
        const ringMat = new THREE.MeshBasicMaterial({ color: 0xff007f });
        const ring = new THREE.Mesh(ringGeom, ringMat);
        ring.position.set(x, h, z);
        scene.add(ring);
        pillars.push(ring);
    }
}

function createGate(x, y, z, rotY, index) {
    const gateGroup = new THREE.Group();
    
    // Outer glowing Ring
    const torusGeom = new THREE.TorusGeometry(2.5, 0.1, 8, 32);
    // Un-cleared gates start as pink/orange
    const color = (index === 0) ? 0x00f0ff : 0xff007f; // Active starts cyan, others pink
    const torusMat = new THREE.MeshBasicMaterial({ color: color });
    const torus = new THREE.Mesh(torusGeom, torusMat);
    gateGroup.add(torus);
    
    // Transparent center collider visualizer
    const innerGeom = new THREE.CircleGeometry(2.4, 16);
    const innerMat = new THREE.MeshBasicMaterial({
        color: color,
        transparent: true,
        opacity: 0.08,
        side: THREE.DoubleSide
    });
    const innerFill = new THREE.Mesh(innerGeom, innerMat);
    gateGroup.add(innerFill);

    // Position and orientation
    gateGroup.position.set(x, y, z);
    gateGroup.rotation.y = rotY;
    
    scene.add(gateGroup);
    
    gates.push({
        index: index,
        mesh: gateGroup,
        pos: new THREE.Vector3(x, y, z),
        normal: new THREE.Vector3(0, 0, 1).applyAxisAngle(new THREE.Vector3(0, 1, 0), rotY),
        radius: 2.5,
        cleared: false,
        torusMesh: torus,
        fillMesh: innerFill
    });
}

function createParticleSystem() {
    const particleCount = 200;
    const geom = new THREE.BufferGeometry();
    const positions = new Float32Array(particleCount * 3);
    const velocities = [];

    for (let i = 0; i < particleCount; i++) {
        // Distribute randomly in a field
        positions[i*3] = (Math.random() - 0.5) * 200;
        positions[i*3+1] = Math.random() * 40;
        positions[i*3+2] = (Math.random() - 0.5) * 200;

        velocities.push(new THREE.Vector3(
            (Math.random() - 0.5) * 0.5,
            (Math.random() - 0.5) * 0.1,
            (Math.random() - 0.5) * 0.5
        ));
    }

    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    
    // Cyan glow points
    const mat = new THREE.PointsMaterial({
        color: 0x00f0ff,
        size: 0.15,
        transparent: true,
        opacity: 0.5
    });

    const pointCloud = new THREE.Points(geom, mat);
    scene.add(pointCloud);
    
    particles = {
        mesh: pointCloud,
        velocities: velocities,
        geom: geom,
        count: particleCount
    };
}

// Particle update loop (ambient dust and rotor prop wash)
function updateParticles(dt) {
    if (!particles || !particles.mesh) return;

    const positions = particles.geom.attributes.position.array;
    const dronePos = dronePhysics.pos;
    const throttle = sticks.throttle;

    for (let i = 0; i < particles.count; i++) {
        // Apply velocity
        positions[i*3] += particles.velocities[i].x * dt * 10;
        positions[i*3+1] += particles.velocities[i].y * dt * 10;
        positions[i*3+2] += particles.velocities[i].z * dt * 10;

        // If particle goes below ground, reset at top
        if (positions[i*3+1] < 0) {
            positions[i*3+1] = 40;
        }
        
        // If particle goes too far from drone, pull back
        const dx = positions[i*3] - dronePos.x;
        const dy = positions[i*3+1] - dronePos.y;
        const dz = positions[i*3+2] - dronePos.z;
        const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
        if (dist > 120) {
            positions[i*3] = dronePos.x + (Math.random() - 0.5) * 100;
            positions[i*3+1] = dronePos.y + Math.random() * 40;
            positions[i*3+2] = dronePos.z + (Math.random() - 0.5) * 100;
        }

        // Rotor Ground Effect: Push particles away when drone is low and thrusting
        if (dronePos.y < 5.0 && throttle > 0.1) {
            const pX = positions[i*3];
            const pY = positions[i*3+1];
            const pZ = positions[i*3+2];
            
            const distToGroundRotor = Math.sqrt((pX - dronePos.x)**2 + (pZ - dronePos.z)**2);
            if (distToGroundRotor < 5.0 && pY < dronePos.y) {
                // Push outward
                const force = (5.0 - distToGroundRotor) * throttle * 8 * dt;
                positions[i*3] += (pX - dronePos.x) * force;
                positions[i*3+2] += (pZ - dronePos.z) * force;
                positions[i*3+1] -= 2 * force; // push down
            }
        }
    }

    particles.geom.attributes.position.needsUpdate = true;
}

// Reset Flight variables
function resetFlight() {
    dronePhysics.reset();
    
    // Reset gate clearing tracking
    activeGateIndex = 0;
    gates.forEach((gate, idx) => {
        gate.cleared = false;
        // set color back
        const color = (idx === 0) ? 0x00f0ff : 0xff007f;
        gate.torusMesh.material.color.setHex(color);
        gate.fillMesh.material.color.setHex(color);
        gate.fillMesh.material.opacity = 0.08;
    });

    // Reset stats
    flightTimer = 0;
    maxSpeedReached = 0;
    
    sticks.throttle = 0.0;
    sticks.yaw = 0.0;
    sticks.pitch = 0.0;
    sticks.roll = 0.0;
    
    Object.keys(keyState).forEach(k => keyState[k] = false);

    // Hide crash/end screen
    document.getElementById('end-overlay').classList.add('hidden');
    document.getElementById('pause-overlay').classList.add('hidden');
    
    if (isSimRunning) {
        audio.stopBatteryBeep();
        startTimer();
    }
    
    showAlert("FLIGHT RESET - READY");
}

// Timer/Stopwatch Functions
function startTimer() {
    if (flightTimerInterval) clearInterval(flightTimerInterval);
    flightTimerInterval = setInterval(() => {
        if (!isPaused && isSimRunning && !dronePhysics.isCrashed) {
            flightTimer += 0.01;
            updateOSD();
        }
    }, 10);
}

function stopTimer() {
    if (flightTimerInterval) {
        clearInterval(flightTimerInterval);
        flightTimerInterval = null;
    }
}

// Format stopwatch output: 00:00.00
function formatTime(sec) {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    const ms = Math.floor((sec % 1) * 100);
    
    const pad = (num) => num.toString().padStart(2, '0');
    return `${pad(m)}:${pad(s)}.${pad(ms)}`;
}

// Update 2D Canvas OSD Dashboard Elements
function updateOSD() {
    document.getElementById('osd-timer').innerText = formatTime(flightTimer);
    
    const speedVal = dronePhysics.vel.length();
    if (speedVal > maxSpeedReached) {
        maxSpeedReached = speedVal;
    }
    document.getElementById('osd-speed').innerText = `SPD: ${speedVal.toFixed(1)} m/s`;
    
    // Altitude: pos.y minus drone radius (centered at 0.15)
    const alt = Math.max(0, dronePhysics.pos.y - 0.15);
    document.getElementById('osd-altitude').innerText = `ALT: ${alt.toFixed(1)} m`;

    document.getElementById('osd-flight-mode').innerText = `MODE: ${dronePhysics.flightMode}`;
    document.getElementById('osd-voltage').innerText = `BAT: ${dronePhysics.currentVoltage.toFixed(2)} V`;
    
    // voltage per cell
    const cellV = dronePhysics.currentVoltage / dronePhysics.batteryCells;
    document.getElementById('osd-voltage-cells').innerText = `(${dronePhysics.batteryCells}S: ${cellV.toFixed(2)}V/C)`;
    
    // OSD Colors base on warnings
    const batPanel = document.getElementById('osd-voltage');
    if (cellV < 3.5) {
        batPanel.style.color = '#ff0f0f'; // Red warning
        audio.startBatteryBeep();
    } else if (cellV < 3.65) {
        batPanel.style.color = '#ffb703'; // Yellow warning
        audio.stopBatteryBeep();
    } else {
        batPanel.style.color = ''; // green normal
        audio.stopBatteryBeep();
    }

    document.getElementById('osd-current').innerText = `AMP: ${dronePhysics.currentAmps.toFixed(1)} A`;
    document.getElementById('osd-throttle').innerText = `THR: ${Math.round(sticks.throttle * 100)}%`;
    if (gates.length > 0) {
        document.getElementById('osd-gates').innerText = `GATES: ${activeGateIndex} / ${gates.length}`;
    } else {
        document.getElementById('osd-gates').innerText = 'FREESTYLE';
    }

    // Adjust OSD artificial horizon
    // Extract pitch & roll from orientation to rotate OSD ladder
    const euler = new THREE.Euler().setFromQuaternion(dronePhysics.quaternion, 'YXZ');
    const pitchDeg = euler.x * 180 / Math.PI;
    const rollDeg = euler.z * 180 / Math.PI;

    // Shift pitch ladder vertically, rotate by roll
    const ladder = document.getElementById('osd-pitch-ladder');
    if (ladder) {
        // 1 degree pitch shifts ladder ~2 pixels
        const yOffset = pitchDeg * 2.2;
        ladder.style.transform = `translateY(${yOffset}px) rotate(${-rollDeg}deg)`;
    }
}

// Display high priority alerts in OSD
let alertTimeout = null;
function showAlert(msg, className = '') {
    const alertEl = document.getElementById('osd-alert-msg');
    if (!alertEl) return;
    
    alertEl.innerText = msg;
    alertEl.className = className; // 'warning', 'success', or empty
    
    if (alertTimeout) clearTimeout(alertTimeout);
    
    // clear after 2.5 seconds
    alertTimeout = setTimeout(() => {
        alertEl.innerText = '';
    }, 2500);
}

// Checkpoints checking: Did the drone fly through the active ring?
function checkGateCollisions() {
    if (gates.length === 0 || activeGateIndex >= gates.length) return;

    const currentGate = gates[activeGateIndex];
    const dronePos = dronePhysics.pos;
    
    // 1. Distance check (gates are circular checkpoints)
    const dist = dronePos.distanceTo(currentGate.pos);
    
    if (dist < currentGate.radius) {
        // Drone is inside the gate cylinder bounds
        // Mark cleared
        currentGate.cleared = true;
        
        // Turn gate green
        currentGate.torusMesh.material.color.setHex(0x39ff14);
        currentGate.fillMesh.material.color.setHex(0x39ff14);
        currentGate.fillMesh.material.opacity = 0.2;
        
        audio.playGatePass();
        activeGateIndex++;
        
        if (activeGateIndex < gates.length) {
            // Highlight next gate
            const nextGate = gates[activeGateIndex];
            nextGate.torusMesh.material.color.setHex(0x00f0ff); // make it Cyan
            nextGate.fillMesh.material.color.setHex(0x00f0ff);
            showAlert(`GATE ${activeGateIndex} CLEARED`, 'success');
        } else {
            // Track finished!
            handleLevelComplete();
        }
    }
}

// Collision checks for pillars (Mega-Pillar Arena mode)
function checkPillarCollisions() {
    if (activeTrack !== 'cyber_pillars') return;
    const dronePos = dronePhysics.pos;
    const pillarRadius = 4.0;
    const droneRadius = 0.15;
    const collisionThreshold = pillarRadius + droneRadius;

    for (let i = 0; i < pillars.length; i++) {
        const p = pillars[i];
        
        // Only check solid cylinder pillars (not the thin glowing visual ring accessories)
        if (p.geometry.type === "CylinderGeometry" && p.geometry.parameters.height > 1.0) {
            // 2D distance check (x/z coordinates)
            const dx = dronePos.x - p.position.x;
            const dz = dronePos.z - p.position.z;
            const dist2D = Math.sqrt(dx*dx + dz*dz);
            
            // If drone is within radius horizontally and inside height vertically
            if (dist2D < collisionThreshold && dronePos.y < p.geometry.parameters.height) {
                dronePhysics.isCrashed = true;
                handleCrash();
                break;
            }
        }
    }
}

// Game Over crash handler
function handleCrash() {
    stopTimer();
    audio.playCrash();
    
    document.getElementById('end-title').innerText = "CRASH DETECTED";
    document.getElementById('end-sub').innerText = "Hull Integrity Critical";
    document.getElementById('stats-summary').classList.add('hidden');
    document.getElementById('end-overlay').classList.remove('hidden');
}

// Win/Finish handler
function handleLevelComplete() {
    stopTimer();
    audio.stopBatteryBeep();
    
    // Play celebratory tone
    setTimeout(() => {
        audio.playGatePass();
        setTimeout(() => audio.playGatePass(), 100);
    }, 100);

    document.getElementById('end-title').innerText = "TRACK COMPLETE";
    document.getElementById('end-sub').innerText = "Excellent Flight Performance";
    
    // Fill stats card
    document.getElementById('summary-time').innerText = formatTime(flightTimer);
    document.getElementById('summary-gates').innerText = `${activeGateIndex} / ${gates.length}`;
    
    const speedVal = maxSpeedReached;
    document.getElementById('summary-speed').innerText = `${speedVal.toFixed(1)} m/s`;
    
    document.getElementById('stats-summary').classList.remove('hidden');
    document.getElementById('end-overlay').classList.remove('hidden');
}

// Pause menu logic
function togglePause() {
    if (!isSimRunning || dronePhysics.isCrashed) return;
    
    isPaused = !isPaused;
    if (isPaused) {
        stopTimer();
        document.getElementById('pause-overlay').classList.remove('hidden');
    } else {
        resumeSimulator();
    }
}

function resumeSimulator() {
    isPaused = false;
    document.getElementById('pause-overlay').classList.add('hidden');
    lastTime = performance.now();
    startTimer();
}

function exitToMenu() {
    isSimRunning = false;
    stopTimer();
    audio.stopBatteryBeep();
    
    document.getElementById('hud-overlay').classList.add('hidden');
    document.getElementById('pause-overlay').classList.add('hidden');
    document.getElementById('end-overlay').classList.add('hidden');
    document.getElementById('menu-overlay').classList.remove('hidden');
    
    switchTab('play');
}

// Main Game Loop (Animate)
function animate() {
    if (!isSimRunning) return;
    
    requestAnimationFrame(animate);

    const now = performance.now();
    let dt = (now - lastTime) / 1000.0;
    lastTime = now;

    if (isPaused) return;

    // 1. Process flight sticks smoothing
    smoothSticksInput(dt);

    // 2. Physics solver step
    dronePhysics.update(dt, sticks, rates, windVector);

    // Check crash trigger
    if (dronePhysics.isCrashed) {
        handleCrash();
        return;
    }

    // 3. Update Visual Drone model mesh (position, rotation, props)
    droneMesh.position.copy(dronePhysics.pos);
    droneMesh.quaternion.copy(dronePhysics.quaternion);

    // Rotate propellers based on throttle (spinning rate)
    if (sticks.throttle > 0.05) {
        const spinSpeed = 20.0 * (0.2 + sticks.throttle * 0.8);
        rotors.forEach((rotor, i) => {
            // counter-rotating pairs (props 1 & 3 spin CW, props 2 & 4 spin CCW)
            const direction = (i % 2 === 0) ? 1 : -1;
            rotor.rotation.y += spinSpeed * dt * direction;
        });
    }

    // 4. Update Camera view
    updateCamera();

    // 5. Particle dynamics (dust / grid wind)
    updateParticles(dt);

    // 6. Check Checkpoints & Collisions
    checkGateCollisions();
    checkPillarCollisions();

    // 7. Update HUD values
    updateOSD();

    // 8. Modulate synthesized sound context
    // Calculate simple rotor variations
    const rollTrim = sticks.roll * 0.15;
    const pitchTrim = sticks.pitch * 0.15;
    const yawTrim = sticks.yaw * 0.1;
    
    const m1 = sticks.throttle + pitchTrim + rollTrim - yawTrim;
    const m2 = sticks.throttle - pitchTrim - rollTrim - yawTrim;
    const m3 = sticks.throttle + pitchTrim - rollTrim + yawTrim;
    const m4 = sticks.throttle - pitchTrim + rollTrim + yawTrim;

    audio.update(sticks.throttle, dronePhysics.vel.length(), [m1, m2, m3, m4]);

    // 9. WebGL Render
    renderer.render(scene, camera);
}

// Camera Placement Algorithms
function updateCamera() {
    if (cameraView === 'FPV') {
        // Place camera exactly at drone position, facing forward relative to pitch tilt
        camera.position.copy(dronePhysics.pos);
        
        // Add a slight nose camera offset
        const forwardOffset = new THREE.Vector3(0, 0, 0.18).applyQuaternion(dronePhysics.quaternion);
        camera.position.add(forwardOffset);
        
        camera.quaternion.copy(dronePhysics.quaternion);
        
        // FPV Tilt: standard 25 degree pitch tilt upward so you can see where you are going when pitching forward
        const fpvTilt = 25 * Math.PI / 180;
        camera.rotateX(fpvTilt);
        
    } else {
        // CHASE MODE: Follow behind
        // Smoothly lerp zoom distance toward target
        chaseZoomCurrent += (chaseZoomTarget - chaseZoomCurrent) * 0.12;

        const backDist = chaseZoomCurrent;
        const upDist = 0.55 * (chaseZoomCurrent / 2.4); // scale height proportionally
        
        // Project direction based only on the yaw component of orientation to keep camera level
        // extracting Euler yaw
        const euler = new THREE.Euler().setFromQuaternion(dronePhysics.quaternion, 'YXZ');
        const yaw = euler.y;
        
        const targetCamPos = new THREE.Vector3(
            dronePhysics.pos.x - Math.sin(yaw) * backDist,
            dronePhysics.pos.y + upDist,
            dronePhysics.pos.z - Math.cos(yaw) * backDist
        );
        
        // Smoothly interpolate current camera position to target camera position (lerp)
        const lerpFactor = 0.15; // smooth laggy camera follow
        camera.position.lerp(targetCamPos, lerpFactor);
        
        // Look at the drone position (plus a small lead looking slightly ahead)
        camera.lookAt(dronePhysics.pos);
    }
}
