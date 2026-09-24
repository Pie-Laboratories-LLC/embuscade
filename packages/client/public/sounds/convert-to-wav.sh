#!/bin/bash
# fix-audio.sh -- convertit tous les fichiers audio en PCM 16-bit / 44.1kHz,
# format le plus sûr pour Web Audio decodeAudioData()
mkdir -p fixed
for f in *.wav *.flac; do
    [ -e "$f" ] || continue
    base="${f%.*}"
    ffmpeg -y -i "$f" -ar 44100 -sample_fmt s16 -c:a pcm_s16le "fixed/${base}.wav"
done
