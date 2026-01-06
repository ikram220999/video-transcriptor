import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { config } from './config.js';

let connection = null;
let sceneQueue = null;

/**
 * Initializes the Redis connection and queue
 */
export async function initQueue() {
  try {
    console.log(`📡 Connecting to queue at: ${config.queueUrl}`);
    
    connection = new Redis(config.queueUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
    
    sceneQueue = new Queue('vision-scenes', { connection });
    
    console.log('✅ Queue connection established');
    return true;
  } catch (error) {
    console.warn(`⚠️  Queue connection failed: ${error.message}`);
    console.warn('   Jobs will be logged locally instead of published to queue');
    return false;
  }
}

/**
 * Publishes scene jobs for the Vision Service
 * 
 * @param {string} jobId - Unique job identifier
 * @param {string} videoPath - Original video path
 * @param {Array} sceneData - Scene data with keyframes and audio
 */
export async function publishSceneJobs(jobId, videoPath, sceneData) {
  console.log(`📤 Publishing ${sceneData.length} scene jobs...`);
  
  const jobs = sceneData.map((scene) => ({
    name: `scene-${scene.sceneNumber}`,
    data: {
      jobId,
      videoPath,
      sceneNumber: scene.sceneNumber,
      startTime: scene.startTime,
      endTime: scene.endTime,
      audioPath: scene.audioPath,
      keyframes: scene.keyframes.map(kf => ({
        timestamp: kf.timestamp,
        path: kf.path,
      })),
      createdAt: new Date().toISOString(),
    },
  }));
  
  if (sceneQueue) {
    try {
      // Bulk add jobs to the queue
      await sceneQueue.addBulk(jobs);
      console.log(`✅ Published ${jobs.length} jobs to vision-scenes queue`);
    } catch (error) {
      console.error(`❌ Failed to publish jobs: ${error.message}`);
      logJobsLocally(jobs);
    }
  } else {
    logJobsLocally(jobs);
  }
  
  return jobs;
}

/**
 * Logs jobs locally when queue is unavailable
 */
function logJobsLocally(jobs) {
  console.log('\n📋 Scene Jobs (Queue Unavailable - Logging Locally):');
  console.log('─'.repeat(60));
  
  jobs.forEach((job) => {
    console.log(`\n  Scene ${job.data.sceneNumber}:`);
    console.log(`    Time: ${job.data.startTime}s - ${job.data.endTime}s`);
    console.log(`    Audio: ${job.data.audioPath}`);
    console.log(`    Keyframes: ${job.data.keyframes.length}`);
    job.data.keyframes.forEach((kf) => {
      console.log(`      - ${kf.timestamp}s: ${kf.path}`);
    });
  });
  
  console.log('\n' + '─'.repeat(60));
}

/**
 * Closes the queue connection
 */
export async function closeQueue() {
  if (sceneQueue) {
    await sceneQueue.close();
  }
  if (connection) {
    await connection.quit();
  }
  console.log('📡 Queue connection closed');
}
