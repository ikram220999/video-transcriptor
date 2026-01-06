# Media Processing Service (Node.js)

Processes raw videos — extracts audio, detects scenes, extracts keyframes, and publishes jobs for Vision Service.

## Features

- **Audio Extraction**: Extracts audio using `ffmpeg -i input.mp4 -vn -acodec pcm_s16le audio.wav`
- **Scene Detection**: Uses PySceneDetect with ContentDetector for accurate scene boundaries
- **Keyframe Extraction**: Extracts configurable number of keyframes per scene
- **Queue Publishing**: Publishes scene jobs to Redis/BullMQ for Vision Service

## Tech Stack

- **Language**: Node.js (ES Modules)
- **Libraries**: fluent-ffmpeg, BullMQ, ioredis
- **Queue**: Redis with BullMQ

## Prerequisites

- **Node.js** 18+ installed
- **Python** 3.8+ installed
- **FFmpeg** installed and in system PATH
- **Redis** server (optional, for queue publishing)

## Installation

```bash
git clone <repo-url>
cd video-node
npm install
pip install -r requirements.txt
cp env.example .env
```

## Configuration

Edit `.env` file with your settings:

```env
STORAGE_URL=./storage
QUEUE_URL=redis://localhost:6379
SCENE_DETECTION_THRESHOLD=30
KEYFRAMES_PER_SCENE=3
OUTPUT_DIR=./output
```

| Variable | Description | Default |
|----------|-------------|---------|
| `STORAGE_URL` | Storage directory path | `./storage` |
| `QUEUE_URL` | Redis connection URL | `redis://localhost:6379` |
| `SCENE_DETECTION_THRESHOLD` | Scene sensitivity (0-100, lower = more sensitive) | `30` |
| `KEYFRAMES_PER_SCENE` | Number of keyframes to extract per scene | `3` |
| `OUTPUT_DIR` | Output directory for processed files | `./output` |

## Usage

```bash
# Process a video
node index.js <path-to-video>

# Examples
node index.js ./videos/sample.mp4
node index.js "C:/Videos/my video.mp4"

# Development mode (auto-reload)
npm run dev
```

## Output Structure

```
output/
└── <job-id>/
    ├── audio/
    │   └── video-name.wav
    ├── scenes/
    │   └── scenes.json
    ├── keyframes/
    │   ├── scene_1/
    │   │   ├── frame_1.jpg
    │   │   ├── frame_2.jpg
    │   │   └── frame_3.jpg
    │   ├── scene_2/
    │   │   └── ...
    │   └── keyframes.json
    └── result.json
```

## How It Works

1. **Audio Extraction**: Converts video audio to WAV format for speech-to-text processing
2. **Scene Detection**: Analyzes video for scene changes using FFmpeg's scene filter
3. **Keyframe Extraction**: Extracts representative frames from each scene
4. **Job Publishing**: Sends scene data to Redis queue for Vision Service consumption

## Notes

- Scene extraction reduces the number of frames sent to Vision Service for cost optimization
- Ensure FFmpeg is installed in the system path
- Queue connection is optional - jobs are logged locally if Redis is unavailable
