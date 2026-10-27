import math, re, time
from openai import OpenAI

client = OpenAI(base_url="http://localhost:11434/v1", api_key="ollama")
MODEL = "deepseek-r1:1.5b"     # a reasoning model; falls back fine to llama3.2:1b
PROBE_EVERY = 40               # tokens between peeks ("k" in the paper)
MAX_TOKENS = 400

PROMPT = "A bat and a ball cost $1.10 total. The bat costs $1 more than the ball. How much is the ball? Think step by step."

def answer_entropy(reasoning_so_far):
    """Peek: force the model out of <think> and read its current answer."""
    # strip any partial think text, then prefill a closed think tag
    seed = reasoning_so_far + "\n</think>\nThe final answer is:"
    r = client.chat.completions.create(
        model=MODEL,
        messages=[
            {"role": "user", "content": PROMPT},
            {"role": "assistant", "content": seed},
        ],
        logprobs=True, top_logprobs=10, max_tokens=12, temperature=0.0,
    )
    toks = r.choices[0].logprobs.content or []
    ans = "".join(t.token for t in toks).strip()
    Hs = []
    for t in toks:
        ps = [math.exp(x.logprob) for x in t.top_logprobs]
        Hs.append(-sum(p*math.log2(p) for p in ps if p > 0))
    H = sum(Hs)/len(Hs) if Hs else 0.0
    return ans, H
# stream the main reasoning, peeking every PROBE_EVERY tokens
print(f"Model: {MODEL}\nPrompt: {PROMPT}\n")
stream = client.chat.completions.create(
    model=MODEL,
    messages=[{"role": "user", "content": PROMPT}],
    stream=True, max_tokens=MAX_TOKENS, temperature=0.7,
)

buf, n, peeks = "", 0, []
for chunk in stream:
    piece = chunk.choices[0].delta.content or ""
    buf += piece; n += len(piece.split())
    if n >= PROBE_EVERY:
        n = 0
        ans, H = answer_entropy(buf)
        peeks.append((ans, H))
        print(f"[peek {len(peeks)}] answer='{ans[:30]}'  answer-entropy={H:.2f}")

print("\n--- reading the trajectory ---")
if len(peeks) >= 2:
    answers = [a for a, _ in peeks]
    Hs = [h for _, h in peeks]
    last = answers[-1]
    stable_count = sum(1 for a in answers[-3:] if a == last)
    if stable_count >= 2 and last != "":
        print(f"VERDICT: answer locked in ('{last[:30]}') across peeks -> CONVERGED")
        print("         (NOTE: converged = committed, NOT necessarily correct)")
    elif len(set(answers)) == len(answers):
        print("VERDICT: answer changes every peek -> still exploring / possible overthinking")
    else:
        print("VERDICT: partially settling -> still working")