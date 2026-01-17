import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';
import { createWriteStream } from 'fs';
import { fileURLToPath } from 'url';
import OpenAI from 'openai';
import dotenv from 'dotenv';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { v4 as uuidv4 } from 'uuid';
import { processOutputFolder } from './visionProcessor.js';
import { config, getOutputPath } from './src/config.js';
import { extractAudio, splitAudioByScenes } from './src/audioExtractor.js';
import { detectScenes } from './src/sceneDetector.js';
import { extractKeyframes } from './src/keyframeExtractor.js';
import ffmpeg from 'fluent-ffmpeg';
import { downloadYoutubeVideo, isValidYoutubeUrl } from './youtubeVideoDownloader.js';

// Get video duration using ffprobe
function getVideoDuration(videoPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (err, metadata) => {
      if (err) {
        reject(err);
        return;
      }
      const duration = metadata.format.duration || 0;
      resolve(duration);
    });
  });
}

// Constants for validation
const MAX_FILE_SIZE_MB = 30;
const MAX_DURATION_SECONDS = 1000; // 1 minute

dotenv.config();

// Rate limiters
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // 100 requests per 15 minutes
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10, // 10 uploads per hour
  message: { error: 'Upload limit reached. Maximum 10 videos per hour.' },
  standardHeaders: true,
  legacyHeaders: false,
  skipFailedRequests: true, // Don't count failed uploads
});

const narrationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour  
  max: 20, // 20 narration requests per hour
  message: { error: 'Narration limit reached. Maximum 20 requests per hour.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Configure multer for video uploads
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const uploadDir = path.join(__dirname, 'uploads');
    await fs.mkdir(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, `video-${uniqueSuffix}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 300 * 1024 * 1024 }, // 30MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = /mp4|mov|avi|mkv|webm|m4v/;
    const ext = path.extname(file.originalname).toLowerCase().slice(1);
    const mimetype = file.mimetype.startsWith('video/');
    
    if (allowedTypes.test(ext) && mimetype) {
      cb(null, true);
    } else {
      cb(new Error('Only video files are allowed'));
    }
  }
});

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
    
    // Generate summary
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    
    console.log('\n' + '═'.repeat(60));
    console.log('✨ MEDIA PROCESSING COMPLETE');
    console.log('═'.repeat(60));
    console.log(`\n📊 Summary:`);
    console.log(`   - Job ID: ${jobId}`);
    console.log(`   - Scenes Detected: ${scenes.length}`);
    console.log(`   - Audio Segments: ${audioSegments.length}`);
    console.log(`   - Keyframes Extracted: ${keyframeData.reduce((sum, s) => sum + s.keyframes.length, 0)}`);
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
  }
}

// Middleware
app.use(express.json());
app.use(express.static(__dirname));
app.use(cors());
app.use(generalLimiter); // Apply general rate limit to all routes
// Serve the upload page
// app.get('/', (req, res) => {
//   res.sendFile(path.join(__dirname, 'upload.html'));
// });

// Helper to send SSE events
function sendSSE(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// API endpoint to upload and process video with SSE progress
// Supports both video file upload and YouTube URL
app.post('/api/upload', uploadLimiter, upload.single('video'), async (req, res) => {
  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  let videoPath = null;
  let isYoutubeDownload = false;

  try {
    const resourceType = req.body.resource_type || 'video';
    const personas = req.body.personas || '';

    // Handle based on resource type
    if (resourceType === 'url') {
      // YouTube URL download
      const youtubeUrl = req.body.youtubeUrl;
      
      if (!youtubeUrl) {
        sendSSE(res, 'error', { message: 'No YouTube URL provided' });
        return res.end();
      }

      if (!isValidYoutubeUrl(youtubeUrl)) {
        sendSSE(res, 'error', { message: 'Invalid YouTube URL' });
        return res.end();
      }

      sendSSE(res, 'progress', { 
        step: 'youtube', 
        status: 'started',
        message: 'Fetching video from YouTube...',
        details: { url: youtubeUrl }
      });

      try {
        const downloadResult = await downloadYoutubeVideo(youtubeUrl, {
          onProgress: (progress) => {
            sendSSE(res, 'progress', {
              step: 'youtube',
              status: 'downloading',
              message: progress.message,
              details: progress
            });
          }
        });

        videoPath = downloadResult.videoPath;
        isYoutubeDownload = true;

        sendSSE(res, 'progress', { 
          step: 'youtube', 
          status: 'completed',
          message: `Downloaded: ${downloadResult.title}`,
          details: { 
            title: downloadResult.title, 
            duration: downloadResult.duration,
            sizeMB: downloadResult.sizeMB 
          }
        });

        // YouTube downloader already validates duration and size
        sendSSE(res, 'progress', { 
          step: 'validation', 
          status: 'completed',
          message: `Video validated: ${downloadResult.duration}s duration`,
          details: { durationSeconds: downloadResult.duration }
        });

      } catch (ytError) {
        sendSSE(res, 'error', { message: `YouTube download failed: ${ytError.message}` });
        return res.end();
      }

    } else {
      // Regular video file upload
      if (!req.file) {
        sendSSE(res, 'error', { message: 'No video file uploaded' });
        return res.end();
      }

      videoPath = req.file.path;
      const fileSizeMB = req.file.size / (1024 * 1024);

      // Progress: Upload received
      sendSSE(res, 'progress', { 
        step: 'upload', 
        status: 'completed',
        message: `Video uploaded: ${req.file.originalname}`,
        details: { fileName: req.file.originalname, sizeMB: fileSizeMB.toFixed(2) }
      });

      // Progress: Validating video
      sendSSE(res, 'progress', { 
        step: 'validation', 
        status: 'started',
        message: 'Checking video duration...'
      });

      const duration = await getVideoDuration(videoPath);

      if (duration > MAX_DURATION_SECONDS) {
        await fs.unlink(videoPath);
        sendSSE(res, 'error', { 
          message: `Video too long. Maximum duration is ${MAX_DURATION_SECONDS} seconds (1 minute). Your video is ${duration.toFixed(2)} seconds.` 
        });
        return res.end();
      }

      sendSSE(res, 'progress', { 
        step: 'validation', 
        status: 'completed',
        message: `Video validated: ${duration.toFixed(2)}s duration`,
        details: { durationSeconds: duration.toFixed(2) }
      });
    }

    // Generate job ID
    const jobId = uuidv4();
    const jobOutputDir = getOutputPath(jobId);
    await fs.mkdir(jobOutputDir, { recursive: true });

    sendSSE(res, 'progress', { 
      step: 'init', 
      status: 'completed',
      message: `Job created: ${jobId}`,
      details: { jobId }
    });

    // Step 1: Scene Detection
    sendSSE(res, 'progress', { 
      step: 'scenes', 
      status: 'started',
      message: 'Detecting scenes...'
    });

    const scenes = await detectScenes(videoPath, jobId);

    sendSSE(res, 'progress', { 
      step: 'scenes', 
      status: 'completed',
      message: `Detected ${scenes.length} scenes`,
      details: { sceneCount: scenes.length }
    });

    // Step 2: Audio Extraction
    sendSSE(res, 'progress', { 
      step: 'audio', 
      status: 'started',
      message: 'Extracting audio segments...'
    });

    const audioSegments = await splitAudioByScenes(videoPath, scenes, jobId);

    sendSSE(res, 'progress', { 
      step: 'audio', 
      status: 'completed',
      message: `Extracted ${audioSegments.length} audio segments`,
      details: { audioCount: audioSegments.length }
    });

    // Step 3: Keyframe Extraction
    sendSSE(res, 'progress', { 
      step: 'keyframes', 
      status: 'started',
      message: 'Extracting keyframes...'
    });

    const keyframeData = await extractKeyframes(videoPath, scenes, jobId);
    const totalKeyframes = keyframeData.reduce((sum, s) => sum + s.keyframes.length, 0);

    sendSSE(res, 'progress', { 
      step: 'keyframes', 
      status: 'completed',
      message: `Extracted ${totalKeyframes} keyframes`,
      details: { keyframeCount: totalKeyframes }
    });

    // Merge audio with keyframes
    const sceneData = keyframeData.map((kf, idx) => ({
      ...kf,
      audioPath: audioSegments[idx]?.audioPath || null,
    }));

    // Save processing result
    await fs.writeFile(path.join(jobOutputDir, 'result.json'), JSON.stringify({
      jobId,
      videoPath,
      scenesDetected: scenes.length,
      audioSegments: audioSegments.length,
      keyframesExtracted: totalKeyframes,
      completedAt: new Date().toISOString(),
      scenes: sceneData,
    }, null, 2));

    // Save personas
    if (personas) {
      await fs.writeFile(path.join(jobOutputDir, 'personas.txt'), personas, 'utf-8');
      sendSSE(res, 'progress', { 
        step: 'personas', 
        status: 'completed',
        message: 'Personas saved'
      });
    }

    // Step 4: Vision Processing
    sendSSE(res, 'progress', { 
      step: 'vision', 
      status: 'started',
      message: 'Starting AI vision analysis...',
      details: { totalScenes: scenes.length }
    });

    // Custom vision processing with progress updates
    const visionResults = await processOutputFolderWithProgress(jobOutputDir, (progress) => {
      sendSSE(res, 'progress', {
        step: 'vision',
        status: 'processing',
        message: progress.message,
        details: progress
      });
    });

    sendSSE(res, 'progress', { 
      step: 'vision', 
      status: 'completed',
      message: `Analyzed ${visionResults.length} scenes with AI`,
      details: { analyzedScenes: visionResults.length }
    });

    // Step 5: Final Story Generation
    sendSSE(res, 'progress', { 
      step: 'story', 
      status: 'started',
      message: 'Generating final story...'
    });

    let story = '';
    try {
      story = await fs.readFile(path.join(jobOutputDir, 'story.txt'), 'utf-8');
    } catch (e) {
      story = '(Story generation pending)';
    }

    sendSSE(res, 'progress', { 
      step: 'story', 
      status: 'completed',
      message: 'Story generated successfully!'
    });

    // Send final complete event
    sendSSE(res, 'complete', {
      success: true,
      message: 'Video processed and story generated!',
      jobId,
      summary: {
        scenesDetected: scenes.length,
        audioSegments: audioSegments.length,
        keyframesExtracted: totalKeyframes,
        scenesAnalyzed: visionResults.length
      },
      story
    });

    res.end();

  } catch (error) {
    console.error('❌ Upload/Processing error:', error);
    sendSSE(res, 'error', { message: error.message || 'Failed to process video' });
    res.end();
  }
});

// Helper function: Vision processing with progress callback
async function processOutputFolderWithProgress(outputFolder, onProgress) {
  // Call processOutputFolder with progress callback
  const results = await processOutputFolder(outputFolder, onProgress);
  return results;
}

// Get job status/result
app.get('/api/job/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const resultPath = path.join(config.rootDir, config.outputDir, jobId, 'result.json');
    
    const data = await fs.readFile(resultPath, 'utf-8');
    res.json(JSON.parse(data));
  } catch (error) {
    res.status(404).json({ error: 'Job not found' });
  }
});

// Get story for a job
app.get('/api/job/:jobId/story', async (req, res) => {
  try {
    const { jobId } = req.params;
    const storyPath = path.join(config.rootDir, config.outputDir, jobId, 'story.txt');
    
    const story = await fs.readFile(storyPath, 'utf-8');
    res.json({ story });
  } catch (error) {
    res.status(404).json({ error: 'Story not found' });
  }
});

// Error handling middleware
app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: `File too large. Maximum size is ${MAX_FILE_SIZE_MB}MB` });
    }
    return res.status(400).json({ error: error.message });
  }
  
  res.status(500).json({ error: error.message || 'Internal server error' });
});

// GET: Combine all storyParts from vision_results.json for a given folderId
app.get('/api/job/:folderId/combined-story', async (req, res) => {
  try {
    const { folderId } = req.params;
    const resultsPath = path.join(config.rootDir, config.outputDir, folderId, 'vision_results.json');
    const data = await fs.readFile(resultsPath, 'utf-8');
    const results = JSON.parse(data);

    if (!Array.isArray(results)) {
      return res.status(400).json({ error: 'vision_results.json has invalid format.' });
    }

    // Collect all storyPart values
    const allStoryParts = results
      .map(item => item.storyPart)
      .filter(Boolean);

    if (allStoryParts.length === 0) {
      return res.status(404).json({ error: 'No storyPart attributes found in vision_results.json.' });
    }

    const combinedStory = allStoryParts.join(' ');

    res.json({ combinedStory });
  } catch (error) {
    res.status(404).json({ error: 'vision_results.json not found or invalid.' });
  }
});

// Generate storytelling audio from vision_results.json
app.get('/api/job/:folderId/narration', narrationLimiter, async (req, res) => {
  try {
    const { folderId } = req.params;
    const jobDir = path.join(config.rootDir, config.outputDir, folderId);
    const resultsPath = path.join(jobDir, 'vision_results.json');
    const audioOutputPath = path.join(jobDir, 'narration.mp3');

    // Check if audio already exists
    try {
      await fs.access(audioOutputPath);
      console.log(`🎵 Narration already exists, serving cached file`);
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Content-Disposition', `attachment; filename="narration-${folderId}.mp3"`);
      const audioBuffer = await fs.readFile(audioOutputPath);
      return res.send(audioBuffer);
    } catch {
      // Audio doesn't exist, generate it
    }

    console.log('\n' + '═'.repeat(60));
    console.log('🎙️  GENERATING STORYTELLING NARRATION');
    console.log('═'.repeat(60));
    console.log(`📁 Job: ${folderId}`);

    // Read vision results
    const data = await fs.readFile(resultsPath, 'utf-8');
    const results = JSON.parse(data);

    if (!Array.isArray(results)) {
      return res.status(400).json({ error: 'vision_results.json has invalid format.' });
    }

    // Combine all storyParts in order
    const storyParts = results
      .filter(item => item.storyPart)
      .sort((a, b) => a.sceneNumber - b.sceneNumber)
      .map(item => item.storyPart);

    if (storyParts.length === 0) {
      return res.status(404).json({ error: 'No storyPart found in vision_results.json.' });
    }

    // Combine into flowing narrative with paragraph breaks
    const fullStory = storyParts.join('\n\n');
    console.log(`📝 Story length: ${fullStory.length} characters`);
    console.log(`📖 Preview: "${fullStory.substring(0, 100)}..."`);

    // Generate speech using OpenAI TTS
    console.log('🎤 Converting to speech...');
    // Split narration into chunks by sentence (~2000 chars max, do not split sentences)
    function splitTextBySentence(text, maxLen) {
      const sentences = text.match(/[^.!?]+[.!?]+[\])'"`’”]*|.+/g) || [];
      const chunks = [];
      let current = '';

      for (const s of sentences) {
        if ((current + s).length > maxLen && current.length > 0) {
          chunks.push(current.trim());
          current = s;
        } else {
          current += s;
        }
      }
      if (current.length) chunks.push(current.trim());
      return chunks;
    }

    const chunkSize = 2000;
    const textChunks = splitTextBySentence(fullStory, chunkSize);

    const audioBuffers = [];
    for (let i = 0; i < 1; i++) {
      const chunk = textChunks[i];
      console.log(`🗣️  Generating TTS chunk ${i + 1}/${textChunks.length} (${chunk.length} chars)`);
      const chunkResponse = await openai.audio.speech.create({
        model: 'gpt-4o-mini-tts',
        voice: 'coral',
        input: chunk,
        speed: 0.95,
        instructions: "Speak in a cheerful and positive tone, with a slow and deliberate pace. Make it like a storyteller is telling a story.",
      });
      const audioBuffer = Buffer.from(await chunkResponse.arrayBuffer());
      audioBuffers.push(audioBuffer);
    }

    // Concatenate all audio buffers into a single Buffer
    const narrationBuffer = Buffer.concat(audioBuffers);

    // Save the narration buffer to file
    await fs.writeFile(audioOutputPath, narrationBuffer);

    console.log(`✅ Narration saved to: ${audioOutputPath}`);
    console.log('═'.repeat(60) + '\n');

    // Send the audio file
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Disposition', `attachment; filename="narration-${folderId}.mp3"`);
    res.send(narrationBuffer);

  } catch (error) {
    console.error('❌ Narration generation error:', error);
    res.status(500).json({ error: error.message || 'Failed to generate narration' });
  }
});

