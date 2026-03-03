<div align="center">
<img src="docs/screenshots/prune-logo.jpg" alt="Prune logo" width="220" />

Prune

Rough cuts at the speed of text.

</div>

<br />

Prune is a transcript-based video editor built for self-hosted setups. I got tired of endlessly scrubbing through timelines to find the right takes, so this tool lets you edit video just by deleting text on a screen.

When you select a word, phrase, or paragraph to remove from the transcript, Prune automatically figures out the exact timeline cuts. You can preview the rough cut right in your browser, render out a quick test video, or export an XML file to finish the project in your usual editor like Premiere or Resolve.

Screenshots

Desktop Editor

A standard split-pane view to take advantage of larger screens.

Mobile Layout

If you're editing on the go, the mobile view uses a tabbed layout (Media, Transcript, Tools, Export) that remembers where you were so you don't lose your place.

Features

Text-based editing: Edit by reading instead of watching. Just click words to cut them, or drag to select and remove entire sections at once.

Local transcription: Uses Whisper STT under the hood. You can choose between different accuracy modes depending on what your local hardware can handle, and it processes everything in the background.

Audio cleanup: Includes built-in helpers to automatically detect and shorten silences, or quickly strip out crutch words like "um" and "ah".

Project saving: Saves your progress locally so you can bounce between projects. It remembers your exact transcript state, deleted tokens, and trim settings.

Basic rendering: If you just need a quick trim or to remux a file without even generating a transcript, the render engine can handle that too.

Exporting & NLE Support

The goal of Prune is to act as a fast middleman before you do your final polish. It supports sending your timeline data to pretty much any major non-linear editor.

Media: Render out a standard .mp4 video.

Interchange formats: Export to DaVinci Resolve/Final Cut Pro (.fcpxml), Premiere Pro (.xml), CMX3600 (.edl), After Effects markers (.json), or an AAF bridge package (.zip).

Subtitles: Generate .srt, .vtt, and raw text scripts.

Note on file handling: Small sidecar exports (like your XMLs or EDLs) will download straight to your browser immediately and are then removed from the server. If you render out an actual media file, it stays cached on the server based on whatever retention window you configure.

Getting Started

The Quick Way (Recommended)

If you have Docker installed, the fastest way to get things running is to pull the repo and spin up the container:

git clone [https://github.com/SloPOS/Prune.git](https://github.com/SloPOS/Prune.git)
cd Prune
docker compose up -d --build


Once the container finishes building, the app will be available at http://localhost:4173.

Alternatively, you can use the automated install script:

curl -fsSL [https://raw.githubusercontent.com/SloPOS/Prune/main/scripts/install-prune.sh](https://raw.githubusercontent.com/SloPOS/Prune/main/scripts/install-prune.sh) | bash


Manual Installation

If you'd rather run the environment manually without Docker, make sure you have Node.js 20+, Python 3.10+, and ffmpeg/ffprobe installed and in your system PATH.

npm install
npm run dev -w @prune/editor-web


This will start the server and give you a local Vite URL in your terminal.

Development & Testing

If you're tinkering with the export engines, there are automated checks included to make sure timelines stay accurate across the different formats. You can run them with:

npm run test:exports
npm run test:interop


Designed by Jacob "FauxRhino" · Reach out at Faux@fauxrhino.com
