import math
from openai import OpenAI

# Ollama's OpenAI-compatible endpoint. api_key is required but ignored.
client = OpenAI(base_url="http://localhost:11434/v1", api_key="ollama")

resp = client.chat.completions.create(
    model="llama3.2:1b",
    messages=[{"role": "user", "content": "What is 17 + 26? Think step by step."}],
    logprobs=True,
    top_logprobs=10,
    max_tokens=80,
)

content = resp.choices[0].logprobs.content if resp.choices[0].logprobs else None

if not content:
    print(">>> NO LOGPROBS. This model/route won't give us entropy. We'll need Azure or the GPU box.")
else:
    print(">>> LOGPROBS WORK! token -> entropy (higher = more uncertain):\n")
    for tok in content:
        probs = [math.exp(t.logprob) for t in tok.top_logprobs]
        H = -sum(p * math.log2(p) for p in probs if p > 0)
        print(f"{tok.token!r:15} entropy={H:.3f}")