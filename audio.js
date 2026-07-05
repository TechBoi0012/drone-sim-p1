class DroneAudioEngine {
    constructor() {
        this.ctx = null;
        
        // Audio nodes
        this.masterVolume = null;
        
        // Motor Synthesizer nodes
        this.motors = []; // We will create 4 motor sound sources
        this.motorGains = [];
        this.motorFilters = [];
        this.noiseNode = null;
        this.noiseFilter = null;
        this.noiseGain = null;
        
        // Wind Synthesizer nodes
        this.windNode = null;
        this.windFilter = null;
        this.windGain = null;
        
        this.isStarted = false;
        this.batteryBeepInterval = null;
    }

    init() {
        if (this.ctx) return;
        
        // Handle browser AudioContext compatibility
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        this.ctx = new AudioContextClass();
        
        // Master Volume
        this.masterVolume = this.ctx.createGain();
        this.masterVolume.gain.setValueAtTime(0.3, this.ctx.currentTime); // Keep master volume comfortable
        this.masterVolume.connect(this.ctx.destination);
        
        this.setupMotors();
        this.setupWind();
    }

    // Helper to create White Noise source
    createNoiseBuffer() {
        const bufferSize = 2 * this.ctx.sampleRate;
        const noiseBuffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
        const output = noiseBuffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
            output[i] = Math.random() * 2 - 1;
        }
        return noiseBuffer;
    }

    setupMotors() {
        // We create a base low hum representing 4 motors
        // Motor sound is made of a sawtooth wave (base rpm frequency) + a square wave (propeller harmonics)
        const baseFreqs = [52.3, 52.5, 52.8, 53.1]; // slightly detuned for chorus effect
        
        for (let i = 0; i < 4; i++) {
            // Sawtooth oscillator
            const oscSaw = this.ctx.createOscillator();
            oscSaw.type = 'sawtooth';
            oscSaw.frequency.setValueAtTime(baseFreqs[i], this.ctx.currentTime);
            
            // Sub-harmonic Square oscillator (adds rotor blade flutter)
            const oscSquare = this.ctx.createOscillator();
            oscSquare.type = 'triangle';
            oscSquare.frequency.setValueAtTime(baseFreqs[i] * 2, this.ctx.currentTime);

            // Filter to make it sound muffled/inside a housing
            const filter = this.ctx.createBiquadFilter();
            filter.type = 'lowpass';
            filter.Q.setValueAtTime(1.0, this.ctx.currentTime);
            filter.frequency.setValueAtTime(180, this.ctx.currentTime);
            
            const motorGain = this.ctx.createGain();
            motorGain.gain.setValueAtTime(0.0, this.ctx.currentTime); // Start quiet

            // Connections
            oscSaw.connect(filter);
            oscSquare.connect(filter);
            filter.connect(motorGain);
            motorGain.connect(this.masterVolume);
            
            this.motors.push({ oscSaw, oscSquare, baseFreq: baseFreqs[i] });
            this.motorGains.push(motorGain);
            this.motorFilters.push(filter);
        }

        // Add some noise for the wind/air slicing effect of rotors
        this.noiseNode = this.ctx.createBufferSource();
        this.noiseNode.buffer = this.createNoiseBuffer();
        this.noiseNode.loop = true;
        
        this.noiseFilter = this.ctx.createBiquadFilter();
        this.noiseFilter.type = 'bandpass';
        this.noiseFilter.frequency.setValueAtTime(150, this.ctx.currentTime);
        this.noiseFilter.Q.setValueAtTime(1.5, this.ctx.currentTime);
        
        this.noiseGain = this.ctx.createGain();
        this.noiseGain.gain.setValueAtTime(0.0, this.ctx.currentTime);
        
        this.noiseNode.connect(this.noiseFilter);
        this.noiseFilter.connect(this.noiseGain);
        this.noiseGain.connect(this.masterVolume);
    }

    setupWind() {
        // High altitude/speed wind sound
        this.windNode = this.ctx.createBufferSource();
        this.windNode.buffer = this.createNoiseBuffer();
        this.windNode.loop = true;

        this.windFilter = this.ctx.createBiquadFilter();
        this.windFilter.type = 'lowpass';
        this.windFilter.frequency.setValueAtTime(200, this.ctx.currentTime);
        this.windFilter.Q.setValueAtTime(1.0, this.ctx.currentTime);

        this.windGain = this.ctx.createGain();
        this.windGain.gain.setValueAtTime(0.0, this.ctx.currentTime);

        this.windNode.connect(this.windFilter);
        this.windFilter.connect(this.windGain);
        this.windGain.connect(this.masterVolume);
    }

    start() {
        this.init();
        if (this.isStarted) return;
        
        // Resume AudioContext if suspended (browser security policy)
        if (this.ctx.state === 'suspended') {
            this.ctx.resume();
        }

        // Start motor oscillators
        this.motors.forEach(m => {
            m.oscSaw.start(0);
            m.oscSquare.start(0);
        });
        
        // Start noises
        this.noiseNode.start(0);
        this.windNode.start(0);
        
        this.isStarted = true;
    }

    // Call inside rendering/physics loop to update sound dynamically
    update(throttle, speed, motorSpeeds = [0, 0, 0, 0]) {
        if (!this.isStarted) return;

        const time = this.ctx.currentTime;
        
        // Motor Sounds (throttle maps 0.0 - 1.0)
        // High throttle increases frequency (rpm) and filter cutoff
        const targetThrottle = Math.max(0.0, Math.min(1.0, throttle));
        
        for (let i = 0; i < 4; i++) {
            // If motorSpeeds is provided, use it (representing individual thrusts), otherwise use general throttle
            const motorVal = motorSpeeds[i] !== undefined ? motorSpeeds[i] : targetThrottle;
            
            // Frequencies range: 50Hz (idle) to ~260Hz (full throttle)
            const targetPitch = this.motors[i].baseFreq * (1.0 + motorVal * 3.8);
            this.motors[i].oscSaw.frequency.setTargetAtTime(targetPitch, time, 0.05);
            this.motors[i].oscSquare.frequency.setTargetAtTime(targetPitch * 1.5, time, 0.05);
            
            // Filters open up under thrust to let high frequencies through
            const filterCutoff = 180 + motorVal * 800;
            this.motorFilters[i].frequency.setTargetAtTime(filterCutoff, time, 0.05);
            
            // Volume scales with throttle
            const targetVol = 0.15 + motorVal * 0.7;
            this.motorGains[i].gain.setTargetAtTime(targetVol, time, 0.03);
        }

        // Rotor noise scales with throttle
        this.noiseGain.gain.setTargetAtTime(targetThrottle * 0.08, time, 0.1);
        this.noiseFilter.frequency.setTargetAtTime(150 + targetThrottle * 300, time, 0.1);

        // Environment Wind noise scales with physical speed
        // Speed up to 40 m/s maps to wind sound
        const windFactor = Math.min(1.0, speed / 40.0);
        this.windGain.gain.setTargetAtTime(windFactor * 0.15, time, 0.2);
        this.windFilter.frequency.setTargetAtTime(180 + windFactor * 800, time, 0.2);
    }

    playGatePass() {
        if (!this.isStarted) return;
        
        const time = this.ctx.currentTime;
        // Synth a futuristic sweep sound
        const osc = this.ctx.createOscillator();
        const gainNode = this.ctx.createGain();
        
        osc.type = 'sine';
        osc.frequency.setValueAtTime(600, time);
        // Sweep frequency up: 600Hz -> 1800Hz in 0.15s
        osc.frequency.exponentialRampToValueAtTime(1800, time + 0.15);
        
        gainNode.gain.setValueAtTime(0.0, time);
        gainNode.gain.linearRampToValueAtTime(0.25, time + 0.02);
        gainNode.gain.exponentialRampToValueAtTime(0.001, time + 0.3); // fade out
        
        osc.connect(gainNode);
        gainNode.connect(this.masterVolume);
        
        osc.start(time);
        osc.stop(time + 0.3);
    }

    playCrash() {
        if (!this.isStarted) return;
        
        const time = this.ctx.currentTime;
        
        // Mute engines immediately on crash
        this.motorGains.forEach(gain => {
            gain.gain.setValueAtTime(0, time);
        });
        this.noiseGain.gain.setValueAtTime(0, time);
        this.windGain.gain.setValueAtTime(0, time);
        
        // Exploding Synth: Low Rumble + Noise explosion
        const lowOsc = this.ctx.createOscillator();
        const lowGain = this.ctx.createGain();
        lowOsc.type = 'sawtooth';
        lowOsc.frequency.setValueAtTime(100, time);
        lowOsc.frequency.linearRampToValueAtTime(10, time + 0.6);
        
        lowGain.gain.setValueAtTime(0.6, time);
        lowGain.gain.exponentialRampToValueAtTime(0.001, time + 0.6);
        
        lowOsc.connect(lowGain);
        lowGain.connect(this.ctx.destination);
        lowOsc.start(time);
        lowOsc.stop(time + 0.6);
        
        // Noise Burst
        const crashNoise = this.ctx.createBufferSource();
        crashNoise.buffer = this.createNoiseBuffer();
        
        const crashFilter = this.ctx.createBiquadFilter();
        crashFilter.type = 'lowpass';
        crashFilter.frequency.setValueAtTime(1000, time);
        crashFilter.frequency.exponentialRampToValueAtTime(80, time + 0.8);
        
        const noiseGain = this.ctx.createGain();
        noiseGain.gain.setValueAtTime(0.8, time);
        noiseGain.gain.exponentialRampToValueAtTime(0.001, time + 0.8);
        
        crashNoise.connect(crashFilter);
        crashFilter.connect(noiseGain);
        noiseGain.connect(this.ctx.destination);
        
        crashNoise.start(time);
        crashNoise.stop(time + 0.8);
    }

    startBatteryBeep() {
        if (this.batteryBeepInterval) return;
        
        this.batteryBeepInterval = setInterval(() => {
            if (!this.isStarted) return;
            const time = this.ctx.currentTime;
            
            const osc = this.ctx.createOscillator();
            const gainNode = this.ctx.createGain();
            
            osc.type = 'sine';
            osc.frequency.setValueAtTime(2500, time); // High pitched warning beep
            
            gainNode.gain.setValueAtTime(0.0, time);
            gainNode.gain.linearRampToValueAtTime(0.12, time + 0.01);
            gainNode.gain.setValueAtTime(0.12, time + 0.1);
            gainNode.gain.exponentialRampToValueAtTime(0.001, time + 0.15);
            
            osc.connect(gainNode);
            gainNode.connect(this.masterVolume);
            
            osc.start(time);
            osc.stop(time + 0.2);
        }, 1000); // Beep every 1s
    }

    stopBatteryBeep() {
        if (this.batteryBeepInterval) {
            clearInterval(this.batteryBeepInterval);
            this.batteryBeepInterval = null;
        }
    }

    playMenuClick() {
        this.init();
        if (this.ctx.state === 'suspended') {
            this.ctx.resume();
        }
        
        const time = this.ctx.currentTime;
        const osc = this.ctx.createOscillator();
        const gainNode = this.ctx.createGain();
        
        osc.type = 'sine';
        osc.frequency.setValueAtTime(1200, time);
        osc.frequency.setValueAtTime(1500, time + 0.04); // subtle chirp
        
        gainNode.gain.setValueAtTime(0.0, time);
        gainNode.gain.linearRampToValueAtTime(0.1, time + 0.01);
        gainNode.gain.exponentialRampToValueAtTime(0.001, time + 0.08);
        
        osc.connect(gainNode);
        gainNode.connect(this.masterVolume);
        
        osc.start(time);
        osc.stop(time + 0.1);
    }
}

// Global Audio Engine Instance
const audio = new DroneAudioEngine();
window.audioEngine = audio;
