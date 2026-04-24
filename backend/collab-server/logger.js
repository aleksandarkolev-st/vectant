/**
 * logger.js — Lightweight structured JSON logger for the collab server.
 *
 * Emits one JSON object per line to stdout/stderr so downstream tooling
 * (Cloud Logging, Loki, Datadog, etc.) can ingest logs without custom
 * parsers.  Falls back to human-readable output when STDOUT is a TTY
 * *and* COLLAB_LOG_FORMAT is not explicitly "json".
 *
 * Usage:
 *   const logger = require('./logger').child({ component: 'collab' });
 *   logger.info('session_created', { sessionId, hostId });
 *   logger.warn('spawner_timeout', { sessionId, durationMs });
 *   logger.error('gcs_upload_failed', { slug, filePath }, err);
 *
 * The first string argument is the event name (stable, snake_case) — keep
 * it machine-queryable.  Supply variable data in the object; supply any
 * caught Error as the final argument so the stack lands in `error.stack`.
 *
 * Environment:
 *   COLLAB_LOG_LEVEL  = 'debug' | 'info' | 'warn' | 'error' (default: info)
 *   COLLAB_LOG_FORMAT = 'json' | 'pretty' (default: auto)
 *   COLLAB_LOG_SERVICE = service name embedded in every record
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN_LEVEL = LEVELS[(process.env.COLLAB_LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;

// Pretty output is useful during local dev; default to JSON whenever stdout
// isn't a TTY (i.e. in containers, systemd, CI) so logs remain parseable.
const LOG_FORMAT = (process.env.COLLAB_LOG_FORMAT || '').toLowerCase()
  || (process.stdout && process.stdout.isTTY ? 'pretty' : 'json');

const SERVICE = process.env.COLLAB_LOG_SERVICE || 'collab-server';
const HOSTNAME = require('os').hostname();
const PID = process.pid;

function serializeError(err) {
  if (!err) return undefined;
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
      // Surface Node-style error codes and HTTP statuses when present.
      code: err.code,
      status: err.status,
    };
  }
  return { message: String(err) };
}

function emit(record) {
  const line = LOG_FORMAT === 'pretty' ? prettyFormat(record) : JSON.stringify(record);
  // Errors go to stderr so stderr-only collectors (eg. K8s event stream)
  // still see them; everything else to stdout.
  if (record.level === 'error') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}

function prettyFormat(record) {
  const { time, level, service: _svc, event, msg, ...rest } = record;
  const kv = Object.entries(rest)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${formatValue(v)}`)
    .join(' ');
  return `${time} ${level.toUpperCase().padEnd(5)} ${event || msg || ''}${kv ? ' ' + kv : ''}`;
}

function formatValue(v) {
  if (v == null) return String(v);
  if (typeof v === 'string') return v.includes(' ') ? JSON.stringify(v) : v;
  if (typeof v === 'object') {
    try { return JSON.stringify(v); } catch (_) { return '[object]'; }
  }
  return String(v);
}

function makeLogger(bindings = {}) {
  const base = { service: SERVICE, host: HOSTNAME, pid: PID, ...bindings };

  function log(levelName, event, data, err) {
    if (LEVELS[levelName] < MIN_LEVEL) return;
    const record = {
      time: new Date().toISOString(),
      level: levelName,
      ...base,
      event,
      ...(data && typeof data === 'object' ? data : data !== undefined ? { data } : {}),
    };
    const errObj = serializeError(err);
    if (errObj) record.error = errObj;
    try {
      emit(record);
    } catch (writeErr) {
      // Last-resort fallback so logger failures never crash the caller.
      try { process.stderr.write(`[logger] write failed: ${writeErr.message}\n`); } catch (_) {}
    }
  }

  return {
    debug: (event, data, err) => log('debug', event, data, err),
    info:  (event, data, err) => log('info',  event, data, err),
    warn:  (event, data, err) => log('warn',  event, data, err),
    error: (event, data, err) => log('error', event, data, err),
    child: (extra) => makeLogger({ ...base, ...extra }),
  };
}

const rootLogger = makeLogger();
module.exports = rootLogger;
module.exports.child = rootLogger.child;
module.exports.LEVELS = LEVELS;
