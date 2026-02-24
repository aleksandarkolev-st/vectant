pub const REQUIRED_TOOLS: &[&str] = &["g++", "rustc", "tsc", "clangd"];
/// Language server binaries that are checked at startup but not fatal if missing.
/// Each worker container should install the ones relevant to the languages it serves.
pub const LSP_TOOLS: &[&str] = &[
    "clangd",                      // C / C++
    "rust-analyzer",               // Rust
    "pylsp",                       // Python  (python-lsp-server)
    "typescript-language-server",  // TypeScript / JavaScript
    "gopls",                       // Go
    "jdtls",                       // Java  (Eclipse JDT.LS)
    "OmniSharp",                   // C#    (OmniSharp-Roslyn)
    "ruby-lsp",                    // Ruby  (Shopify ruby-lsp)
    "phpactor",                    // PHP   (phpactor)
    "kotlin-language-server",      // Kotlin
    "zls",                         // Zig
    "dart",                        // Dart  (dart language-server)
    "elixir-ls",                   // Elixir (ElixirLS)
    "lua-language-server",         // Lua   (LuaLS / lua-language-server)
    "svelte-language-server",      // Svelte
    "vscode-css-language-server",  // CSS / SCSS / LESS (vscode-langservers-extracted)
    "vscode-html-language-server", // HTML (vscode-langservers-extracted)
];
pub const GUI_TOOLS: &[&str] = &["Xvfb", "matchbox-window-manager"]; // xdotool no longer needed — input goes through runner stdin
