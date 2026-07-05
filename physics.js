class DronePhysics {
    constructor() {
        // Position and velocities
        this.pos = new THREE.Vector3(0, 1.5, 0); // start slightly above ground
        this.vel = new THREE.Vector3(0, 0, 0);
        this.quaternion = new THREE.Quaternion();
        this.angularVel = new THREE.Vector3(0, 0, 0); // radians/sec on local Pitch, Roll, Yaw
        
        // Physics constants
        this.mass = 0.6; // kg
        this.gravity = 9.81; // m/s^2
        this.linearDrag = 0.12; // air resistance coefficient
        
        // Quadcopter parameters
        this.powerRatio = 8.0; // thrust-to-weight ratio (8:1)
        this.maxThrust = 0; // calculated based on mass and powerRatio
        this.angleLimit = 45 * Math.PI / 180; // rad (max angle in Angle mode)
        
        // Cascade Flight Controller constants (PID tuning values)
        this.K_angle_p = 6.0;   // Outer loop Proportional gain (Angle -> Rate)
        this.K_rate_p = 0.28;   // Inner loop Proportional gain (Rate -> Torque)
        this.K_rate_d = 0.05;   // Inner loop Derivative gain (Rate change -> Torque)
        
        this.lastRateError = new THREE.Vector3(0, 0, 0);
        
        // Battery simulation
        this.batteryCells = 4; // 4S LiPo
        this.maxVoltsPerCell = 4.2;
        this.minVoltsPerCell = 3.2;
        this.nominalVoltsPerCell = 3.7;
        
        this.batteryCapacityMah = 1300;
        this.batteryMahRemaining = 1300;
        this.internalResistance = 0.008; // ohms per cell
        
        this.currentAmps = 0.0;
        this.currentVoltage = 16.8;
        
        // State
        this.isCrashed = false;
        this.isLanded = true;
        this.flightMode = 'ANGLE'; // 'ANGLE' or 'ACRO'
        
        this.reset();
    }

    reset() {
        this.pos.set(0, 0.2, 0); // rest on the pad
        this.vel.set(0, 0, 0);
        this.quaternion.set(0, 0, 0, 1);
        this.angularVel.set(0, 0, 0);
        
        this.lastRateError.set(0, 0, 0);
        
        this.batteryMahRemaining = this.batteryCapacityMah;
        this.currentVoltage = this.batteryCells * this.maxVoltsPerCell;
        this.currentAmps = 0.0;
        
        this.isCrashed = false;
        this.isLanded = true;
    }

    updateConfig(config) {
        if (!config) return;
        this.mass = parseFloat(config.weight) / 1000.0; // g to kg
        this.powerRatio = parseFloat(config.powerRatio);
        this.batteryCells = parseInt(config.batteryCells);
        this.angleLimit = parseFloat(config.angleLimit) * Math.PI / 180.0; // deg to rad
        
        // Update battery specs
        this.currentVoltage = this.batteryCells * this.maxVoltsPerCell;
        
        // Max thrust = mass * gravity * powerRatio
        this.maxThrust = this.mass * this.gravity * this.powerRatio;
    }

    /**
     * Physics Step
     * @param {number} dt - Timestep in seconds
     * @param {object} sticks - Joystick inputs: { throttle: 0-1, roll: -1..1, pitch: -1..1, yaw: -1..1 }
     * @param {object} ratesSettings - Betaflight rates config
     * @param {THREE.Vector3} windVector - Wind force vector in world coordinates
     */
    update(dt, sticks, ratesSettings, windVector) {
        if (this.isCrashed) return;

        // Cap dt to prevent massive physics jumps
        dt = Math.min(dt, 0.05);
        if (dt <= 0.0) return;

        // Update Battery State of Charge and Sag
        this.updateBattery(dt, sticks.throttle);

        // If drone has no battery left, throttle is cut
        const actualThrottle = (this.currentVoltage < this.batteryCells * this.minVoltsPerCell) ? 0 : sticks.throttle;

        // 1. Calculate Target Angular Rates (Degrees/sec -> Radians/sec)
        const degToRad = Math.PI / 180.0;
        const targetRates = new THREE.Vector3(); // x=pitch, y=yaw, z=roll rates

        // Extract Euler Angles (Roll, Pitch, Yaw) from current Quaternion
        // Order 'YXZ' allows independent yaw, pitch, roll
        const euler = new THREE.Euler().setFromQuaternion(this.quaternion, 'YXZ');
        const currentYaw = euler.y;
        const currentPitch = euler.x; // pitch is rotation around local X
        const currentRoll = euler.z;  // roll is rotation around local Z

        if (this.flightMode === 'ANGLE') {
            // ANGLE MODE: Sticks command TARGET TILT ANGLE
            // Target tilt angles in radians
            const targetRollAngle = sticks.roll * this.angleLimit;
            const targetPitchAngle = -sticks.pitch * this.angleLimit; // pitch inverted (forward stick tilts forward / pitch down)

            // Outer Proportional Loop: Angle Error -> Target Rate
            targetRates.x = (targetPitchAngle - currentPitch) * this.K_angle_p; // x = Pitch
            targetRates.y = rates.calculateRate(sticks.yaw, ratesSettings.yaw.rcRate, ratesSettings.yaw.superRate, ratesSettings.yaw.expo) * degToRad; // y = Yaw (rate)
            targetRates.z = (targetRollAngle - currentRoll) * this.K_angle_p;   // z = Roll
        } else {
            // ACRO MODE: Sticks command TARGET ROTATION RATE directly
            targetRates.x = -rates.calculateRate(sticks.pitch, ratesSettings.pitch.rcRate, ratesSettings.pitch.superRate, ratesSettings.pitch.expo) * degToRad; // x = Pitch
            targetRates.y = rates.calculateRate(sticks.yaw, ratesSettings.yaw.rcRate, ratesSettings.yaw.superRate, ratesSettings.yaw.expo) * degToRad; // y = Yaw
            targetRates.z = rates.calculateRate(sticks.roll, ratesSettings.roll.rcRate, ratesSettings.roll.superRate, ratesSettings.roll.expo) * degToRad; // z = Roll
        }

        // 2. Inner Rate PD Loop: Rate Error -> Applied Torques
        const rateError = new THREE.Vector3(
            targetRates.x - this.angularVel.x,
            targetRates.y - this.angularVel.y,
            targetRates.z - this.angularVel.z
        );

        // Derivative term: error change rate (damping term)
        const rateErrorDiff = new THREE.Vector3(
            (rateError.x - this.lastRateError.x) / dt,
            (rateError.y - this.lastRateError.y) / dt,
            (rateError.z - this.lastRateError.z) / dt
        );

        this.lastRateError.copy(rateError);

        // Applied Torques = P * error + D * d_error
        const appliedTorque = new THREE.Vector3(
            rateError.x * this.K_rate_p + rateErrorDiff.x * this.K_rate_d,
            rateError.y * this.K_rate_p + rateErrorDiff.y * this.K_rate_d,
            rateError.z * this.K_rate_p + rateErrorDiff.z * this.K_rate_d
        );

        // Angular acceleration (assuming unit inertia tensor for simplicity)
        const angularAcc = appliedTorque.clone();
        
        // Update Local Angular Velocity
        this.angularVel.addScaledVector(angularAcc, dt);
        
        // Apply angular damping (drag from rotation)
        this.angularVel.multiplyScalar(Math.exp(-2.5 * dt));

        // 3. Update Quaternion (Orientation) using Local Angular Velocity
        // Delta quaternion: q_delta = [cos(theta/2), axis * sin(theta/2)]
        const theta = this.angularVel.length() * dt;
        if (theta > 0.0001) {
            const axis = this.angularVel.clone().normalize();
            const deltaQ = new THREE.Quaternion().setFromAxisAngle(axis, theta);
            this.quaternion.multiply(deltaQ); // Right multiplication because angularVel is in local coordinates
            this.quaternion.normalize();
        }

        // 4. Translate Linear Forces (Thrust, Gravity, Wind, Drag)
        // Thrust is along the local UP axis of the drone (0, 1, 0 rotated by quaternion)
        const localUp = new THREE.Vector3(0, 1, 0).applyQuaternion(this.quaternion);
        
        // Thrust force
        this.maxThrust = this.mass * this.gravity * this.powerRatio;
        const thrustForce = localUp.multiplyScalar(actualThrottle * this.maxThrust);
        
        // Gravity force
        const gravityForce = new THREE.Vector3(0, -this.gravity * this.mass, 0);
        
        // Aerodynamic Drag = -linearDrag * velocity * speed
        const speed = this.vel.length();
        const dragForce = this.vel.clone().multiplyScalar(-this.linearDrag * Math.max(1.0, speed));
        
        // Wind Force (applied as drag offset)
        const windEffect = windVector.clone().sub(this.vel); // relative wind velocity
        const windForce = windEffect.multiplyScalar(this.linearDrag * 0.5);

        // Sum forces
        const totalForce = new THREE.Vector3()
            .add(thrustForce)
            .add(gravityForce)
            .add(dragForce)
            .add(windForce);

        // Acceleration = Force / Mass
        const acc = totalForce.divideScalar(this.mass);

        // Integrate Velocity & Position
        this.vel.addScaledVector(acc, dt);
        this.pos.addScaledVector(this.vel, dt);

        // 5. Landed state detection & Ground Collisions
        // Drone radius is about 0.15m (15cm)
        const droneRadius = 0.15;
        if (this.pos.y < droneRadius) {
            // Check if we are landing on the central pad (3.0m radius from origin)
            const padRadius = 3.0;
            const dist2D = Math.sqrt(this.pos.x * this.pos.x + this.pos.z * this.pos.z);
            const isOnPad = dist2D <= (padRadius + droneRadius); // 3.15m radius tolerance

            // Check crash speed: if downward velocity is higher than 8 m/s, it's a critical crash
            if (this.vel.y < -7.5 && !isOnPad) {
                console.warn("CRASH: High velocity impact:", this.vel.y, "m/s");
                this.isCrashed = true;
                return;
            }

            // Normal landing/rebound behavior
            this.pos.y = droneRadius;
            
            // Check if we are landing flat
            // Roll and Pitch should be close to 0 to land flat without flipping/crashing
            const dot = Math.max(-1.0, Math.min(1.0, new THREE.Vector3(0, 1, 0).dot(localUp)));
            const tilt = Math.acos(dot);
            if (tilt > 35 * Math.PI / 180 && !isOnPad) {
                console.warn("CRASH: Landed with too much tilt:", (tilt * 180 / Math.PI).toFixed(1), "deg");
                this.isCrashed = true;
                return;
            }

            // Reset velocity, simulate friction on ground
            this.vel.y = 0;
            this.vel.x *= Math.exp(-8.0 * dt);
            this.vel.z *= Math.exp(-8.0 * dt);

            // If throttle is zero and we are flat, we are landed
            if (actualThrottle < 0.05 && this.vel.length() < 0.1) {
                this.isLanded = true;
                // Auto level the drone on the ground
                this.quaternion.set(0, 0, 0, 1);
                this.angularVel.set(0, 0, 0);
            } else {
                this.isLanded = false;
            }
        } else {
            this.isLanded = false;
        }
    }

    /**
     * Simulates battery drain, voltage sag, and current draw.
     */
    updateBattery(dt, throttle) {
        // Base power draw (receivers, camera, flight controller) = ~1.5 Amps
        // Max motor draw = ~100 Amps total at full throttle for 4S standard racer
        const maxMotorAmps = 100.0;
        this.currentAmps = 1.5 + throttle * maxMotorAmps;

        // Drain mAh remaining
        // Formula: mAh = Amps * (hours * 1000)
        // discharge rate per sec = Amps * 1000 / 3600
        const mahDrained = (this.currentAmps * 1000.0 / 3600.0) * dt;
        this.batteryMahRemaining = Math.max(0, this.batteryMahRemaining - mahDrained);

        // State of Charge percentage
        const soc = this.batteryMahRemaining / this.batteryCapacityMah;

        // Discharge curve simulation: Lipo cell drops from 4.2V down to ~3.5V, then rapidly down to 3.2V
        // cellVoltage(soc) = nominal + curve
        let restingVoltsPerCell = 3.4 + 0.8 * Math.pow(soc, 0.4); // typical discharge curve approximation
        
        // Sag = Current * Internal Resistance
        // Total internal resistance = cellIR * cells
        const totalResistance = this.internalResistance * this.batteryCells;
        const voltageSag = this.currentAmps * totalResistance;

        this.currentVoltage = Math.max(
            this.batteryCells * this.minVoltsPerCell,
            (restingVoltsPerCell * this.batteryCells) - voltageSag
        );
    }
}

// Global physics instance
const physics = new DronePhysics();
window.dronePhysics = physics;
