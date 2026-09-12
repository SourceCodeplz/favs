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

async function listSandboxFiles(fs, dir, out) {
  var entries = await fs.readDir(dir);
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i];
    var full = dir === '/' ? '/' + e.name : dir + '/' + e.name;
    if (e.kind === 'directory') {
      await listSandboxFiles(fs, full, out);
    } else if (e.kind === 'file' && full.indexOf(WORKSPACE + '/') === 0) {
      out.push(full.slice(WORKSPACE.length + 1));
    }
  }
}

// Diff the sandbox against the shadow copy; write new/changed text files
// back to the user-picked folder. Returns { written: [paths], errors: n }.
async function syncBack() {
  var result = { written: [], errors: 0 };
  if (!agent.sandbox || !agent.dirHandle) return result;
  var fs = agent.sandbox.fs;
  var paths = [];
  try {
    await listSandboxFiles(fs, WORKSPACE, paths);
  } catch (e) {
    result.errors++;
    return result;
  }
  // Guard: never sync absurd trees back (runaway `tar xzf`, build output...).
  if (paths.length > MAX_FILES * 2) {
    result.errors++;
    return result;
  }
  for (var i = 0; i < paths.length; i++) {
    var rel = paths[i];
    var text;
    try {
      text = await fs.readText(WORKSPACE + '/' + rel);
    } catch (e) {
      result.errors++;
      continue;
    }
    if (agent.shadow[rel] === text) continue;
    if (text.length > MAX_FILE_BYTES) {
      result.errors++;
      continue;
    }
    try {
      var slash = rel.lastIndexOf('/');
      var dirHandle = await ensureDirHandle(slash === -1 ? '' : rel.slice(0, slash));
      var name = slash === -1 ? rel : rel.slice(slash + 1);
      var fileHandle = await dirHandle.getFileHandle(name, { create: true });
      var writable = await fileHandle.createWritable();
      await writable.write(text);
      await writable.close();
      agent.fileHandles[rel] = fileHandle;
      agent.shadow[rel] = text;
      result.written.push(rel);
    } catch (e) {
      result.errors++;
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
    syncErrors: sync.errors
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
  try { console.log('[favs-agent] sandbox ready, shell resolved, ' + stats.files + ' files'); } catch (logErr) {}
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
    fileCount: agent.fileCount
  };
}

window.favsAgent = {
  getState: getState,
  isReady: isReady,
  pickFolder: pickFolder,
  closeFolder: closeFolder,
  runBash: runBash
};
