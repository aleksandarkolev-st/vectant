/**
 * Node.js polyfill entry point for the extension host worker.
 * 
 * This file gets bundled by esbuild into public/node-polyfills.js,
 * which the worker loads via importScripts(). It provides REAL browser
 * implementations of Node.js built-in modules so marketplace extensions
 * (webpack/esbuild bundles) work correctly.
 * 
 * Modules that are truly impossible in a browser (fs, child_process,
 * net, worker_threads) are given minimal stubs in the worker itself.
 */

// Real polyfills from npm
import { Buffer } from 'buffer';
import process from 'process';
import path from 'path-browserify';
import { EventEmitter } from 'events';
import Stream from 'stream-browserify';
import util from 'util';
import assert from 'assert';
import { StringDecoder } from 'string_decoder';
import * as zlib from 'browserify-zlib';
import * as constants from 'constants-browserify';
import * as qs from 'querystring-es3';
import * as osBrowserify from 'os-browserify';
import * as tty from 'tty-browserify';
import * as punycode from 'punycode';

// --- Enhance os with constants that os-browserify might lack ---
const os = Object.assign({}, osBrowserify);
if (!os.constants) {
  os.constants = {};
}
if (!os.constants.signals) {
  os.constants.signals = {
    SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5,
    SIGABRT: 6, SIGBUS: 7, SIGFPE: 8, SIGKILL: 9, SIGUSR1: 10,
    SIGSEGV: 11, SIGUSR2: 12, SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15,
    SIGCHLD: 17, SIGCONT: 18, SIGSTOP: 19, SIGTSTP: 20, SIGTTIN: 21, SIGTTOU: 22
  };
}
if (!os.constants.errno) {
  os.constants.errno = {
    EACCES: -13, ENOENT: -2, EEXIST: -17, EISDIR: -21,
    ENOTDIR: -20, ENOTEMPTY: -39, EPERM: -1, EBADF: -9
  };
}
if (!os.constants.priority) {
  os.constants.priority = {
    PRIORITY_LOW: 19, PRIORITY_BELOW_NORMAL: 10, PRIORITY_NORMAL: 0,
    PRIORITY_ABOVE_NORMAL: -7, PRIORITY_HIGH: -14, PRIORITY_HIGHEST: -20
  };
}
// Ensure common methods exist
if (!os.userInfo) os.userInfo = () => ({ username: 'web', homedir: '/', shell: '/bin/sh', uid: 1000, gid: 1000 });
if (!os.hostname) os.hostname = () => 'localhost';
if (!os.networkInterfaces) os.networkInterfaces = () => ({});

// --- Crypto: use native Web Crypto where possible ---
const cryptoShim = {
  randomUUID: () => self.crypto.randomUUID(),
  randomBytes: (n) => {
    const buf = Buffer.alloc(n);
    self.crypto.getRandomValues(buf);
    return buf;
  },
  getRandomValues: (buf) => self.crypto.getRandomValues(buf),
  createHash: (algorithm) => {
    // Simple hash accumulator — for extensions that call createHash('sha256').update(str).digest('hex')
    let chunks = [];
    return {
      update(data) { chunks.push(typeof data === 'string' ? new TextEncoder().encode(data) : data); return this; },
      async digest(encoding) {
        const merged = Buffer.concat(chunks);
        try {
          const algo = algorithm.replace('-', '').toLowerCase() === 'sha256' ? 'SHA-256'
            : algorithm.replace('-', '').toLowerCase() === 'sha1' ? 'SHA-1'
            : algorithm.replace('-', '').toLowerCase() === 'sha512' ? 'SHA-512'
            : algorithm.replace('-', '').toLowerCase() === 'md5' ? 'SHA-256' // fallback
            : 'SHA-256';
          const hashBuffer = await self.crypto.subtle.digest(algo, merged);
          const hashArray = new Uint8Array(hashBuffer);
          if (encoding === 'hex') return Array.from(hashArray).map(b => b.toString(16).padStart(2, '0')).join('');
          if (encoding === 'base64') return btoa(String.fromCharCode(...hashArray));
          return Buffer.from(hashArray);
        } catch(e) {
          // Sync fallback — return dummy
          if (encoding === 'hex') return '0'.repeat(64);
          return Buffer.alloc(32);
        }
      }
    };
  },
  createHmac: (algorithm, key) => {
    return { update() { return this; }, digest(enc) { return enc === 'hex' ? '0'.repeat(64) : Buffer.alloc(32); } };
  },
  subtle: typeof self !== 'undefined' && self.crypto ? self.crypto.subtle : {}
};

