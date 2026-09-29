
import { GoogleGenAI, Type, Schema, Modality } from "@google/genai";
import { 
  BookOutline, 
  ChapterOutline, 
  Source, 
  SourceType, 
  WritingStyle, 
  ManuscriptPov, 
  ManuscriptTense, 
  TargetDepth, 
  LoreVault 
} from "../types";
import { PricingService } from "./pricing";

// Helper to get a fresh instance with the current key
const getAI = () => new GoogleGenAI({ apiKey: process.env.API_KEY });

// Models (Google AI Studio Free Tier compliant models)
const MODEL_FAST = 'gemini-3.6-flash';
const MODEL_SMART = 'gemini-3.6-flash';
const MODEL_IMAGE = 'gemini-3.1-flash-lite-image';
const MODEL_TTS = 'gemini-3.1-flash-tts-preview';

const isFatalError = (error: any): boolean => {
  const msg = error?.message || '';
  const status = error?.status;
  // Fail fast on permission denied (leaked key, no quota, etc)
  if (status === 403 || status === 401) return true;
  if (msg.includes('leaked') || msg.includes('API key') || msg.includes('PERMISSION_DENIED')) return true;
  return false;
};

// Helper for delay
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export interface TrendResult {
  content: string;
  sources: { title: string; uri: string }[];
}

export const researchBookTrends = async (): Promise<TrendResult> => {
  try {
    const ai = getAI();
    const response = await ai.models.generateContent({
      model: MODEL_FAST, // Flash is efficient for search grounding
      contents: "Act as a publishing market analyst. Perform deep online research to identify the current top 5 trending ebook topics/genres for the current week/month. For each trend, provide: 1. The Genre/Topic Name. 2. Why it is trending (viral events, seasonal, etc). 3. Estimated gross sales potential or popularity ranking if available. 4. Target audience. 5. A specific 'Book Idea' prompt for a user. Summarize the findings in markdown.",
      config: {
        tools: [{ googleSearch: {} }],
      },
    });

    // Track Cost
    if (response.usageMetadata) {
      PricingService.trackUsage(
        MODEL_FAST, 
        response.usageMetadata.promptTokenCount || 0, 
        response.usageMetadata.candidatesTokenCount || 0
      );
    }

    const sources: { title: string; uri: string }[] = [];
    if (response.candidates?.[0]?.groundingMetadata?.groundingChunks) {
      response.candidates[0].groundingMetadata.groundingChunks.forEach((chunk: any) => {
        if (chunk.web?.uri && chunk.web?.title) {
          sources.push({ title: chunk.web.title, uri: chunk.web.uri });
        }
      });
    }

    return {
      content: response.text || "No trends found.",
      sources: sources
    };
  } catch (error) {
    console.error("Trend research error:", error);
    throw new Error("Failed to research trends.");
  }
};

export const transcribeAudio = async (base64Audio: string, mimeType: string): Promise<string> => {
  try {
    const ai = getAI();
    const response = await ai.models.generateContent({
      model: MODEL_FAST,
      contents: {
        parts: [
          {
            inlineData: {
              data: base64Audio,
              mimeType: mimeType
            }
          },
          {
            text: "Transcribe the following audio precisely. Return only the transcript text."
          }
        ]
      }
    });

    if (response.usageMetadata) {
      PricingService.trackUsage(
        MODEL_FAST, 
        response.usageMetadata.promptTokenCount || 0, 
        response.usageMetadata.candidatesTokenCount || 0
      );
    }

    return response.text || "";
  } catch (error) {
    console.error("Transcription error:", error);
    throw new Error("Failed to transcribe audio.");
  }
};

