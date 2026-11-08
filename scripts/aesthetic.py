"""Dev tool: convert LAION's aesthetic predictor (MIT) for CLIP ViT-B/32 to JSON.

https://github.com/LAION-AI/aesthetic-predictor — sa_0_4_vit_b_32_linear.pth is a
torch state dict for nn.Linear(512, 1) on L2-normalised CLIP image embeddings,
predicting a 1–10 "how much people like this photo" score. Read without torch:
the .pth is a zip; archive/data/0 = weight (512 float32), archive/data/1 = bias.
Usage: python scripts/aesthetic.py path/to/sa_0_4_vit_b_32_linear.pth
"""
import json, os, sys, zipfile
import numpy as np

z = zipfile.ZipFile(sys.argv[1])
pkl = z.read("archive/data.pkl")
assert pkl.index(b"weight") < pkl.index(b"bias"), "unexpected tensor order"
w = np.frombuffer(z.read("archive/data/0"), dtype="<f4")
b = np.frombuffer(z.read("archive/data/1"), dtype="<f4")
assert w.shape == (512,) and b.shape == (1,)
dest = os.path.join(os.path.dirname(__file__), "..", "src", "analysis", "aesthetic.json")
with open(dest, "w") as f:
    json.dump({"source": "LAION-AI/aesthetic-predictor sa_0_4_vit_b_32_linear (MIT)", "w": [round(float(x), 7) for x in w], "b": float(b[0])}, f)
print("wrote", dest)