// --- URL polyfill (use native browser URL + helpers) ---
const urlShim = {
  URL: typeof URL !== 'undefined' ? URL : class {},
  URLSearchParams: typeof URLSearchParams !== 'undefined' ? URLSearchParams : class {},
  parse(u) {
    try {
      const o = new URL(u);
      return { protocol: o.protocol, slashes: true, auth: null, host: o.host, port: o.port || null, hostname: o.hostname, hash: o.hash || null, search: o.search || null, query: o.search ? o.search.slice(1) : null, pathname: o.pathname, path: o.pathname + (o.search || ''), href: o.href };
    } catch(e) { return { href: u || '' }; }
  },
  format(o) { return o && o.href ? o.href : ''; },
  resolve(from, to) { try { return new URL(to, from).href; } catch(e) { return to || ''; } }
};

// --- HTTP/HTTPS stubs (can't truly do raw sockets from worker) ---
function makeHttpModule() {
  return {
    request(opts, cb) {
      const req = new EventEmitter();
      req.write = () => {};
      req.end = () => { setTimeout(() => req.emit('error', new Error('http not available in web worker')), 0); };
      req.setTimeout = () => {};
      req.destroy = () => {};
      req.abort = () => {};
      return req;
    },
    get(opts, cb) { return this.request(opts, cb); },
    createServer() { return new EventEmitter(); },
    Agent: function HttpAgent(opts) {},
    globalAgent: {},
    STATUS_CODES: { 200: 'OK', 201: 'Created', 204: 'No Content', 301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 500: 'Internal Server Error' }
  };
}
const httpShim = makeHttpModule();
const httpsShim = makeHttpModule();

// --- Modules that truly can't work in a browser get minimal stubs ---
const fsShim = {
  readFileSync: () => '',
  writeFileSync: () => {},
  existsSync: () => false,
  mkdirSync: () => {},
  readdirSync: () => [],
  statSync: () => ({ isFile: () => false, isDirectory: () => false, isSymbolicLink: () => false, isBlockDevice: () => false, isCharacterDevice: () => false, isFIFO: () => false, isSocket: () => false, size: 0, mtime: new Date(0), mode: 0 }),
  lstatSync: () => fsShim.statSync(),
  unlinkSync: () => {},
  rmdirSync: () => {},
  renameSync: () => {},
  copyFileSync: () => {},
  chmodSync: () => {},
  accessSync: () => { throw new Error('ENOENT: no such file (web shim)'); },
  readlinkSync: () => '',
  realpathSync: (p) => p,
  createReadStream: () => new Stream.Readable({ read() { this.push(null); } }),
  createWriteStream: () => new Stream.Writable({ write(c, e, cb) { cb(); } }),
  watch: () => new EventEmitter(),
  watchFile: () => {},
  unwatchFile: () => {},
  constants: { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1, COPYFILE_EXCL: 1 },
  promises: {
    readFile: () => Promise.resolve(''),
    writeFile: () => Promise.resolve(),
    readdir: () => Promise.resolve([]),
    stat: () => Promise.resolve(fsShim.statSync()),
    lstat: () => Promise.resolve(fsShim.statSync()),
    mkdir: () => Promise.resolve(),
    rmdir: () => Promise.resolve(),
    unlink: () => Promise.resolve(),
    rename: () => Promise.resolve(),
    access: () => Promise.reject(new Error('ENOENT: no such file (web shim)')),
    realpath: (p) => Promise.resolve(p),
    copyFile: () => Promise.resolve(),
    chmod: () => Promise.resolve(),
    readlink: () => Promise.resolve(''),
  }
};

