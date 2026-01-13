import fs from 'fs/promises';
import { createReadStream } from 'fs';
import path from 'path';
import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/**
 * Vision + Audio Processor
 * 
 * Processes keyframe images AND audio through OpenAI APIs:
 * - Whisper for audio transcription
 * - GPT-4o Vision for image analysis
 * - Combines both for rich story generation
 * 
 * Usage: node visionProcessor.js <output_folder>
 */

async function loadPersonas(outputFolder) {
  const personasPath = path.join(outputFolder, 'personas.txt');
  try {
    const content = await fs.readFile(personasPath, 'utf-8');
    return content.trim();
  } catch {
    return null;
  }
}

async function loadAudioSegments(outputFolder) {
  const audioPath = path.join(outputFolder, 'audio', 'audio_segments.json');
  try {
    const content = await fs.readFile(audioPath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return [];
  }
}

async function transcribeAudio(audioPath) {
  try {
    // Check if file exists and has content
    const stats = await fs.stat(audioPath);
    if (stats.size < 1000) {
      // Skip very small files (likely silence)
      return null;
    }

    const response = await openai.audio.transcriptions.create({
      file: createReadStream(audioPath),
      model: 'whisper-1',
      language: 'ms', // Malay - adjust as needed
    });

    // Check if transcript contains any of the excluded words; if so, return null
    if (
      !response.text ||
      [
        'musik',
        'music',
        'tiada pertuturan',
        'no speech',
        'no talking',
        'no voice',
        'terima kasih',
        'menonton',
        'subscribe',
        'like',
        'share',
        'follow',
        'komen',
      ].some(word => response.text.toLowerCase().includes(word))
    ) {
      return null;
    }

    return response.text?.trim() || null;
  } catch (error) {
    console.log(`   ⚠️  Audio transcription failed: ${error.message}`);
    return null;
  }
}

async function processScene(scenePath, sceneNumber, totalScenes, personas, audioPath, previousSceneContext) {
  // Get all jpg files in the scene folder
  const files = await fs.readdir(scenePath);
  const imageFiles = files
    .filter(f => f.endsWith('.jpg') || f.endsWith('.png'))
    .sort();

  if (imageFiles.length === 0) {
    console.log(`   ⚠️  No images found in scene ${sceneNumber}`);
    return null;
  }

  console.log(`   📷 Processing ${imageFiles.length} images...`);

  // Transcribe audio for this scene
  let transcript = null;
  if (audioPath) {
    console.log(`   🎤 Transcribing audio...`);
    transcript = await transcribeAudio(audioPath);
    if (transcript) {
      console.log(`   📝 Transcript: "${transcript.substring(0, 60)}${transcript.length > 60 ? '...' : ''}"`);
    }
  }

  // Read images and convert to base64
  const imageContents = await Promise.all(
    imageFiles.map(async (file) => {
      const imagePath = path.join(scenePath, file);
      const imageBuffer = await fs.readFile(imagePath);
      const base64 = imageBuffer.toString('base64');
      const mimeType = file.endsWith('.png') ? 'image/png' : 'image/jpeg';
      return {
        type: 'image_url',
        image_url: {
          url: `data:${mimeType};base64,${base64}`,
          detail: 'low',
        },
      };
    })
  );

  // Build the prompt with personas and audio context
  const personasContext = personas 
    ? `\n\n## PERSONAS / CHARACTERS:\n${personas}\n\nUse these personas to identify and describe the characters in the scene.`
    : '';

  const audioContext = transcript
    ? `\n\n## AUDIO TRANSCRIPT (what is being said in this scene):\n"${transcript}"\n\nIncorporate this dialogue/narration into your story. If you're not confident about what is being said, just ignore the audio.`
    : '';

  // Build previous scene context - only include if exists and provide clear instructions
  const previousContext = previousSceneContext
    ? `\n\n## PREVIOUS SCENE (for narrative continuity):
"${previousSceneContext}"

CONTINUITY RULES:
- Continue the story naturally from where the previous scene left off
- Do NOT repeat or summarize what happened in the previous scene
- Build upon established context (characters, setting, mood)
- Create smooth transition into this new scene`
    : '';

  const positionContext = sceneNumber === 1 
    ? 'This is the OPENING scene - introduce the setting and characters.'
    : sceneNumber === totalScenes 
      ? 'This is the FINAL scene - bring the story to a satisfying conclusion.'
      : `This is scene ${sceneNumber} of ${totalScenes}.`;

  const prompt = `You are a storyteller analyzing Scene ${sceneNumber} of ${totalScenes} from a video.
${positionContext}
${personasContext}
${audioContext}
${previousContext}

Analyze these ${imageFiles.length} sequential keyframes and the audio transcript (if provided).

Your task:
1. **Scene Description**: What is happening visually? Who is present?
2. **Dialogue/Audio**: What is being said? Who is speaking?
3. **Visual Elements**: Key objects, locations, expressions, movements
4. **Mood**: The emotional tone and atmosphere
5. **Story Contribution**: Write a NEW narrative paragraph (2-3 sentences) for THIS scene only

IMPORTANT RULES:
- Write the story contribution in Bahasa Melayu
- Use character names from personas if provided
- Incorporate dialogue naturally if audio transcript exists
- DO NOT repeat information from the previous scene
- Focus ONLY on what is NEW in this scene
- The narrative should advance the story forward

Respond in JSON format:
{
  "description": "Detailed scene description combining visuals and audio",
  "characters": ["characters visible or heard in scene"],
  "dialogue": "Key dialogue or narration from audio" or null,
  "visualElements": ["key", "visual", "elements"],
  "mood": "emotional tone",
  "storyPart": "NEW narrative paragraph in Bahasa Melayu for THIS scene only (2-3 sentences, no repetition from previous)"
}`;

  // Send to OpenAI Vision
  const response = await openai.chat.completions.create({
    model: 'gpt-5-mini',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          ...imageContents,
        ],
      },
    ],
    max_completion_tokens: 700,
    reasoning_effort: "low",
  });

  const content = response.choices[0].message.content;
  
  // Try to parse as JSON
  try {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const result = JSON.parse(jsonMatch[0]);
      result.transcript = transcript; // Include original transcript
      return result;
    }
  } catch (e) {
    return { rawResponse: content, transcript };
  }

  return { rawResponse: content, transcript };
}

