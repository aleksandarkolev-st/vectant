// Tokenizer fixture — exercises every C++ scope the Synthi grammar emits.

#include <SDL2/SDL.h>
#include <vector>
#include <string>
#include <cstdint>

#define MAX_PARTICLES 1024
#define DEG_TO_RAD(x) ((x) * 0.0174533f)

namespace synthi::demo {

constexpr int    WINDOW_WIDTH  = 800;
constexpr int    WINDOW_HEIGHT = 600;
constexpr float  GRAVITY       = 9.81f;

enum class ButtonState : uint8_t {
    Idle    = 0,
    Hovered = 1,
    Pressed = 2,
};

struct Particle {
    float    x, y;
    float    vx, vy;
    uint32_t color;
};

class ParticleSystem {
public:
    explicit ParticleSystem(size_t capacity) : particles_(capacity) {}

    void emit(float x, float y, uint32_t color) {
        if (particles_.size() >= MAX_PARTICLES) return;
        particles_.push_back({ x, y, 0.0f, -2.5f, color });
    }

    void tick(float dt) {
        for (auto& p : particles_) {
            p.vy += GRAVITY * dt;
            p.x  += p.vx * dt;
            p.y  += p.vy * dt;
        }
    }

private:
    std::vector<Particle> particles_;
};

}  // namespace synthi::demo

int main(int argc, char** argv) {
    SDL_Init(SDL_INIT_VIDEO);
    SDL_Window* win = SDL_CreateWindow(
        "Synthi Tokenizer Fixture",
        SDL_WINDOWPOS_CENTERED, SDL_WINDOWPOS_CENTERED,
        synthi::demo::WINDOW_WIDTH, synthi::demo::WINDOW_HEIGHT, 0
    );
    SDL_Renderer* ren = SDL_CreateRenderer(win, -1, SDL_RENDERER_ACCELERATED);

    synthi::demo::ParticleSystem system(MAX_PARTICLES);

    bool running = true;
    while (running) {
        SDL_Event ev;
        while (SDL_PollEvent(&ev)) {
            if (ev.type == SDL_QUIT)        running = false;
            if (ev.type == SDL_MOUSEBUTTONDOWN) {
                system.emit(static_cast<float>(ev.button.x),
                            static_cast<float>(ev.button.y),
                            0xFF00AAFFu);
            }
        }
        system.tick(1.0f / 60.0f);

        SDL_SetRenderDrawColor(ren, 0x12, 0x14, 0x1c, 0xFF);
        SDL_RenderClear(ren);
        SDL_RenderPresent(ren);
    }

    SDL_DestroyRenderer(ren);
    SDL_DestroyWindow(win);
    SDL_Quit();
    return 0;
}
