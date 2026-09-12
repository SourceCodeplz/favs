/* FAVS agent runtime — local coding agent sandbox.
 *
 * Wasmer + WASIX + shell: @wasmer/sdk v0.11.0 (vendored under vendor/wasmer/,
 * no CDN — see AGENTS.md) runs `wasmer/bash` (the official shell package,
 * same as wasmer.sh uses — bundles Unix tools: ls, grep, find, sed, ...) 100% in-browser.
 * The model gets a single tool, `execute_bash`, implemented here as
 * `sandbox.shell(command).run()` with cwd /workspace.
 *
 * Filesystem: the user picks a real folder (File System Access API). Its text
 * files are snapshotted into the sandbox at start; after every command the
 * sandbox is diffed against the shadow copy and changes are written back to
 * disk. Nothing runs without the user first picking a folder.
 *
 * Protocol with chat.js: this module exposes `window.favsAgent` and emits
 * `favs:agent` CustomEvents on window:
 *   { status: 'starting'|'ready'|'error'|'closed', message, folderName?, fileCount? }
 */

import { Wasmer } from './vendor/wasmer/dist/index.js';

// Official shell package (same as wasmer.sh). It bundles the Unix tools,
// so no separate coreutils package is needed. NOTE: do NOT switch back to
// `sharrattj/bash` — it throws `RuntimeError: function signature mismatch`
// on every shell invocation with current SDK versions (see wasmer-sdk#463).
var PACKAGES = ['wasmer/bash'];
var WORKSPACE = '/workspace';
var AGENT_VERSION = 6; // bump on every agent.js change; shown in console + self-test tag
var CMD_TIMEOUT_MS = 30000;
var MODEL_OUTPUT_CHARS = 8000; // truncation budget per stream for tool results

// Folder snapshot limits (keeps the sandbox + model context sane).
var MAX_FILE_BYTES = 200000; // per text file
var MAX_FILES = 500;
var MAX_TOTAL_BYTES = 4000000;
var SKIP_DIRS = { '.git': true, 'node_modules': true };

var agent = {
  status: 'idle', // idle | starting | ready | error
  message: '',
  folderName: '',
  fileCount: 0,
  wasmer: null,
  sandbox: null,
  dirHandle: null,
  dirHandles: {}, // rel dir path -> FileSystemDirectoryHandle
  fileHandles: {}, // rel file path -> FileSystemFileHandle
  shadow: {} // rel path -> text snapshot of last-synced sandbox content
};

function emit() {
  try {
    window.dispatchEvent(new CustomEvent('favs:agent', {
      detail: {
        status: agent.status,
        message: agent.message,
        folderName: agent.folderName,
        fileCount: agent.fileCount
      }
    }));
  } catch (e) {}
}

function setStatus(status, message) {
  agent.status = status;
  agent.message = message || '';
  emit();
}

