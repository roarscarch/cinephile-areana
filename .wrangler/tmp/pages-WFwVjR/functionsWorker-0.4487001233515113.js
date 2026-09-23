var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// ../../.npm/_npx/32026684e21afda6/node_modules/unenv/dist/runtime/_internal/utils.mjs
// @__NO_SIDE_EFFECTS__
function createNotImplementedError(name) {
  return new Error(`[unenv] ${name} is not implemented yet!`);
}
__name(createNotImplementedError, "createNotImplementedError");
// @__NO_SIDE_EFFECTS__
function notImplemented(name) {
  const fn = /* @__PURE__ */ __name(() => {
    throw /* @__PURE__ */ createNotImplementedError(name);
  }, "fn");
  return Object.assign(fn, { __unenv__: true });
}
__name(notImplemented, "notImplemented");
// @__NO_SIDE_EFFECTS__
function notImplementedClass(name) {
  return class {
    __unenv__ = true;
    constructor() {
      throw new Error(`[unenv] ${name} is not implemented yet!`);
    }
  };
}
__name(notImplementedClass, "notImplementedClass");

// ../../.npm/_npx/32026684e21afda6/node_modules/unenv/dist/runtime/node/internal/perf_hooks/performance.mjs
var _timeOrigin = globalThis.performance?.timeOrigin ?? Date.now();
var _performanceNow = globalThis.performance?.now ? globalThis.performance.now.bind(globalThis.performance) : () => Date.now() - _timeOrigin;
var nodeTiming = {
  name: "node",
  entryType: "node",
  startTime: 0,
  duration: 0,
  nodeStart: 0,
  v8Start: 0,
  bootstrapComplete: 0,
  environment: 0,
  loopStart: 0,
  loopExit: 0,
  idleTime: 0,
  uvMetricsInfo: {
    loopCount: 0,
    events: 0,
    eventsWaiting: 0
  },
  detail: void 0,
  toJSON() {
    return this;
  }
};
var PerformanceEntry = class {
  static {
    __name(this, "PerformanceEntry");
  }
  __unenv__ = true;
  detail;
  entryType = "event";
  name;
  startTime;
  constructor(name, options) {
    this.name = name;
    this.startTime = options?.startTime || _performanceNow();
    this.detail = options?.detail;
  }
  get duration() {
    return _performanceNow() - this.startTime;
  }
  toJSON() {
    return {
      name: this.name,
      entryType: this.entryType,
      startTime: this.startTime,
      duration: this.duration,
      detail: this.detail
    };
  }
};
var PerformanceMark = class PerformanceMark2 extends PerformanceEntry {
  static {
    __name(this, "PerformanceMark");
  }
  entryType = "mark";
  constructor() {
    super(...arguments);
  }
  get duration() {
    return 0;
  }
};
var PerformanceMeasure = class extends PerformanceEntry {
  static {
    __name(this, "PerformanceMeasure");
  }
  entryType = "measure";
};
var PerformanceResourceTiming = class extends PerformanceEntry {
  static {
    __name(this, "PerformanceResourceTiming");
  }
  entryType = "resource";
  serverTiming = [];
  connectEnd = 0;
  connectStart = 0;
  decodedBodySize = 0;
  domainLookupEnd = 0;
  domainLookupStart = 0;
  encodedBodySize = 0;
  fetchStart = 0;
  initiatorType = "";
  name = "";
  nextHopProtocol = "";
  redirectEnd = 0;
  redirectStart = 0;
  requestStart = 0;
  responseEnd = 0;
  responseStart = 0;
  secureConnectionStart = 0;
  startTime = 0;
  transferSize = 0;
  workerStart = 0;
  responseStatus = 0;
};
var PerformanceObserverEntryList = class {
  static {
    __name(this, "PerformanceObserverEntryList");
  }
  __unenv__ = true;
  getEntries() {
    return [];
  }
  getEntriesByName(_name, _type) {
    return [];
  }
  getEntriesByType(type) {
    return [];
  }
};
var Performance = class {
  static {
    __name(this, "Performance");
  }
  __unenv__ = true;
  timeOrigin = _timeOrigin;
  eventCounts = /* @__PURE__ */ new Map();
  _entries = [];
  _resourceTimingBufferSize = 0;
  navigation = void 0;
  timing = void 0;
  timerify(_fn, _options) {
    throw createNotImplementedError("Performance.timerify");
  }
  get nodeTiming() {
    return nodeTiming;
  }
  eventLoopUtilization() {
    return {};
  }
  markResourceTiming() {
    return new PerformanceResourceTiming("");
  }
  onresourcetimingbufferfull = null;
  now() {
    if (this.timeOrigin === _timeOrigin) {
      return _performanceNow();
    }
    return Date.now() - this.timeOrigin;
  }
  clearMarks(markName) {
    this._entries = markName ? this._entries.filter((e) => e.name !== markName) : this._entries.filter((e) => e.entryType !== "mark");
  }
  clearMeasures(measureName) {
    this._entries = measureName ? this._entries.filter((e) => e.name !== measureName) : this._entries.filter((e) => e.entryType !== "measure");
  }
  clearResourceTimings() {
    this._entries = this._entries.filter((e) => e.entryType !== "resource" || e.entryType !== "navigation");
  }
  getEntries() {
    return this._entries;
  }
  getEntriesByName(name, type) {
    return this._entries.filter((e) => e.name === name && (!type || e.entryType === type));
  }
  getEntriesByType(type) {
    return this._entries.filter((e) => e.entryType === type);
  }
  mark(name, options) {
    const entry = new PerformanceMark(name, options);
    this._entries.push(entry);
    return entry;
  }
  measure(measureName, startOrMeasureOptions, endMark) {
    let start;
    let end;
    if (typeof startOrMeasureOptions === "string") {
      start = this.getEntriesByName(startOrMeasureOptions, "mark")[0]?.startTime;
      end = this.getEntriesByName(endMark, "mark")[0]?.startTime;
    } else {
      start = Number.parseFloat(startOrMeasureOptions?.start) || this.now();
      end = Number.parseFloat(startOrMeasureOptions?.end) || this.now();
    }
    const entry = new PerformanceMeasure(measureName, {
      startTime: start,
      detail: {
        start,
        end
      }
    });
    this._entries.push(entry);
    return entry;
  }
  setResourceTimingBufferSize(maxSize) {
    this._resourceTimingBufferSize = maxSize;
  }
  addEventListener(type, listener, options) {
    throw createNotImplementedError("Performance.addEventListener");
  }
  removeEventListener(type, listener, options) {
    throw createNotImplementedError("Performance.removeEventListener");
  }
  dispatchEvent(event) {
    throw createNotImplementedError("Performance.dispatchEvent");
  }
  toJSON() {
    return this;
  }
};
var PerformanceObserver = class {
  static {
    __name(this, "PerformanceObserver");
  }
  __unenv__ = true;
  static supportedEntryTypes = [];
  _callback = null;
  constructor(callback) {
    this._callback = callback;
  }
  takeRecords() {
    return [];
  }
  disconnect() {
    throw createNotImplementedError("PerformanceObserver.disconnect");
  }
  observe(options) {
    throw createNotImplementedError("PerformanceObserver.observe");
  }
  bind(fn) {
    return fn;
  }
  runInAsyncScope(fn, thisArg, ...args) {
    return fn.call(thisArg, ...args);
  }
  asyncId() {
    return 0;
  }
  triggerAsyncId() {
    return 0;
  }
  emitDestroy() {
    return this;
  }
};
var performance = globalThis.performance && "addEventListener" in globalThis.performance ? globalThis.performance : new Performance();

// ../../.npm/_npx/32026684e21afda6/node_modules/@cloudflare/unenv-preset/dist/runtime/polyfill/performance.mjs
if (!("__unenv__" in performance)) {
  const proto = Performance.prototype;
  for (const key of Object.getOwnPropertyNames(proto)) {
    if (key !== "constructor" && !(key in performance)) {
      const desc = Object.getOwnPropertyDescriptor(proto, key);
      if (desc) {
        Object.defineProperty(performance, key, desc);
      }
    }
  }
}
globalThis.performance = performance;
globalThis.Performance = Performance;
globalThis.PerformanceEntry = PerformanceEntry;
globalThis.PerformanceMark = PerformanceMark;
globalThis.PerformanceMeasure = PerformanceMeasure;
globalThis.PerformanceObserver = PerformanceObserver;
globalThis.PerformanceObserverEntryList = PerformanceObserverEntryList;
globalThis.PerformanceResourceTiming = PerformanceResourceTiming;

// ../../.npm/_npx/32026684e21afda6/node_modules/unenv/dist/runtime/node/console.mjs
import { Writable } from "node:stream";

// ../../.npm/_npx/32026684e21afda6/node_modules/unenv/dist/runtime/mock/noop.mjs
var noop_default = Object.assign(() => {
}, { __unenv__: true });

// ../../.npm/_npx/32026684e21afda6/node_modules/unenv/dist/runtime/node/console.mjs
var _console = globalThis.console;
var _ignoreErrors = true;
var _stderr = new Writable();
var _stdout = new Writable();
var log = _console?.log ?? noop_default;
var info = _console?.info ?? log;
var trace = _console?.trace ?? info;
var debug = _console?.debug ?? log;
var table = _console?.table ?? log;
var error = _console?.error ?? log;
var warn = _console?.warn ?? error;
var createTask = _console?.createTask ?? /* @__PURE__ */ notImplemented("console.createTask");
var clear = _console?.clear ?? noop_default;
var count = _console?.count ?? noop_default;
var countReset = _console?.countReset ?? noop_default;
var dir = _console?.dir ?? noop_default;
var dirxml = _console?.dirxml ?? noop_default;
var group = _console?.group ?? noop_default;
var groupEnd = _console?.groupEnd ?? noop_default;
var groupCollapsed = _console?.groupCollapsed ?? noop_default;
var profile = _console?.profile ?? noop_default;
var profileEnd = _console?.profileEnd ?? noop_default;
var time = _console?.time ?? noop_default;
var timeEnd = _console?.timeEnd ?? noop_default;
var timeLog = _console?.timeLog ?? noop_default;
var timeStamp = _console?.timeStamp ?? noop_default;
var Console = _console?.Console ?? /* @__PURE__ */ notImplementedClass("console.Console");
var _times = /* @__PURE__ */ new Map();
var _stdoutErrorHandler = noop_default;
var _stderrErrorHandler = noop_default;

// ../../.npm/_npx/32026684e21afda6/node_modules/@cloudflare/unenv-preset/dist/runtime/node/console.mjs
var workerdConsole = globalThis["console"];
var {
  assert,
  clear: clear2,
  // @ts-expect-error undocumented public API
  context,
  count: count2,
  countReset: countReset2,
  // @ts-expect-error undocumented public API
  createTask: createTask2,
  debug: debug2,
  dir: dir2,
  dirxml: dirxml2,
  error: error2,
  group: group2,
  groupCollapsed: groupCollapsed2,
  groupEnd: groupEnd2,
  info: info2,
  log: log2,
  profile: profile2,
  profileEnd: profileEnd2,
  table: table2,
  time: time2,
  timeEnd: timeEnd2,
  timeLog: timeLog2,
  timeStamp: timeStamp2,
  trace: trace2,
  warn: warn2
} = workerdConsole;
Object.assign(workerdConsole, {
  Console,
  _ignoreErrors,
  _stderr,
  _stderrErrorHandler,
  _stdout,
  _stdoutErrorHandler,
  _times
});
var console_default = workerdConsole;

