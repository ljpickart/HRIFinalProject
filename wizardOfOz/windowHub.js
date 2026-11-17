// Participant screen and transparency-window control.
//
// Added alongside the robot/dashboard server in index.js; the original robot
// and dashboard behaviour is unchanged. This module adds:
//   GET /participant          the participant-facing page (participant.html)
//   GET /control              the wizard's control page (control.html)
//   ws  ?role=participant     receives window updates only; may only send a take-over
//   ws  ?role=control         drives the window (the control page, later the trial runner)
// Every event is appended to a CSV file in wizardOfOz/logs/ (or $LOG_DIR).

const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const WebSocket = require('ws');

const PAGES = {
  '/participant': 'participant.html',
  '/control': 'control.html',
};
// Optional picture for the progress bar's robot icon: put robot-icon.png (or .jpg, .jpeg,
// .webp, .svg) in this folder to replace the built-in drawing.
const ROBOT_ICON_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};
const CONDITIONS = ['none', 'basic', 'detailed'];
const STATES = ['THINKING', 'CONVERGING', 'OVERTHINKING'];
const LOG_DIR = process.env.LOG_DIR || path.join(__dirname, 'logs');
const LOG_COLUMNS = [
  'server_time_iso', 'server_time_ms', 'participant_id', 'condition', 'trial_id',
  'event', 'value', 'client_elapsed_ms', 'server_elapsed_ms',
];

const participantClients = new Set();
const controlClients = new Set();

const session = { participantId: '', condition: 'none', trialCount: 0 };
// The current (or last) trial: { seq, id, active, startPerf, state, progress, takeover, endElapsedMs }
let trial = null;
let logPath = null;

function send(socket, message) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

function broadcast(clients, message) {
  for (const socket of clients) {
    send(socket, message);
  }
}

// Milliseconds since the running trial started, on the server's monotonic clock.
function trialElapsedMs() {
  return Math.round(performance.now() - trial.startPerf);
}

function trialView() {
  if (!trial) {
    return null;
  }
  return {
    seq: trial.seq,
    id: trial.id,
    active: trial.active,
    state: trial.state,
    progress: trial.progress,
    elapsedMs: trial.active ? trialElapsedMs() : trial.endElapsedMs,
    takenOver: Boolean(trial.takeover),
  };
}

function robotIconFile() {
  for (const [extension, type] of Object.entries(ROBOT_ICON_TYPES)) {
    const file = path.join(__dirname, `robot-icon${extension}`);
    if (fs.existsSync(file)) {
      return { file, type };
    }
  }
  return null;
}

// What the participant page is allowed to know: no participant ID, no robot chat.
function participantSnapshot() {
  return {
    type: 'snapshot',
    condition: session.condition,
    trial: trialView(),
    robotIcon: robotIconFile() ? '/robot-icon' : null,
  };
}

function controlStatus() {
  return {
    type: 'status',
    participantId: session.participantId,
    condition: session.condition,
    participantsConnected: participantClients.size,
    logFile: logPath,
    trial: trial ? { ...trialView(), takeover: trial.takeover } : null,
  };
}

function publish() {
  broadcast(participantClients, participantSnapshot());
  broadcast(controlClients, controlStatus());
}

function csvCell(value) {
  if (value === undefined || value === null) {
    return '';
  }
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

// Append one row to the CSV log and mirror it to the control pages.
function logEvent(event, { value = '', clientElapsedMs = '', serverElapsedMs } = {}) {
  const now = Date.now();
  if (!logPath) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
    logPath = path.join(LOG_DIR, `events-${stamp}.csv`);
    fs.writeFileSync(logPath, `${LOG_COLUMNS.join(',')}\n`);
  }
  if (serverElapsedMs === undefined) {
    serverElapsedMs = trial && trial.active ? trialElapsedMs() : '';
  }
  // Between trials the trial column stays empty, except on rows that close or refer back to one.
  const trialId = trial && (trial.active || event === 'trial_end' || event === 'takeover_ignored') ? trial.id : '';
  const row = [
    new Date(now).toISOString(), now, session.participantId, session.condition,
    trialId, event, value, clientElapsedMs, serverElapsedMs,
  ];
  fs.appendFileSync(logPath, `${row.map(csvCell).join(',')}\n`);
  broadcast(controlClients, {
    type: 'event',
    time: new Date(now).toISOString(),
    trialId,
    event,
    value,
    clientElapsedMs,
    serverElapsedMs,
  });
}

function endTrial(reason) {
  trial.endElapsedMs = trialElapsedMs();
  trial.active = false;
  logEvent('trial_end', { value: reason, serverElapsedMs: trial.endElapsedMs });
}

function replyError(socket, message) {
  send(socket, { type: 'error', message });
}

