import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import fs from 'fs/promises';
import { existsSync, mkdirSync } from 'fs';
import { getOutputPath } from './config.js';

/**
 * Ensure directory exists (sync to avoid race conditions with ffmpeg)
 */
function ensureDirectoryExists(dirPath) {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
}

/**
 * Extracts full audio from a video file
 * Command equivalent: ffmpeg -i input.mp4 -vn -acodec pcm_s16le audio.wav
 * 
 * @param {string} videoPath - Path to the input video file
 * @param {string} jobId - Unique job identifier
 * @returns {Promise<string>} Path to the extracted audio file
 */
export async function extractAudio(videoPath, jobId) {
  const outputDir = getOutputPath(jobId, 'audio');
  
  // Use sync mkdir to ensure directory exists before ffmpeg runs
  ensureDirectoryExists(outputDir);
  
  const videoName = path.basename(videoPath, path.extname(videoPath));
  const audioPath = path.join(outputDir, `${videoName}.wav`);

  return new Promise((resolve, reject) => {
    console.log(`🎵 Extracting audio from: ${videoPath}`);
    console.log(`   Output directory: ${outputDir}`);
    
    ffmpeg(videoPath)
      .noVideo()
      .audioCodec('pcm_s16le')
      .output(audioPath)
      .on('start', (cmd) => {
        console.log(`   Running: ${cmd}`);
      })
      .on('progress', (progress) => {
        if (progress.percent) {
          process.stdout.write(`\r   Progress: ${progress.percent.toFixed(1)}%`);
        }
      })
      .on('end', () => {
        console.log(`\n✅ Audio extracted to: ${audioPath}`);
        resolve(audioPath);
      })
      .on('error', (err) => {
        console.error(`❌ Audio extraction failed: ${err.message}`);
        console.error(`   Output path was: ${audioPath}`);
        reject(err);
      })
      .run();
  });
}

/**
 * Splits audio into segments based on detected scenes
 * 
 * @param {string} videoPath - Path to the input video file
 * @param {Array<{sceneNumber: number, startTime: number, endTime: number}>} scenes - Scene list
 * @param {string} jobId - Unique job identifier
 * @returns {Promise<Array<{sceneNumber: number, audioPath: string}>>}
 */
export async function splitAudioByScenes(videoPath, scenes, jobId) {
  const outputDir = getOutputPath(jobId, 'audio', 'scenes');
  
  // Use sync mkdir to ensure directory exists before ffmpeg runs
  ensureDirectoryExists(outputDir);
  console.log(`🎵 Splitting audio into ${scenes.length} scene segments...`);
  console.log(`   Output directory: ${outputDir}`);
  
  const results = [];
  
  for (const scene of scenes) {
    const audioPath = path.join(outputDir, `scene_${scene.sceneNumber}.wav`);
    const duration = scene.endTime - scene.startTime;
    
    // Skip scenes with invalid duration
    if (duration <= 0) {
      console.log(`   Scene ${scene.sceneNumber}: Skipped (invalid duration: ${duration}s)`);
      continue;
    }
    
    try {
      await extractAudioSegment(
        videoPath,
        scene.startTime,
        scene.endTime,
        audioPath
      );
      
      results.push({
        sceneNumber: scene.sceneNumber,
        startTime: scene.startTime,
        endTime: scene.endTime,
        duration: scene.duration || duration,
        audioPath,
      });
      
      console.log(`   Scene ${scene.sceneNumber}: ${scene.startTime}s - ${scene.endTime}s ✓`);
    } catch (err) {
      console.log(`   Scene ${scene.sceneNumber}: Failed - ${err.message}`);
      // Continue with other scenes even if one fails
    }
  }
  
  // Save audio manifest
  const audioDir = getOutputPath(jobId, 'audio');
  ensureDirectoryExists(audioDir);
  const manifestPath = path.join(audioDir, 'audio_segments.json');
  await fs.writeFile(manifestPath, JSON.stringify(results, null, 2));
  
  console.log(`✅ Audio split into ${results.length} segments`);
  
  return results;
}

/**
 * Extracts a specific audio segment from video
 */
function extractAudioSegment(videoPath, startTime, endTime, outputPath) {
  return new Promise((resolve, reject) => {
    const duration = endTime - startTime;
    
    // Ensure parent directory exists
    const parentDir = path.dirname(outputPath);
    ensureDirectoryExists(parentDir);
    
    ffmpeg(videoPath)
      .seekInput(startTime)
      .duration(duration)
      .noVideo()
      .audioCodec('pcm_s16le')
      .audioFrequency(16000) // 16kHz sample rate for better compatibility
      .audioChannels(1) // Mono audio
      .output(outputPath)
      .on('end', () => resolve(outputPath))
      .on('error', (err) => {
        console.error(`      FFmpeg error for ${outputPath}: ${err.message}`);
        reject(err);
      })
      .run();
  });
}