function isBinary(buf, len) {
  var n = Math.min(buf.length, len || 8000);
  for (var i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

async function walkLocal(dirHandle, rel, files, handles, stats) {
  var entry;
  try {
    for await (entry of dirHandle.values()) {
      if (stats.files >= MAX_FILES || stats.bytes >= MAX_TOTAL_BYTES) {
        stats.truncated = true;
        break;
      }
      var path = rel ? rel + '/' + entry.name : entry.name;
      if (entry.kind === 'directory') {
        if (SKIP_DIRS[entry.name]) continue;
        handles.dirs[path] = entry;
        await walkLocal(entry, path, files, handles, stats);
      } else if (entry.kind === 'file') {
        var file;
        try {
          file = await entry.getFile();
        } catch (e) {
          stats.skipped++;
          continue;
        }
        if (file.size > MAX_FILE_BYTES) {
          stats.skipped++;
          continue;
        }
        var buf;
        try {
          buf = new Uint8Array(await file.arrayBuffer());
        } catch (e) {
          stats.skipped++;
          continue;
        }
        if (isBinary(buf)) {
          stats.skipped++;
          continue;
        }
        var text = new TextDecoder().decode(buf);
        files[path] = text;
        handles.files[path] = entry;
        stats.files++;
        stats.bytes += buf.length;
      }
    }
  } catch (e) {
    stats.errors++;
  }
}

async function ensureDirHandle(path) {
  if (!path) return agent.dirHandle;
  if (agent.dirHandles[path]) return agent.dirHandles[path];
  var parent = path.indexOf('/') === -1 ? '' : path.slice(0, path.lastIndexOf('/'));
  var parentHandle = await ensureDirHandle(parent);
  var name = path.slice(path.lastIndexOf('/') + 1);
  var handle = await parentHandle.getDirectoryHandle(name, { create: true });
  agent.dirHandles[path] = handle;
  return handle;
}

async function entryIsDir(fs, full, e) {
  // readDir entries are typed { name, kind: 'file'|'directory', size }
  // upstream, but be liberal: older/newer SDKs may use `type`, boolean
  // flags, or bare strings. When in doubt, stat the path.
  if (e && (e.kind === 'directory' || e.kind === 'dir')) return true;
  if (e && (e.kind === 'file')) return false;
  if (e && (e.type === 'directory' || e.type === 'dir' || e.type === 'Dir')) return true;
  if (e && (e.type === 'file' || e.type === 'File')) return false;
  if (e && typeof e.isDirectory === 'boolean' && typeof e.isFile === 'boolean') return !!e.isDirectory;
  if (e && typeof e.isDir === 'boolean') return !!e.isDir;
  if (e && typeof e.is_dir === 'boolean') return !!e.is_dir;
  if (e && e.metadata && (e.metadata.kind === 'directory' || e.metadata.isDir)) return true;
  try {
    var st = await fs.stat(full);
    var k = st && (st.kind || st.type);
    if (k === 'directory' || k === 'dir') return true;
    if (k === 'file') return false;
    if (st && typeof st.isDirectory === 'boolean') return !!st.isDirectory;
    if (st && typeof st.isDir === 'boolean') return !!st.isDir;
  } catch (statErr) {}
  // Last resort: assume a file so at least readText is attempted; if it is
  // really a directory, readText throws and the entry is skipped.
  return false;
}

async function listSandboxFiles(fs, dir, out) {
  var entries = await fs.readDir(dir);
  if (!entries) return;
  // Some runtimes return { entries: [...] } or an async iterable.
  if (!Array.isArray(entries) && Array.isArray(entries.entries)) entries = entries.entries;
  if (!Array.isArray(entries) && typeof entries[Symbol.asyncIterator] === 'function') {
    var collected = [];
    for await (var it of entries) collected.push(it);
    entries = collected;
  }
  if (!Array.isArray(entries)) return;
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    var raw = (typeof e === 'string') ? e : (e && (e.name || e.path)) || '';
    if (!raw) continue;
    // `name` is usually bare, but take the last segment in case an SDK
    // ever returns a full guest path (avoids /workspace//workspace/x).
    var base = raw.indexOf('/') === -1 ? raw : raw.slice(raw.lastIndexOf('/') + 1);
    if (!base || base === '.' || base === '..') continue;
    var full = dir + '/' + base;
    var isDir = await entryIsDir(fs, full, (typeof e === 'object' && e) ? e : null);
    if (isDir) {
      await listSandboxFiles(fs, full, out);
    } else if (full.indexOf(WORKSPACE + '/') === 0) {
      out.push(full.slice(WORKSPACE.length + 1));
    }
  }
}

function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

// Run a shell command directly, WITHOUT triggering a syncBack (used BY the
// sync itself for enumeration/content fallbacks — going through runBash here
// would recurse). Throws on transport failure; check output.ok for exit status.
async function runShellDirect(script) {
  var output = await agent.sandbox
    .shell(script, { cwd: WORKSPACE })
    .run({ check: false, timeoutMs: CMD_TIMEOUT_MS });
  return output;
}

// Enumerate workspace files. The fs API is preferred, but some SDK builds
// reject readDir on the workspace root itself (`entry not found`); the guest
// shell always sees the truth, so fall back to shell enumeration.
// Three tiers: fs -> `find` -> `ls -R` (parsed). Only reports listError when
// every method actually FAILED — empty results mean an empty workspace.
async function listSandboxPaths(fs) {
  var out = [];
  var fsMsg = null;
  try {
    await listSandboxFiles(fs, WORKSPACE, out);
    return { paths: out, listError: null };
  } catch (fsErr) {
    fsMsg = fsErr && fsErr.message ? fsErr.message : String(fsErr);
    try { console.warn('[favs-agent] fs listing failed, trying shell:', fsMsg); } catch (warnErr) {}
  }
  // Tier 2: find. `command -v` guards the pipe so a missing find binary
  // can't masquerade as "no files" (head would exit 0 on empty input).
  try {
    var found = await runShellDirect('command -v find >/dev/null && find /workspace -type f 2>/dev/null | head -' + (MAX_FILES * 2));
    var ftext = '';
    try { ftext = found.stdout ? found.stdout.text() : ''; } catch (textErr) {}
    if (found.ok) {
      var lines = String(ftext).split('\n');
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].replace(/\r$/, '');
        if (!line) continue;
        if (line.indexOf(WORKSPACE + '/') === 0) out.push(line.slice(WORKSPACE.length + 1));
        else if (line.charAt(0) !== '/') out.push(line);
      }
      return { paths: out, listError: null };
    }
  } catch (shellErr) {}
  // Tier 3: parse `ls -R`. Headers end with ':'; -p marks dirs with '/'.
  // (Filenames containing newlines can't round-trip here — accepted edge.)
  try {
    var listed = await runShellDirect('ls -Rp /workspace 2>/dev/null | head -2000');
    var ltext = '';
    try { ltext = listed.stdout ? listed.stdout.text() : ''; } catch (textErr2) {}
    if (!listed.ok) return { paths: [], listError: 'could not list sandbox files: ' + fsMsg };
    var cur = null;
    var llines = String(ltext).split('\n');
    for (var j = 0; j < llines.length; j++) {
      var lline = llines[j].replace(/\r$/, '');
      if (!lline || lline.indexOf('total ') === 0) continue;
      if (lline.charAt(lline.length - 1) === ':' && lline.indexOf(WORKSPACE) === 0) {
        var h = lline.slice(0, -1);
        cur = h === WORKSPACE ? '' : (h.indexOf(WORKSPACE + '/') === 0 ? h.slice(WORKSPACE.length + 1) : null);
        continue;
      }
      if (cur === null) continue;
      if (lline.charAt(lline.length - 1) === '/') continue; // dir; contents have their own header
      out.push(cur ? cur + '/' + lline : lline);
    }
    return { paths: out, listError: null };
  } catch (lsErr) {
    return { paths: [], listError: 'could not list sandbox files: ' + fsMsg };
  }
}

