// Tokenizer fixture — exercises every Rust scope the Synthi grammar emits.

#![allow(dead_code)]

use std::collections::HashMap;
use std::fmt::{self, Display};
use std::sync::atomic::{AtomicUsize, Ordering};

const MAX_PARTICLES: usize = 1024;
const GRAVITY: f32        = 9.81;

static EMITTED: AtomicUsize = AtomicUsize::new(0);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ButtonState {
    Idle,
    Hovered,
    Pressed,
}

impl Display for ButtonState {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Idle    => write!(f, "idle"),
            Self::Hovered => write!(f, "hovered"),
            Self::Pressed => write!(f, "pressed"),
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct Particle {
    pub x:     f32,
    pub y:     f32,
    pub vx:    f32,
    pub vy:    f32,
    pub color: u32,
}

pub trait Renderer<'a, T: 'a> {
    fn draw(&mut self, item: &'a T);
}

pub struct ParticleSystem {
    particles: Vec<Particle>,
}

impl ParticleSystem {
    pub fn new(capacity: usize) -> Self {
        Self {
            particles: Vec::with_capacity(capacity),
        }
    }

    pub fn emit(&mut self, x: f32, y: f32, color: u32) -> Result<(), &'static str> {
        if self.particles.len() >= MAX_PARTICLES {
            return Err("particle pool full");
        }
        self.particles.push(Particle { x, y, vx: 0.0, vy: -2.5, color });
        EMITTED.fetch_add(1, Ordering::Relaxed);
        Ok(())
    }

    pub fn tick(&mut self, dt: f32) {
        for p in self.particles.iter_mut() {
            p.vy += GRAVITY * dt;
            p.x  += p.vx * dt;
            p.y  += p.vy * dt;
        }
    }
}

fn main() {
    let mut system = ParticleSystem::new(MAX_PARTICLES);
    let labels: HashMap<ButtonState, &str> = HashMap::from([
        (ButtonState::Idle,    "idle"),
        (ButtonState::Hovered, "hovered"),
        (ButtonState::Pressed, "pressed"),
    ]);

    for i in 0..16 {
        system.emit(i as f32 * 8.0, 32.0, 0xFF00_AAFF).unwrap();
    }
    system.tick(1.0 / 60.0);

    println!("emitted = {}", EMITTED.load(Ordering::Relaxed));
    for (state, label) in &labels {
        println!("{state:<8} → {label}");
    }
}
