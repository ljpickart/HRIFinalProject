import math
import matplotlib
matplotlib.use("Agg")  # save to file (no popup needed)
import matplotlib.pyplot as plt
from openai import OpenAI

client = OpenAI(base_url="http://localhost:11434/v1", api_key="ollama")

PROMPT = "What is 17 + 26? Think step by step."
WINDOW = 8   # <-- your "window of observation": how many tokens we average over

resp = client.chat.completions.create(
    model="llama3.2:1b",
    messages=[{"role": "user", "content": PROMPT}],
    logprobs=True, top_logprobs=10, max_tokens=120,
)

ent = []
for tok in resp.choices[0].logprobs.content:
    probs = [math.exp(t.logprob) for t in tok.top_logprobs]
    ent.append(-sum(p * math.log2(p) for p in probs if p > 0))

# rolling average = the smoothed balance trajectory
roll = []
for i in range(len(ent)):
    lo = max(0, i - WINDOW + 1)
    roll.append(sum(ent[lo:i+1]) / (i - lo + 1))

third = max(1, len(ent) // 3)
early = sum(ent[:third]) / third
late = sum(ent[-third:]) / third
overall = sum(ent) / len(ent)
print(f"Early avg: {early:.2f}   Late avg: {late:.2f}   Overall: {overall:.2f}")

CALM = 0.8            # below this, the model is basically confident
RISE = 0.25           # late must exceed early by this much to count as "rising"

if late < CALM and early < CALM:
    print("VERDICT: calm/low uncertainty throughout -> healthy, easy task.")
elif late < 0.6 * early:
    print("VERDICT: converging -> healthy thinking (uncertainty collapsed).")
elif late > early + RISE:
    print("VERDICT: uncertainty clearly rising -> possible overthinking / stuck.")
else:
    print("VERDICT: stable, no clear convergence or divergence.")