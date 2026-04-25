// Tokenizer fixture — exercises every TypeScript scope the Synthi grammar emits.

import type { Readable } from 'node:stream';

const MAX_PARTICLES = 1024 as const;
const GRAVITY: number = 9.81;

export enum ButtonState {
    Idle    = 'idle',
    Hovered = 'hovered',
    Pressed = 'pressed',
}

export interface Particle {
    readonly x:  number;
    readonly y:  number;
    vx:          number;
    vy:          number;
    color:       number;
}

export type Renderer<T> = (item: T) => void;

type Maybe<T> = T | null | undefined;

function clamp<T extends number>(value: T, min: T, max: T): T {
    return Math.min(Math.max(value, min), max) as T;
}

function decorator(_target: unknown, _key: string): void {}

export class ParticleSystem<T extends Particle = Particle> {
    private readonly particles: T[] = [];
    private emitted = 0;

    constructor(public readonly capacity: number) {}

    @decorator
    emit(x: number, y: number, color = 0xFF00AAFF): boolean {
        if (this.particles.length >= MAX_PARTICLES) return false;
        this.particles.push({ x, y, vx: 0, vy: -2.5, color } as T);
        this.emitted += 1;
        return true;
    }

    tick(dt: number): void {
        for (const p of this.particles) {
            p.vy += GRAVITY * dt;
            p.x  += p.vx * dt;
            p.y  += p.vy * dt;
        }
    }

    get count(): number { return this.particles.length; }
}

const labels: Record<ButtonState, string> = {
    [ButtonState.Idle]:    'idle',
    [ButtonState.Hovered]: 'hovered',
    [ButtonState.Pressed]: 'pressed',
};

async function main(stream?: Readable): Promise<void> {
    const system = new ParticleSystem(MAX_PARTICLES);
    for (let i = 0; i < 16; i++) {
        system.emit(clamp(i * 8, 0, 800), 32);
    }
    system.tick(1 / 60);

    const banner = `── Synthi Tokenizer Fixture ──
    count = ${system.count}`;
    console.log(banner);

    const labelEntries = Object.entries(labels) as Array<[ButtonState, string]>;
    for (const [state, label] of labelEntries) {
        console.log(`${state} → ${label}`);
    }
    void stream;
}

main().catch((err: unknown) => console.error('failed:', err));
