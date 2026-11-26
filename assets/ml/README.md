# PickPic ML assets

The current AI bridge loads `efficientnet-lite4.tflite` when image
classification is enabled. `labels.txt` contains the matching ImageNet label
names used to translate model output.

Unused comparison/backup models (`mobilenet_*.tflite`) and `*.placeholder`
files must not be committed or bundled into release builds.
`efficientnet-lite4.tar.gz` is an optional local source archive and is
intentionally ignored by Git.