// Stream narration audio (if already generated)
app.get('/api/job/:folderId/narration/stream', async (req, res) => {
  try {
    const { folderId } = req.params;
    const audioPath = path.join(config.rootDir, config.outputDir, folderId, 'narration.mp3');

    // Check if file exists
    const stats = await fs.stat(audioPath);
    
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', stats.size);
    res.setHeader('Accept-Ranges', 'bytes');

    const audioBuffer = await fs.readFile(audioPath);
    res.send(audioBuffer);

  } catch (error) {
    res.status(404).json({ error: 'Narration not found. Generate it first using GET /api/job/:folderId/narration' });
  }
});

// Generate narration from story.txt (final cohesive story)
app.get('/api/job/:folderId/narration/final', narrationLimiter, async (req, res) => {
  try {
    const { folderId } = req.params;
    const jobDir = path.join(config.rootDir, config.outputDir, folderId);
    const storyPath = path.join(jobDir, 'story.txt');
    const audioOutputPath = path.join(jobDir, 'narration_final.mp3');

    // Check if audio already exists
    try {
      await fs.access(audioOutputPath);
      console.log(`🎵 Final narration already exists, serving cached file`);
      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Content-Disposition', `attachment; filename="narration-final-${folderId}.mp3"`);
      const audioBuffer = await fs.readFile(audioOutputPath);
      return res.send(audioBuffer);
    } catch {
      // Audio doesn't exist, generate it
    }

    console.log('\n' + '═'.repeat(60));
    console.log('🎙️  GENERATING FINAL STORY NARRATION');
    console.log('═'.repeat(60));

    // Read the final story
    const fullStory = await fs.readFile(storyPath, 'utf-8');
    
    if (!fullStory.trim()) {
      return res.status(404).json({ error: 'story.txt is empty.' });
    }

    console.log(`📝 Story length: ${fullStory.length} characters`);

    // Generate speech using OpenAI TTS
    console.log('🎤 Converting to speech...');
    
    const mp3Response = await openai.audio.speech.create({
      model: 'tts-1-hd',
      voice: 'nova',               // Warm storytelling voice
      input: fullStory,
      speed: 0.9,                  // Slower for dramatic storytelling
    });

    const buffer = Buffer.from(await mp3Response.arrayBuffer());
    await fs.writeFile(audioOutputPath, buffer);

    console.log(`✅ Final narration saved to: ${audioOutputPath}`);
    console.log('═'.repeat(60) + '\n');

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Disposition', `attachment; filename="narration-final-${folderId}.mp3"`);
    res.send(buffer);

  } catch (error) {
    console.error('❌ Final narration error:', error);
    res.status(500).json({ error: error.message || 'Failed to generate final narration' });
  }
});

app.listen(PORT, () => {
  console.log('\n' + '═'.repeat(60));
  console.log('🚀 VIDEO STORY GENERATOR SERVER');
  console.log('═'.repeat(60));
  console.log(`\n   📡 Server running at: http://localhost:${PORT}`);
  console.log(`   📁 Upload page: http://localhost:${PORT}/`);
  console.log(`   📤 API endpoint: POST /api/upload`);
  console.log('\n' + '═'.repeat(60) + '\n');
});

export default app;
