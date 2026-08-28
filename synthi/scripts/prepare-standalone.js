const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const buildRoot = path.join(projectRoot, ".next");
const standaloneRoot = path.join(buildRoot, "standalone", "synthi");

const requiredSourcePaths = [
  path.join(buildRoot, "static"),
  path.join(projectRoot, "public"),
];

if (!fs.existsSync(path.join(standaloneRoot, "server.js"))) {
  throw new Error("Next standalone server was not produced.");
}

for (const source of requiredSourcePaths) {
  if (!fs.existsSync(source)) {
    throw new Error(`Standalone source asset directory is missing: ${source}`);
  }
}

const destinations = [
  path.join(standaloneRoot, ".next", "static"),
  path.join(standaloneRoot, "public"),
];

for (let index = 0; index < requiredSourcePaths.length; index += 1) {
  fs.cpSync(requiredSourcePaths[index], destinations[index], {
    recursive: true,
    force: true,
  });
}

for (const destination of destinations) {
  if (!fs.existsSync(destination)) {
    throw new Error(`Standalone asset copy failed: ${destination}`);
  }
}

console.log("Prepared standalone server assets.");
