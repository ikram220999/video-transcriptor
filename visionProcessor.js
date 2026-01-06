import fs from 'fs/promises';
import path from 'path';
import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/**
 * Vision Processor
 * 
 * Processes keyframe images through OpenAI Vision to extract story parts
 * 
 * Usage: node visionProcessor.js <output_folder>
 */

async function processScene(scenePath, sceneNumber) {
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

  // Send to OpenAI Vision
  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `You are analyzing keyframes from Scene ${sceneNumber} of a video. These ${imageFiles.length} images are sequential frames from this scene.

Analyze these images and provide:
1. A brief description of what's happening in this scene
2. Key visual elements (people, objects, locations, actions)
3. The mood/atmosphere of the scene
4. Any text visible in the images

Format your response as a JSON object with these fields:
{
  "description": "Brief narrative description of the scene",
  "visualElements": ["list", "of", "key", "elements"],
  "mood": "The mood/atmosphere",
  "visibleText": ["any", "text", "seen"] or null,
  "storyPart": "A one-sentence story contribution from this scene"
}`,
          },
          ...imageContents,
        ],
      },
    ],
    max_tokens: 500,
  });

  const content = response.choices[0].message.content;
  
  // Try to parse as JSON
  try {
    // Extract JSON from response (handle markdown code blocks)
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch (e) {
    // If parsing fails, return raw content
    return { rawResponse: content };
  }

  return { rawResponse: content };
}

async function processOutputFolder(outputFolder) {
  const keyframesPath = path.join(outputFolder, 'keyframes');

  // Check if keyframes folder exists
  try {
    await fs.access(keyframesPath);
  } catch {
    console.error(`❌ Keyframes folder not found at: ${keyframesPath}`);
    process.exit(1);
  }

  console.log('\n' + '═'.repeat(60));
  console.log('👁️  VISION PROCESSOR - OpenAI Image Analysis');
  console.log('═'.repeat(60));
  console.log(`\n📁 Processing: ${outputFolder}`);

  // Find all scene folders
  const items = await fs.readdir(keyframesPath);
  const sceneFolders = items
    .filter(item => item.startsWith('scene_'))
    .sort((a, b) => {
      const numA = parseInt(a.replace('scene_', ''));
      const numB = parseInt(b.replace('scene_', ''));
      return numA - numB;
    });

  console.log(`📊 Found ${sceneFolders.length} scenes to process\n`);
  console.log('─'.repeat(60) + '\n');

  const results = [];

  for (const sceneFolder of sceneFolders) {
    const sceneNumber = parseInt(sceneFolder.replace('scene_', ''));
    const scenePath = path.join(keyframesPath, sceneFolder);

    console.log(`🎬 Scene ${sceneNumber}:`);

    try {
      const sceneResult = await processScene(scenePath, sceneNumber);
      
      if (sceneResult) {
        results.push({
          sceneNumber,
          ...sceneResult,
        });
        console.log(`   ✅ Processed successfully`);
        
        if (sceneResult.storyPart) {
          console.log(`   📝 "${sceneResult.storyPart}"`);
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

  // Save results
  const resultsPath = path.join(outputFolder, 'vision_results.json');
  await fs.writeFile(resultsPath, JSON.stringify(results, null, 2));

  // Generate full story
  const storyParts = results
    .filter(r => r.storyPart)
    .map(r => r.storyPart);

  const fullStory = storyParts.join(' ');

  const storyPath = path.join(outputFolder, 'story.txt');
  await fs.writeFile(storyPath, fullStory);

  console.log('═'.repeat(60));
  console.log('✨ PROCESSING COMPLETE');
  console.log('═'.repeat(60));
  console.log(`\n📄 Results saved to: ${resultsPath}`);
  console.log(`📖 Story saved to: ${storyPath}`);
  console.log(`\n📖 Full Story:\n`);
  console.log(fullStory || '(No story parts generated)');
  console.log('\n' + '═'.repeat(60) + '\n');

  return results;
}

// CLI entry point
async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log(`
╔═══════════════════════════════════════════════════════════╗
║           VISION PROCESSOR - OpenAI Image Analysis        ║
╠═══════════════════════════════════════════════════════════╣
║  Analyzes keyframe images using OpenAI Vision API         ║
║  to extract story parts from each scene.                  ║
╚═══════════════════════════════════════════════════════════╝

Usage:
  node visionProcessor.js <output_folder>

Example:
  node visionProcessor.js ./output/3b71fb08-01fc-4427-b023-452612154e7a

Environment Variables:
  OPENAI_API_KEY - Your OpenAI API key (required)

Output:
  - vision_results.json - Detailed analysis of each scene
  - story.txt - Combined story from all scenes
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

main();

export { processOutputFolder, processScene };