async function generateFinalStory(results, personas) {
  console.log('\n📝 Generating cohesive final story...\n');

  const sceneDescriptions = results
    .filter(r => r.storyPart || r.description)
    .map(r => {
      let desc = `Scene ${r.sceneNumber}: ${r.storyPart || r.description}`;
      if (r.dialogue) {
        desc += `\n   Dialogue: "${r.dialogue}"`;
      }
      return desc;
    })
    .join('\n\n');

  const personasContext = personas 
    ? `\n\nPERSONAS:\n${personas}`
    : '';

  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      {
        role: 'system',
        content: `You are a creative storyteller who writes engaging narratives in Bahasa Melayu. 
Your task is to take scene-by-scene descriptions (with their dialogues) and weave them into a cohesive, flowing story.
- Maintain consistent character names and personalities
- Incorporate dialogue naturally into the narrative
- Write in an engaging narrative style
- Ensure smooth transitions between scenes`
      },
      {
        role: 'user',
        content: `Based on these scene descriptions and dialogues, write a cohesive story in Bahasa Melayu.
${personasContext}

SCENE DESCRIPTIONS:
${sceneDescriptions}

Write a flowing narrative that:
1. Connects all scenes into one cohesive story
2. Incorporates dialogue naturally (using quotation marks)
3. Maintains consistent character voices
4. Has smooth transitions between scenes
5. Is 4-6 paragraphs long`
      }
    ],
    max_tokens: 2000,
  });

  return response.choices[0].message.content;
}

