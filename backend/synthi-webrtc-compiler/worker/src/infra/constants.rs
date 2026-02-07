pub const REQUIRED_TOOLS: &[&str] = &["g++", "rustc", "tsc", "clangd"];
/// Language server binaries that are checked at startup but not fatal if missing.
/// Each worker container should install the ones relevant to the languages it serves.
pub const LSP_TOOLS: &[&str] = &[
    "clangd",                     // C / C++
    "rust-analyzer",              // Rust
    "pylsp",                      // Python  (python-lsp-server)
    "typescript-language-server", // TypeScript / JavaScript
    "gopls",                      // Go
    "jdtls",                      // Java  (Eclipse JDT.LS)
    "OmniSharp",                  // C#    (OmniSharp-Roslyn)
    "ruby-lsp",                   // Ruby  (Shopify ruby-lsp)
    "phpactor",                   // PHP   (phpactor)
    "kotlin-language-server",     // Kotlin
    "zls",                        // Zig
    "dart",                       // Dart  (dart language-server)
    "elixir-ls",                  // Elixir (ElixirLS)
    "lua-language-server",        // Lua   (LuaLS / lua-language-server)
    "svelte-language-server",     // Svelte
    "vscode-css-languageserver",  // CSS / SCSS / LESS
    "vscode-html-languageserver", // HTML
];
pub const GUI_TOOLS: &[&str] = &["xdotool", "Xvfb", "matchbox-window-manager"]; // Keeping these for now as SDL2 might use Xvfb on Linux