// Read one workspace file as text. fs first; the guest shell (`cat`) covers
// the same SDK builds where the fs API misbehaves. Returns null for binary.
async function readSandboxText(fs, rel) {
  var guest = WORKSPACE + '/' + rel;
  try {
    return await fs.readText(guest);
  } catch (fsErr) {
    var output = await runShellDirect('cat ' + shellQuote(guest));
    if (!output.ok) {
      throw new Error('could not read sandbox file "' + rel + '"');
    }
    var bytes = output.stdout ? output.stdout.bytes : null;
    if (bytes && bytes.length > MAX_FILE_BYTES) {
      throw new Error('skipped "' + rel + '" (exceeds the per-file cap)');
    }
    if (bytes && isBinary(bytes)) return null;
    var text = '';
    try { text = output.stdout ? output.stdout.text() : ''; } catch (textErr) {}
    return text;
  }
}
// Diff the sandbox against the shadow copy; write new/changed text files
// back to the user-picked folder. Returns { written: [paths], errors: n,
// notes: [strings] } — notes carry the first few failure reasons so the UI
// can show *why* nothing landed on disk instead of failing silently.
// An empty workspace with an empty shadow is the normal idle state, not an
// error — it syncs quietly.
async function syncBack() {
  var result = { written: [], errors: 0, notes: [] };
  function note(msg) {
    result.errors++;
    if (result.notes.length < 5) result.notes.push(String(msg).slice(0, 300));
    try { console.warn('[favs-agent] sync:', msg); } catch (warnErr) {}
  }
  if (!agent.sandbox || !agent.dirHandle) return result;
  // The File System Access write grant can lapse (e.g. after dismissal);
  // re-assert it so a silent NotAllowedError doesn't eat the user's files.
  try {
    if (agent.dirHandle.queryPermission) {
      var perm = await agent.dirHandle.queryPermission({ mode: 'readwrite' });
      if (perm !== 'granted' && agent.dirHandle.requestPermission) {
        perm = await agent.dirHandle.requestPermission({ mode: 'readwrite' });
      }
      if (perm !== 'granted') {
        note('browser denied write access to "' + agent.folderName + '" — re-pick the folder and allow writing');
        return result;
      }
    }
  } catch (e) {}
  var fs = agent.sandbox.fs;
  var listed = await listSandboxPaths(fs);
  if (listed.listError) {
    // Only alarm when there was something to lose; a failed listing over an
    // empty shadow just means "nothing to sync".
    if (Object.keys(agent.shadow).length) {
      note(listed.listError);
    } else {
      try { console.log('[favs-agent] sync: workspace not listable, shadow empty — nothing to do'); } catch (logErr) {}
    }
    return result;
  }
  var paths = listed.paths;
  // Guard: never sync absurd trees back (runaway `tar xzf`, build output...).
  if (paths.length > MAX_FILES * 2) {
    note('too many files (' + paths.length + ') — refusing to sync; narrow the command');
    return result;
  }
  if (!paths.length && !Object.keys(agent.shadow).length) return result; // idle, quiet
  for (var i = 0; i < paths.length; i++) {
    var rel = paths[i];
    var text;
    try {
      text = await readSandboxText(fs, rel);
    } catch (e) {
      note(e && e.message ? e.message : String(e));
      continue;
    }
    if (text === null) continue; // binary — skip quietly (walkLocal skips them too)
    if (agent.shadow[rel] === text) continue;
    if (text.length > MAX_FILE_BYTES) {
      note('skipped "' + rel + '" (' + text.length + ' chars exceeds the ' + MAX_FILE_BYTES + ' per-file cap)');
      continue;
    }
    try {
      var slash = rel.lastIndexOf('/');
      var dirHandle = await ensureDirHandle(slash === -1 ? '' : rel.slice(0, slash));
      var name = slash === -1 ? rel : rel.slice(slash + 1);
      var fileHandle = await dirHandle.getFileHandle(name, { create: true });
      var writable = await fileHandle.createWritable();
      try {
        // Truncate-then-write so a shorter rewrite never leaves a stale tail.
        await writable.write({ type: 'truncate', size: 0 });
      } catch (truncateErr) {}
      await writable.write(new Blob([text], { type: 'text/plain' }));
      await writable.close();
      agent.fileHandles[rel] = fileHandle;
      agent.shadow[rel] = text;
      result.written.push(rel);
    } catch (e) {
      note('could not write "' + rel + '" to disk: ' + (e && e.name === 'NotAllowedError' ? 'browser blocked writing — re-pick the folder and allow access' : (e && e.message ? e.message : String(e))));
    }
  }
  return result;
}

