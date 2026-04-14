// Phase 7 corpus — SFML (class-based C++ API)
// Tests the AI's ability to split a C++ class-based library with
// RAII objects. Expected: runner_link_flags contains -lsfml-graphics
// -lsfml-window -lsfml-system, hot_reload_mode=swap.
#include <SFML/Graphics.hpp>
#include <SFML/Window.hpp>

int main() {
    sf::RenderWindow window(sf::VideoMode(800, 600), "SFML HMR Test");
    window.setFramerateLimit(60);

    sf::RectangleShape btn(sf::Vector2f(200.f, 60.f));
    btn.setPosition(50.f, 50.f);
    btn.setFillColor(sf::Color(60, 120, 220));

    while (window.isOpen()) {
        sf::Event event;
        while (window.pollEvent(event)) {
            if (event.type == sf::Event::Closed) {
                window.close();
            }
        }

        window.clear(sf::Color(20, 20, 40));
        window.draw(btn);
        window.display();
    }

    return 0;
}
