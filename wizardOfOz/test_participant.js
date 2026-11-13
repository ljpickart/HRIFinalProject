// Automated check of the participant page and take-over logging.
// No robot or browser needed. From the repo root, after `npm install`:
//
//   node wizardOfOz/test_participant.js
//
// It starts its own copy of the server on a spare port with a temporary log folder,
// plays the control page, the participant page, Logan's wizard page and a fake robot,
// and prints PASS or FAIL for each check.

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { performance } = require('perf_hooks');
const WebSocket = require('ws');

const PORT = 18000 + Math.floor(Math.random() * 1000);
const LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hri-participant-test-'));
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function httpStatus(urlPath) {
  return new Promise((resolve) => {
    http
      .get({ host: '127.0.0.1', port: PORT, path: urlPath }, (response) => {
        response.resume();
        resolve(response.statusCode);
      })
      .on('error', () => resolve(0));
  });
}

class Client {
  constructor(query) {
    this.query = query;
    this.messages = [];
  }

  open() {
    return new Promise((resolve, reject) => {
      this.socket = new WebSocket(`ws://127.0.0.1:${PORT}/${this.query}`);
      this.socket.on('message', (data) => {
        const text = data.toString();
        let message = text;
        try {
          message = JSON.parse(text);
        } catch {
          // Plain text (what the robot receives).
        }
        this.messages.push({ at: performance.now(), message });
      });
      this.socket.once('open', resolve);
      this.socket.once('error', reject);
    });
  }

  send(message) {
    this.socket.send(typeof message === 'string' ? message : JSON.stringify(message));
  }

  mark() {
    return this.messages.length;
  }

  since(index) {
    return this.messages.slice(index).map((entry) => entry.message);
  }

  async waitFor(predicate, from = 0, timeout = 2000) {
    const deadline = performance.now() + timeout;
    while (performance.now() < deadline) {
      for (let i = from; i < this.messages.length; i += 1) {
        if (predicate(this.messages[i].message)) {
          return this.messages[i];
        }
      }
      await sleep(10);
    }
    return null;
  }

  close() {
    return new Promise((resolve) => {
      this.socket.once('close', resolve);
      this.socket.close();
    });
  }
}

const mentions = (messages, text) => messages.some((message) => JSON.stringify(message).includes(text));

function readLog() {
  const files = fs.readdirSync(LOG_DIR).filter((file) => file.endsWith('.csv'));
  if (files.length !== 1) {
    return { files, rows: [] };
  }
  const lines = fs.readFileSync(path.join(LOG_DIR, files[0]), 'utf8').trim().split(/\r?\n/);
  const header = lines[0].split(',');
  // Values in this test never contain commas, so a plain split is enough here.
  const rows = lines.slice(1).map((line) => {
    const cells = line.split(',');
    return Object.fromEntries(header.map((name, i) => [name, cells[i]]));
  });
  return { files, rows };
}

