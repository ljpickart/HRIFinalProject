import math, os, json
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from openai import OpenAI

client = OpenAI(base_url="http://localhost:11434/v1", api_key="ollama")
WINDOW = 8
os.makedirs("trials", exist_ok=True)

# label, prompt, temperature
TRIALS = [
    ("healthy_add",      "What is 17 + 26? Think step by step.", 0.7),
    ("healthy_capital",  "What is the capital of France? Explain briefly.", 0.7),
    ("healthy_sort",     "Put these in order: 5, 2, 9, 1. Show your steps.", 0.7),
    ("over_collatz",     "Prove or disprove the Collatz conjecture with a complete formal proof.", 0.7),
    ("over_evenodd",     "Find an even number that is also odd, and rigorously prove it exists.", 0.7),
    ("over_nocommit",    "Consider many possibilities for the meaning of life. Do not commit to any answer. Keep questioning each idea forever.", 1.3),
]

def run(prompt, temp):
    resp = client.chat.completions.create(
        model="llama3.2:1b",
        messages=[{"role": "user", "content": prompt}],
        logprobs=True, top_logprobs=10, max_tokens=200, temperature=temp,
    )
    ent = []
    for tok in resp.choices[0].logprobs.content:
        probs = [math.exp(t.logprob) for t in tok.top_logprobs]
        ent.append(-sum(p * math.log2(p) for p in probs if p > 0))
    return ent

def roll(ent):
    r=[]
    for i in range(len(ent)):
        lo=max(0,i-WINDOW+1); r.append(sum(ent[lo:i+1])/(i-lo+1))
    return r
def verdict(ent):
    t = max(1, len(ent)//3)
    early = sum(ent[:t])/t
    late  = sum(ent[-t:])/t
    overall = sum(ent)/len(ent)
    HIGH = 0.9   # a trajectory sitting above this never really converged
    CALM = 0.6   # below this it's settled
    if late < CALM:
        v = "healthy (converged/calm)"
    elif overall > HIGH and late > CALM:
        v = "OVERTHINKING (stayed high)"
    elif late > early + 0.25:
        v = "OVERTHINKING (rising)"
    else:
        v = "unclear"
    return early, late, v
REPEATS = 3  # run each prompt several times, average out randomness

print(f"{'trial':16} {'label':12} {'early':>6} {'late':>6} {'over':>6}  verdict")
for name, prompt, temp in TRIALS:
    expected = "healthy" if name.startswith("healthy") else "overthinking"
    es, ls, os_ = [], [], []
    last_ent = None
    for _ in range(REPEATS):
        ent = run(prompt, temp)
        last_ent = ent
        t = max(1, len(ent)//3)
        es.append(sum(ent[:t])/t); ls.append(sum(ent[-t:])/t); os_.append(sum(ent)/len(ent))
    early = sum(es)/REPEATS; late = sum(ls)/REPEATS; overall = sum(os_)/REPEATS
    HIGH, CALM = 0.9, 0.6
    if late < CALM:                         v = "healthy (converged/calm)"
    elif overall > HIGH and late > CALM:    v = "OVERTHINKING (stayed high)"
    elif late > early + 0.25:               v = "OVERTHINKING (rising)"
    else:                                   v = "unclear"
    ok = "OK" if expected.split()[0] in v.lower() else "<-- MISMATCH"
    print(f"{name:16} {expected:12} {early:6.2f} {late:6.2f} {overall:6.2f}  {v}  {ok}")
    json.dump({"prompt":prompt,"expected":expected,"entropy":last_ent,"verdict":v},
              open(f"trials/{name}.json","w"))