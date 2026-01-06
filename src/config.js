import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const config = {
  storageUrl: process.env.STORAGE_URL || './storage',
  queueUrl: process.env.QUEUE_URL || 'redis://localhost:6379',
  sceneDetectionThreshold: parseFloat(process.env.SCENE_DETECTION_THRESHOLD) || 30,
  keyframesPerScene: parseInt(process.env.KEYFRAMES_PER_SCENE) || 3,
  outputDir: process.env.OUTPUT_DIR || './output',
  rootDir: path.resolve(__dirname, '..'),
};

export function getOutputPath(...segments) {
  return path.join(config.rootDir, config.outputDir, ...segments);
}

export function getStoragePath(...segments) {
  return path.join(config.rootDir, config.storageUrl, ...segments);
}

