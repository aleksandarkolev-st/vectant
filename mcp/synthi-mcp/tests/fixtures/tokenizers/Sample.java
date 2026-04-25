// Tokenizer fixture — exercises every Java scope the Synthi grammar emits.

package com.synthi.demo;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Demo of {@link ParticleSystem} — javadoc reference, annotations,
 * generics, lambdas and text blocks all in one file.
 */
public final class Sample {

    public static final int    MAX_PARTICLES = 1024;
    public static final double GRAVITY       = 9.81;

    private static final String BANNER = """
        ╔════════════════════════╗
        ║  Synthi Tokenizer Test ║
        ╚════════════════════════╝
        """;

    public enum ButtonState { IDLE, HOVERED, PRESSED }

    public record Particle(float x, float y, float vx, float vy, int color) {}

    public interface Renderer<T> {
        void draw(T item);
    }

    @FunctionalInterface
    public interface Updatable {
        void tick(float dt);
    }

    public static class ParticleSystem implements Updatable {
        private final List<Particle>   particles = new ArrayList<>();
        private final AtomicInteger    emitted   = new AtomicInteger(0);

        @Override
        public void tick(float dt) {
            particles.replaceAll(p -> new Particle(
                p.x() + p.vx() * dt,
                p.y() + p.vy() * dt,
                p.vx(),
                p.vy() + (float) GRAVITY * dt,
                p.color()
            ));
        }

        public void emit(float x, float y, int color) {
            if (particles.size() >= MAX_PARTICLES) return;
            particles.add(new Particle(x, y, 0.0f, -2.5f, color));
            emitted.incrementAndGet();
        }
    }

    public static void main(String[] args) {
        System.out.println(BANNER);
        var system = new ParticleSystem();
        for (int i = 0; i < 16; i++) {
            system.emit(i * 8.0f, 32.0f, 0xFF00AAFF);
        }
        system.tick(1.0f / 60.0f);

        Map<ButtonState, String> labels = Map.of(
            ButtonState.IDLE,    "idle",
            ButtonState.HOVERED, "hovered",
            ButtonState.PRESSED, "pressed"
        );
        labels.forEach((state, label) ->
            System.out.printf("%-8s → %s%n", state, label));
    }
}