function truncate(s, n) {
  s = String(s == null ? '' : s);
  if (s.length <= n) return s;
  return s.slice(0, n) + '\n…[truncated ' + (s.length - n) + ' chars]';
}

async function runBash(command) {
  if (agent.status !== 'ready' || !agent.sandbox) {
    throw new Error('agent sandbox is not ready — pick a folder first');
  }
  var cmd = String(command == null ? '' : command);
  if (!cmd.trim()) throw new Error('empty command');
  var output;
  try {
    output = await agent.sandbox
      .shell(cmd, { cwd: WORKSPACE })
      .run({ check: false, timeoutMs: CMD_TIMEOUT_MS });
  } catch (err) {
    throw new Error('bash failed to run: ' + (err && err.message ? err.message : String(err)));
  }
  var stdout = '';
  var stderr = '';
  try { stdout = output.stdout ? output.stdout.text() : ''; } catch (e) {}
  try { stderr = output.stderr ? output.stderr.text() : ''; } catch (e) {}
  var sync = await syncBack();
  return {
    exitCode: output.exitCode,
    ok: !!output.ok,
    stdout: truncate(stdout, MODEL_OUTPUT_CHARS),
    stderr: truncate(stderr, MODEL_OUTPUT_CHARS),
    written: sync.written.slice(0, 50),
    syncErrors: sync.errors,
    syncNotes: sync.notes.slice(0, 5)
  };
}