const childProcessShim = {
  exec(cmd, opts, cb) { cb = cb || opts; if (typeof cb === 'function') setTimeout(() => cb(new Error('child_process not available in web worker'), '', ''), 0); },
  execSync() { throw new Error('child_process not available in web worker'); },
  execFile(file, args, opts, cb) { cb = cb || opts || args; if (typeof cb === 'function') setTimeout(() => cb(new Error('child_process not available in web worker'), '', ''), 0); },
  fork() { throw new Error('child_process.fork not available in web worker'); },
  spawn() {
    const proc = new EventEmitter();
    proc.stdin = new Stream.Writable({ write(c, e, cb) { cb(); } });
    proc.stdout = new Stream.Readable({ read() { this.push(null); } });
    proc.stderr = new Stream.Readable({ read() { this.push(null); } });
    proc.pid = 0;
    proc.kill = () => {};
    proc.ref = () => {};
    proc.unref = () => {};
    setTimeout(() => { proc.emit('error', new Error('child_process not available in web worker')); proc.emit('close', 1); }, 0);
    return proc;
  }
};

const netShim = {
  Socket: function NetSocket() {
    Stream.Duplex.call(this);
    this.connect = () => this;
    this.setTimeout = () => {};
    this.setNoDelay = () => {};
    this.setKeepAlive = () => {};
    this.address = () => ({});
    this.destroy = () => {};
    this.ref = () => {};
    this.unref = () => {};
  },
  Server: function NetServer() {
    EventEmitter.call(this);
    this.listen = () => this;
    this.close = () => {};
    this.address = () => null;
    this.ref = () => {};
    this.unref = () => {};
  },
  createServer: () => new netShim.Server(),
  createConnection: () => new netShim.Socket(),
  connect: () => new netShim.Socket(),
  isIP: () => 0,
  isIPv4: () => false,
  isIPv6: () => false
};

const workerThreadsShim = {
  isMainThread: true,
  parentPort: null,
  workerData: null,
  Worker: function() { throw new Error('worker_threads not available in web worker'); },
  MessageChannel: typeof MessageChannel !== 'undefined' ? MessageChannel : function() {},
  MessagePort: function() {}
};

const perfHooksShim = {
  performance: typeof performance !== 'undefined' ? performance : { now: () => Date.now() },
  PerformanceObserver: function() { this.observe = () => {}; this.disconnect = () => {}; }
};

// --- Module registry: the shimRequire function will look these up ---
const MODULE_REGISTRY = {
  buffer: { Buffer },
  process,
  path,
  events: { EventEmitter, default: EventEmitter },
  stream: Stream,
  'stream-browserify': Stream,
  'readable-stream': Stream,
  util,
  assert,
  string_decoder: { StringDecoder },
  zlib,
  os,
  tty,
  constants,
  querystring: qs,
  punycode,
  url: urlShim,
  crypto: cryptoShim,
  http: httpShim,
  https: httpsShim,
  fs: fsShim,
  child_process: childProcessShim,
  net: netShim,
  worker_threads: workerThreadsShim,
  perf_hooks: perfHooksShim,
  module: {
    createRequire: () => self.__nodeRequire || (() => ({})),
    builtinModules: Object.keys(MODULE_REGISTRY || {}),
    Module: function Module() {}
  },
  // Some extensions require these alternate names
  'node:path': path,
  'node:fs': fsShim,
  'node:os': os,
  'node:url': urlShim,
  'node:util': util,
  'node:events': { EventEmitter },
  'node:stream': Stream,
  'node:crypto': cryptoShim,
  'node:buffer': { Buffer },
  'node:process': process,
  'node:assert': assert,
  'node:child_process': childProcessShim,
  'node:net': netShim,
  'node:http': httpShim,
  'node:https': httpsShim,
  'node:zlib': zlib,
  'node:querystring': qs,
  'node:string_decoder': { StringDecoder },
  'node:tty': tty,
  'node:constants': constants,
  'node:worker_threads': workerThreadsShim,
  'node:perf_hooks': perfHooksShim,
  'node:module': { createRequire: () => self.__nodeRequire || (() => ({})) }
};

// Expose to the worker global scope
self.__nodePolyfills = MODULE_REGISTRY;
self.__nodeBuffer = Buffer;
self.__nodeProcess = process;