// ../../.npm/_npx/32026684e21afda6/node_modules/wrangler/_virtual_unenv_global_polyfill-@cloudflare-unenv-preset-node-console
globalThis.console = console_default;

// ../../.npm/_npx/32026684e21afda6/node_modules/unenv/dist/runtime/node/internal/process/hrtime.mjs
var hrtime = /* @__PURE__ */ Object.assign(/* @__PURE__ */ __name(function hrtime2(startTime) {
  const now = Date.now();
  const seconds = Math.trunc(now / 1e3);
  const nanos = now % 1e3 * 1e6;
  if (startTime) {
    let diffSeconds = seconds - startTime[0];
    let diffNanos = nanos - startTime[0];
    if (diffNanos < 0) {
      diffSeconds = diffSeconds - 1;
      diffNanos = 1e9 + diffNanos;
    }
    return [diffSeconds, diffNanos];
  }
  return [seconds, nanos];
}, "hrtime"), { bigint: /* @__PURE__ */ __name(function bigint() {
  return BigInt(Date.now() * 1e6);
}, "bigint") });

// ../../.npm/_npx/32026684e21afda6/node_modules/unenv/dist/runtime/node/internal/process/process.mjs
import { EventEmitter } from "node:events";

// ../../.npm/_npx/32026684e21afda6/node_modules/unenv/dist/runtime/node/internal/tty/read-stream.mjs
var ReadStream = class {
  static {
    __name(this, "ReadStream");
  }
  fd;
  isRaw = false;
  isTTY = false;
  constructor(fd) {
    this.fd = fd;
  }
  setRawMode(mode) {
    this.isRaw = mode;
    return this;
  }
};

// ../../.npm/_npx/32026684e21afda6/node_modules/unenv/dist/runtime/node/internal/tty/write-stream.mjs
var WriteStream = class {
  static {
    __name(this, "WriteStream");
  }
  fd;
  columns = 80;
  rows = 24;
  isTTY = false;
  constructor(fd) {
    this.fd = fd;
  }
  clearLine(dir3, callback) {
    callback && callback();
    return false;
  }
  clearScreenDown(callback) {
    callback && callback();
    return false;
  }
  cursorTo(x, y, callback) {
    callback && typeof callback === "function" && callback();
    return false;
  }
  moveCursor(dx, dy, callback) {
    callback && callback();
    return false;
  }
  getColorDepth(env2) {
    return 1;
  }
  hasColors(count3, env2) {
    return false;
  }
  getWindowSize() {
    return [this.columns, this.rows];
  }
  write(str, encoding, cb) {
    if (str instanceof Uint8Array) {
      str = new TextDecoder().decode(str);
    }
    try {
      console.log(str);
    } catch {
    }
    cb && typeof cb === "function" && cb();
    return false;
  }
};

// ../../.npm/_npx/32026684e21afda6/node_modules/unenv/dist/runtime/node/internal/process/node-version.mjs
var NODE_VERSION = "22.14.0";

// ../../.npm/_npx/32026684e21afda6/node_modules/unenv/dist/runtime/node/internal/process/process.mjs
var Process = class _Process extends EventEmitter {
  static {
    __name(this, "Process");
  }
  env;
  hrtime;
  nextTick;
  constructor(impl) {
    super();
    this.env = impl.env;
    this.hrtime = impl.hrtime;
    this.nextTick = impl.nextTick;
    for (const prop of [...Object.getOwnPropertyNames(_Process.prototype), ...Object.getOwnPropertyNames(EventEmitter.prototype)]) {
      const value = this[prop];
      if (typeof value === "function") {
        this[prop] = value.bind(this);
      }
    }
  }
  // --- event emitter ---
  emitWarning(warning, type, code) {
    console.warn(`${code ? `[${code}] ` : ""}${type ? `${type}: ` : ""}${warning}`);
  }
  emit(...args) {
    return super.emit(...args);
  }
  listeners(eventName) {
    return super.listeners(eventName);
  }
  // --- stdio (lazy initializers) ---
  #stdin;
  #stdout;
  #stderr;
  get stdin() {
    return this.#stdin ??= new ReadStream(0);
  }
  get stdout() {
    return this.#stdout ??= new WriteStream(1);
  }
  get stderr() {
    return this.#stderr ??= new WriteStream(2);
  }
  // --- cwd ---
  #cwd = "/";
  chdir(cwd2) {
    this.#cwd = cwd2;
  }
  cwd() {
    return this.#cwd;
  }
  // --- dummy props and getters ---
  arch = "";
  platform = "";
  argv = [];
  argv0 = "";
  execArgv = [];
  execPath = "";
  title = "";
  pid = 200;
  ppid = 100;
  get version() {
    return `v${NODE_VERSION}`;
  }
  get versions() {
    return { node: NODE_VERSION };
  }
  get allowedNodeEnvironmentFlags() {
    return /* @__PURE__ */ new Set();
  }
  get sourceMapsEnabled() {
    return false;
  }
  get debugPort() {
    return 0;
  }
  get throwDeprecation() {
    return false;
  }
  get traceDeprecation() {
    return false;
  }
  get features() {
    return {};
  }
  get release() {
    return {};
  }
  get connected() {
    return false;
  }
  get config() {
    return {};
  }
  get moduleLoadList() {
    return [];
  }
  constrainedMemory() {
    return 0;
  }
  availableMemory() {
    return 0;
  }
  uptime() {
    return 0;
  }
  resourceUsage() {
    return {};
  }
  // --- noop methods ---
  ref() {
  }
  unref() {
  }
  // --- unimplemented methods ---
  umask() {
    throw createNotImplementedError("process.umask");
  }
  getBuiltinModule() {
    return void 0;
  }
  getActiveResourcesInfo() {
    throw createNotImplementedError("process.getActiveResourcesInfo");
  }
  exit() {
    throw createNotImplementedError("process.exit");
  }
  reallyExit() {
    throw createNotImplementedError("process.reallyExit");
  }
  kill() {
    throw createNotImplementedError("process.kill");
  }
  abort() {
    throw createNotImplementedError("process.abort");
  }
  dlopen() {
    throw createNotImplementedError("process.dlopen");
  }
  setSourceMapsEnabled() {
    throw createNotImplementedError("process.setSourceMapsEnabled");
  }
  loadEnvFile() {
    throw createNotImplementedError("process.loadEnvFile");
  }
  disconnect() {
    throw createNotImplementedError("process.disconnect");
  }
  cpuUsage() {
    throw createNotImplementedError("process.cpuUsage");
  }
  setUncaughtExceptionCaptureCallback() {
    throw createNotImplementedError("process.setUncaughtExceptionCaptureCallback");
  }
  hasUncaughtExceptionCaptureCallback() {
    throw createNotImplementedError("process.hasUncaughtExceptionCaptureCallback");
  }
  initgroups() {
    throw createNotImplementedError("process.initgroups");
  }
  openStdin() {
    throw createNotImplementedError("process.openStdin");
  }
  assert() {
    throw createNotImplementedError("process.assert");
  }
  binding() {
    throw createNotImplementedError("process.binding");
  }
  // --- attached interfaces ---
  permission = { has: /* @__PURE__ */ notImplemented("process.permission.has") };
  report = {
    directory: "",
    filename: "",
    signal: "SIGUSR2",
    compact: false,
    reportOnFatalError: false,
    reportOnSignal: false,
    reportOnUncaughtException: false,
    getReport: /* @__PURE__ */ notImplemented("process.report.getReport"),
    writeReport: /* @__PURE__ */ notImplemented("process.report.writeReport")
  };
  finalization = {
    register: /* @__PURE__ */ notImplemented("process.finalization.register"),
    unregister: /* @__PURE__ */ notImplemented("process.finalization.unregister"),
    registerBeforeExit: /* @__PURE__ */ notImplemented("process.finalization.registerBeforeExit")
  };
  memoryUsage = Object.assign(() => ({
    arrayBuffers: 0,
    rss: 0,
    external: 0,
    heapTotal: 0,
    heapUsed: 0
  }), { rss: /* @__PURE__ */ __name(() => 0, "rss") });
  // --- undefined props ---
  mainModule = void 0;
  domain = void 0;
  // optional
  send = void 0;
  exitCode = void 0;
  channel = void 0;
  getegid = void 0;
  geteuid = void 0;
  getgid = void 0;
  getgroups = void 0;
  getuid = void 0;
  setegid = void 0;
  seteuid = void 0;
  setgid = void 0;
  setgroups = void 0;
  setuid = void 0;
  // internals
  _events = void 0;
  _eventsCount = void 0;
  _exiting = void 0;
  _maxListeners = void 0;
  _debugEnd = void 0;
  _debugProcess = void 0;
  _fatalException = void 0;
  _getActiveHandles = void 0;
  _getActiveRequests = void 0;
  _kill = void 0;
  _preload_modules = void 0;
  _rawDebug = void 0;
  _startProfilerIdleNotifier = void 0;
  _stopProfilerIdleNotifier = void 0;
  _tickCallback = void 0;
  _disconnect = void 0;
  _handleQueue = void 0;
  _pendingMessage = void 0;
  _channel = void 0;
  _send = void 0;
  _linkedBinding = void 0;
};

