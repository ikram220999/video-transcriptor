import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';
import { createWriteStream } from 'fs';
import { fileURLToPath } from 'url';
import OpenAI from 'openai';
import dotenv from 'dotenv';
import { processVideo } from './index.js';
import { processOutputFolder } from './visionProcessor.js';
import { config } from './src/config.js';

dotenv.config();

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
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB limit
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

// Middleware
app.use(express.json());
app.use(express.static(__dirname));

// // Serve the upload page
// app.get('/', (req, res) => {
//   res.sendFile(path.join(__dirname, 'upload.html'));
// });

// API endpoint to upload and process video
app.post('/api/upload', upload.single('video'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No video file uploaded' });
    }

    const videoPath = req.file.path;
    const personas = req.body.personas || '';

    console.log('\n' + '═'.repeat(60));
    console.log('📤 NEW UPLOAD RECEIVED');
    console.log('═'.repeat(60));
    console.log(`📁 File: ${req.file.originalname}`);
    console.log(`📏 Size: ${(req.file.size / (1024 * 1024)).toFixed(2)} MB`);
    console.log(`👥 Personas: ${personas ? 'Provided' : 'None'}`);
    console.log('═'.repeat(60) + '\n');

    // Process the video
    const result = await processVideo(videoPath);

    // Save personas to the job output directory
    const jobOutputDir = path.join(config.rootDir, config.outputDir, result.jobId);
    if (personas) {
      const personasPath = path.join(jobOutputDir, 'personas.txt');
      await fs.writeFile(personasPath, personas, 'utf-8');
      console.log(`\n✅ Personas saved to: ${personasPath}`);
    }

    // Run vision processor directly (no Redis needed)
    console.log('\n📌 STEP 5: Running Vision Processor\n');
    const visionResults = await processOutputFolder(jobOutputDir);

    // Read the generated story
    let story = '';
    try {
      story = await fs.readFile(path.join(jobOutputDir, 'story.txt'), 'utf-8');
    } catch (e) {
      story = '(Story generation pending)';
    }

    res.json({
      success: true,
      message: 'Video processed and story generated!',
      jobId: result.jobId,
      summary: {
        scenesDetected: result.scenes.length,
        audioSegments: result.audioSegments.length,
        keyframesExtracted: result.keyframeData.reduce((sum, s) => sum + s.keyframes.length, 0),
        scenesAnalyzed: visionResults.length
      },
      story
    });

  } catch (error) {
    console.error('❌ Upload/Processing error:', error);
    res.status(500).json({ 
      error: error.message || 'Failed to process video' 
    });
  }
});

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
      return res.status(400).json({ error: 'File too large. Maximum size is 500MB' });
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
app.get('/api/job/:folderId/narration', async (req, res) => {
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
app.get('/api/job/:folderId/narration/final', async (req, res) => {
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
