/**
 * NeuralVisuals - Remixed Neural Network Particle Background
 * Adapted from Qwen3-Coder-Next Neural Hello World
 * Auto-playing particle system — no human interaction
 * Clean render: full canvas clear each frame, no residual color artifacts
 */
class NeuralVisuals {
    constructor() {
        this.canvas = document.getElementById('neural-bg');
        this.ctx = this.canvas.getContext('2d');
        this.particles = [];
        this.width = window.innerWidth;
        this.height = window.innerHeight;

        this.resize();
        window.addEventListener('resize', () => {
            this.resize();
            this.initParticles();
        });

        this.initParticles();
        this.animate();
    }

    resize() {
        this.width = window.innerWidth;
        this.height = window.innerHeight;
        this.canvas.width = this.width;
        this.canvas.height = this.height;
    }

    initParticles() {
        const count = Math.floor((this.width * this.height) / 15000);
        this.particles = [];
        for (let i = 0; i < count; i++) {
            this.particles.push({
                x: Math.random() * this.width,
                y: Math.random() * this.height,
                vx: (Math.random() - 0.5) * 2,
                vy: (Math.random() - 0.5) * 2,
                size: Math.random() * 3,
                color: Math.random() > 0.8 ? '#00f2ff' : '#7000ff'
            });
        }
    }

    animate() {
        // Full canvas clear — no trail residue, no color bleeding
        this.ctx.clearRect(0, 0, this.width, this.height);

        for (let i = 0; i < this.particles.length; i++) {
            const p = this.particles[i];

            // Movement
            p.x += p.vx;
            p.y += p.vy;

            // Boundary Wrap
            if (p.x < 0) p.x = this.width;
            if (p.x > this.width) p.x = 0;
            if (p.y < 0) p.y = this.height;
            if (p.y > this.height) p.y = 0;

            // Draw Particle
            this.ctx.beginPath();
            this.ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
            this.ctx.fillStyle = p.color;
            this.ctx.fill();

            // Draw Connections to nearby particles
            for (let j = i + 1; j < this.particles.length; j++) {
                const p2 = this.particles[j];
                const dx = p.x - p2.x;
                const dy = p.y - p2.y;
                const dist = Math.sqrt(dx * dx + dy * dy);

                if (dist < 150) {
                    this.ctx.beginPath();
                    this.ctx.moveTo(p.x, p.y);
                    this.ctx.lineTo(p2.x, p2.y);
                    const opacity = 1 - (dist / 150);
                    this.ctx.strokeStyle = 'rgba(0, 242, 255, ' + (opacity * 0.5) + ')';
                    this.ctx.lineWidth = 1;
                    this.ctx.stroke();
                }
            }
        }

        requestAnimationFrame(() => this.animate());
    }
}

// Auto-initialize when DOM is ready
(function() {
    function initNeuralBg() {
        const canvas = document.getElementById('neural-bg');
        if (canvas) {
            window.neuralVisuals = new NeuralVisuals();
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initNeuralBg);
    } else {
        initNeuralBg();
    }
})();