async function pickFolder() {
  if (agent.status === 'starting') return;
  if (typeof window.showDirectoryPicker !== 'function') {
    setStatus('error', 'This browser cannot open folders (File System Access API missing) — use Chrome or Edge on desktop.');
    return;
  }
  var dirHandle;
  try {
    dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
  } catch (e) {
    // User cancelled the picker — stay silent.
    if (e && (e.name === 'AbortError' || e.name === 'NotAllowedError')) return;
    setStatus('error', 'Could not open folder: ' + (e && e.message ? e.message : String(e)));
    return;
  }
  await closeSandbox();
  setStatus('starting', 'Reading "' + (dirHandle.name || 'folder') + '"…');
  agent.dirHandle = dirHandle;
  agent.dirHandles = {};
  agent.fileHandles = {};
  agent.shadow = {};
  agent.folderName = dirHandle.name || 'folder';

  var files = {};
  var handles = { dirs: {}, files: {} };
  var stats = { files: 0, bytes: 0, skipped: 0, errors: 0, truncated: false };
  try {
    await walkLocal(dirHandle, '', files, handles, stats);
  } catch (e) {
    setStatus('error', 'Could not read folder: ' + (e && e.message ? e.message : String(e)));
    return;
  }
  agent.dirHandles = handles.dirs;
  agent.fileHandles = handles.files;
  agent.fileCount = stats.files;
  var note = stats.truncated ? ' (capped at ' + MAX_FILES + ' files / 4MB — rest skipped)' : '';
  var skipped = stats.skipped ? ' ' + stats.skipped + ' binary/large file(s) skipped.' : '';

  setStatus('starting', 'Starting sandbox — downloading shell packages on first run (one-time, ~10MB)…');
  var shellRef = null;
  try {
    agent.wasmer = new Wasmer();
    try {
      await agent.wasmer.ready();
    } catch (initErr) {
      throw new Error('runtime init failed: ' + (initErr && initErr.message ? initErr.message : String(initErr)));
    }
    // Resolve the real shell command instead of guessing its name.
    var bashPkg;
    try {
      bashPkg = await agent.wasmer.packages.load('wasmer/bash');
    } catch (e) {
      throw new Error('could not download wasmer/bash from the Wasmer registry (network?): ' + (e && e.message ? e.message : String(e)));
    }
    var shellName = (bashPkg && bashPkg.entrypoint) || (bashPkg && bashPkg.commands && bashPkg.commands[0]);
    if (!shellName) throw new Error('wasmer/bash exports no commands');
    try {
      shellRef = bashPkg.command(shellName);
    } catch (e) {
      shellRef = shellName;
    }
    agent.sandbox = await agent.wasmer.sandboxes.create({
      packages: PACKAGES,
      shell: shellRef,
      files: files
    });
  } catch (e) {
    agent.wasmer = null;
    agent.sandbox = null;
    setStatus('error', 'Sandbox failed to start: ' + (e && e.message ? e.message : String(e)));
    try { console.warn('[favs-agent] sandbox start failed:', e); } catch (warnErr) {}
    return;
  }
  // Snapshot what the sandbox actually holds (normalizes encoding).
  agent.shadow = {};
  var keys = Object.keys(files);
  for (var i = 0; i < keys.length; i++) agent.shadow[keys[i]] = files[keys[i]];
  try { console.log('[favs-agent] v' + AGENT_VERSION + ' sandbox ready, shell resolved, ' + stats.files + ' files'); } catch (logErr) {}
  setStatus('ready', 'Agent ready — "' + agent.folderName + '" (' + stats.files + ' files)' + note + '.' + skipped + ' Ask me to explore or edit the code.');
}

async function closeSandbox() {
  if (agent.sandbox) {
    try { await agent.sandbox.close(); } catch (e) {}
  }
  if (agent.wasmer) {
    try { await agent.wasmer.close(); } catch (e) {}
  }
  agent.wasmer = null;
  agent.sandbox = null;
}

async function closeFolder() {
  await closeSandbox();
  agent.dirHandle = null;
  agent.dirHandles = {};
  agent.fileHandles = {};
  agent.shadow = {};
  agent.folderName = '';
  agent.fileCount = 0;
  setStatus('closed', '');
}

function isReady() {
  return agent.status === 'ready' && !!agent.sandbox;
}

function getState() {
  return {
    status: agent.status,
    message: agent.message,
    folderName: agent.folderName,
    fileCount: agent.fileCount,
    version: AGENT_VERSION
  };
}

function getVersion() {
  return AGENT_VERSION;
}

window.favsAgent = {
  getState: getState,
  getVersion: getVersion,
  isReady: isReady,
  pickFolder: pickFolder,
  closeFolder: closeFolder,
  runBash: runBash
};

try { console.log('[favs-agent] loaded v' + AGENT_VERSION); } catch (loadErr) {}
