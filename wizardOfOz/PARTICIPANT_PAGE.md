# Participant page and take-over logging

Adds a participant-facing page and a wizard control page to the Wizard-of-Oz server.
The original wizard page (`/`) and the robot connection work exactly as before.

## Run it

1. From the repo root, the first time: `npm install`
2. `node wizardOfOz/index.js`
3. Open two browser windows:
   - `http://localhost:8080/control` for the wizard (keep it out of the participant's sight)
   - `http://localhost:8080/participant` for the participant (press F11 for full screen)

   From another computer on the same network, use this computer's IP address instead of `localhost`.

## Control page

- Participant ID and condition:
  - **none**: Take over button only
  - **basic**: robot state and elapsed time
  - **detailed**: state, time and a progress bar with an "answers here" mark, and a small
    robot icon riding the bar's leading edge. To show a picture of your own robot instead, save it as
    `wizardOfOz/robot-icon.png` (or `.jpg`, `.jpeg`, `.webp`, `.svg`) and restart the server.
- Start thinking (`S`), state buttons (`1` `2` `3`), progress slider, End trial (`E`).
- When the participant presses Take over, a red banner shows the time. Make the robot react from the original wizard page.

## What the participant page can see and do

It receives only the window: condition, state, progress and the trial's start.
It never receives typed robot lines, robot transcripts or the participant ID.
The only thing it can send is a take-over, and only one per trial.

## Log

Each server run writes `wizardOfOz/logs/events-<time>.csv`. That folder is in `.gitignore`, so participant data stays off GitHub.

| Column | Meaning |
|---|---|
| `server_time_iso`, `server_time_ms` | when the server recorded the event |
| `participant_id`, `condition`, `trial_id` | context (trial is blank between trials) |
| `event` | `participant`, `condition`, `trial_start`, `state`, `progress`, `takeover`, `takeover_ignored`, `trial_end`, `participant_screen_connected`, `participant_screen_disconnected` |
| `value` | the new condition, state, progress, or the reason a trial ended |
| `client_elapsed_ms` | take-over time measured in the participant's browser, from the trial appearing to the press (no network delay) |
| `server_elapsed_ms` | time since the trial started on the server's clock (cross-check) |

## Test

`node wizardOfOz/test_participant.js` starts its own server on a spare port with a temporary log folder and runs 38 checks. No robot or browser needed.

## For the trial script (later)

Connect to `ws://<host>:8080/?role=control` and send JSON commands:

```json
{"cmd": "set_participant", "value": "P01"}
{"cmd": "set_condition", "value": "detailed"}
{"cmd": "start_trial", "value": "A3"}
{"cmd": "set_state", "value": "CONVERGING"}
{"cmd": "set_progress", "value": 62}
{"cmd": "end_trial"}
```

The trial label in `start_trial` is optional; without one, trials are numbered.
