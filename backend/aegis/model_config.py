"""Pinned public model artifact shared by preparation and offline inference."""

MODEL_NAME = "sentence-transformers/all-MiniLM-L6-v2"
MODEL_COMMIT = "1110a243fdf4706b3f48f1d95db1a4f5529b4d41"
MODEL_REVISION = f"{MODEL_NAME}@{MODEL_COMMIT}"
MODEL_FILES = (
    "1_Pooling/config.json",
    "config.json",
    "config_sentence_transformers.json",
    "model.safetensors",
    "modules.json",
    "sentence_bert_config.json",
    "special_tokens_map.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "vocab.txt",
)
