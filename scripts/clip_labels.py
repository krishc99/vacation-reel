"""Dev tool: precompute CLIP text embeddings for scene labels (Milestone 4b).

The app only ever runs CLIP's image encoder; the label side is fixed, so its
embeddings are computed once here and committed as src/analysis/sceneLabels.json.

Needs: pip install onnxruntime tokenizers numpy
       Xenova/clip-vit-base-patch32 (MIT): tokenizer.json + onnx/text_model_quantized.onnx in CLIP_DIR.
Usage: python scripts/clip_labels.py CLIP_DIR
"""
import json, sys, os
import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

# Several phrasings per class, averaged ("prompt ensembling"): more robust than one prompt.
CLASSES = {
    "people": ["a photo of friends together", "a group photo of people", "a selfie", "a portrait photo of a person", "a photo of a man", "a photo of a woman", "people smiling at the camera"],
    "food": ["a photo of food", "a photo of a meal on a plate", "a photo of a dish at a restaurant", "a photo of dessert", "a photo of a drink or cocktail", "a photo of coffee"],
    "scenery": ["a landscape photo", "a photo of nature", "a photo of mountains", "a photo of the sea", "a photo of a beach", "a photo of a lake", "a photo of the desert", "a photo of a field of grass", "a photo of trees in a forest"],
    "sunset": ["a photo of a sunset", "a photo of a sunrise", "a golden hour sky over the horizon"],
    "city": ["a photo of a city street", "a photo of buildings", "a city skyline"],
    "landmark": ["a photo of a famous landmark", "a photo of a monument", "a photo of a tourist attraction", "a photo of a famous tower"],
    "nightlife": ["a photo of a party", "a photo taken in a nightclub", "a photo of a concert", "people dancing at night"],
    "activity": ["a photo of people swimming", "a photo of a boat on the water", "a photo of a hike", "a photo of water sports", "a photo of a theme park"],
    "travel": ["a photo of an airplane", "a view from an airplane window", "a photo of an airport", "a photo inside a car"],
    "vehicle": ["a photo of a motorcycle", "a photo of a car", "a photo of a bus", "a photo of a bicycle"],
    "room": ["a photo of a hotel room", "a photo of a bedroom", "a photo of a hotel lobby"],
    "animal": ["a photo of an animal", "a photo of a pet", "a photo of a camel", "a photo of a bird"],
    "junk": ["a screenshot of a phone screen", "a screenshot of a chat conversation", "a screenshot of text messages", "a photo of a document", "a photo of a receipt", "a photo of a ticket or boarding pass", "a photo of a menu", "a QR code", "a page of printed text"],
}

def main(clip_dir: str):
    tok = Tokenizer.from_file(os.path.join(clip_dir, "tokenizer.json"))
    sess = ort.InferenceSession(os.path.join(clip_dir, "onnx", "text_model_quantized.onnx"))
    names = [i.name for i in sess.get_inputs()]
    out = {}
    for cls, prompts in CLASSES.items():
        embs = []
        for p in prompts:
            ids = tok.encode(p).ids[:77]
            feeds = {"input_ids": np.array([ids], dtype=np.int64)}
            if "attention_mask" in names:
                feeds["attention_mask"] = np.ones((1, len(ids)), dtype=np.int64)
            e = sess.run(["text_embeds"], feeds)[0][0]
            embs.append(e / np.linalg.norm(e))
        m = np.mean(embs, axis=0)
        out[cls] = [round(float(x), 6) for x in m / np.linalg.norm(m)]
    dest = os.path.join(os.path.dirname(__file__), "..", "src", "analysis", "sceneLabels.json")
    with open(dest, "w") as f:
        json.dump({"model": "Xenova/clip-vit-base-patch32", "classes": out}, f)
    print("wrote", dest, len(out), "classes")

if __name__ == "__main__":
    main(sys.argv[1])