// ../../.npm/_npx/32026684e21afda6/node_modules/@cloudflare/unenv-preset/dist/runtime/node/process.mjs
var globalProcess = globalThis["process"];
var getBuiltinModule = globalProcess.getBuiltinModule;
var workerdProcess = getBuiltinModule("node:process");
var unenvProcess = new Process({
  env: globalProcess.env,
  hrtime,
  // `nextTick` is available from workerd process v1
  nextTick: workerdProcess.nextTick
});
var { exit, features, platform } = workerdProcess;
var {
  _channel,
  _debugEnd,
  _debugProcess,
  _disconnect,
  _events,
  _eventsCount,
  _exiting,
  _fatalException,
  _getActiveHandles,
  _getActiveRequests,
  _handleQueue,
  _kill,
  _linkedBinding,
  _maxListeners,
  _pendingMessage,
  _preload_modules,
  _rawDebug,
  _send,
  _startProfilerIdleNotifier,
  _stopProfilerIdleNotifier,
  _tickCallback,
  abort,
  addListener,
  allowedNodeEnvironmentFlags,
  arch,
  argv,
  argv0,
  assert: assert2,
  availableMemory,
  binding,
  channel,
  chdir,
  config,
  connected,
  constrainedMemory,
  cpuUsage,
  cwd,
  debugPort,
  disconnect,
  dlopen,
  domain,
  emit,
  emitWarning,
  env,
  eventNames,
  execArgv,
  execPath,
  exitCode,
  finalization,
  getActiveResourcesInfo,
  getegid,
  geteuid,
  getgid,
  getgroups,
  getMaxListeners,
  getuid,
  hasUncaughtExceptionCaptureCallback,
  hrtime: hrtime3,
  initgroups,
  kill,
  listenerCount,
  listeners,
  loadEnvFile,
  mainModule,
  memoryUsage,
  moduleLoadList,
  nextTick,
  off,
  on,
  once,
  openStdin,
  permission,
  pid,
  ppid,
  prependListener,
  prependOnceListener,
  rawListeners,
  reallyExit,
  ref,
  release,
  removeAllListeners,
  removeListener,
  report,
  resourceUsage,
  send,
  setegid,
  seteuid,
  setgid,
  setgroups,
  setMaxListeners,
  setSourceMapsEnabled,
  setuid,
  setUncaughtExceptionCaptureCallback,
  sourceMapsEnabled,
  stderr,
  stdin,
  stdout,
  throwDeprecation,
  title,
  traceDeprecation,
  umask,
  unref,
  uptime,
  version,
  versions
} = unenvProcess;
var _process = {
  abort,
  addListener,
  allowedNodeEnvironmentFlags,
  hasUncaughtExceptionCaptureCallback,
  setUncaughtExceptionCaptureCallback,
  loadEnvFile,
  sourceMapsEnabled,
  arch,
  argv,
  argv0,
  chdir,
  config,
  connected,
  constrainedMemory,
  availableMemory,
  cpuUsage,
  cwd,
  debugPort,
  dlopen,
  disconnect,
  emit,
  emitWarning,
  env,
  eventNames,
  execArgv,
  execPath,
  exit,
  finalization,
  features,
  getBuiltinModule,
  getActiveResourcesInfo,
  getMaxListeners,
  hrtime: hrtime3,
  kill,
  listeners,
  listenerCount,
  memoryUsage,
  nextTick,
  on,
  off,
  once,
  pid,
  platform,
  ppid,
  prependListener,
  prependOnceListener,
  rawListeners,
  release,
  removeAllListeners,
  removeListener,
  report,
  resourceUsage,
  setMaxListeners,
  setSourceMapsEnabled,
  stderr,
  stdin,
  stdout,
  title,
  throwDeprecation,
  traceDeprecation,
  umask,
  uptime,
  version,
  versions,
  // @ts-expect-error old API
  domain,
  initgroups,
  moduleLoadList,
  reallyExit,
  openStdin,
  assert: assert2,
  binding,
  send,
  exitCode,
  channel,
  getegid,
  geteuid,
  getgid,
  getgroups,
  getuid,
  setegid,
  seteuid,
  setgid,
  setgroups,
  setuid,
  permission,
  mainModule,
  _events,
  _eventsCount,
  _exiting,
  _maxListeners,
  _debugEnd,
  _debugProcess,
  _fatalException,
  _getActiveHandles,
  _getActiveRequests,
  _kill,
  _preload_modules,
  _rawDebug,
  _startProfilerIdleNotifier,
  _stopProfilerIdleNotifier,
  _tickCallback,
  _disconnect,
  _handleQueue,
  _pendingMessage,
  _channel,
  _send,
  _linkedBinding
};
var process_default = _process;

// ../../.npm/_npx/32026684e21afda6/node_modules/wrangler/_virtual_unenv_global_polyfill-@cloudflare-unenv-preset-node-process
globalThis.process = process_default;

