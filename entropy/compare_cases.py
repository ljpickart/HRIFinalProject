import math
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from openai import OpenAI

client = OpenAI(base_url="http://localhost:11434/v1", api_key="ollama")
WINDOW = 8

CASES = {
    "Easy (should converge)": "What is 17 + 26? Think step by step.",
    "Hard (may not converge)": "Prove or disprove the Collatz conjecture rigorously, with a complete formal proof.",
}

def entropies(prompt):
    resp = client.chat.completions.create(
        model="llama3.2:1b",
        messages=[{"role": "user", "content": prompt}],
        logprobs=True, top_logprobs=10, max_tokens=200,
    )
    out = []
    for tok in resp.choices[0].logprobs.content:
        probs = [math.exp(t.logprob) for t in tok.top_logprobs]
        out.append(-sum(p * math.log2(p) for p in probs if p > 0))
    return out

def roll(ent):
    r = []
    for i in range(len(ent)):
        lo = max(0, i - WINDOW + 1)
        r.append(sum(ent[lo:i+1]) / (i - lo + 1))
    return r

def verdict(ent):
    t = max(1, len(ent)//3)
    early, late = sum(ent[:t])/t, sum(ent[-t:])/t
    CALM, RISE = 0.8, 0.25
    if late < CALM and early < CALM: v = "calm/healthy"
    elif late < 0.6*early:           v = "converging/healthy"
    elif late > early + RISE:        v = "RISING -> overthinking"
    else:                            v = "stable/unclear"
    return early, late, v

fig, axes = plt.subplots(1, 2, figsize=(13, 4), sharey=True)
for ax, (title, prompt) in zip(axes, CASES.items()):
    ent = entropies(prompt)
    e, l, v = verdict(ent)
    print(f"{title}: early={e:.2f} late={l:.2f} -> {v}")
    ax.plot(ent, color="#cccccc", lw=1)
    ax.plot(roll(ent), color="#c0392b", lw=2)
    ax.set_title(f"{title}\n{v}")
    ax.set_xlabel("token position (time ->)")
axes[0].set_ylabel("entropy (uncertainty)")
plt.tight_layout()
plt.savefig("compare_cases.png", dpi=120)
print("\nSaved compare_cases.png")