export const generateOutline = async (
  sources: Source[], 
  customInstruction?: string,
  options?: { pov?: ManuscriptPov; tense?: ManuscriptTense; targetDepth?: TargetDepth }
): Promise<BookOutline> => {
  const parts: any[] = [];

  // 1. System Instruction / Goal
  let systemText = `You are a world-class literary editor and master storyteller. Analyze the provided source materials to build a comprehensive book outline and a rich Story & Lore Vault.
    
    The source material may include text notes, audio transcripts, and visual references (images).
    Find the narrative arc, core themes, key events, character dynamics, and world/technical details.
    
    STRUCTURE REQUIREMENTS:
    1. Introduction: Include a distinct "Introduction" chapter first (assign it chapterNumber: 0). Setting the stage, tone, and hook without summarizing the entire ending. The Introduction must only establish tone and promise — it must NOT narrate specific events reserved for Chapter 1 or later, and must NOT spoil the ending or major twists.
    2. Chapter 1: Begin the main narrative or core subject content.
    3. Subsequent Chapters: Develop the story or non-fiction ideas logically step-by-step with clear chapter goals.
    
    CHAPTER UNIQUENESS REQUIREMENTS (CRITICAL - prevents repetitive chapters):
    - No two chapters may cover the same event, scene, or topic. Each chapter's summary must begin exactly where the previous chapter's summary ends.
    - Write each chapter summary as a forward-moving arc: (a) the state entering the chapter, (b) what NEW developments happen in THIS chapter only, (c) how the chapter ends and the state the next chapter inherits.
    - Every chapter after the first must introduce at least one genuinely new development, location, reveal, or consequence. If a summary would repeat a prior summary, cut it or fold it into the neighboring chapter.
    - Do not restate a character's introduction, a world rule, or a piece of backstory in more than one chapter summary.
    
    LORE VAULT REQUIREMENTS:
    - Extract key characters with their roles and distinct traits/profiles.
    - Extract world/setting details or core foundational principles.
    - Extract key terminology, jargon, or recurring concepts.
    - Summarize overarching plot arcs or structural rules.`;

  if (options) {
    if (options.pov) systemText += `\nTarget Point of View: ${options.pov}`;
    if (options.tense) systemText += `\nTarget Tense: ${options.tense}`;
    if (options.targetDepth) systemText += `\nTarget Chapter Depth: ${options.targetDepth}`;
  }

  if (customInstruction && customInstruction.trim()) {
    systemText += `\n\nIMPORTANT SPECIAL INSTRUCTIONS:\nThe user provided specific guidance: "${customInstruction}". Prioritize this guidance when structuring the outline.`;
  }

  parts.push({ text: systemText });

  // 2. Add Sources
  for (const source of sources) {
    if (source.type === SourceType.TEXT) {
      parts.push({ text: `\n\n--- Source: ${source.name} (Notes) ---\n${source.content}` });
    } else if (source.type === SourceType.AUDIO && source.transcription) {
      parts.push({ text: `\n\n--- Source: ${source.name} (Transcript) ---\n${source.transcription}` });
    } else if (source.type === SourceType.IMAGE) {
       parts.push({ text: `\n\n--- Source: ${source.name} (Visual Reference) ---` });
       parts.push({
         inlineData: {
           data: source.content,
           mimeType: source.mimeType || 'image/jpeg'
         }
       });
    }
  }

  const schema: Schema = {
    type: Type.OBJECT,
    properties: {
      title: { type: Type.STRING, description: "A creative and engaging title for the book." },
      description: { type: Type.STRING, description: "A compelling synopsis of the book." },
      chapters: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            chapterNumber: { type: Type.INTEGER },
            title: { type: Type.STRING },
            summary: { type: Type.STRING, description: "Unique narrative beats for THIS chapter only, written as a forward-moving arc: (a) the state entering the chapter, (b) new developments exclusive to this chapter, (c) how it ends and the state the next chapter inherits. Must not repeat events, introductions, or rules covered by other chapters." }
          },
          required: ["chapterNumber", "title", "summary"]
        }
      },
      loreVault: {
        type: Type.OBJECT,
        properties: {
          characters: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                name: { type: Type.STRING },
                role: { type: Type.STRING },
                description: { type: Type.STRING }
              },
              required: ["name", "role", "description"]
            }
          },
          worldAndSetting: { type: Type.STRING, description: "Description of settings, environments, or core domain framework." },
          keyTermsAndConcepts: { 
            type: Type.ARRAY, 
            items: { type: Type.STRING },
            description: "List of key terms, character motivations, or concepts." 
          },
          plotArcsAndRules: { type: Type.STRING, description: "Summary of plot arcs, thematic goals, or non-fiction principles." }
        },
        required: ["characters", "worldAndSetting", "keyTermsAndConcepts", "plotArcsAndRules"]
      }
    },
    required: ["title", "description", "chapters", "loreVault"]
  };

  try {
    const ai = getAI();
    const response = await ai.models.generateContent({
      model: MODEL_SMART,
      contents: { parts },
      config: {
        responseMimeType: "application/json",
        responseSchema: schema,
      }
    });
    
    if (response.usageMetadata) {
      PricingService.trackUsage(
        MODEL_SMART, 
        response.usageMetadata.promptTokenCount || 0, 
        response.usageMetadata.candidatesTokenCount || 0
      );
    }

    if (!response.text) {
        throw new Error("AI returned an empty response. Please try again or check your source material.");
    }
    
    const jsonStr = response.text.replace(/```json/g, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(jsonStr) as BookOutline;
    if (parsed.loreVault || parsed.loreBible) {
      const vault = parsed.loreVault || parsed.loreBible;
      parsed.loreVault = vault;
      parsed.loreBible = vault;
    }
    return parsed;
  } catch (error) {
    console.error("Outline generation error:", error);
    if (isFatalError(error)) throw error;
    throw new Error("Failed to generate outline.");
  }
};

export const generateImage = async (prompt: string, aspectRatio: "1:1" | "3:4" | "4:3" | "16:9" | "9:16" = "1:1"): Promise<string> => {
  try {
    const ai = getAI();
    const response = await ai.models.generateContent({
      model: MODEL_IMAGE,
      contents: {
        parts: [
          { text: prompt }
        ]
      },
      config: {
        imageConfig: {
          aspectRatio: aspectRatio,
          imageSize: "1K" 
        }
      }
    });

    PricingService.trackUsage(MODEL_IMAGE, 1, 0);

    if (response.candidates) {
      for (const candidate of response.candidates) {
        if (candidate.content && candidate.content.parts) {
          for (const part of candidate.content.parts) {
            if (part.inlineData && part.inlineData.data) {
              return part.inlineData.data;
            }
          }
        }
      }
    }
    
    if (response.promptFeedback?.blockReason) {
        throw new Error(`Image generation blocked: ${response.promptFeedback.blockReason}`);
    }
    
    throw new Error("No image data found in response.");
  } catch (error) {
    console.error("Image generation error:", error);
    if (isFatalError(error)) throw error;
    throw new Error("Failed to generate image.");
  }
};

export interface ChapterWriteOptions {
  style?: WritingStyle;
  pov?: ManuscriptPov;
  tense?: ManuscriptTense;
  targetDepth?: TargetDepth;
  twoPassPolish?: boolean;
  previousChapterTitle?: string;
  previousChapterEnding?: string;
  storySoFarRecap?: string;
  loreVault?: LoreVault;
  loreBible?: LoreVault;
}

export const writeChapter = async (
  chapter: ChapterOutline,
  outline: BookOutline,
  sources: Source[],
  options: ChapterWriteOptions = {}
): Promise<string> => {
   
   const {
     style = 'standard',
     pov = 'third_limited',
     tense = 'past',
     targetDepth = 'standard',
     twoPassPolish = true,
     previousChapterTitle,
     previousChapterEnding,
     storySoFarRecap,
     loreVault = options.loreVault || options.loreBible || outline.loreVault || outline.loreBible
   } = options;

   const parts: any[] = [];
   const isIntro = chapter.chapterNumber === 0;
   const chapterLabel = isIntro ? "Introduction" : `Chapter ${chapter.chapterNumber}`;

   // Target Word Count Guidelines
   const depthWordTargets: Record<TargetDepth, string> = {
     short: "Aim for approximately 1,200 to 1,500 words. Keep scenes punchy and fast-moving.",
     standard: "Aim for approximately 2,200 to 2,800 words. Develop deep scenes, rich dialogue, and sensory atmosphere.",
     epic: "Aim for an expansive 3,200 to 4,000 words. Fully flesh out every detail, character monologue, subtle subtext, and scene nuance."
   };

   // POV Directives
   const povInstructions: Record<ManuscriptPov, string> = {
     first: "Write strictly in FIRST-PERSON ('I', 'me', 'my', 'we'). Provide deep internal thoughts and immediate subjective perspective.",
     third_limited: "Write strictly in THIRD-PERSON LIMITED ('he', 'she', 'they'). Focus closely on the main character's experience without switching perspectives mid-scene.",
     second: "Write strictly in SECOND-PERSON ('you', 'your'). Directly engage the reader in an immersive, immediate manner.",
     omniscient: "Write in THIRD-PERSON OMNISCIENT ('he', 'she', 'they'). Provide wide narrative perspective and insight into multiple characters/elements."
   };

   // Tense Directives
   const tenseInstructions: Record<ManuscriptTense, string> = {
     past: "Write strictly in PAST TENSE ('walked', 'said', 'realized'). Maintain total grammatical consistency.",
     present: "Write strictly in PRESENT TENSE ('walks', 'says', 'realizes'). Create urgent, immediate narrative flow."
   };

   const styleInstructions: Record<WritingStyle, string> = {
     'standard': 'Write in a clear, engaging, and professional bestseller style.',
     'literary': 'Use rich sensory descriptions, evocative metaphors, and elevated prose.',
     'humorous': 'Be witty, light-hearted, clever, and entertaining.',
     'technical': 'Be precise, factual, educational, and structured.',
     'simple': 'Use direct sentence structures and accessible vocabulary for seamless readability.',
     'sarcastic': 'Write in a highly sarcastic, witty manner with sharp humor and a cynical tone.'
   };

   let systemPrompt = `You are an award-winning bestseller author writing one chapter of an ongoing book. The reader has already read every preceding chapter. Write the complete manuscript content for ${chapterLabel}: "${chapter.title}".

BOOK CONTEXT:
- Title: ${outline.title}
- Synopsis: ${outline.description}
- THIS CHAPTER'S GOAL & SUMMARY: ${chapter.summary}
  Cover ONLY the events described in this chapter's summary. Events from other chapters' summaries are already written and must NOT be re-created here.

MANUSCRIPT STYLE & FORMATTING DIRECTIVES:
- Word Count Target: ${depthWordTargets[targetDepth]}
- Point of View: ${povInstructions[pov]}
- Tense: ${tenseInstructions[tense]}
- Literary Style: ${styleInstructions[style]}`;

   if (loreVault) {
     systemPrompt += `\n\nSTORY & LORE VAULT (REFERENCE ONLY): Use this to keep characters, facts, and terms consistent. It is background knowledge for YOU — never dump it into prose, and never re-explain to the reader what the reader already knows.`;
     if (loreVault.characters && loreVault.characters.length > 0) {
       systemPrompt += `\n- Key Characters: ${loreVault.characters.map(c => `${c.name} (${c.role}): ${c.description}`).join('; ')}`;
     }
     if (loreVault.worldAndSetting) {
       systemPrompt += `\n- Setting & World Rules: ${loreVault.worldAndSetting}`;
     }
     if (loreVault.keyTermsAndConcepts && loreVault.keyTermsAndConcepts.length > 0) {
       systemPrompt += `\n- Terminology & Concepts: ${loreVault.keyTermsAndConcepts.join(', ')}`;
     }
   }

   if (storySoFarRecap && storySoFarRecap.trim()) {
     systemPrompt += `\n\nREADER KNOWLEDGE (what has already happened in preceding chapters — continuity context FOR YOU ONLY):
${storySoFarRecap.trim()}

These events are already on the page. NEVER summarize, retell, flash back to, or re-explain them in your chapter text.`;
   }

   if (previousChapterEnding && previousChapterEnding.trim()) {
     const seamLabel = previousChapterTitle && previousChapterTitle.trim() ? `"${previousChapterTitle.trim()}"` : 'the previous chapter';
     systemPrompt += `\n\nSEAM — CONTINUE FROM HERE:
The chapter immediately before this one, ${seamLabel}, literally ended with this passage:
<<<${previousChapterEnding.trim()}>>>
Open your chapter in the moment right AFTER this passage — in the next scene beat of your own chapter. Never quote, paraphrase, or restate these final lines, and do not re-describe the scene that just finished. Do not re-introduce characters, restart the timeline, or recap what led to this moment.`;
   }

   if (isIntro) {
     systemPrompt += `\n\nINTRODUCTION-SPECIFIC RULES:
- This Introduction establishes tone, promise, and hook ONLY. It must not narrate specific plot events that belong to Chapter 1 or later, and must not reveal the ending or major twists.
- Do not open with meta-framing such as "In this book..." or "This book is about...". Dramatize instead.`;
   }

   systemPrompt += `\n\nNON-REPETITION & FLOW RULES (CRITICAL):
1. Open in medias res: the story is already in motion. Never open with a recap of past events, a re-establishment of the setting, or a summary of where the characters "find themselves" after earlier chapters.
2. Characters never re-introduce themselves and never re-explain facts, plans, or relationships the reader already knows. Dialogue may reference established history naturally, but must not restate it.
3. Never re-explain world rules, terminology, or backstory that earlier chapters already established. If the reader already knows it, leave it implicit.
4. Every paragraph must advance the story with NEW information: new action, new dialogue, new thought, or new sensory detail. Delete any paragraph that only restates prior material.
5. If this chapter's summary overlaps something that already happened in the READER KNOWLEDGE section, skip ahead to the new material — do not re-enact it.
6. Vary sentence rhythm, paragraph lengths, and scene openings. Never repeat the same phrase, image, or idea twice within the chapter.
7. Introduce at least one genuinely new development, reveal, or consequence that moves the book forward.

CHAPTER SCENE STRUCTURE (3 Narrative Beats — each beat covers DISTINCT new material, never the same moment twice):
1. Beat 1 (Immediate Scene & Objective): Ground the reader in the immediate physical environment, sensory atmosphere, current emotional baseline, and scene objective — as they are right now, not how they got here.
2. Beat 2 (Escalation & Core Development): Unfold key character interactions, natural dialogue with subtext, core thematic developments, or non-fiction analysis.
3. Beat 3 (Resolution & Narrative Hook): Bring the chapter's immediate arc to a resonant climax, shift character/thematic baseline, and end with a compelling transition or cliffhanger that the next chapter can pick up.

ANTI-SUMMARY DIRECTIVES ("SHOW, DON'T TELL"):
- Write in fully dramatized, immersive scenes. Use realistic dialogue, internal monologue, sensory details (sights, sounds, textures, scents), and physical beats.
- NEVER summarize plot jumps or use meta-phrases like 'In conclusion', 'As time passed', or 'Overall'.
- BAN AI CLICHÉS: Strictly avoid cliché phrases such as 'a testament to', 'in a world where', 'little did they know', 'a tapestry of', 'beacon of', or 'delve'. Format using Markdown paragraphs and headings.`;

   parts.push({ text: systemPrompt });

   // Add Sources
   for (const source of sources) {
      if (source.type === SourceType.TEXT) {
        parts.push({ text: `\n[Reference Source: ${source.name} — research material for consistency only; never copy its wording verbatim]:\n${source.content.slice(0, 5000)}` });
      } else if (source.type === SourceType.AUDIO && source.transcription) {
        parts.push({ text: `\n[Reference Source: ${source.name} — research material for consistency only; never copy its wording verbatim]:\n${source.transcription.slice(0, 5000)}` });
      } else if (source.type === SourceType.IMAGE) {
        parts.push({ text: `\n[Reference Source: ${source.name} (Image Reference)]` });
        parts.push({
          inlineData: {
             data: source.content,
             mimeType: source.mimeType || 'image/jpeg'
          }
        });
      }
   }
 
   const MAX_RETRIES = 5;
   let lastError;
   let draftContent = "";
   const ai = getAI();

   // Primary Model Attempt (Pro)
   for (let i = 0; i < MAX_RETRIES; i++) {
     try {
       const response = await ai.models.generateContent({
         model: MODEL_SMART,
         contents: { parts }
       });
       
       if (response.usageMetadata) {
         PricingService.trackUsage(
           MODEL_SMART, 
           response.usageMetadata.promptTokenCount || 0, 
           response.usageMetadata.candidatesTokenCount || 0
         );
       }
   
       draftContent = response.text || "";
       break;
     } catch (error: any) {
        lastError = error;
        if (isFatalError(error)) throw error; 
        console.warn(`Smart model attempt ${i + 1} failed for chapter ${chapter.chapterNumber}:`, error.message);
        await delay(2000 * Math.pow(2, i));
     }
   }

   // Fallback Model Attempt (Flash) if Pro failed
   if (!draftContent) {
     console.warn(`All primary attempts failed. Falling back to ${MODEL_FAST} for chapter ${chapter.chapterNumber}`);
     for (let i = 0; i < MAX_RETRIES; i++) {
        try {
            const response = await ai.models.generateContent({
              model: MODEL_FAST,
              contents: { parts }
            });

            if (response.usageMetadata) {
              PricingService.trackUsage(
                MODEL_FAST, 
                response.usageMetadata.promptTokenCount || 0, 
                response.usageMetadata.candidatesTokenCount || 0
              );
            }

            draftContent = response.text || "";
            break;
        } catch (fallbackError: any) {
            lastError = fallbackError;
            if (isFatalError(fallbackError)) throw fallbackError;

            console.warn(`Fallback model attempt ${i + 1} failed:`, fallbackError.message);
            await delay(2000 * Math.pow(2, i));
        }
     }
   }

   if (!draftContent) {
     throw new Error(`Failed to write ${chapterLabel} after multiple attempts. Last error: ${lastError?.message}`);
   }

   // Two-Pass Generation: Automatic Style Polish Pass
   if (twoPassPolish) {
     try {
       console.log(`Running Pass 2 (Style Refinement) on chapter ${chapter.chapterNumber}...`);
       const polished = await refineChapterText(
         draftContent, 
         `Perform a master literary polish pass on this chapter. 
         1. Eliminate any remaining AI clichés ('testament to', 'tapestry', 'little did they know', 'beacon', 'delve', 'realm').
         2. Convert passive constructions to active, vivid verbs.
         3. Strengthen character dialogue cadence and sensory atmosphere.
         4. Maintain exact story events, length, POV (${pov}), and tense (${tense}).`
          5. DELETED-PLACEHOLDER
       );
       if (polished && polished.trim().length > 100) {
         return polished;
       }
     } catch (polishErr) {
       console.warn(`Pass 2 style refinement encountered an error, keeping draft:`, polishErr);
     }
   }

   return draftContent;
};

export const refineChapterText = async (currentContent: string, instruction: string): Promise<string> => {
  try {
    const ai = getAI();

    // Map common preset instructions to detailed editor directives
    let detailedInstruction = instruction;
    if (instruction.includes('sensory') || instruction.includes('Deepen Sensory')) {
      detailedInstruction = "Enhance the text with vivid sensory details (sights, sounds, textures, scents, and physical atmosphere). Show, don't tell, without adding redundant filler.";
    } else if (instruction.includes('dialogue') || instruction.includes('Enrich Dialogue')) {
      detailedInstruction = "Expand and refine character dialogue with realistic subtext, distinct vocal tones, natural pauses, and physical action beats.";
    } else if (instruction.includes('pacing') || instruction.includes('Accelerate Pacing')) {
      detailedInstruction = "Heighten tension, tighten sentence structure, remove slow exposition, and increase narrative momentum.";
    } else if (instruction.includes('cliché') || instruction.includes('Strip AI Clichés')) {
      detailedInstruction = "Eliminate AI clichés ('testament to', 'in a world where', 'little did they know', 'tapestry', 'delve', 'beacon'), convert passive voice to active verbs, and sharpen vocabulary.";
    }

    const response = await ai.models.generateContent({
      model: MODEL_FAST, // Use fast model for editing/polishing
      contents: {
        parts: [
          {
            text: `You are an expert bestseller book editor.
            
            EDITING TASK: ${detailedInstruction}
            
            CURRENT TEXT:
            ${currentContent}
            
            Return ONLY the rewritten manuscript text in clean Markdown format. Do NOT add conversational intro/outro filler.`
          }
        ]
      }
    });

    if (response.usageMetadata) {
      PricingService.trackUsage(
        MODEL_FAST, 
        response.usageMetadata.promptTokenCount || 0, 
        response.usageMetadata.candidatesTokenCount || 0
      );
    }

    return response.text || currentContent;
  } catch (error) {
    console.error("Refine text error:", error);
    if (isFatalError(error)) throw error;
    throw error;
  }
};

export const generateSpeech = async (text: string, voiceName: string = 'Kore'): Promise<string> => {
  try {
    const ai = getAI();
    const response = await ai.models.generateContent({
      model: MODEL_TTS,
      contents: {
        parts: [{ text: text }]
      },
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: voiceName },
          },
        },
      },
    });

    PricingService.trackUsage(MODEL_TTS, text.length, 0);

    const audioData = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!audioData) {
      throw new Error("No audio data generated");
    }
    return audioData;
  } catch (error) {
    console.error("TTS generation error:", error);
    return "";
  }
};