// lib/ex.js
var PROVIDERS = [
  { name: "horizon", path: "hr" },
  { name: "wolf", path: "air" },
  { name: "spider", path: "holly" },
  { name: "multi", path: "multi" },
  { name: "iron", path: "moviebox" }
];
var VIDNEST_PROVIDERS = [
  { name: "videasy" },
  { name: "hollymoviehd" },
  { name: "rogflix" },
  { name: "buzz" },
  { name: "ngc", slug: "nextgencloudfabric" },
  { name: "vidxyz" }
];
var PEACHIFY_API = "https://none.eat-peach.sbs";
var PEACHIFY_REFERER = "https://peachify.top/";
var VIDNEST_API = "https://new.vidnest.fun";
var VIDNEST_REFERER = "https://vidnest.fun/";
var STREAM_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
var PROBE_TIMEOUT_MS = 15e3;
var PROBE_STREAM_TIMEOUT_MS = 8e3;
var STREAM_OK_TTL_MS = 6e4;
var DEAD_TTL_MS = 3e4;
var FAMILY_TTL_MS = 6e4;
var providerCache = /* @__PURE__ */ new Map();
var vidnestCache = /* @__PURE__ */ new Map();
var subsCache = /* @__PURE__ */ new Map();
var vdrkSubsCache = /* @__PURE__ */ new Map();
var deadCache = /* @__PURE__ */ new Map();
var familyDeadUntil = /* @__PURE__ */ new Map();
var streamOkCache = /* @__PURE__ */ new Map();
function markDead(family, provider, key) {
  deadCache.set(`${family}:${provider.name}:${key}`, Date.now() + DEAD_TTL_MS);
}
__name(markDead, "markDead");
function isDead(family, provider, key) {
  return (deadCache.get(`${family}:${provider.name}:${key}`) || 0) > Date.now();
}
__name(isDead, "isDead");
function familyDown(family) {
  return (familyDeadUntil.get(family) || 0) > Date.now();
}
__name(familyDown, "familyDown");
function healFamily(family) {
  familyDeadUntil.delete(family);
}
__name(healFamily, "healFamily");
function titleKey(type, id, season, episode) {
  return type === "tv" ? `tv/${id}/${season}/${episode}` : `movie/${id}`;
}
__name(titleKey, "titleKey");
function b64urlToBytes(s) {
  const b64 = String(s).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
__name(b64urlToBytes, "b64urlToBytes");
function hexToBytes(hex) {
  const h = String(hex).trim();
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}
__name(hexToBytes, "hexToBytes");
async function fetchJSON(url, { headers = {}, timeout = PROBE_TIMEOUT_MS } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, { headers, signal: ctrl.signal, redirect: "follow" });
    if (!r.ok) {
      const e = new Error(`API ${r.status}`);
      e.status = r.status;
      throw e;
    }
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}
__name(fetchJSON, "fetchJSON");
async function decryptPayload(payload, keyHex) {
  const [ivB64, ctB64, tagB64] = String(payload).split(".");
  const key = await crypto.subtle.importKey("raw", hexToBytes(keyHex), "AES-GCM", false, ["decrypt"]);
  const iv = b64urlToBytes(ivB64);
  const ct = b64urlToBytes(ctB64);
  const tag = b64urlToBytes(tagB64);
  const combined = new Uint8Array(ct.length + tag.length);
  combined.set(ct, 0);
  combined.set(tag, ct.length);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, combined);
  return JSON.parse(new TextDecoder().decode(plain));
}
__name(decryptPayload, "decryptPayload");
async function fetchProvider(env2, provider, type, id, season, episode) {
  let url = `${PEACHIFY_API}/${provider.path}/${type}/${id}`;
  if (type === "tv") url += `/${season}/${episode}`;
  try {
    const json2 = await fetchJSON(url, {
      headers: { Referer: PEACHIFY_REFERER, Origin: "https://peachify.top", "User-Agent": STREAM_UA }
    });
    if (json2 && json2.isEncrypted) return decryptPayload(json2.data, env2.PEACHIFY_KEY_HEX);
    return json2;
  } catch (err2) {
    throw new Error(`peachify ${provider.name} API ${err2.status || err2.message}`);
  }
}
__name(fetchProvider, "fetchProvider");
async function fetchSubtitles(env2, type, id, season, episode) {
  const key = titleKey(type, id, season, episode);
  if (subsCache.has(key)) return subsCache.get(key);
  try {
    let url = `${PEACHIFY_API}/subs/${type}/${id}`;
    if (type === "tv") url += `/${season}/${episode}`;
    const raw = await fetchJSON(url, {
      headers: { Referer: PEACHIFY_REFERER, Origin: "https://peachify.top", "User-Agent": STREAM_UA },
      timeout: 3e3
    });
    const subs = (Array.isArray(raw) ? raw : []).map((s) => ({
      url: s.url || s.file || s.src,
      label: s.label || s.language || s.lang || "Unknown",
      lang: s.lang || s.language || null
    })).filter((s) => s.url);
    subsCache.set(key, subs);
    return subs;
  } catch {
    return [];
  }
}
__name(fetchSubtitles, "fetchSubtitles");
function vidnestDecode(data, alphabet) {
  const l = [...String(data)].map((c) => alphabet.indexOf(c));
  const bytes = [];
  for (let o = 0; o + 3 < l.length; o += 4) {
    const a = l[o], b = l[o + 1], c = l[o + 2], d = l[o + 3];
    if (a < 0 || a > 63) break;
    bytes.push(a << 2 | b >> 4);
    if (c !== 64) bytes.push((b & 15) << 4 | c >> 2);
    if (d !== 64) bytes.push((c & 3) << 6 | d);
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}
__name(vidnestDecode, "vidnestDecode");
async function fetchVidnestProvider(env2, provider, type, id, season, episode) {
  const slug = provider.slug || provider.name;
  let url = `${VIDNEST_API}/${slug}/${type}/${id}`;
  if (type === "tv") url += `/${season}/${episode}`;
  try {
    const json2 = await fetchJSON(url, {
      headers: { Referer: VIDNEST_REFERER, Origin: "https://vidnest.fun", "User-Agent": STREAM_UA }
    });
    if (!json2 || !json2.data) throw new Error(`vidnest ${provider.name}: unexpected response`);
    return JSON.parse(vidnestDecode(json2.data, env2.VIDNEST_ALPHABET));
  } catch (err2) {
    const status = err2.status || "";
    if (status === 502 || status === 404) throw new Error(`vidnest ${provider.name}: no source (${status})`);
    throw new Error(`vidnest ${provider.name} API ${status || err2.message}`);
  }
}
__name(fetchVidnestProvider, "fetchVidnestProvider");
function vidnestToResult(provider, data) {
  const items = Array.isArray(data.streams) ? data.streams : [{ url: data.url, type: data.hls, headers: data.headers, referer: data.referer, label: data.label }];
  const sources = items.map((s) => {
    const url = s.url || s.file;
    if (!url) return null;
    return {
      url,
      quality: s.quality || s.resolution || s.label || "auto",
      isM3U8: s.type === "hls" || /\.m3u8($|\?)|streamsvr|\/hls\d*\//i.test(url) || /master\.txt($|\?)|\.txt($|\?)/i.test(url),
      headers: s.headers || null,
      referer: s.headers && s.headers.Referer || s.referer || null,
      lang: s.language || null
    };
  }).filter(Boolean);
  return { provider: provider.name, sources, subtitles: [] };
}
__name(vidnestToResult, "vidnestToResult");
async function resolveVidnest(env2, { type, id, season, episode, server }) {
  if (type !== "movie" && type !== "tv") throw new Error("type must be movie or tv");
  if (server) {
    const p = VIDNEST_PROVIDERS.find((x) => x.name === String(server).toLowerCase());
    if (!p) throw new Error(`Unknown vidnest provider '${server}'`);
    return vidnestToResult(p, await fetchVidnestProvider(env2, p, type, id, season, episode));
  }
  const key = titleKey(type, id, season, episode);
  const cached = vidnestCache.get(key);
  const baseOrder = cached ? [cached, ...VIDNEST_PROVIDERS.filter((p) => p.name !== cached.name)] : VIDNEST_PROVIDERS;
  const order = baseOrder.filter((p) => !isDead("vidnest", p, key));
  let lastError = null;
  const settled = await Promise.allSettled(
    order.map((p) => fetchVidnestProvider(env2, p, type, id, season, episode).then((d) => vidnestToResult(p, d)))
  );
  for (let i = 0; i < order.length; i++) {
    const p = order[i];
    const s = settled[i];
    if (s.status === "rejected") {
      lastError = s.reason;
      markDead("vidnest", p, key);
      continue;
    }
    if (!s.value.sources.length) continue;
    vidnestCache.set(key, p.name);
    return s.value;
  }
  throw new Error(`No vidnest source found${lastError ? ` (${lastError.message})` : ""}`);
}
__name(resolveVidnest, "resolveVidnest");
async function fetchVidnestSubtitles(type, id, season, episode) {
  const key = titleKey(type, id, season, episode);
  if (vdrkSubsCache.has(key)) return vdrkSubsCache.get(key);
  try {
    let url = `https://sub.vdrk.site/v2/${type}/${id}`;
    if (type === "tv") url += `/${season}/${episode}`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3e3);
    try {
      const r = await fetch(url, { signal: ctrl.signal });
      const list = r.ok ? await r.json() : [];
      const subs = (Array.isArray(list) ? list : []).map((s) => ({ url: s.file || s.url, label: s.label, lang: s.label || null })).filter((s) => s.url);
      vdrkSubsCache.set(key, subs);
      return subs;
    } finally {
      clearTimeout(t);
    }
  } catch {
    return [];
  }
}
__name(fetchVidnestSubtitles, "fetchVidnestSubtitles");
async function probeStreamPlayable(src) {
  if (!src || !src.url) return false;
  try {
    const headers = { "User-Agent": STREAM_UA, Referer: src.referer || PEACHIFY_REFERER };
    if (src.origin) headers.Origin = src.origin;
    const isM3U8 = src.isM3U8 || /\.m3u8($|\?)|streamsvr|\/hls\d*\//i.test(src.url) || /master\.txt($|\?)|\.txt($|\?)/i.test(src.url);
    if (!isM3U8) headers.Range = "bytes=0-0";
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), PROBE_STREAM_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(src.url, { headers, signal: ctrl.signal, redirect: "follow" });
    } finally {
      clearTimeout(t);
    }
    if (!res || res.status !== 200 && res.status !== 206) return false;
    if (isM3U8) {
      const head = (await res.text()).slice(0, 300);
      const ct = res.headers.get("content-type") || "";
      return /#EXT/i.test(head) || ct.includes("mpegurl");
    }
    return (await res.arrayBuffer()).byteLength > 0;
  } catch {
    return false;
  }
}
__name(probeStreamPlayable, "probeStreamPlayable");
async function autoRace(env2, pOrder, vOrder, key, opts) {
  const cand = [];
  for (const p of pOrder) cand.push(["peachify", p]);
  for (const p of vOrder) cand.push(["vidnest", p]);
  return await new Promise((resolve) => {
    let left = cand.length;
    if (!left) return resolve({ won: false, lastErr: {} });
    let done = false;
    const lastErr = {};
    const fails = { peachify: 0, vidnest: 0 };
    const totals = { peachify: pOrder.length, vidnest: vOrder.length };
    const finish = /* @__PURE__ */ __name((out) => {
      if (!done) {
        done = true;
        resolve(out);
      }
    }, "finish");
    for (const [fam, p] of cand) {
      (fam === "peachify" ? fetchProvider(env2, p, opts.type, opts.id, opts.season, opts.episode).then(
        (d) => toResult(p, d)
      ) : fetchVidnestProvider(env2, p, opts.type, opts.id, opts.season, opts.episode).then(
        (d) => vidnestToResult(p, d)
      )).then((result) => {
        healFamily(fam);
        return { ok: true, fam, p, result };
      }).catch((e) => {
        markDead(fam, p, key);
        fails[fam]++;
        lastErr[fam] = e && e.message;
        if (fails[fam] === totals[fam]) familyDeadUntil.set(fam, Date.now() + FAMILY_TTL_MS);
        return { ok: false };
      }).then(async (r) => {
        try {
          if (r.ok && r.result.sources.length && !done) {
            const scKey = `${r.fam}:${r.p.name}:${key}`;
            let playable = (streamOkCache.get(scKey) || 0) > Date.now();
            if (!playable) {
              playable = await probeStreamPlayable(r.result.sources[0]);
              if (playable) streamOkCache.set(scKey, Date.now() + STREAM_OK_TTL_MS);
            }
            if (playable) {
              (r.fam === "peachify" ? providerCache : vidnestCache).set(key, r.p.name);
              return finish({ won: true, result: r.result });
            }
            markDead(r.fam, r.p, key);
            fails[r.fam]++;
            lastErr[r.fam] = `${r.p.name}: stream not startable`;
            if (fails[r.fam] === totals[r.fam]) familyDeadUntil.set(r.fam, Date.now() + FAMILY_TTL_MS);
          }
        } finally {
          left--;
          if (!left && !done) finish({ won: false, lastErr });
        }
      });
    }
  });
}
__name(autoRace, "autoRace");
async function resolveStream(env2, { type, id, season, episode, server, skip }) {
  if (type !== "movie" && type !== "tv") throw new Error("type must be movie or tv");
  if (!env2.PEACHIFY_KEY_HEX) throw new Error("PEACHIFY_KEY_HEX env required");
  if (!env2.VIDNEST_ALPHABET) throw new Error("VIDNEST_ALPHABET env required");
  if (server) {
    const name = String(server).toLowerCase();
    const vid = VIDNEST_PROVIDERS.find((x) => x.name === name);
    if (vid) return resolveVidnest(env2, { type, id, season, episode, server: name });
    const p = PROVIDERS.find((x) => x.name === name || x.path === name);
    if (!p) throw new Error(`Unknown provider '${server}'`);
    const data = await fetchProvider(env2, p, type, id, season, episode);
    return toResult(p, data);
  }
  const key = titleKey(type, id, season, episode);
  const pc = providerCache.get(key);
  const skipSet = new Set((skip || []).map((s) => String(s).toLowerCase()));
  const pOrder = (pc ? [pc, ...PROVIDERS.filter((p) => p.name !== pc.name)] : PROVIDERS).filter(
    (p) => !skipSet.has(p.name) && !familyDown("peachify") && !isDead("peachify", p, key)
  );
  const vc = vidnestCache.get(key);
  const vOrder = (vc ? [vc, ...VIDNEST_PROVIDERS.filter((p) => p.name !== vc.name)] : VIDNEST_PROVIDERS).filter(
    (p) => !skipSet.has(p.name) && !familyDown("vidnest") && !isDead("vidnest", p, key)
  );
  const out = await autoRace(env2, pOrder, vOrder, key, { type, id, season, episode });
  if (out.won) return out.result;
  return { provider: null, sources: [], subtitles: [] };
}
__name(resolveStream, "resolveStream");
function unwrapProxies(src) {
  if (!src || !src.url || !/\/(?:m3u8|mp4)-proxy/.test(src.url)) return src;
  try {
    const u = new URL(src.url);
    const real = u.searchParams.get("url");
    if (!real) return src;
    let headers = null;
    try {
      const h = JSON.parse(u.searchParams.get("headers") || "{}");
      headers = { ...h.origin ? { Origin: h.origin } : {}, ...h.referer ? { Referer: h.referer } : {} };
    } catch {
    }
    return { ...src, url: real, headers };
  } catch {
    return src;
  }
}
__name(unwrapProxies, "unwrapProxies");
function toResult(provider, data) {
  const sources = (data.sources || []).map((s) => {
    const unwrapped = unwrapProxies(s);
    const h = unwrapped.headers || {};
    return {
      url: unwrapped.url || unwrapped.src || unwrapped.file,
      quality: unwrapped.quality || unwrapped.resolution || unwrapped.height || "auto",
      sizeBytes: unwrapped.sizeBytes || unwrapped.size || null,
      dub: unwrapped.dub || null,
      isM3U8: /\.m3u8($|\?)|m3u8-proxy|streamsvr|\/hls\d*\//i.test(unwrapped.url || "") || /master\.txt($|\?)|\.txt($|\?)/i.test(unwrapped.url || ""),
      headers: unwrapped.headers || null,
      referer: h.Referer || h.referer || null,
      origin: h.Origin || h.origin || null
    };
  }).filter((s) => s.url);
  const subtitles = (data.subtitles || []).map((s) => ({
    url: s.url || s.file || s.src,
    label: s.label || s.language || s.lang || "Unknown",
    lang: s.lang || s.language || null,
    format: s.format || null,
    encoding: s.encoding || null
  })).filter((s) => s.url);
  return { provider: provider.name, sources, subtitles };
}
__name(toResult, "toResult");

