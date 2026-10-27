# Entropy-based thinking detector

**Author:** Marjan Beheshti, CS5761 Human-Robot Interaction

This folder decides whether the robot's LLM is **thinking** (making progress toward an answer) or **overthinking / stuck** (going nowhere). It does this by watching the model's own uncertainty, measured as **token entropy**, as it generates text.

**Main idea:** the *shape* of the entropy curve over time matters more than its level.

- **Healthy:** entropy rises while the model explores, then falls as it settles on an answer.
- **Overthinking:** entropy stays high or keeps rising, and never settles.

This follows recent work on the entropy dynamics of chain-of-thought reasoning:

- Xu et al., *Unveiling the Entropy Dynamics of Chain-of-Thought Reasoning* (ICML 2026)
- Bin/Jiang et al., *Explore Briefly, Then Decide* (TECA, 2026)

---

## Files

| File | What it does | Model |
|---|---|---|
| `entropy_test.py` | Feasibility check that Ollama returns per-token probabilities, so entropy can be computed. Prints the entropy of each token. Not needed by the other scripts. | `llama3.2:1b` |
| `entropy_trajectory.py` | **The main detector.** Runs one prompt, smooths the per-token entropy with a rolling window of 8 tokens, prints a verdict, and saves `entropy_trajectory.png`. | `llama3.2:1b` |
| `compare_cases.py` | **Key result.** Runs an easy prompt (17 + 26) and a hard one (the Collatz conjecture) side by side and saves `compare_cases.png`. Shows that the two cases produce different curve shapes. | `llama3.2:1b` |
| `build_trial_bank.py` | Runs a fixed list of labelled test prompts (3 runs each, averaged) and checks whether the detector labels each one correctly. Saves each trial's result to `trials/<name>.json`. | `llama3.2:1b` |
| `answer_probe.py` | The "peek" detector from the two papers. While a reasoning model thinks, it repeatedly asks "what is your answer so far?" and checks whether the answer has stopped changing. | `deepseek-r1:1.5b` |
| `entropy_trajectory.png` | Plot from `entropy_trajectory.py` | |
| `compare_cases.png` | Plot from `compare_cases.py` | |

Each script runs on its own. None of them imports another.

---

## Setup

All of this runs locally on a laptop: no API key and no GPU needed.

1. Install Ollama from https://ollama.com/download, then download the two models:
   ```
   ollama pull llama3.2:1b
   ollama pull deepseek-r1:1.5b
   ```
2. Create the Python environment:
   ```
   conda create -n HRI python=3.12 -y
   conda activate HRI
   pip install ollama openai matplotlib
   ```
3. Run the scripts from **inside this folder**:
   ```
   python entropy_trajectory.py
   python compare_cases.py
   python build_trial_bank.py
   python answer_probe.py
   ```

The scripts talk to Ollama through its OpenAI-compatible endpoint (`http://localhost:11434/v1`), because plain `ollama.chat()` does not return token probabilities.

---

## How the verdict works

The entropy curve is split into thirds, and the first third (**early**) is compared with the last third (**late**):

| Condition | Verdict |
|---|---|
| Late entropy is low (below 0.6) | **Healthy:** converged or calm |
| Overall entropy is high (above 0.9) and late is still high | **Overthinking:** stayed high |
| Late is clearly higher than early (by more than 0.25) | **Overthinking:** rising |
| None of the above | **Unclear:** the honest middle zone |

The thresholds were calibrated on the labelled prompts in `build_trial_bank.py`.

---

## The test prompts (`build_trial_bank.py`)

The prompts are in the `TRIALS` list at the top of the file. Each entry has three parts: name, prompt, temperature.

| Trial | Purpose | Usual result |
|---|---|---|
| `healthy_add` | "What is 17 + 26?" An easy task with a clear answer | Healthy ✓ |
| `healthy_capital` | "What is the capital of France?" | Healthy ✓ |
| `healthy_sort` | Sort 5, 2, 9, 1 | Healthy ✓ |
| `over_collatz` | Prove the Collatz conjecture, an unsolved problem | Unclear (middle zone) |
| `over_evenodd` | Find a number that is both even and odd, an impossible request | Unclear (middle zone) |
| `over_nocommit` | "Never commit to an answer," at temperature 1.3 | Overthinking ✓ |

**Finding:** healthy prompts score about 0.0–0.5 and the forced overthinking prompt about 1.4, with an ambiguous band around 0.7–0.8. Collatz and even-odd fall in that band on this small model. That makes them good illustrations, but they are too ambiguous to use as experiment trials. This is why the window has **three states**:

- **Low entropy:** thinking, so wait.
- **High entropy:** overthinking, so consider taking over.
- **Middle:** genuinely uncertain.

**To add a test,** add a line in the same format, for example:
```python
("over_paradox", "Is 'this statement is false' true? Never settle on an answer.", 1.3),
```
Names that start with `healthy_` are expected to converge, and anything else is expected to overthink.

---

## Answer probe (`answer_probe.py`)

Every few tokens, the script interrupts a copy of the reasoning and forces the model to state its current answer. It does this by adding `</think> The final answer is:` after the reasoning so far, because reasoning models only give an answer after closing their `<think>` block. If the answer stays the same across peeks, the verdict is **CONVERGED**.

**Important:** converged does not mean correct. On the bat-and-ball question, the model locks onto **$0.10**, the classic wrong answer (the correct answer is $0.05). The detector measures whether the model has **committed** to an answer, not whether that answer is **right**. The window shows the dynamics, and the human supervisor judges the content.

---

## Limits

- The detector observes behaviour, not thoughts. LLMs are not interpretable.
- `llama3.2:1b` is small and noisy, and results vary from run to run. That's why `build_trial_bank.py` averages 3 runs.
- For the experiment, which trials are "thinking" and which are "stuck" is scripted (Wizard-of-Oz), using prompts that are confirmed to behave as labelled.

## Next steps

- Show the state live in the window as THINKING / CONVERGING / OVERTHINKING, with elapsed time (Logan).
- Turn the confirmed prompts into controlled experiment trials (Vincent).
- Connect to Reachy Mini (last).
