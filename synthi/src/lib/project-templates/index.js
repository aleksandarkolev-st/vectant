/**
 * Project & file template registry for the New-Workspace picker.
 *
 * A "project template" describes a small starter scaffold dropped into an
 * empty workspace. Two flavours:
 *   - simple:   { files: [...], manifest: 'Language Name' }
 *   - variants: { variants: [{ id, label, description, files, manifest }, ...] }
 *
 * Templates with variants surface a second step in the picker before the
 * scaffold runs. See [NewProjectPicker.jsx](../../components/NewProjectPicker.jsx).
 *
 * Per template the picker calls `scaffoldProjectThunk` in workspaceSlice,
 * which writes the file list in one `write-files-batch` call, then
 * populates compileManifestSlice with a synthetic `## Language & Framework`
 * markdown block so the bottom-right pill lights up immediately.
 *
 * The RN-Android and Flutter-Android templates intentionally ship only a
 * package.json / pubspec.yaml + entry source. The Rust worker's existing
 * ensure_android_gradle_project() runs on first compile and fills in the
 * android/ folder.
 */

import {
  FileText,
  FileCode,
  FileJson,
  Hash,
  Braces,
  Smartphone,
  Atom,
  Server,
  Cog,
  Coffee,
  Sparkles,
  Type,
} from 'lucide-react';

// ─── Single-file templates (Files tab) ─────────────────────────────

export const FILE_TYPES = [
  { id: 'py',   label: 'Python',     ext: 'py',   icon: FileCode,   defaultName: 'main' },
  { id: 'ts',   label: 'TypeScript', ext: 'ts',   icon: Type,       defaultName: 'index' },
  { id: 'js',   label: 'JavaScript', ext: 'js',   icon: FileCode,   defaultName: 'index' },
  { id: 'cpp',  label: 'C++',        ext: 'cpp',  icon: FileCode,   defaultName: 'main' },
  { id: 'c',    label: 'C',          ext: 'c',    icon: FileCode,   defaultName: 'main' },
  { id: 'h',    label: 'C Header',   ext: 'h',    icon: FileCode,   defaultName: 'main' },
  { id: 'java', label: 'Java',       ext: 'java', icon: Coffee,     defaultName: 'Main' },
  { id: 'rs',   label: 'Rust',       ext: 'rs',   icon: Cog,        defaultName: 'main' },
  { id: 'md',   label: 'Markdown',   ext: 'md',   icon: Hash,       defaultName: 'README' },
  { id: 'json', label: 'JSON',       ext: 'json', icon: FileJson,   defaultName: 'data' },
  { id: 'yaml', label: 'YAML',       ext: 'yaml', icon: Braces,     defaultName: 'config' },
  { id: 'txt',  label: 'Plain text', ext: 'txt',  icon: FileText,   defaultName: 'notes' },
];

// ─── Project templates (Projects tab) ──────────────────────────────

/** Helper — emit a one-line architecture markdown for compileManifestSlice. */
const arch = (lf) => `## Language & Framework\n${lf}\n`;