// lib/subs.js
var SUBDL_BASE = "https://api.subdl.com/api/v1";
var SUBDL_DL_BASE = "https://dl.subdl.com";
var OS_BASE = "https://api.opensubtitles.com/api/v1";
var OS_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
var loginToken = null;
var loginExp = 0;
var VTT_CACHE = /* @__PURE__ */ new Map();
var VTT_CACHE_MAX = 200;
function subdlKey(env2) {
  return env2.SUBDL_API_KEY || "";
}
__name(subdlKey, "subdlKey");
function srtToVtt(srt) {
  if (!srt) return "";
  if (srt.startsWith("WEBVTT")) return srt;
  const cleaned = srt.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const vttTimestamps = cleaned.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2");
  return `WEBVTT

${vttTimestamps.trim()}
`;
}
__name(srtToVtt, "srtToVtt");
function extractSrtFromZip(bytes, episode) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dec = new TextDecoder();
  let offset = 0;
  const entries = [];
  while (offset + 30 <= bytes.length) {
    if (view.getUint32(offset, true) !== 67324752) break;
    const method = view.getUint16(offset + 8, true);
    const compSize = view.getUint32(offset + 18, true);
    const nameLen = view.getUint16(offset + 26, true);
    const extraLen = view.getUint16(offset + 28, true);
    const filename = dec.decode(bytes.subarray(offset + 30, offset + 30 + nameLen));
    const dataStart = offset + 30 + nameLen + extraLen;
    const data = bytes.subarray(dataStart, dataStart + compSize);
    if (filename.endsWith(".srt") || filename.endsWith(".vtt")) entries.push({ filename, method, data });
    offset = dataStart + compSize;
  }
  if (!entries.length) return null;
  let chosen = entries[0];
  if (episode) {
    const epNum = Number(episode);
    const epPadded = epNum < 10 ? `0${epNum}` : String(epNum);
    const match2 = entries.find((e) => {
      const fn = e.filename.toLowerCase();
      return fn.includes(`e${epPadded}`) || fn.includes(`episode ${epNum}`) || fn.includes(`ep${epNum}`) || fn.includes(` ${epPadded} `) || fn.startsWith(epPadded);
    });
    if (match2) chosen = match2;
  }
  return (async () => {
    let content;
    if (chosen.method === 0) {
      content = dec.decode(chosen.data);
    } else if (chosen.method === 8) {
      const ds = new DecompressionStream("deflate-raw");
      const stream = new Response(chosen.data, { headers: { "Content-Type": "application/octet-stream" } }).body.pipeThrough(ds);
      content = await new Response(stream).text();
    } else {
      return null;
    }
    return { filename: chosen.filename, content };
  })();
}
__name(extractSrtFromZip, "extractSrtFromZip");
async function timedFetch(url, opts = {}, ms = 6e3) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}
__name(timedFetch, "timedFetch");
async function fetchSubdlVtt(env2, zipUrlPath, episode) {
  const cacheKey = `${zipUrlPath}::${episode || ""}`;
  if (VTT_CACHE.has(cacheKey)) return VTT_CACHE.get(cacheKey);
  const r = await timedFetch(`${SUBDL_DL_BASE}${zipUrlPath}`, {}, 1e4);
  if (!r.ok) throw new Error(`SubDL zip ${r.status}`);
  const bytes = new Uint8Array(await r.arrayBuffer());
  const extracted = await extractSrtFromZip(bytes, episode);
  if (!extracted || !extracted.content) throw new Error("Could not extract subtitle from zip archive");
  const vtt = srtToVtt(extracted.content);
  if (VTT_CACHE.size >= VTT_CACHE_MAX) {
    const firstKey = VTT_CACHE.keys().next().value;
    if (firstKey) VTT_CACHE.delete(firstKey);
  }
  VTT_CACHE.set(cacheKey, vtt);
  return vtt;
}
__name(fetchSubdlVtt, "fetchSubdlVtt");
async function searchSubdl(env2, { type, imdbId, season, episode }) {
  const key = subdlKey(env2);
  if (!key || !imdbId) return [];
  try {
    const params = new URLSearchParams({ api_key: key, imdb_id: imdbId, languages: "en" });
    if (type === "tv" && season && episode) {
      params.set("season_number", String(Number(season)));
      params.set("episode_number", String(Number(episode)));
    }
    const r = await timedFetch(`${SUBDL_BASE}/subtitles?${params}`);
    if (!r.ok) return [];
    const data = await r.json();
    const list = data && data.subtitles || [];
    return list.slice(0, 4).map((item) => ({
      url: `/subtitles/subdl?zip=${encodeURIComponent(item.url)}&ep=${type === "tv" ? episode || "" : ""}`,
      label: item.release_name || item.name || "English (SubDL)",
      lang: "en"
    })).filter((s) => s.url);
  } catch {
    return [];
  }
}
__name(searchSubdl, "searchSubdl");
async function loginOpenSubs(env2) {
  const key = env2.OPENSUBTITLES_API_KEY;
  const username = env2.OPENSUBTITLES_USERNAME;
  const password = env2.OPENSUBTITLES_PASSWORD;
  if (!key || !username || !password) throw new Error("opensubtitles credentials missing");
  if (loginToken && Date.now() < loginExp) return loginToken;
  const r = await timedFetch(
    `${OS_BASE}/login`,
    {
      method: "POST",
      headers: { "Api-Key": key, "User-Agent": OS_UA, "Content-Type": "application/json" },
      body: JSON.stringify({ username, password })
    },
    6e3
  );
  const data = await r.json();
  loginToken = data && data.token;
  loginExp = Date.now() + 24 * 60 * 60 * 1e3;
  return loginToken;
}
__name(loginOpenSubs, "loginOpenSubs");
async function searchOpenSubs(env2, { type, imdbId, season, episode }) {
  const key = env2.OPENSUBTITLES_API_KEY;
  if (!key) return [];
  try {
    const params = new URLSearchParams({ imdb_id: imdbId, languages: "en" });
    if (type === "tv" && season && episode) {
      params.set("type", "episode");
      params.set("season_number", String(Number(season)));
      params.set("episode_number", String(Number(episode)));
    }
    const r = await timedFetch(`${OS_BASE}/subtitles?${params}`, {
      headers: { "Api-Key": key, "User-Agent": OS_UA }
    });
    if (!r.ok) return [];
    const data = await r.json();
    const rows = data && data.data || [];
    const hits = rows.map((it) => {
      const a = it && it.attributes || {};
      const file = a.files && a.files[0] || {};
      return { fileId: file.file_id, label: a.language || "English", lang: a.language_id || "en" };
    }).filter((s) => s.fileId);
    const token = await loginOpenSubs(env2);
    const subs = [];
    for (const h of hits.slice(0, 2)) {
      try {
        const dRes = await timedFetch(
          `${OS_BASE}/download`,
          {
            method: "POST",
            headers: {
              "Api-Key": key,
              Authorization: `Bearer ${token}`,
              "User-Agent": OS_UA,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({ file_id: h.fileId })
          },
          6e3
        );
        const d = await dRes.json();
        if (d && d.link) subs.push({ url: d.link, label: h.label || "English (OpenSubtitles)", lang: h.lang || "en" });
      } catch {
      }
    }
    return subs;
  } catch {
    return [];
  }
}
__name(searchOpenSubs, "searchOpenSubs");
async function fetchEnglishSubtitles(env2, { type, imdbId, season, episode }) {
  if (!imdbId) return [];
  const subdlHits = await searchSubdl(env2, { type, imdbId, season, episode });
  if (subdlHits.length > 0) return subdlHits;
  return searchOpenSubs(env2, { type, imdbId, season, episode });
}
__name(fetchEnglishSubtitles, "fetchEnglishSubtitles");

// lib/flix.js
var TMDB_BASE = "https://api.themoviedb.org/3";
var IMAGE_BASE = "https://image.tmdb.org/t/p/w500";
var SERVERS = [...PROVIDERS, ...VIDNEST_PROVIDERS];
function withDeadline(promise, ms) {
  let t;
  const cap = new Promise((resolve) => {
    t = setTimeout(() => resolve([]), ms);
  });
  return Promise.race([promise, cap]).finally(() => clearTimeout(t));
}
__name(withDeadline, "withDeadline");
var SUB_VALID_CACHE = /* @__PURE__ */ new Map();
var SUB_VALID_TTL = 10 * 60 * 1e3;
var FlixHQ = class {
  static {
    __name(this, "FlixHQ");
  }
  constructor(env2) {
    if (!env2.TMDB_API_KEY) throw new Error("TMDB_API_KEY env required");
    this.env = env2;
    this.name = "MyFlixHQ";
    this.baseUrl = "https://myflixerfree.to";
    this._genresCache = null;
    this._cache = /* @__PURE__ */ new Map();
  }
  async tmdbGet(path, params = {}, timeout = 12e3) {
    const q = new URLSearchParams({ api_key: this.env.TMDB_API_KEY, ...params });
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    try {
      const r = await fetch(`${TMDB_BASE}${path}?${q}`, { signal: ctrl.signal });
      if (!r.ok) {
        const e = new Error(`TMDB ${r.status}`);
        e.status = r.status;
        throw e;
      }
      return await r.json();
    } finally {
      clearTimeout(t);
    }
  }
  _cached(key, ttlMs, fn) {
    const now = Date.now();
    const hit = this._cache.get(key);
    if (hit) {
      if (hit.exp > now) return hit.promise;
      this._cache.delete(key);
    }
    const p = Promise.resolve().then(fn).then((v) => {
      this._cache.set(key, { exp: Date.now() + ttlMs, promise: Promise.resolve(v) });
      return v;
    }).catch((e) => {
      this._cache.delete(key);
      throw e;
    });
    this._cache.set(key, { exp: now + ttlMs, promise: p });
    if (this._cache.size > 600) {
      const t = Date.now();
      for (const [k, v] of this._cache) if (v.exp < t) this._cache.delete(k);
    }
    return p;
  }
  _imdbId(type, id) {
    return this._cached(`imdb:${type}:${id}`, 7 * 24 * 60 * 60 * 1e3, async () => {
      try {
        const data = await this.tmdbGet(`/${type}/${id}/external_ids`);
        return data.imdb_id || null;
      } catch {
        return null;
      }
    });
  }
  _img(path) {
    return path ? `${IMAGE_BASE}${path}` : null;
  }
  _playerUrl(type, id, title2, season, episode) {
    const params = new URLSearchParams({ id, type, title: title2 || "Watch Now" });
    if (type === "tv" && season && episode) {
      params.set("season", season);
      params.set("episode", episode);
    }
    return `${this.baseUrl}/player?${params.toString()}`;
  }
  _item(id, tmdbItem, type) {
    const title2 = tmdbItem.title || tmdbItem.name;
    return {
      id: `${type}/${tmdbItem.id}`,
      title: title2,
      url: this._playerUrl(type, tmdbItem.id, title2),
      image: this._img(tmdbItem.poster_path || tmdbItem.backdrop_path),
      releaseDate: (tmdbItem.release_date || tmdbItem.first_air_date || "").split("-")[0] || void 0,
      type: type === "movie" ? "MOVIE" : "TVSERIES",
      rating: tmdbItem.vote_average || 0
    };
  }
  async _genres() {
    if (!this._genresCache) {
      const [movies, tv] = await Promise.all([
        this.tmdbGet("/genre/movie/list"),
        this.tmdbGet("/genre/tv/list")
      ]);
      const map = {};
      [...movies.genres, ...tv.genres].forEach((g) => {
        map[g.name.toLowerCase()] = g.id;
      });
      this._genresCache = map;
    }
    return this._genresCache;
  }
  async _discover(type, page, extra = {}) {
    const key = `discover:${type}:${page}:${JSON.stringify(extra)}`;
    return this._cached(key, 10 * 60 * 1e3, async () => {
      const data = await this.tmdbGet(`/discover/${type}`, { page, sort_by: "popularity.desc", ...extra });
      return {
        currentPage: data.page,
        hasNextPage: data.page < data.total_pages,
        results: data.results.map((r) => this._item(type, r, type))
      };
    });
  }
  async search(query, page = 1) {
    return this._cached(`search:${query}:${page}`, 5 * 60 * 1e3, async () => {
      const data = await this.tmdbGet("/search/multi", { query, page, include_adult: "false" });
      const results = data.results.filter((r) => r.media_type === "movie" || r.media_type === "tv").map((r) => this._item(r.media_type, r, r.media_type));
      return { currentPage: data.page, hasNextPage: data.page < data.total_pages, results };
    });
  }
  async fetchMediaInfo(mediaId) {
    return this._cached(`info:${mediaId}`, 15 * 60 * 1e3, async () => {
      const [type, id] = mediaId.split("/");
      if (type !== "movie" && type !== "tv") throw new Error("Invalid media ID format");
      const data = await this.tmdbGet(`/${type}/${id}`, { append_to_response: "credits,recommendations,videos" });
      const title2 = data.title || data.name;
      const info3 = {
        id: `${type}/${data.id}`,
        title: title2,
        url: this._playerUrl(type, data.id, title2),
        cover: this._img(data.backdrop_path),
        image: this._img(data.poster_path),
        description: data.overview,
        type: type === "movie" ? "MOVIE" : "TVSERIES",
        releaseDate: data.release_date || data.first_air_date,
        genres: (data.genres || []).map((g) => g.name),
        casts: (data.credits && data.credits.cast || []).slice(0, 15).map((c) => c.name),
        production: (data.production_companies || []).slice(0, 3).map((c) => c.name),
        country: (data.production_countries || []).map((c) => c.name),
        duration: type === "movie" ? `${data.runtime || 0} min` : void 0,
        rating: data.vote_average || 0,
        recommendations: (data.recommendations && data.recommendations.results || []).slice(0, 12).map((r) => this._item(type, r, type))
      };
      if (type === "tv") {
        const seasonCount = Math.min(data.number_of_seasons || 0, 10);
        const seasonResults = await Promise.all(
          Array.from(
            { length: seasonCount },
            (_, i) => this.tmdbGet(`/tv/${id}/season/${i + 1}`).then((r) => r.episodes || []).catch(() => null)
          )
        );
        info3.episodes = [];
        seasonResults.forEach((eps, i) => {
          if (!eps) return;
          const s = i + 1;
          for (const ep of eps) {
            info3.episodes.push({
              id: `${s}-${ep.episode_number}`,
              title: ep.name,
              number: ep.episode_number,
              season: s,
              url: this._playerUrl("tv", data.id, title2, s, ep.episode_number)
            });
          }
        });
      } else {
        info3.episodes = [{ id, title: title2, number: 1, season: 1, url: this._playerUrl("movie", data.id, title2) }];
      }
      return info3;
    });
  }
  async fetchEpisodeServers() {
    return SERVERS.map((s) => ({ name: s.name }));
  }
  async fetchEpisodeSources(episodeId, mediaId, server = null, skip = []) {
    const sk = [...skip || []].sort().join(",");
    return this._cached(
      `sources:${episodeId}:${mediaId}:${server || "auto"}:${sk}`,
      60 * 1e3,
      () => this._episodeSources(episodeId, mediaId, server, skip)
    );
  }
  _parseMedia(episodeId, mediaId) {
    const [type, id] = String(mediaId).split("/");
    if (!type || !id) throw new Error("mediaId must be movie/{id} or tv/{id}");
    let season = 1;
    let episode = 1;
    if (type === "tv") {
      const m = String(episodeId || "").match(/^(?:s)?(\d+)(?:e|[-/])(\d+)$/i);
      if (m) {
        season = m[1];
        episode = m[2];
      } else if (String(episodeId).includes("-")) {
        [season, episode] = String(episodeId).split("-");
      }
    }
    return { type, id, season, episode };
  }
  _mergeSubtitles(osSubs, subs, vsubs) {
    const isEn = /* @__PURE__ */ __name((s) => /english|\beng\b|\ben\b/i.test(`${s.label || ""} ${s.lang || ""}`), "isEn");
    const builtIn = [...subs, ...vsubs].filter(isEn);
    const merged = [...osSubs, ...builtIn];
    const seen = /* @__PURE__ */ new Set();
    return merged.filter((s) => {
      const k = s.label || s.lang || "unknown";
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }
  async _validateSubtitles(subs) {
    const check = /* @__PURE__ */ __name(async (s) => {
      const cached = SUB_VALID_CACHE.get(s.url);
      if (cached && Date.now() - cached.ts < SUB_VALID_TTL) return cached.ok ? s : null;
      try {
        let head;
        if (s.url.startsWith("/subtitles/subdl?")) {
          const q = new URLSearchParams(s.url.split("?")[1]);
          head = (await fetchSubdlVtt(this.env, q.get("zip"), q.get("ep"))).slice(0, 4e3);
        } else {
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), 5e3);
          try {
            const r = await fetch(s.url, { signal: ctrl.signal });
            if (!r.ok) return null;
            head = (await r.text()).slice(0, 4e3);
          } finally {
            clearTimeout(t);
          }
        }
        const ok = /^WEBVTT/m.test(head) || /-->/m.test(head);
        SUB_VALID_CACHE.set(s.url, { ok, ts: Date.now() });
        return ok ? s : null;
      } catch {
        SUB_VALID_CACHE.set(s.url, { ok: false, ts: Date.now() });
        return null;
      }
    }, "check");
    const results = await Promise.all(subs.slice(0, 8).map(check));
    return results.filter(Boolean).slice(0, 6);
  }
  async fetchEpisodeSubtitles(episodeId, mediaId) {
    const { type, id, season, episode } = this._parseMedia(episodeId, mediaId);
    const budgetMs = 6e3;
    const imdbId = await this._imdbId(type, id);
    const [subs, vsubs, osSubs] = await Promise.all([
      withDeadline(fetchSubtitles(this.env, type, id, season, episode), budgetMs),
      withDeadline(fetchVidnestSubtitles(type, id, season, episode), budgetMs),
      imdbId ? withDeadline(fetchEnglishSubtitles(this.env, { type, imdbId, season, episode }), budgetMs) : []
    ]);
    return this._validateSubtitles(this._mergeSubtitles(osSubs, subs, vsubs));
  }
  async _episodeSources(episodeId, mediaId, server = null, skip = []) {
    const { type, id, season, episode } = this._parseMedia(episodeId, mediaId);
    const stream = await resolveStream(this.env, { type, id, season, episode, server, skip });
    const embedUrl = this._playerUrl(type, id, "", season, episode);
    return {
      headers: { Referer: "https://peachify.top/" },
      sources: stream.sources,
      subtitles: [],
      provider: stream.provider,
      server: stream.provider,
      embedUrl
    };
  }
  async fetchMovieEmbedLinks(movieId, serverName = null) {
    const servers = serverName ? SERVERS.filter((s) => s.name === serverName) : SERVERS;
    const results = [];
    for (const s of servers) {
      try {
        const stream = await resolveStream(this.env, { type: "movie", id: movieId, server: s.name });
        results.push({ server: s.name, url: stream.sources[0] && stream.sources[0].url || null, isM3U8: stream.sources[0] ? !!stream.sources[0].isM3U8 : false });
      } catch {
      }
    }
    return { id: movieId, sources: results };
  }
  async fetchTvEpisodeEmbedLinks(episodeId, serverName = null) {
    const [tvId, se] = episodeId.includes(":") ? episodeId.split(":") : [null, episodeId];
    if (!tvId) throw new Error("episodeId must be tvId:s{e} e.g. 1396:1-3");
    const m = se.match(/^(\d+)-(\d+)$/);
    if (!m) throw new Error("episodeId must be tvId:s{e} e.g. 1396:1-3");
    const [, season, episode] = m;
    const servers = serverName ? SERVERS.filter((s) => s.name === serverName) : SERVERS;
    const results = [];
    for (const s of servers) {
      try {
        const stream = await resolveStream(this.env, { type: "tv", id: tvId, season, episode, server: s.name });
        results.push({ server: s.name, url: stream.sources[0] && stream.sources[0].url || null, isM3U8: stream.sources[0] ? !!stream.sources[0].isM3U8 : false });
      } catch {
      }
    }
    return { id: episodeId, sources: results };
  }
  async fetchDubs(episodeId, mediaId) {
    return this._cached(`dubs:${episodeId}:${mediaId}`, 10 * 60 * 1e3, () => this._fetchDubs(episodeId, mediaId));
  }
  async _fetchDubs(episodeId, mediaId) {
    const [type, id] = mediaId.split("/");
    if (!type || !id) throw new Error("mediaId must be movie/{id} or tv/{id}");
    let season = 1;
    let episode = 1;
    if (type === "tv") {
      const m = String(episodeId || "").match(/^(?:s)?(\d+)(?:e|[-/])(\d+)$/i);
      if (m) {
        season = m[1];
        episode = m[2];
      } else if (episodeId.includes("-")) {
        [season, episode] = episodeId.split("-");
      }
    }
    const out = {};
    await Promise.all(
      ["iron", "multi"].map(async (server) => {
        try {
          const res = await resolveStream(this.env, { type, id, season, episode, server });
          out[server] = [...new Set(res.sources.map((s) => s.dub).filter(Boolean))];
        } catch {
          out[server] = [];
        }
      })
    );
    return out;
  }
  async fetchRecentMovies() {
    return this._cached("recent:movies", 10 * 60 * 1e3, async () => {
      const data = await this.tmdbGet("/movie/now_playing");
      return data.results.slice(0, 20).map((r) => this._item("movie", r, "movie"));
    });
  }
  async fetchRecentTvShows() {
    return this._cached("recent:tv", 10 * 60 * 1e3, async () => {
      const data = await this.tmdbGet("/tv/on_the_air");
      return data.results.slice(0, 20).map((r) => this._item("tv", r, "tv"));
    });
  }
  async fetchTrendingMovies() {
    return this._cached("trending:movies", 10 * 60 * 1e3, async () => {
      const data = await this.tmdbGet("/trending/movie/week");
      return data.results.slice(0, 20).map((r) => this._item("movie", r, "movie"));
    });
  }
  async fetchTrendingTvShows() {
    return this._cached("trending:tv", 10 * 60 * 1e3, async () => {
      const data = await this.tmdbGet("/trending/tv/week");
      return data.results.slice(0, 20).map((r) => this._item("tv", r, "tv"));
    });
  }
  async fetchMoviesByPage(page = 1) {
    return this._discover("movie", page);
  }
  async fetchTvShowsByPage(page = 1) {
    return this._discover("tv", page);
  }
  async fetchByGenre(genre, page = 1) {
    const genres = await this._genres();
    const id = genres[String(genre).toLowerCase()];
    if (!id) throw new Error(`Genre '${genre}' not found`);
    return this._discover("movie", page, { with_genres: id });
  }
  async fetchTopIMDB(type = "all", page = 1, minVote) {
    if (type === "all") {
      const [movies, tv] = await Promise.all([
        this._discover("movie", 1, { sort_by: "vote_average.desc", "vote_count.gte": 500 }),
        this._discover("tv", 1, { sort_by: "vote_average.desc", "vote_count.gte": 500 })
      ]);
      return {
        currentPage: page,
        hasNextPage: false,
        results: [...movies.results, ...tv.results].sort((a, b) => (b.rating || 0) - (a.rating || 0)).slice(0, 40)
      };
    }
    if (type !== "movie" && type !== "tv") throw new Error("type must be 'movie', 'tv' or 'all'");
    const params = { sort_by: "vote_average.desc", "vote_count.gte": 500 };
    if (minVote) params["vote_average.gte"] = minVote;
    return this._discover(type, page, params);
  }
};

// [[path]].js
var PLAY_WORKER_DEFAULT = "https://flixerz-play.cinephilia-areana.workers.dev";
var DOWNLOAD_FALLBACK_DEFAULT = "https://cinephilia-vercel.vercel.app";
var flix = null;
function getFlix(env2) {
  if (!flix) flix = new FlixHQ(env2);
  return flix;
}
__name(getFlix, "getFlix");
function json(data, { status = 200, cache = null } = {}) {
  const headers = { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" };
  if (cache) headers["Cache-Control"] = cache;
  return new Response(JSON.stringify(data), { status, headers });
}
__name(json, "json");
var err = /* @__PURE__ */ __name((message, status = 500) => json({ error: message }, { status }), "err");
async function cachedJson(request, ctx, ttlS, fn, extraHeaders = {}) {
  const cache = caches.default;
  try {
    const hit = await cache.match(request);
    if (hit) return hit;
  } catch {
  }
  const data = await fn();
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": `public, max-age=300, s-maxage=${ttlS}`,
    ...extraHeaders
  };
  const res = new Response(JSON.stringify(data), { headers });
  try {
    ctx.waitUntil(cache.put(request, res.clone()));
  } catch {
  }
  return res;
}
__name(cachedJson, "cachedJson");
async function onRequest({ request, env: env2, params, next, waitUntil }) {
  const ctx = { waitUntil };
  const url = new URL(request.url);
  const seg = url.pathname.split("/").filter(Boolean);
  const q = url.searchParams;
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Max-Age": "86400"
      }
    });
  }
  if (request.method !== "GET") return err("Method not allowed", 405);
  try {
    const api = getFlix(env2);
    const [a, b, c, d] = seg;
    if (seg.length === 1 && a === "health") {
      return json({ ok: true, edge: "cinephile-areana", ts: Date.now() });
    }
    if (a === "play") {
      const base = (env2.PLAY_PROXY_BASE || PLAY_WORKER_DEFAULT).replace(/\/$/, "");
      const target = `${base}${url.pathname}${url.search}`;
      return Response.redirect(target, 302);
    }
    if (a === "download") {
      const base = (env2.DOWNLOAD_FALLBACK || DOWNLOAD_FALLBACK_DEFAULT).replace(/\/$/, "");
      return Response.redirect(`${base}${url.pathname}${url.search}`, 302);
    }
    if (a === "search" && seg.length === 1) {
      const query = q.get("query");
      if (!query) return err("Query parameter is required", 400);
      return json(await api.search(query, parseInt(q.get("page") || "1", 10)));
    }
    if (a === "info" && seg.length === 3) {
      const mediaId = `${b}/${c}`;
      if (!/^(movie|tv)\/[\w-]+$/.test(mediaId)) return err("Invalid media ID format", 400);
      const info3 = await api.fetchMediaInfo(mediaId);
      if (!info3) return err("Media not found", 404);
      return cachedJson(request, ctx, 3600, async () => info3);
    }
    if (a === "sources" && seg.length === 2) {
      const mediaId = q.get("mediaId");
      if (!mediaId) return err("mediaId query parameter is required", 400);
      const skip = q.get("skip") ? String(q.get("skip")).split(",").map((s) => s.trim()).filter(Boolean) : [];
      const sources = await api.fetchEpisodeSources(b, mediaId, q.get("server"), skip);
      if (!sources || !(sources.sources || []).length) {
        return json({
          provider: sources && sources.provider || q.get("server") || null,
          sources: [],
          subtitles: [],
          message: "No sources available \u2014 try another server"
        });
      }
      return json(sources);
    }
    if (a === "servers" && seg.length === 2) {
      if (!q.get("mediaId")) return err("mediaId query parameter is required", 400);
      const servers = await api.fetchEpisodeServers(b, q.get("mediaId"));
      if (!servers || !servers.length) return err("No servers found", 404);
      return json(servers);
    }
    if (a === "subtitles" && b === "subdl" && seg.length === 2) {
      const zip = q.get("zip");
      if (!zip) return err("zip parameter is required", 400);
      const vtt = await fetchSubdlVtt(env2, zip, q.get("ep"));
      return new Response(vtt, {
        headers: {
          "Content-Type": "text/vtt; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "public, max-age=86400"
        }
      });
    }
    if (a === "subtitles" && seg.length === 2) {
      if (!q.get("mediaId")) return err("mediaId query parameter is required", 400);
      return cachedJson(request, ctx, 3600, async () => ({
        subtitles: await api.fetchEpisodeSubtitles(b, q.get("mediaId"))
      }));
    }
    if (a === "dubs" && seg.length === 2) {
      if (!q.get("mediaId")) return err("mediaId query parameter is required", 400);
      return cachedJson(request, ctx, 3600, async () => api.fetchDubs(b, q.get("mediaId")));
    }
    if (a === "recent" && (b === "movies" || b === "tv") && seg.length === 2) {
      return cachedJson(
        request,
        ctx,
        3600,
        async () => b === "movies" ? api.fetchRecentMovies() : api.fetchRecentTvShows()
      );
    }
    if (a === "trending" && (b === "movies" || b === "tv") && seg.length === 2) {
      return cachedJson(
        request,
        ctx,
        3600,
        async () => b === "movies" ? api.fetchTrendingMovies() : api.fetchTrendingTvShows()
      );
    }
    if ((a === "movies" || a === "tv") && seg.length === 1) {
      const page = parseInt(q.get("page") || "1", 10);
      return cachedJson(
        request,
        ctx,
        3600,
        async () => a === "movies" ? api.fetchMoviesByPage(page) : api.fetchTvShowsByPage(page)
      );
    }
    if (a === "genre" && seg.length === 2) {
      const page = parseInt(q.get("page") || "1", 10);
      return cachedJson(request, ctx, 3600, async () => api.fetchByGenre(b, page));
    }
    if (a === "top-imdb" && seg.length === 1) {
      const mv = q.get("minVote");
      return cachedJson(
        request,
        ctx,
        3600,
        async () => api.fetchTopIMDB(q.get("type") || "all", parseInt(q.get("page") || "1", 10), mv ? parseFloat(mv) : void 0)
      );
    }
    if ((a === "movie" || a === "tv") && b === "embed" && (seg.length === 3 || seg.length === 4)) {
      const srv = q.get("server");
      if (seg.length === 4 && !srv) return err("Server parameter is required", 400);
      if (a === "movie") return json(await api.fetchMovieEmbedLinks(c, srv));
      return json(await api.fetchTvEpisodeEmbedLinks(c, srv));
    }
    return next();
  } catch (e) {
    if (e && /TMDB_API_KEY|PEACHIFY_KEY_HEX|VIDNEST_ALPHABET/.test(e.message || "")) {
      return err(`Server misconfigured: ${e.message}`, 500);
    }
    return err(e.message || "Something broke!", 500);
  }
}
__name(onRequest, "onRequest");

