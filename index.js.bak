import path from 'path';
import fs from 'fs/promises';
import { v4 as uuidv4 } from 'uuid';
import { config, getOutputPath, getStoragePath } from './src/config.js';
import { extractAudio, splitAudioByScenes } from './src/audioExtractor.js';
import { detectScenes } from './src/sceneDetector.js';
import { extractKeyframes } from './src/keyframeExtractor.js';
import { initQueue, publishSceneJobs, closeQueue } from './src/queuePublisher.js';

/**
 * Media Processing Service
 * 
 * Processes raw videos:
 * 1. Detects scenes
 * 2. Extracts audio per scene
 * 3. Extracts keyframes per scene
 * 4. Publishes scene jobs for Vision Service
 */

async function processVideo(videoPath) {
  const jobId = uuidv4();
  const startTime = Date.now();
  
  console.log('\n' + '═'.repeat(60));
  console.log('🎬 MEDIA PROCESSING SERVICE');
  console.log('═'.repeat(60));
  console.log(`\n📁 Input: ${videoPath}`);
  console.log(`🆔 Job ID: ${jobId}`);
  console.log(`⚙️  Settings:`);
  console.log(`   - Scene Threshold: ${config.sceneDetectionThreshold}%`);
  console.log(`   - Keyframes/Scene: ${config.keyframesPerScene}`);
  console.log(`   - Output Dir: ${config.outputDir}`);
  console.log('\n' + '─'.repeat(60) + '\n');

  try {
    // Verify video file exists
    await fs.access(videoPath);
    
    // Create output directory for this job
    const jobOutputDir = getOutputPath(jobId);
    await fs.mkdir(jobOutputDir, { recursive: true });
    
    // Step 1: Detect scenes first (needed for audio splitting)
    console.log('📌 STEP 1: Scene Detection\n');
    const scenes = await detectScenes(videoPath, jobId);
    
    console.log('\n' + '─'.repeat(60) + '\n');
    
    // Step 2: Extract and split audio by scenes
    console.log('📌 STEP 2: Audio Extraction (per scene)\n');
    const audioSegments = await splitAudioByScenes(videoPath, scenes, jobId);
    
    console.log('\n' + '─'.repeat(60) + '\n');
    
    // Step 3: Extract keyframes
    console.log('📌 STEP 3: Keyframe Extraction\n');
    const keyframeData = await extractKeyframes(videoPath, scenes, jobId);
    
    // Merge audio segments with keyframe data
    const sceneData = keyframeData.map((kf, idx) => ({
      ...kf,
      audioPath: audioSegments[idx]?.audioPath || null,
    }));
    
    console.log('\n' + '─'.repeat(60) + '\n');
    
    // Step 4: Publish to queue
    console.log('📌 STEP 4: Publishing to Vision Service\n');
    await initQueue();
    const publishedJobs = await publishSceneJobs(jobId, videoPath, sceneData);
    
    // Generate summary
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    
    console.log('\n' + '═'.repeat(60));
    console.log('✨ PROCESSING COMPLETE');
    console.log('═'.repeat(60));
    console.log(`\n📊 Summary:`);
    console.log(`   - Job ID: ${jobId}`);
    console.log(`   - Scenes Detected: ${scenes.length}`);
    console.log(`   - Audio Segments: ${audioSegments.length}`);
    console.log(`   - Keyframes Extracted: ${keyframeData.reduce((sum, s) => sum + s.keyframes.length, 0)}`);
    console.log(`   - Jobs Published: ${publishedJobs.length}`);
    console.log(`   - Processing Time: ${elapsed}s`);
    console.log(`   - Output Directory: ${jobOutputDir}`);
    console.log('\n' + '═'.repeat(60) + '\n');
    
    // Save processing result
    const resultPath = path.join(jobOutputDir, 'result.json');
    await fs.writeFile(resultPath, JSON.stringify({
      jobId,
      videoPath,
      scenesDetected: scenes.length,
      audioSegments: audioSegments.length,
      keyframesExtracted: keyframeData.reduce((sum, s) => sum + s.keyframes.length, 0),
      processingTime: elapsed,
      completedAt: new Date().toISOString(),
      scenes: sceneData,
    }, null, 2));
    
    return { jobId, scenes, audioSegments, keyframeData: sceneData };
    
  } catch (error) {
    console.error('\n❌ Processing failed:', error.message);
    throw error;
  } finally {
    await closeQueue();
  }
}

// CLI entry point
async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.log(`
╔═══════════════════════════════════════════════════════════╗
║           MEDIA PROCESSING SERVICE - Node.js              ║
╠═══════════════════════════════════════════════════════════╣
║  Processes videos: extracts audio, detects scenes,        ║
║  extracts keyframes, and publishes jobs for Vision AI.    ║
╚═══════════════════════════════════════════════════════════╝

Usage:
  node index.js <video-file>

Example:
  node index.js ./videos/sample.mp4
  node index.js C:/Videos/myvideo.mp4

Environment Variables (set in .env file):
  STORAGE_URL              - Storage directory (default: ./storage)
  QUEUE_URL                - Redis URL (default: redis://localhost:6379)
  SCENE_DETECTION_THRESHOLD - Scene detection sensitivity (default: 30)
  KEYFRAMES_PER_SCENE      - Keyframes to extract per scene (default: 3)
  OUTPUT_DIR               - Output directory (default: ./output)

Prerequisites:
  - FFmpeg must be installed and in system PATH
  - PySceneDetect CLI installed
  - Redis server (optional, for queue publishing)
`);
    process.exit(0);
  }
  
  const videoPath = path.resolve(args[0]);
  
  try {
    await processVideo(videoPath);
    process.exit(0);
  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  }
}

// Only run CLI if this is the entry point
const isMainModule = process.argv[1]?.includes('index.js');
if (isMainModule) {
  main();
}

export { processVideo };