async function processOutputFolder(outputFolder) {
  const keyframesPath = path.join(outputFolder, 'keyframes');

  // Check if keyframes folder exists
  try {
    await fs.access(keyframesPath);
  } catch {
    console.error(`❌ Keyframes folder not found at: ${keyframesPath}`);
    throw new Error('Keyframes folder not found');
  }

  console.log('\n' + '═'.repeat(60));
  console.log('👁️  VISION + AUDIO PROCESSOR');
  console.log('═'.repeat(60));
  console.log(`\n📁 Processing: ${outputFolder}`);

  // Load personas
  const personas = await loadPersonas(outputFolder);
  if (personas) {
    console.log(`\n👥 Personas loaded:\n${personas}`);
  } else {
    console.log('\n👥 No personas file found - using generic character references');
  }

  // Load audio segments
  const audioSegments = await loadAudioSegments(outputFolder);
  const audioMap = new Map(audioSegments.map(s => [s.sceneNumber, s.audioPath]));
  console.log(`🎵 Audio segments loaded: ${audioSegments.length}\n`);

  // Find all scene folders
  const items = await fs.readdir(keyframesPath);
  const sceneFolders = items
    .filter(item => item.startsWith('scene_'))
    .sort((a, b) => {
      const numA = parseInt(a.replace('scene_', ''));
      const numB = parseInt(b.replace('scene_', ''));
      return numA - numB;
    });

  const totalScenes = sceneFolders.length;
  console.log(`📊 Found ${totalScenes} scenes to process\n`);
  console.log('─'.repeat(60) + '\n');

  const results = [];

  for (const sceneFolder of sceneFolders) {
    const sceneNumber = parseInt(sceneFolder.replace('scene_', ''));
    const scenePath = path.join(keyframesPath, sceneFolder);
    const audioPath = audioMap.get(sceneNumber) || null;

    console.log(`🎬 Scene ${sceneNumber}/${totalScenes}:`);

    // Get previous scene's story part for continuity (only if it exists and was successful)
    let previousSceneContext = null;
    if (sceneNumber > 1 && results[sceneNumber - 2]?.storyPart) {
      previousSceneContext = results[sceneNumber - 2].storyPart;
      console.log(`   🔗 Using previous scene context for continuity`);
    }

    try {
      const sceneResult = await processScene(scenePath, sceneNumber, totalScenes, personas, audioPath, previousSceneContext);
      
      if (sceneResult) {
        results.push({
          sceneNumber,
          ...sceneResult,
        });
        console.log(`   ✅ Processed successfully`);
        
        if (sceneResult.storyPart) {
          console.log(`   📖 "${sceneResult.storyPart.substring(0, 80)}..."`);
        }
      }
    } catch (error) {
      console.error(`   ❌ Error: ${error.message}`);
      results.push({
        sceneNumber,
        error: error.message,
      });
    }

    console.log('');
  }

  // Save scene-by-scene results
  const resultsPath = path.join(outputFolder, 'vision_results.json');
  await fs.writeFile(resultsPath, JSON.stringify(results, null, 2));

  // Generate cohesive final story
  let finalStory = '';
  try {
    finalStory = await generateFinalStory(results, personas);
  } catch (error) {
    console.error('❌ Failed to generate final story:', error.message);
    // Fallback to concatenated story parts
    finalStory = results
      .filter(r => r.storyPart)
      .map(r => r.storyPart)
      .join('\n\n');
  }

  const storyPath = path.join(outputFolder, 'story.txt');
  await fs.writeFile(storyPath, finalStory);

  console.log('═'.repeat(60));
  console.log('✨ PROCESSING COMPLETE');
  console.log('═'.repeat(60));
  console.log(`\n📄 Results saved to: ${resultsPath}`);
  console.log(`📖 Story saved to: ${storyPath}`);
  console.log(`\n📖 Final Story:\n`);
  console.log(finalStory || '(No story generated)');
  console.log('\n' + '═'.repeat(60) + '\n');

  return results;
}

// CLI entry point
async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log(`
╔═══════════════════════════════════════════════════════════╗
║      VISION + AUDIO PROCESSOR - OpenAI Analysis           ║
╠═══════════════════════════════════════════════════════════╣
║  Analyzes keyframe images AND transcribes audio           ║
║  to generate rich, character-driven stories.              ║
╚═══════════════════════════════════════════════════════════╝

Usage:
  node visionProcessor.js <output_folder>

Example:
  node visionProcessor.js ./output/3b71fb08-01fc-4427-b023-452612154e7a

Environment Variables:
  OPENAI_API_KEY - Your OpenAI API key (required)

Input Files:
  - keyframes/ folder with scene subfolders
  - audio/scenes/ folder with scene audio files
  - audio/audio_segments.json - Audio segment mapping
  - personas.txt (optional) - Character definitions

Output:
  - vision_results.json - Scene analysis with transcripts
  - story.txt - Cohesive story in Bahasa Melayu
`);
    process.exit(0);
  }

  if (!process.env.OPENAI_API_KEY) {
    console.error('❌ OPENAI_API_KEY environment variable is required');
    console.error('   Add it to your .env file: OPENAI_API_KEY=sk-...');
    process.exit(1);
  }

  const outputFolder = path.resolve(args[0]);

  try {
    await processOutputFolder(outputFolder);
    process.exit(0);
  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  }
}

// Only run CLI if this is the entry point
const isMainModule = process.argv[1]?.includes('visionProcessor.js');
if (isMainModule) {
  main();
}

export { processOutputFolder, processScene };