// ../.wrangler/tmp/pages-WFwVjR/functionsRoutes-0.7664764070044134.mjs
var routes = [
  {
    routePath: "/:path*",
    mountPath: "/",
    method: "",
    middlewares: [],
    modules: [onRequest]
  }
];

// ../../.npm/_npx/32026684e21afda6/node_modules/path-to-regexp/dist.es2015/index.js
function lexer(str) {
  var tokens = [];
  var i = 0;
  while (i < str.length) {
    var char = str[i];
    if (char === "*" || char === "+" || char === "?") {
      tokens.push({ type: "MODIFIER", index: i, value: str[i++] });
      continue;
    }
    if (char === "\\") {
      tokens.push({ type: "ESCAPED_CHAR", index: i++, value: str[i++] });
      continue;
    }
    if (char === "{") {
      tokens.push({ type: "OPEN", index: i, value: str[i++] });
      continue;
    }
    if (char === "}") {
      tokens.push({ type: "CLOSE", index: i, value: str[i++] });
      continue;
    }
    if (char === ":") {
      var name = "";
      var j = i + 1;
      while (j < str.length) {
        var code = str.charCodeAt(j);
        if (
          // `0-9`
          code >= 48 && code <= 57 || // `A-Z`
          code >= 65 && code <= 90 || // `a-z`
          code >= 97 && code <= 122 || // `_`
          code === 95
        ) {
          name += str[j++];
          continue;
        }
        break;
      }
      if (!name)
        throw new TypeError("Missing parameter name at ".concat(i));
      tokens.push({ type: "NAME", index: i, value: name });
      i = j;
      continue;
    }
    if (char === "(") {
      var count3 = 1;
      var pattern = "";
      var j = i + 1;
      if (str[j] === "?") {
        throw new TypeError('Pattern cannot start with "?" at '.concat(j));
      }
      while (j < str.length) {
        if (str[j] === "\\") {
          pattern += str[j++] + str[j++];
          continue;
        }
        if (str[j] === ")") {
          count3--;
          if (count3 === 0) {
            j++;
            break;
          }
        } else if (str[j] === "(") {
          count3++;
          if (str[j + 1] !== "?") {
            throw new TypeError("Capturing groups are not allowed at ".concat(j));
          }
        }
        pattern += str[j++];
      }
      if (count3)
        throw new TypeError("Unbalanced pattern at ".concat(i));
      if (!pattern)
        throw new TypeError("Missing pattern at ".concat(i));
      tokens.push({ type: "PATTERN", index: i, value: pattern });
      i = j;
      continue;
    }
    tokens.push({ type: "CHAR", index: i, value: str[i++] });
  }
  tokens.push({ type: "END", index: i, value: "" });
  return tokens;
}
__name(lexer, "lexer");
function parse(str, options) {
  if (options === void 0) {
    options = {};
  }
  var tokens = lexer(str);
  var _a = options.prefixes, prefixes = _a === void 0 ? "./" : _a, _b = options.delimiter, delimiter = _b === void 0 ? "/#?" : _b;
  var result = [];
  var key = 0;
  var i = 0;
  var path = "";
  var tryConsume = /* @__PURE__ */ __name(function(type) {
    if (i < tokens.length && tokens[i].type === type)
      return tokens[i++].value;
  }, "tryConsume");
  var mustConsume = /* @__PURE__ */ __name(function(type) {
    var value2 = tryConsume(type);
    if (value2 !== void 0)
      return value2;
    var _a2 = tokens[i], nextType = _a2.type, index = _a2.index;
    throw new TypeError("Unexpected ".concat(nextType, " at ").concat(index, ", expected ").concat(type));
  }, "mustConsume");
  var consumeText = /* @__PURE__ */ __name(function() {
    var result2 = "";
    var value2;
    while (value2 = tryConsume("CHAR") || tryConsume("ESCAPED_CHAR")) {
      result2 += value2;
    }
    return result2;
  }, "consumeText");
  var isSafe = /* @__PURE__ */ __name(function(value2) {
    for (var _i = 0, delimiter_1 = delimiter; _i < delimiter_1.length; _i++) {
      var char2 = delimiter_1[_i];
      if (value2.indexOf(char2) > -1)
        return true;
    }
    return false;
  }, "isSafe");
  var safePattern = /* @__PURE__ */ __name(function(prefix2) {
    var prev = result[result.length - 1];
    var prevText = prefix2 || (prev && typeof prev === "string" ? prev : "");
    if (prev && !prevText) {
      throw new TypeError('Must have text between two parameters, missing text after "'.concat(prev.name, '"'));
    }
    if (!prevText || isSafe(prevText))
      return "[^".concat(escapeString(delimiter), "]+?");
    return "(?:(?!".concat(escapeString(prevText), ")[^").concat(escapeString(delimiter), "])+?");
  }, "safePattern");
  while (i < tokens.length) {
    var char = tryConsume("CHAR");
    var name = tryConsume("NAME");
    var pattern = tryConsume("PATTERN");
    if (name || pattern) {
      var prefix = char || "";
      if (prefixes.indexOf(prefix) === -1) {
        path += prefix;
        prefix = "";
      }
      if (path) {
        result.push(path);
        path = "";
      }
      result.push({
        name: name || key++,
        prefix,
        suffix: "",
        pattern: pattern || safePattern(prefix),
        modifier: tryConsume("MODIFIER") || ""
      });
      continue;
    }
    var value = char || tryConsume("ESCAPED_CHAR");
    if (value) {
      path += value;
      continue;
    }
    if (path) {
      result.push(path);
      path = "";
    }
    var open = tryConsume("OPEN");
    if (open) {
      var prefix = consumeText();
      var name_1 = tryConsume("NAME") || "";
      var pattern_1 = tryConsume("PATTERN") || "";
      var suffix = consumeText();
      mustConsume("CLOSE");
      result.push({
        name: name_1 || (pattern_1 ? key++ : ""),
        pattern: name_1 && !pattern_1 ? safePattern(prefix) : pattern_1,
        prefix,
        suffix,
        modifier: tryConsume("MODIFIER") || ""
      });
      continue;
    }
    mustConsume("END");
  }
  return result;
}
__name(parse, "parse");
function match(str, options) {
  var keys = [];
  var re = pathToRegexp(str, keys, options);
  return regexpToFunction(re, keys, options);
}
__name(match, "match");
function regexpToFunction(re, keys, options) {
  if (options === void 0) {
    options = {};
  }
  var _a = options.decode, decode = _a === void 0 ? function(x) {
    return x;
  } : _a;
  return function(pathname) {
    var m = re.exec(pathname);
    if (!m)
      return false;
    var path = m[0], index = m.index;
    var params = /* @__PURE__ */ Object.create(null);
    var _loop_1 = /* @__PURE__ */ __name(function(i2) {
      if (m[i2] === void 0)
        return "continue";
      var key = keys[i2 - 1];
      if (key.modifier === "*" || key.modifier === "+") {
        params[key.name] = m[i2].split(key.prefix + key.suffix).map(function(value) {
          return decode(value, key);
        });
      } else {
        params[key.name] = decode(m[i2], key);
      }
    }, "_loop_1");
    for (var i = 1; i < m.length; i++) {
      _loop_1(i);
    }
    return { path, index, params };
  };
}
__name(regexpToFunction, "regexpToFunction");
function escapeString(str) {
  return str.replace(/([.+*?=^!:${}()[\]|/\\])/g, "\\$1");
}
__name(escapeString, "escapeString");
function flags(options) {
  return options && options.sensitive ? "" : "i";
}
__name(flags, "flags");
function regexpToRegexp(path, keys) {
  if (!keys)
    return path;
  var groupsRegex = /\((?:\?<(.*?)>)?(?!\?)/g;
  var index = 0;
  var execResult = groupsRegex.exec(path.source);
  while (execResult) {
    keys.push({
      // Use parenthesized substring match if available, index otherwise
      name: execResult[1] || index++,
      prefix: "",
      suffix: "",
      modifier: "",
      pattern: ""
    });
    execResult = groupsRegex.exec(path.source);
  }
  return path;
}
__name(regexpToRegexp, "regexpToRegexp");
function arrayToRegexp(paths, keys, options) {
  var parts = paths.map(function(path) {
    return pathToRegexp(path, keys, options).source;
  });
  return new RegExp("(?:".concat(parts.join("|"), ")"), flags(options));
}
__name(arrayToRegexp, "arrayToRegexp");
function stringToRegexp(path, keys, options) {
  return tokensToRegexp(parse(path, options), keys, options);
}
__name(stringToRegexp, "stringToRegexp");
function tokensToRegexp(tokens, keys, options) {
  if (options === void 0) {
    options = {};
  }
  var _a = options.strict, strict = _a === void 0 ? false : _a, _b = options.start, start = _b === void 0 ? true : _b, _c = options.end, end = _c === void 0 ? true : _c, _d = options.encode, encode = _d === void 0 ? function(x) {
    return x;
  } : _d, _e = options.delimiter, delimiter = _e === void 0 ? "/#?" : _e, _f = options.endsWith, endsWith = _f === void 0 ? "" : _f;
  var endsWithRe = "[".concat(escapeString(endsWith), "]|$");
  var delimiterRe = "[".concat(escapeString(delimiter), "]");
  var route = start ? "^" : "";
  for (var _i = 0, tokens_1 = tokens; _i < tokens_1.length; _i++) {
    var token = tokens_1[_i];
    if (typeof token === "string") {
      route += escapeString(encode(token));
    } else {
      var prefix = escapeString(encode(token.prefix));
      var suffix = escapeString(encode(token.suffix));
      if (token.pattern) {
        if (keys)
          keys.push(token);
        if (prefix || suffix) {
          if (token.modifier === "+" || token.modifier === "*") {
            var mod = token.modifier === "*" ? "?" : "";
            route += "(?:".concat(prefix, "((?:").concat(token.pattern, ")(?:").concat(suffix).concat(prefix, "(?:").concat(token.pattern, "))*)").concat(suffix, ")").concat(mod);
          } else {
            route += "(?:".concat(prefix, "(").concat(token.pattern, ")").concat(suffix, ")").concat(token.modifier);
          }
        } else {
          if (token.modifier === "+" || token.modifier === "*") {
            throw new TypeError('Can not repeat "'.concat(token.name, '" without a prefix and suffix'));
          }
          route += "(".concat(token.pattern, ")").concat(token.modifier);
        }
      } else {
        route += "(?:".concat(prefix).concat(suffix, ")").concat(token.modifier);
      }
    }
  }
  if (end) {
    if (!strict)
      route += "".concat(delimiterRe, "?");
    route += !options.endsWith ? "$" : "(?=".concat(endsWithRe, ")");
  } else {
    var endToken = tokens[tokens.length - 1];
    var isEndDelimited = typeof endToken === "string" ? delimiterRe.indexOf(endToken[endToken.length - 1]) > -1 : endToken === void 0;
    if (!strict) {
      route += "(?:".concat(delimiterRe, "(?=").concat(endsWithRe, "))?");
    }
    if (!isEndDelimited) {
      route += "(?=".concat(delimiterRe, "|").concat(endsWithRe, ")");
    }
  }
  return new RegExp(route, flags(options));
}
__name(tokensToRegexp, "tokensToRegexp");
function pathToRegexp(path, keys, options) {
  if (path instanceof RegExp)
    return regexpToRegexp(path, keys);
  if (Array.isArray(path))
    return arrayToRegexp(path, keys, options);
  return stringToRegexp(path, keys, options);
}
__name(pathToRegexp, "pathToRegexp");

// ../../.npm/_npx/32026684e21afda6/node_modules/wrangler/templates/pages-template-worker.ts
var escapeRegex = /[.+?^${}()|[\]\\]/g;
function* executeRequest(request) {
  const requestPath = new URL(request.url).pathname;
  for (const route of [...routes].reverse()) {
    if (route.method && route.method !== request.method) {
      continue;
    }
    const routeMatcher = match(route.routePath.replace(escapeRegex, "\\$&"), {
      end: false
    });
    const mountMatcher = match(route.mountPath.replace(escapeRegex, "\\$&"), {
      end: false
    });
    const matchResult = routeMatcher(requestPath);
    const mountMatchResult = mountMatcher(requestPath);
    if (matchResult && mountMatchResult) {
      for (const handler of route.middlewares.flat()) {
        yield {
          handler,
          params: matchResult.params,
          path: mountMatchResult.path
        };
      }
    }
  }
  for (const route of routes) {
    if (route.method && route.method !== request.method) {
      continue;
    }
    const routeMatcher = match(route.routePath.replace(escapeRegex, "\\$&"), {
      end: true
    });
    const mountMatcher = match(route.mountPath.replace(escapeRegex, "\\$&"), {
      end: false
    });
    const matchResult = routeMatcher(requestPath);
    const mountMatchResult = mountMatcher(requestPath);
    if (matchResult && mountMatchResult && route.modules.length) {
      for (const handler of route.modules.flat()) {
        yield {
          handler,
          params: matchResult.params,
          path: matchResult.path
        };
      }
      break;
    }
  }
}
__name(executeRequest, "executeRequest");
var pages_template_worker_default = {
  async fetch(originalRequest, env2, workerContext) {
    let request = originalRequest;
    const handlerIterator = executeRequest(request);
    let data = {};
    let isFailOpen = false;
    const next = /* @__PURE__ */ __name(async (input, init) => {
      if (input !== void 0) {
        let url = input;
        if (typeof input === "string") {
          url = new URL(input, request.url).toString();
        }
        request = new Request(url, init);
      }
      const result = handlerIterator.next();
      if (result.done === false) {
        const { handler, params, path } = result.value;
        const context2 = {
          request: new Request(request.clone()),
          functionPath: path,
          next,
          params,
          get data() {
            return data;
          },
          set data(value) {
            if (typeof value !== "object" || value === null) {
              throw new Error("context.data must be an object");
            }
            data = value;
          },
          env: env2,
          waitUntil: workerContext.waitUntil.bind(workerContext),
          passThroughOnException: /* @__PURE__ */ __name(() => {
            isFailOpen = true;
          }, "passThroughOnException")
        };
        const response = await handler(context2);
        if (!(response instanceof Response)) {
          throw new Error("Your Pages function should return a Response");
        }
        return cloneResponse(response);
      } else if ("ASSETS") {
        const response = await env2["ASSETS"].fetch(request);
        return cloneResponse(response);
      } else {
        const response = await fetch(request);
        return cloneResponse(response);
      }
    }, "next");
    try {
      return await next();
    } catch (error3) {
      if (isFailOpen) {
        const response = await env2["ASSETS"].fetch(request);
        return cloneResponse(response);
      }
      throw error3;
    }
  }
};
var cloneResponse = /* @__PURE__ */ __name((response) => (
  // https://fetch.spec.whatwg.org/#null-body-status
  new Response(
    [101, 204, 205, 304].includes(response.status) ? null : response.body,
    response
  )
), "cloneResponse");
export {
  pages_template_worker_default as default
};