async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, 'index.js')], {
    env: { ...process.env, PORT: String(PORT), LOG_DIR },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverOutput = '';
  server.stdout.on('data', (chunk) => { serverOutput += chunk; });
  server.stderr.on('data', (chunk) => { serverOutput += chunk; });

  try {
    let up = false;
    for (let attempt = 0; attempt < 100 && !up; attempt += 1) {
      up = (await httpStatus('/participant')) === 200;
      if (!up) {
        await sleep(100);
      }
    }
    check('server starts and serves the participant page', up);
    if (!up) {
      throw new Error(`server did not start:\n${serverOutput}`);
    }
    check("Logan's wizard page is still served at /", (await httpStatus('/')) === 200);
    check('control page is served at /control', (await httpStatus('/control')) === 200);
    check('unknown pages still return 404', (await httpStatus('/nope')) === 404);

    const control = new Client('?role=control');
    let participant = new Client('?role=participant');
    const robot = new Client('');
    const dashboard = new Client('?dashboard=true');
    for (const client of [control, participant, robot, dashboard]) {
      await client.open();
    }
    await sleep(200);

    // 1. Logan's robot chat works exactly as before, and none of it reaches the new pages.
    let p0 = participant.mark();
    let r0 = robot.mark();
    const d0 = dashboard.mark();
    dashboard.send({ text: 'hello robot' });
    check('a typed line still reaches the robot', await robot.waitFor((m) => m === 'hello robot', r0));
    check('a typed line is still echoed on the wizard page',
      await dashboard.waitFor((m) => m.direction === 'sent' && m.text === 'hello robot', d0));
    robot.send('I heard you');
    check('a robot transcript still reaches the wizard page',
      await dashboard.waitFor((m) => m.direction === 'received' && m.text === 'I heard you', d0));
    await sleep(200);
    check('the participant page never receives typed lines or transcripts',
      !mentions(participant.since(p0), 'hello robot') && !mentions(participant.since(p0), 'I heard you'));
    check('the control page never receives the robot chat',
      !mentions(control.since(0), 'hello robot') && !mentions(control.since(0), 'I heard you'));

    // 2. Participant ID and condition.
    p0 = participant.mark();
    control.send({ cmd: 'set_participant', value: 'P99' });
    control.send({ cmd: 'set_condition', value: 'detailed' });
    check('the participant page gets the condition',
      await participant.waitFor((m) => m.type === 'snapshot' && m.condition === 'detailed', p0));
    check('the participant page is never sent the participant ID', !mentions(participant.since(0), 'P99'));
    control.send({ cmd: 'set_condition', value: 'fancy' });
    check('an unknown condition is refused', await control.waitFor((m) => m.type === 'error' && m.message.includes('fancy')));

    // 3. A trial: start, state, progress.
    p0 = participant.mark();
    control.send({ cmd: 'start_trial' });
    const started = await participant.waitFor((m) => m.type === 'snapshot' && m.trial && m.trial.active, p0);
    check('the participant page gets the trial start',
      started && started.message.trial.state === 'THINKING' && started.message.trial.elapsedMs < 200);
    if (!started) {
      throw new Error('trial did not start');
    }
    const seq = started.message.trial.seq;
    const startedAt = started.at;

    p0 = participant.mark();
    control.send({ cmd: 'set_state', value: 'CONVERGING' });
    control.send({ cmd: 'set_progress', value: 55 });
    check('a state change reaches the participant page',
      await participant.waitFor((m) => m.type === 'snapshot' && m.trial && m.trial.state === 'CONVERGING', p0));
    check('a progress change reaches the participant page',
      await participant.waitFor((m) => m.type === 'snapshot' && m.trial && m.trial.progress === 55, p0));

    // 4. The participant page cannot drive anything.
    r0 = robot.mark();
    participant.send({ text: 'spoofed robot line' });
    participant.send({ cmd: 'set_condition', value: 'none' });
    participant.send('not json');
    await sleep(300);
    check('the participant page cannot make the robot speak', robot.since(r0).length === 0);
    const latestStatus = [...control.messages].reverse().find((entry) => entry.message.type === 'status');
    check('the participant page cannot change the condition', latestStatus && latestStatus.message.condition === 'detailed');

    // 5. Take over 1.5 s into the trial.
    await sleep(Math.max(0, 1500 - (performance.now() - startedAt)));
    const clientElapsedMs = Math.round(performance.now() - startedAt);
    const c1 = control.mark();
    p0 = participant.mark();
    participant.send({ type: 'takeover', trialSeq: seq, clientElapsedMs });
    const alert = await control.waitFor((m) => m.type === 'status' && m.trial && m.trial.takeover, c1);
    check('the take-over reaches the control page', alert);
    if (alert) {
      const { takeover } = alert.message.trial;
      check('the screen time is recorded as the page measured it', takeover.clientElapsedMs === clientElapsedMs,
        `${takeover.clientElapsedMs} ms`);
      check('the server clock agrees within 100 ms', Math.abs(takeover.serverElapsedMs - clientElapsedMs) <= 100,
        `server ${takeover.serverElapsedMs} ms, screen ${clientElapsedMs} ms`);
    }
    check('the participant page is told the take-over landed',
      await participant.waitFor((m) => m.type === 'snapshot' && m.trial && m.trial.takenOver, p0));

    participant.send({ type: 'takeover', trialSeq: seq, clientElapsedMs: clientElapsedMs + 300 });
    await sleep(300);

    // 6. A reloaded participant page resumes the running trial.
    await participant.close();
    participant = new Client('?role=participant');
    await participant.open();
    const resumed = await participant.waitFor((m) => m.type === 'snapshot');
    const resumedTrial = resumed && resumed.message.trial;
    check('a reloaded participant page resumes the trial where it was',
      resumedTrial && resumedTrial.seq === seq && resumedTrial.takenOver && resumedTrial.elapsedMs >= 1500,
      resumedTrial ? `${resumedTrial.elapsedMs} ms elapsed` : 'no snapshot');

    // 7. End the trial; a late press is ignored.
    p0 = participant.mark();
    control.send({ cmd: 'end_trial' });
    check('the end of the trial reaches the participant page',
      await participant.waitFor((m) => m.type === 'snapshot' && m.trial && !m.trial.active, p0));
    participant.send({ type: 'takeover', trialSeq: seq, clientElapsedMs: 9999 });
    await sleep(300);

    // 8. A second, labelled trial with no take-over, ended by the next start.
    control.send({ cmd: 'start_trial', value: 'B2' });
    await sleep(400);
    control.send({ cmd: 'start_trial' });
    await sleep(200);
    control.send({ cmd: 'end_trial' });
    await sleep(300);

    // 9. The log file.
    const { files, rows } = readLog();
    check('exactly one log file was written', files.length === 1, files.join(', '));
    const takeovers = rows.filter((row) => row.event === 'takeover');
    check('exactly one take-over row (the double press was ignored)', takeovers.length === 1, `${takeovers.length} rows`);
    if (takeovers[0]) {
      const row = takeovers[0];
      check('the take-over row has participant, condition and trial',
        row.participant_id === 'P99' && row.condition === 'detailed' && row.trial_id === '1');
      check('the take-over row has both elapsed times',
        Number(row.client_elapsed_ms) === clientElapsedMs && row.server_elapsed_ms !== '');
    }
    check('a press after the trial ended is logged as ignored', rows.some((row) => row.event === 'takeover_ignored'));
    check('a labelled trial keeps its label', rows.some((row) => row.event === 'trial_start' && row.trial_id === 'B2'));
    check('starting a new trial ends the old one', rows.some((row) => row.event === 'trial_end' && row.value === 'replaced'));
    for (const event of ['participant', 'condition', 'trial_start', 'state', 'progress', 'trial_end',
      'participant_screen_connected', 'participant_screen_disconnected']) {
      check(`the log has a ${event} row`, rows.some((row) => row.event === event));
    }

    for (const client of [control, participant, robot, dashboard]) {
      await client.close();
    }
  } catch (error) {
    check('the test run finished without errors', false, error.message);
  } finally {
    server.kill();
  }

  const failed = results.filter((result) => !result.ok).length;
  console.log(`\n${results.length - failed} of ${results.length} checks passed. Test log folder: ${LOG_DIR}`);
  process.exit(failed ? 1 : 0);
}

main();