export const PROJECT_TEMPLATES = [
  {
    id: 'python',
    label: 'Python',
    icon: FileCode,
    description: 'main.py + requirements.txt',
    manifest: 'Python',
    systemPromptHint:
      'You are scaffolding a Python application. Follow PEP 8, prefer the standard library, declare third-party deps in requirements.txt, and structure entry points behind `if __name__ == "__main__":`.',
    files: [
      { path: 'main.py', content: 'def main():\n    print("Hello from Synthi")\n\n\nif __name__ == "__main__":\n    main()\n' },
      { path: 'requirements.txt', content: '' },
    ],
  },
  {
    id: 'node',
    label: 'Node.js',
    icon: Server,
    description: 'package.json + index.js',
    manifest: 'Node.js',
    systemPromptHint:
      'You are scaffolding a Node.js application. Use ES modules (`"type": "module"`), declare explicit scripts in package.json, and pin dependency versions.',
    files: [
      {
        path: 'package.json',
        content: JSON.stringify(
          { name: 'synthi-app', version: '0.1.0', type: 'module', main: 'index.js', scripts: { start: 'node index.js' } },
          null,
          2,
        ) + '\n',
      },
      { path: 'index.js', content: 'console.log("Hello from Synthi");\n' },
    ],
  },
  {
    id: 'typescript',
    label: 'TypeScript',
    icon: Type,
    description: 'package.json + src/index.ts + tsconfig.json',
    manifest: 'TypeScript',
    systemPromptHint:
      'You are scaffolding a TypeScript application. Use strict mode, ES modules, prefer explicit types over `any`, and compile through `tsc` into a `dist/` directory.',
    files: [
      {
        path: 'package.json',
        content: JSON.stringify(
          {
            name: 'synthi-app',
            version: '0.1.0',
            type: 'module',
            main: 'dist/index.js',
            scripts: { build: 'tsc', start: 'node dist/index.js' },
            devDependencies: { typescript: '^5.4.0' },
          },
          null,
          2,
        ) + '\n',
      },
      {
        path: 'tsconfig.json',
        content: JSON.stringify(
          {
            compilerOptions: {
              target: 'ES2022',
              module: 'ES2022',
              moduleResolution: 'bundler',
              outDir: 'dist',
              strict: true,
              esModuleInterop: true,
            },
            include: ['src'],
          },
          null,
          2,
        ) + '\n',
      },
      { path: 'src/index.ts', content: 'const greeting: string = "Hello from Synthi";\nconsole.log(greeting);\n' },
    ],
  },
  {
    id: 'react',
    label: 'React',
    icon: Atom,
    description: 'Choose a build setup',
    variants: [
      {
        id: 'vite',
        label: 'Vite',
        description: 'index.html + Vite + React 18 (recommended)',
        manifest: 'React (Vite)',
        systemPromptHint:
          'You are scaffolding a React + Vite single-page app. Use function components and hooks, ES modules, place sources under `src/`, and configure Vite via `vite.config.js`. Do not introduce CRA-specific files.',
        files: [
          {
            path: 'package.json',
            content: JSON.stringify(
              {
                name: 'synthi-react',
                version: '0.1.0',
                type: 'module',
                scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' },
                dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1' },
                devDependencies: { vite: '^5.2.0', '@vitejs/plugin-react': '^4.3.0' },
              },
              null,
              2,
            ) + '\n',
          },
          {
            path: 'index.html',
            content: '<!doctype html>\n<html>\n  <head>\n    <meta charset="UTF-8" />\n    <title>Synthi React</title>\n  </head>\n  <body>\n    <div id="root"></div>\n    <script type="module" src="/src/main.jsx"></script>\n  </body>\n</html>\n',
          },
          {
            path: 'vite.config.js',
            content: 'import { defineConfig } from "vite";\nimport react from "@vitejs/plugin-react";\n\nexport default defineConfig({ plugins: [react()] });\n',
          },
          {
            path: 'src/main.jsx',
            content: 'import { createRoot } from "react-dom/client";\nimport App from "./App.jsx";\n\ncreateRoot(document.getElementById("root")).render(<App />);\n',
          },
          {
            path: 'src/App.jsx',
            content: 'export default function App() {\n  return <h1>Hello from Synthi</h1>;\n}\n',
          },
        ],
      },
      {
        id: 'cra',
        label: 'Create React App',
        description: 'Classic CRA layout — react-scripts',
        manifest: 'React (CRA)',
        systemPromptHint:
          'You are scaffolding a Create React App project (`react-scripts`). Public assets live under `public/`, sources under `src/`. Use function components and hooks. Do not introduce Vite or alternative bundler configs.',
        files: [
          {
            path: 'package.json',
            content: JSON.stringify(
              {
                name: 'synthi-react',
                version: '0.1.0',
                private: true,
                scripts: { start: 'react-scripts start', build: 'react-scripts build', test: 'react-scripts test' },
                dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1', 'react-scripts': '5.0.1' },
                browserslist: { production: ['>0.2%', 'not dead'], development: ['last 1 chrome version'] },
              },
              null,
              2,
            ) + '\n',
          },
          {
            path: 'public/index.html',
            content: '<!doctype html>\n<html>\n  <head><meta charset="UTF-8" /><title>Synthi React</title></head>\n  <body><div id="root"></div></body>\n</html>\n',
          },
          {
            path: 'src/index.js',
            content: 'import React from "react";\nimport { createRoot } from "react-dom/client";\nimport App from "./App";\n\ncreateRoot(document.getElementById("root")).render(<App />);\n',
          },
          {
            path: 'src/App.js',
            content: 'export default function App() {\n  return <h1>Hello from Synthi</h1>;\n}\n',
          },
        ],
      },
    ],
  },
  {
    id: 'cpp',
    label: 'C++',
    icon: FileCode,
    description: 'main.cpp + CMakeLists.txt',
    manifest: 'C++ with CMake',
    systemPromptHint:
      'You are scaffolding a C++17 application built with CMake. Keep declarations in headers and definitions in `.cpp` files. Update `CMakeLists.txt` for any new sources or dependencies.',
    files: [
      {
        path: 'main.cpp',
        content: '#include <iostream>\n\nint main() {\n    std::cout << "Hello from Synthi" << std::endl;\n    return 0;\n}\n',
      },
      {
        path: 'CMakeLists.txt',
        content: 'cmake_minimum_required(VERSION 3.15)\nproject(synthi_app CXX)\nset(CMAKE_CXX_STANDARD 17)\nadd_executable(synthi_app main.cpp)\n',
      },
    ],
  },
  {
    id: 'rust',
    label: 'Rust',
    icon: Cog,
    description: 'Cargo.toml + src/main.rs',
    manifest: 'Rust (Cargo)',
    systemPromptHint:
      'You are scaffolding a Rust binary crate. Declare dependencies in Cargo.toml, prefer the standard library, and follow idiomatic ownership/borrowing patterns. Place modules under `src/`.',
    files: [
      {
        path: 'Cargo.toml',
        content: '[package]\nname = "synthi_app"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\n',
      },
      {
        path: 'src/main.rs',
        content: 'fn main() {\n    println!("Hello from Synthi");\n}\n',
      },
    ],
  },
  {
    id: 'java',
    label: 'Java',
    icon: Coffee,
    description: 'Choose a build setup',
    variants: [
      {
        id: 'plain',
        label: 'Plain',
        description: 'Single-file Main.java — no build system',
        manifest: 'Java',
        systemPromptHint:
          'You are scaffolding a plain Java project with no build system. Sources sit at the project root, compile with `javac` and run with `java`. Do not introduce Maven/Gradle files unless explicitly asked.',
        files: [
          {
            path: 'Main.java',
            content: 'public class Main {\n    public static void main(String[] args) {\n        System.out.println("Hello from Synthi");\n    }\n}\n',
          },
        ],
      },
      {
        id: 'maven',
        label: 'Maven',
        description: 'pom.xml + src/main/java/Main.java',
        manifest: 'Java (Maven)',
        systemPromptHint:
          'You are scaffolding a Maven-managed Java project. Sources live under `src/main/java`, tests under `src/test/java`. Add dependencies to `pom.xml`, target JDK 17.',
        files: [
          {
            path: 'pom.xml',
            content: '<?xml version="1.0" encoding="UTF-8"?>\n<project xmlns="http://maven.apache.org/POM/4.0.0">\n    <modelVersion>4.0.0</modelVersion>\n    <groupId>com.synthi</groupId>\n    <artifactId>synthi-app</artifactId>\n    <version>0.1.0</version>\n    <properties>\n        <maven.compiler.source>17</maven.compiler.source>\n        <maven.compiler.target>17</maven.compiler.target>\n    </properties>\n</project>\n',
          },
          {
            path: 'src/main/java/Main.java',
            content: 'public class Main {\n    public static void main(String[] args) {\n        System.out.println("Hello from Synthi");\n    }\n}\n',
          },
        ],
      },
    ],
  },
  {
    id: 'react-native-android',
    label: 'React Native (Android)',
    icon: Smartphone,
    description: 'package.json + App.tsx — worker scaffolds android/ on first compile',
    manifest: 'React Native (Android)',
    systemPromptHint:
      'You are scaffolding a React Native (Android) app. Use TypeScript (.tsx), React Native primitives (View/Text/SafeAreaView), and `StyleSheet.create`. Do not edit `android/` — the worker generates that on first compile. Keep `react-native: 0.73.6` and `react: 18.2.0`.',
    files: [
      {
        path: 'package.json',
        content: JSON.stringify(
          {
            name: 'synthiapp',
            version: '0.1.0',
            private: true,
            scripts: { start: 'react-native start', android: 'react-native run-android' },
            dependencies: { react: '18.2.0', 'react-native': '0.73.6' },
          },
          null,
          2,
        ) + '\n',
      },
      {
        path: 'app.json',
        content: JSON.stringify({ name: 'SynthiApp', displayName: 'SynthiApp' }, null, 2) + '\n',
      },
      {
        path: 'index.js',
        content: 'import { AppRegistry } from "react-native";\nimport App from "./App";\nimport { name as appName } from "./app.json";\n\nAppRegistry.registerComponent(appName, () => App);\n',
      },
      {
        path: 'App.tsx',
        content: 'import React from "react";\nimport { SafeAreaView, Text, StyleSheet } from "react-native";\n\nexport default function App() {\n  return (\n    <SafeAreaView style={styles.container}>\n      <Text style={styles.text}>Hello from Synthi</Text>\n    </SafeAreaView>\n  );\n}\n\nconst styles = StyleSheet.create({\n  container: { flex: 1, alignItems: "center", justifyContent: "center" },\n  text: { fontSize: 20 },\n});\n',
      },
    ],
  },
  {
    id: 'flutter-android',
    label: 'Flutter (Android)',
    icon: Smartphone,
    description: 'pubspec.yaml + lib/main.dart — worker handles android/ on first compile',
    manifest: 'Flutter (Android)',
    systemPromptHint:
      'You are scaffolding a Flutter (Android) app. Dart 3 with null-safety, Material 3 widgets, sources under `lib/`. Update `pubspec.yaml` for any new dependencies. Do not edit `android/` — the worker handles it on first compile.',
    files: [
      {
        path: 'pubspec.yaml',
        content: 'name: synthi_app\ndescription: Synthi Flutter starter\nversion: 0.1.0\n\nenvironment:\n  sdk: ">=3.0.0 <4.0.0"\n\ndependencies:\n  flutter:\n    sdk: flutter\n\nflutter:\n  uses-material-design: true\n',
      },
      {
        path: 'lib/main.dart',
        content: 'import "package:flutter/material.dart";\n\nvoid main() => runApp(const SynthiApp());\n\nclass SynthiApp extends StatelessWidget {\n  const SynthiApp({super.key});\n  @override\n  Widget build(BuildContext context) {\n    return MaterialApp(\n      home: Scaffold(\n        body: Center(child: Text("Hello from Synthi", style: TextStyle(fontSize: 20))),\n      ),\n    );\n  }\n}\n',
      },
    ],
  },
];

