class RatesEngine {
    constructor() {
        // Default rates
        this.roll = { rcRate: 1.0, superRate: 0.7, expo: 0.15 };
        this.pitch = { rcRate: 1.0, superRate: 0.7, expo: 0.15 };
        this.yaw = { rcRate: 1.0, superRate: 0.6, expo: 0.15 };
    }

    /**
     * Calculate rotation rate in degrees/sec using Betaflight formulas
     * @param {number} stickValue - Stick input from -1.0 to 1.0
     * @param {number} rcRate - Linear multiplier (0.1 - 2.0)
     * @param {number} superRate - High stick acceleration (0.0 - 0.9)
     * @param {number} expo - Center stick dampening (0.0 - 0.9)
     * @returns {number} Rate in degrees per second
     */
    calculateRate(stickValue, rcRate, superRate, expo) {
        if (stickValue === 0) return 0;
        
        const sign = Math.sign(stickValue);
        const absVal = Math.abs(stickValue);
        
        // 1. Apply Expo
        // Formula: x_expo = x * x^3 * expo + x * (1 - expo)
        const expoVal = absVal * absVal * absVal * expo + absVal * (1 - expo);
        
        // 2. Apply RC Rate & Super Rate
        // Formula: rate = (expoVal * 200 * rcRate) / (1 - (expoVal * superRate))
        const rcRatePart = expoVal * 200.0 * rcRate;
        const superRatePart = 1.0 - (expoVal * superRate);
        
        let rateDegSec = 0;
        if (superRatePart > 0.01) {
            rateDegSec = rcRatePart / superRatePart;
        } else {
            rateDegSec = rcRatePart / 0.01; // Avoid divide by zero
        }
        
        return rateDegSec * sign;
    }

    getMaxRate(rcRate, superRate) {
        // Max rate happens when stick = 1.0 (expo has no effect since 1^3 = 1)
        const rcRatePart = 1.0 * 200.0 * rcRate;
        const superRatePart = 1.0 - superRate;
        if (superRatePart > 0.01) {
            return Math.round(rcRatePart / superRatePart);
        }
        return Math.round(rcRatePart / 0.01);
    }

    /**
     * Draws the rate response curve on a 2D canvas
     */
    drawRatesPlot(canvas, rcRate, superRate, expo, strokeColor = '#00f0ff') {
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const width = canvas.width;
        const height = canvas.height;
        
        // Clear canvas
        ctx.fillStyle = '#0a0b10';
        ctx.fillRect(0, 0, width, height);
        
        // Draw grid
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
        ctx.lineWidth = 1;
        
        // Horizontal grid lines
        for (let y = height / 4; y < height; y += height / 4) {
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(width, y);
            ctx.stroke();
        }
        
        // Vertical grid lines
        for (let x = width / 4; x < width; x += width / 4) {
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, height);
            ctx.stroke();
        }
        
        // Center cross axes
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
        ctx.beginPath();
        ctx.moveTo(width / 2, 0);
        ctx.lineTo(width / 2, height);
        ctx.moveTo(0, height / 2);
        ctx.lineTo(width, height / 2);
        ctx.stroke();
        
        // Plot the curve
        // Scale factor: max rate corresponds to the top/bottom edges of the canvas
        const maxRate = this.getMaxRate(rcRate, superRate);
        const padding = 15;
        const graphHeight = height - padding * 2;
        const graphWidth = width - padding * 2;
        
        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        
        for (let px = 0; px <= graphWidth; px++) {
            // Map pixel X to stick value [-1.0, 1.0]
            const stick = ((px / graphWidth) * 2) - 1.0;
            const rate = this.calculateRate(stick, rcRate, superRate, expo);
            
            // Map rate [-maxRate, maxRate] to pixel Y [height - padding, padding]
            const py = (height / 2) - (rate / maxRate) * (graphHeight / 2);
            
            if (px === 0) {
                ctx.moveTo(px + padding, py);
            } else {
                ctx.lineTo(px + padding, py);
            }
        }
        ctx.stroke();
        
        // Draw labels for axes
        ctx.fillStyle = '#64748b';
        ctx.font = '9px Orbitron';
        ctx.textAlign = 'right';
        ctx.fillText(`${maxRate} deg/s`, width - 5, padding + 10);
        ctx.fillText(`0 deg/s`, width - 5, height / 2 - 3);
        ctx.fillText(`-${maxRate} deg/s`, width - 5, height - padding - 2);
        
        ctx.textAlign = 'left';
        ctx.fillText('-1.0', padding, height - 2);
        ctx.textAlign = 'center';
        ctx.fillText('0.0 (Center)', width / 2, height - 2);
        ctx.textAlign = 'right';
        ctx.fillText('1.0', width - padding, height - 2);
    }
}

// Global Rates Instance
const rates = new RatesEngine();
window.ratesEngine = rates;
