import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import { config, getOutputPath } from './config.js';

/**
 * Detects scenes in a video using PySceneDetect CLI
 * 
 * @param {string} videoPath - Path to the input video file
 * @param {string} jobId - Unique job identifier
 * @returns {Promise<Array<{sceneNumber: number, startTime: number, endTime: number}>>}
 */
export async function detectScenes(videoPath, jobId) {
  const outputDir = getOutputPath(jobId, 'scenes');
  await fs.mkdir(outputDir, { recursive: true });
  
  console.log(`🎬 Detecting scenes using PySceneDetect CLI (threshold: ${config.sceneDetectionThreshold})...`);
  
  // Run scenedetect CLI
  await runSceneDetectCLI(videoPath, outputDir, config.sceneDetectionThreshold);
  
  // Parse the CSV output
  const scenes = await parseSceneList(outputDir);
  
  // Save as JSON too
  const sceneDataPath = path.join(outputDir, 'scenes.json');
  await fs.writeFile(sceneDataPath, JSON.stringify(scenes, null, 2));
  
  console.log(`✅ Detected ${scenes.length} scenes, saved to: ${sceneDataPath}`);
  
  return scenes;
}

/**
 * Runs PySceneDetect CLI
 */
function runSceneDetectCLI(videoPath, outputDir, threshold) {
  return new Promise((resolve, reject) => {
    const args = [
      '-i', videoPath,
      'detect-content', '-t', threshold.toString(),
      'list-scenes', '-o', outputDir, '-f', 'scenes.csv'
    ];
    
    console.log(`   Running: scenedetect ${args.join(' ')}`);
    
    const process = spawn('scenedetect', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true
    });
    
    let stderr = '';
    
    process.stdout.on('data', (data) => {
      const line = data.toString().trim();
      if (line) console.log(`   ${line}`);
    });
    
    process.stderr.on('data', (data) => {
      stderr += data.toString();
      const line = data.toString().trim();
      // Show progress
      if (line.includes('%') || line.includes('Detected')) {
        console.log(`   ${line}`);
      }
    });
    
    process.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`scenedetect exited with code ${code}: ${stderr}`));
        return;
      }
      resolve();
    });
    
    process.on('error', (err) => {
      reject(new Error(`Failed to run scenedetect: ${err.message}. Make sure PySceneDetect CLI is installed.`));
    });
  });
}

/**
 * Parses the CSV output from PySceneDetect
 */
async function parseSceneList(outputDir) {
  // Find the CSV file
  const files = await fs.readdir(outputDir);
  const csvFile = files.find(f => f.endsWith('.csv'));
  
  if (!csvFile) {
    console.log('   No scenes detected, treating entire video as one scene');
    return [{ sceneNumber: 1, startTime: 0, endTime: 0, duration: 0 }];
  }
  
  const csvPath = path.join(outputDir, csvFile);
  const content = await fs.readFile(csvPath, 'utf-8');
  const lines = content.trim().split('\n');
  
  // Skip header lines (PySceneDetect outputs 2 header lines)
  const dataLines = lines.slice(2);
  
  const scenes = [];
  
  for (const line of dataLines) {
    if (!line.trim()) continue;
    
    const cols = line.split(',');
    // CSV format: Scene Number, Start Frame, Start Timecode, Start Time (seconds), End Frame, End Timecode, End Time (seconds), Length (frames), Length (timecode), Length (seconds)
    const sceneNumber = parseInt(cols[0]);
    const startTime = parseFloat(cols[3]);
    const endTime = parseFloat(cols[6]);
    const duration = parseFloat(cols[9]);
    
    scenes.push({
      sceneNumber,
      startTime: Math.round(startTime * 1000) / 1000,
      endTime: Math.round(endTime * 1000) / 1000,
      duration: Math.round(duration * 1000) / 1000,
    });
  }
  
  return scenes;
}
