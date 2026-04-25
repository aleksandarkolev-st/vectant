// Tokenizer fixture — exercises every JavaScript scope the Synthi grammar emits.

const MAX_PARTICLES = 1024;
const GRAVITY = 9.81;

const ButtonState = Object.freeze({
    IDLE:    0,
    HOVERED: 1,
    PRESSED: 2,
});

/**
 * Particle pool with gravity + emission.
 * @param {number} capacity
 */
class ParticleSystem {
    #particles = [];
    #emitted = 0;

    constructor(capacity) {
        this.capacity = capacity;
    }

    emit(x, y, color = 0xFF00AAFF) {
        if (this.#particles.length >= MAX_PARTICLES) return false;
        this.#particles.push({ x, y, vx: 0, vy: -2.5, color });
        this.#emitted++;
        return true;
    }

    tick(dt) {
        for (const p of this.#particles) {
            p.vy += GRAVITY * dt;
            p.x  += p.vx * dt;
            p.y  += p.vy * dt;
        }
    }

    get emitted() { return this.#emitted; }
}

const labels = new Map([
    [ButtonState.IDLE,    'idle'],
    [ButtonState.HOVERED, 'hovered'],
    [ButtonState.PRESSED, 'pressed'],
]);

async function run() {
    const system = new ParticleSystem(MAX_PARTICLES);
    for (let i = 0; i < 16; i++) {
        system.emit(i * 8, 32);
    }
    system.tick(1 / 60);

    const banner = `── Synthi Tokenizer Fixture ──
    emitted = ${system.emitted}`;
    console.log(banner);

    const isHex = /^0x[0-9a-fA-F]+$/;
    if (!isHex.test('0xCAFEBABE')) throw new Error('regex mismatch');

    await Promise.all([...labels].map(async ([state, label]) => {
        console.log(`${state} → ${label}`);
    }));
}

run().catch(err => console.error('failed:', err));
