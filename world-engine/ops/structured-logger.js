'use strict';

const LEVEL_ORDER = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function createStructuredLogger(options = {}) {
  const level = LEVEL_ORDER[options.level] ? options.level : 'info';
  const threshold = LEVEL_ORDER[level];
  const service = options.service || 'phyrex-world-engine';
  const output = options.output || process.stdout;
  const errorOutput = options.errorOutput || process.stderr;
  const clock = options.clock || (() => new Date().toISOString());

  function write(logLevel, event, fields = {}) {
    if (LEVEL_ORDER[logLevel] < threshold) return null;
    const entry = {
      time: clock(),
      level: logLevel,
      service,
      event: String(event || 'log'),
      ...normalizeFields(fields),
    };
    const line = JSON.stringify(entry) + '\n';
    const stream = logLevel === 'error' ? errorOutput : output;
    stream.write(line);
    return entry;
  }

  return {
    level,
    debug: (event, fields) => write('debug', event, fields),
    info: (event, fields) => write('info', event, fields),
    warn: (event, fields) => write('warn', event, fields),
    error: (event, fields) => write('error', event, fields),
    child(extra = {}) {
      return createStructuredLogger({
        level,
        service,
        output: createPrefixedStream(output, extra),
        errorOutput: createPrefixedStream(errorOutput, extra),
        clock,
      });
    },
  };
}

function createPrefixedStream(stream, extra) {
  return {
    write(line) {
      try {
        const parsed = JSON.parse(String(line));
        stream.write(JSON.stringify({ ...extra, ...parsed }) + '\n');
      } catch (_error) {
        stream.write(line);
      }
    },
  };
}

function normalizeFields(fields) {
  if (fields instanceof Error) return serializeError(fields);
  const output = {};
  for (const [key, value] of Object.entries(fields || {})) {
    if (/token|secret|password/i.test(key)) {
      output[key] = value ? '[redacted]' : value;
    } else if (value instanceof Error) {
      output[key] = serializeError(value);
    } else if (typeof value === 'bigint') {
      output[key] = value.toString();
    } else {
      output[key] = value;
    }
  }
  return output;
}

function serializeError(error) {
  return {
    name: error.name || 'Error',
    message: error.message || String(error),
    code: error.code || null,
    stack: error.stack || null,
  };
}

module.exports = {
  LEVEL_ORDER,
  createStructuredLogger,
  normalizeFields,
  serializeError,
};
