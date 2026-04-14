// Phase 7 corpus — no graphics, console-only app
// Tests the AI's handling of a project that has no UI framework at
// all. Expected: runner_link_flags minimal (just -ldl), host_runner
// synthesised from the plain main() with a simple loop, gui.cpp
// should end up empty or a minimal no-op stub. hot_reload_mode=swap.
#include <cstdio>
#include <cstdlib>
#include <ctime>

int main() {
    std::srand(static_cast<unsigned int>(std::time(nullptr)));

    int counter = 0;
    const int target = 100;

    while (counter < target) {
        int roll = std::rand() % 6 + 1;
        counter += roll;
        std::printf("Roll: %d, total: %d\n", roll, counter);
    }

    std::printf("Reached target after %d throws.\n", counter);
    return 0;
}
