# PickPic ML assets

The current AI bridge loads `efficientnet-lite4.tflite` when image
classification is enabled. `labels.txt` contains the matching ImageNet label
names used to translate model output.

The `mobilenet_*.tflite` files are retained as local comparison/backup models;
the current bridge does not load them. `efficientnet-lite4.tar.gz` is an
optional local source archive and is intentionally ignored by Git.
