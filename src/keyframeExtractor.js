import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import fs from 'fs/promises';
import { config, getOutputPath } from './config.js';

/**
 * Extracts keyframes from each scene
 * 
 * @param {string} videoPath - Path to the input video file
 * @param {Array<{sceneNumber: number, startTime: number, endTime: number}>} scenes - Scene list
 * @param {string} jobId - Unique job identifier
 * @returns {Promise<Array<{sceneNumber: number, keyframes: string[]}>>}
 */
export async function extractKeyframes(videoPath, scenes, jobId) {
  const outputDir = getOutputPath(jobId, 'keyframes');
  await fs.mkdir(outputDir, { recursive: true });
  
  console.log(`🖼️  Extracting ${config.keyframesPerScene} keyframes per scene...`);
  
  const results = [];
  
  for (const scene of scenes) {
    const sceneDir = path.join(outputDir, `scene_${scene.sceneNumber}`);
    await fs.mkdir(sceneDir, { recursive: true });
    
    const keyframes = await extractSceneKeyframes(
      videoPath,
      scene,
      sceneDir,
      config.keyframesPerScene
    );
    
    results.push({
      sceneNumber: scene.sceneNumber,
      startTime: scene.startTime,
      endTime: scene.endTime,
      keyframes,
    });
    
    console.log(`   Scene ${scene.sceneNumber}: ${keyframes.length} keyframes extracted`);
  }
  
  // Save keyframe manifest
  const manifestPath = path.join(outputDir, 'keyframes.json');
  await fs.writeFile(manifestPath, JSON.stringify(results, null, 2));
  
  console.log(`✅ Keyframes extracted, manifest saved to: ${manifestPath}`);
  
  return results;
}

/**
 * Extracts keyframes from a single scene
 */
function extractSceneKeyframes(videoPath, scene, outputDir, count) {
  return new Promise((resolve, reject) => {
    const duration = scene.endTime - scene.startTime;
    const keyframes = [];
    
    // Calculate timestamps for evenly distributed keyframes
    const timestamps = [];
    for (let i = 0; i < count; i++) {
      // Distribute frames evenly within the scene
      const offset = (duration / (count + 1)) * (i + 1);
      timestamps.push(scene.startTime + offset);
    }
    
    // Extract frames at calculated timestamps
    const extractPromises = timestamps.map((timestamp, index) => {
      return new Promise((resolveFrame, rejectFrame) => {
        const framePath = path.join(outputDir, `frame_${index + 1}.jpg`);
        
        ffmpeg(videoPath)
          .seekInput(timestamp)
          .frames(1)
          .output(framePath)
          .outputOptions(['-q:v', '2']) // High quality JPEG
          .on('end', () => {
            keyframes.push({
              index: index + 1,
              timestamp: Math.round(timestamp * 1000) / 1000,
              path: framePath,
            });
            resolveFrame();
          })
          .on('error', (err) => {
            console.error(`   Warning: Failed to extract frame at ${timestamp}s: ${err.message}`);
            resolveFrame(); // Continue even if one frame fails
          })
          .run();
      });
    });
    
    Promise.all(extractPromises)
      .then(() => {
        // Sort by index to maintain order
        keyframes.sort((a, b) => a.index - b.index);
        resolve(keyframes);
      })
      .catch(reject);
  });
}