function handleControlMessage(socket, raw) {
  let message;
  try {
    message = JSON.parse(raw.toString());
  } catch {
    replyError(socket, 'Invalid JSON');
    return;
  }

  switch (message.cmd) {
    case 'set_participant': {
      // Letters, digits, dash and underscore only: safe for spreadsheets and file names.
      const id = String(message.value ?? '').trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
      session.participantId = id;
      logEvent('participant', { value: id });
      break;
    }
    case 'set_condition':
      if (!CONDITIONS.includes(message.value)) {
        replyError(socket, `Unknown condition: ${message.value}`);
        return;
      }
      session.condition = message.value;
      logEvent('condition', { value: message.value });
      break;
    case 'start_trial': {
      if (trial && trial.active) {
        endTrial('replaced');
      }
      session.trialCount += 1;
      const label = String(message.value ?? '').trim().slice(0, 40);
      trial = {
        seq: session.trialCount,
        id: label || String(session.trialCount),
        active: true,
        startPerf: performance.now(),
        state: 'THINKING',
        progress: 0,
        takeover: null,
        endElapsedMs: null,
      };
      logEvent('trial_start', { value: 'THINKING', serverElapsedMs: 0 });
      break;
    }
    case 'set_state':
      if (!trial || !trial.active) {
        replyError(socket, 'Start a trial first');
        return;
      }
      if (!STATES.includes(message.value)) {
        replyError(socket, `Unknown state: ${message.value}`);
        return;
      }
      trial.state = message.value;
      logEvent('state', { value: message.value });
      break;
    case 'set_progress': {
      if (!trial || !trial.active) {
        replyError(socket, 'Start a trial first');
        return;
      }
      const value = Number(message.value);
      if (!Number.isFinite(value)) {
        replyError(socket, 'Progress must be a number from 0 to 100');
        return;
      }
      trial.progress = Math.max(0, Math.min(100, Math.round(value)));
      // While a slider is being dragged the page sends final: false; only the release is logged.
      if (message.final !== false) {
        logEvent('progress', { value: trial.progress });
      }
      break;
    }
    case 'end_trial':
      if (!trial || !trial.active) {
        replyError(socket, 'No trial is running');
        return;
      }
      endTrial('wizard');
      break;
    default:
      replyError(socket, `Unknown command: ${message.cmd}`);
      return;
  }
  publish();
}

// The participant page may only report a take-over; anything else is ignored.
function handleParticipantMessage(socket, raw) {
  let message;
  try {
    message = JSON.parse(raw.toString());
  } catch {
    return;
  }
  if (!message || message.type !== 'takeover') {
    return;
  }

  const reported = Number(message.clientElapsedMs);
  const clientElapsedMs = Number.isFinite(reported) ? Math.max(0, Math.round(reported)) : '';

  if (!trial || !trial.active || message.trialSeq !== trial.seq) {
    logEvent('takeover_ignored', {
      value: trial && trial.active ? 'different trial' : 'no trial running',
      clientElapsedMs,
    });
    send(socket, participantSnapshot());
    return;
  }
  if (trial.takeover) {
    // A second press of the same trial: already recorded.
    send(socket, participantSnapshot());
    return;
  }

  const serverElapsedMs = trialElapsedMs();
  trial.takeover = { clientElapsedMs, serverElapsedMs, time: new Date().toISOString() };
  logEvent('takeover', { clientElapsedMs, serverElapsedMs });
  const seconds = clientElapsedMs === '' ? '?' : (clientElapsedMs / 1000).toFixed(2);
  console.log(`Participant took over: trial ${trial.id} at ${seconds} s`);
  publish();
}

// Serve the two pages. Returns true when the request was handled here.
function handleHttp(request, response) {
  if (request.method !== 'GET') {
    return false;
  }
  const { pathname } = new URL(request.url, 'http://localhost');
  if (pathname === '/robot-icon') {
    const icon = robotIconFile();
    if (!icon) {
      return false;
    }
    response.setHeader('Content-Type', icon.type);
    response.setHeader('Cache-Control', 'no-store');
    response.end(fs.readFileSync(icon.file));
    return true;
  }
  const file = PAGES[pathname];
  if (!file) {
    return false;
  }
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(fs.readFileSync(path.join(__dirname, file)));
  return true;
}

// Detect dead connections (for example a sleeping laptop) so the
// "participant screen connected" count stays honest.
function watchConnection(socket) {
  socket.isAlive = true;
  socket.on('pong', () => {
    socket.isAlive = true;
  });
}

setInterval(() => {
  for (const socket of [...participantClients, ...controlClients]) {
    if (!socket.isAlive) {
      socket.terminate();
      continue;
    }
    socket.isAlive = false;
    socket.ping();
  }
}, 5000).unref();

// Take over participant and control connections. Returns true when handled here;
// every other connection keeps the original dashboard/robot handling.
function handleConnection(socket, request) {
  const role = new URL(request.url, 'http://localhost').searchParams.get('role');

  if (role === 'participant') {
    participantClients.add(socket);
    watchConnection(socket);
    logEvent('participant_screen_connected', { value: participantClients.size });
    send(socket, participantSnapshot());
    broadcast(controlClients, controlStatus());
    socket.on('message', (raw) => handleParticipantMessage(socket, raw));
    socket.on('close', () => {
      participantClients.delete(socket);
      logEvent('participant_screen_disconnected', { value: participantClients.size });
      broadcast(controlClients, controlStatus());
    });
    return true;
  }

  if (role === 'control') {
    controlClients.add(socket);
    watchConnection(socket);
    send(socket, controlStatus());
    socket.on('message', (raw) => handleControlMessage(socket, raw));
    socket.on('close', () => {
      controlClients.delete(socket);
    });
    return true;
  }

  return false;
}

module.exports = { handleHttp, handleConnection };