// ─── "Other" — special id ──────────────────────────────────────────
//
// Behaves differently per picker mode:
//   - scaffold mode (empty workspace): clicking opens an inline
//     description input; on submit dispatches a window event that the
//     workspace page consumes to fire the AI chat with the user's prompt.
//   - jumpstart mode (dashboard): clicking just selects "no project
//     type" and unlocks the existing prompt textarea with no extra
//     system-prompt addition (blank canvas).

export const OTHER_TEMPLATE_ID = 'other';

export const OTHER_TEMPLATE = {
  id: OTHER_TEMPLATE_ID,
  label: 'Other',
  icon: Sparkles,
  description: 'Describe it — AI builds from a blank canvas',
  manifest: null,
  systemPromptHint: null,
  files: [],
};

// ─── Lookups ───────────────────────────────────────────────────────

export function getProjectTemplate(id) {
  if (id === OTHER_TEMPLATE_ID) return OTHER_TEMPLATE;
  return PROJECT_TEMPLATES.find((t) => t.id === id) || null;
}

export function hasVariants(template) {
  return Array.isArray(template?.variants) && template.variants.length > 0;
}

/** Build the synthetic arch-cache markdown that `setCompileManifest` parses. */
export function buildArchMarkdown(languageAndFramework) {
  if (!languageAndFramework) return '';
  return arch(languageAndFramework);
}

/**
 * Format the project-type system prompt addition for an AI chat invocation.
 * The hint is wrapped in a clear directive marker so the model can tell it
 * apart from the user's free-text prompt. Returns '' when the template has
 * no hint (e.g. OTHER).
 */
export function formatSystemPromptAddition(template, variant) {
  const hint = variant?.systemPromptHint || template?.systemPromptHint;
  if (!hint) return '';
  const label = variant ? `${template.label} (${variant.label})` : template?.label || 'project';
  return `[PROJECT TYPE: ${label}]\n${hint}\n\n`;
}
