
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

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
const MODEL_CHAT = "deepseek-chat";
const KEY_STORAGE = "lore_deepseek_key";

// ---------------------------------------------------------------------------
// API Key Management (stored locally in the browser; env var takes priority)
// ---------------------------------------------------------------------------
const envKey = (import.meta as any)?.env?.VITE_DEEPSEEK_API_KEY as string | undefined;

export const getDeepseekKey = (): string => {
  if (envKey && envKey.trim()) return envKey.trim();
  try {
    return localStorage.getItem(KEY_STORAGE) || "";
  } catch {
    return "";
  }
};

export const setDeepseekKey = (key: string) => {
  try {
    localStorage.setItem(KEY_STORAGE, key.trim());
  } catch (e) {
    console.warn("Could not persist API key:", e);
  }
};

export const hasDeepseekKey = (): boolean => !!getDeepseekKey().trim();

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------
export class DeepseekError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

// Fail fast on auth/billing problems; retry transient ones (429, 5xx).
const isFatalError = (error: any): boolean => {
  const status = error?.status;
  if (status === 400 || status === 401 || status === 402) return true;
  const msg = error?.message || "";
  if (msg.includes("Invalid API key") || msg.includes("Insufficient Balance") || msg.includes("Authentication Fails")) return true;
  return false;
};

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Low-level chat helpers
// ---------------------------------------------------------------------------
export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatResult {
  content: string;
  finishReason: string | null;
  promptTokens: number;
  completionTokens: number;
}

interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
}

const chatOnce = async (messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> => {
  const apiKey = getDeepseekKey();
  if (!apiKey) {
    throw new DeepseekError("No DeepSeek API key configured. Add your key on the welcome screen.", 401);
  }

  const body: any = {
    model: MODEL_CHAT,
    messages,
    stream: false,
    temperature: opts.temperature ?? 0.9,
    max_tokens: opts.maxTokens ?? 8192,
  };
  if (opts.jsonMode) {
    body.response_format = { type: "json_object" };
  }

  const response = await fetch(DEEPSEEK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    let detail = "";
    try {
      const errJson = await response.json();
      detail = errJson?.error?.message || JSON.stringify(errJson);
    } catch {
      /* ignore body parse errors */
    }
    throw new DeepseekError(`DeepSeek API error (${response.status})${detail ? `: ${detail}` : ""}`, response.status);
  }

  const json = await response.json();
  const choice = json?.choices?.[0];
  return {
    content: choice?.message?.content ?? "",
    finishReason: choice?.finish_reason ?? null,
    promptTokens: json?.usage?.prompt_tokens ?? 0,
    completionTokens: json?.usage?.completion_tokens ?? 0,
  };
};

// Retries transient failures with exponential backoff and tracks real usage.
const chatWithRetries = async (messages: ChatMessage[], opts: ChatOptions = {}, maxRetries = 4): Promise<ChatResult> => {
  let lastError: any;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const result = await chatOnce(messages, opts);
      if (result.finishReason === "length") {
        // Output hit the token ceiling and was cut off — treat as a failure and retry.
        throw new DeepseekError("Response was truncated (length limit).", 0);
      }
      if (result.promptTokens > 0 || result.completionTokens > 0) {
        PricingService.trackUsage(MODEL_CHAT, result.promptTokens, result.completionTokens);
      }
      return result;
    } catch (error: any) {
      lastError = error;
      if (isFatalError(error)) throw error;
      if (attempt < maxRetries) {
        const waitMs = 1500 * Math.pow(2, attempt) + Math.random() * 1000;
        console.warn(`DeepSeek attempt ${attempt + 1} failed: ${error.message}. Retrying in ${Math.round(waitMs)}ms...`);
        await delay(waitMs);
      }
    }
  }
  throw lastError;
};

// ---------------------------------------------------------------------------
// Source material → prompt text (DeepSeek is text-only)
// ---------------------------------------------------------------------------
const buildSourceText = (sources: Source[]): string => {
  const chunks: string[] = [];
  let skippedImages = 0;
  for (const source of sources) {
    if (source.type === SourceType.TEXT) {
      chunks.push(`\n[Reference Material: ${source.name}]\n${source.content.slice(0, 6000)}`);
    } else if (source.type === SourceType.AUDIO && source.transcription) {
      chunks.push(`\n[Reference Material: ${source.name} (transcript)]\n${source.transcription.slice(0, 6000)}`);
    } else if (source.type === SourceType.IMAGE) {
      skippedImages++;
    }
  }
  if (skippedImages > 0) {
    chunks.push(`\n[Note: ${skippedImages} image source(s) were skipped — the current AI provider cannot analyze images.]`);
  }
  return chunks.join("\n").trim();
};

// ---------------------------------------------------------------------------
// 1. Outline generation (structured JSON)
// ---------------------------------------------------------------------------
export const generateOutline = async (
  sources: Source[],
  customInstruction?: string,
  options?: { pov?: ManuscriptPov; tense?: ManuscriptTense; targetDepth?: TargetDepth }
): Promise<BookOutline> => {
  let systemText = `You are a world-class literary editor and master storyteller. Analyze the provided source materials to build a comprehensive book outline and a rich Story & Lore Vault.

    The source material includes text notes and transcripts.
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

  systemText += `\n\nOUTPUT FORMAT (json):
Return ONLY a valid JSON object — no markdown fences, no commentary — with exactly this shape:
{
  "title": "string",
  "description": "string",
  "chapters": [
    { "chapterNumber": 0, "title": "Introduction title", "summary": "string" },
    { "chapterNumber": 1, "title": "string", "summary": "string" }
  ],
  "loreVault": {
    "characters": [ { "name": "string", "role": "string", "description": "string" } ],
    "worldAndSetting": "string",
    "keyTermsAndConcepts": ["string"],
    "plotArcsAndRules": "string"
  }
}
Rules:
- "chapters" must include the Introduction with chapterNumber 0 first, then Chapter 1, Chapter 2, ... in strictly ascending order.
- Every chapter summary is unique and non-overlapping, written as entering state -> new developments -> how it ends.`;

  const sourceText = buildSourceText(sources);
  const messages: ChatMessage[] = [
    { role: "system", content: systemText },
    { role: "user", content: `SOURCE MATERIALS:\n${sourceText || "(No source materials provided — create from your own imagination.)"}\n\nNow produce the book outline JSON.` }
  ];

  const parseOutlineJson = (raw: string): BookOutline => {
    let text = (raw || "").trim();
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenceMatch) text = fenceMatch[1].trim();
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end <= start) throw new Error("No JSON object found in response.");
    const data = JSON.parse(text.slice(start, end + 1));
    if (!data || typeof data !== "object") throw new Error("Parsed value is not an object.");
    if (typeof data.title !== "string") throw new Error("Missing 'title'.");
    if (!Array.isArray(data.chapters) || data.chapters.length === 0) throw new Error("Missing 'chapters' array.");
    if (!data.loreVault) throw new Error("Missing 'loreVault'.");

    const loreVault: LoreVault = {
      characters: Array.isArray(data.loreVault.characters)
        ? data.loreVault.characters.map((c: any) => ({
            name: String(c.name || ""),
            role: String(c.role || ""),
            description: String(c.description || "")
          }))
        : [],
      worldAndSetting: String(data.loreVault.worldAndSetting || ""),
      keyTermsAndConcepts: Array.isArray(data.loreVault.keyTermsAndConcepts)
        ? data.loreVault.keyTermsAndConcepts.map((t: any) => String(t))
        : [],
      plotArcsAndRules: String(data.loreVault.plotArcsAndRules || "")
    };

    const outline: BookOutline = {
      title: String(data.title),
      description: typeof data.description === "string" ? data.description : "",
      chapters: data.chapters.map((c: any) => ({
        chapterNumber: Number(c.chapterNumber) || 0,
        title: String(c.title || "Untitled"),
        summary: String(c.summary || "")
      })),
      loreVault
    };
    outline.loreBible = loreVault;
    return outline;
  };

  // First attempt
  let result = await chatWithRetries(messages, { temperature: 0.6, maxTokens: 8192, jsonMode: true }, 3);
  try {
    return parseOutlineJson(result.content);
  } catch (parseError) {
    console.warn("Outline JSON parse failed, asking for a repair:", parseError);
    // One repair attempt with the model's own output as context
    const repairMessages: ChatMessage[] = [
      ...messages,
      { role: "assistant", content: result.content },
      { role: "user", content: "Your previous response was not a valid JSON object matching the required shape. Return ONLY the corrected JSON object now." }
    ];
    const repaired = await chatWithRetries(repairMessages, { temperature: 0.4, maxTokens: 8192, jsonMode: true }, 2);
    try {
      return parseOutlineJson(repaired.content);
    } catch (repairError) {
      console.error("Outline JSON repair failed:", repairError);
      throw new Error("Failed to generate outline: the AI returned an unparseable response. Please try again.");
    }
  }
};

// ---------------------------------------------------------------------------
// 2. Chapter writing
// ---------------------------------------------------------------------------
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

  const isIntro = chapter.chapterNumber === 0;
  const chapterLabel = isIntro ? "Introduction" : `Chapter ${chapter.chapterNumber}`;

  // Target Word Count Guidelines
  const depthWordTargets: Record<TargetDepth, string> = {
    short: "Aim for approximately 1,200 to 1,500 words. Keep scenes punchy and fast-moving.",
    standard: "Aim for approximately 2,200 to 2,800 words. Develop deep scenes, rich dialogue, and sensory atmosphere.",
    epic: "Aim for an expansive 3,200 to 3,800 words. Fully flesh out every detail, character monologue, subtle subtext, and scene nuance."
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
- BAN AI CLICHÉS: Strictly avoid cliché phrases such as 'a testament to', 'in a world where', 'little did they know', 'a tapestry of', 'beacon of', or 'delve'.
- Use source material as research for consistency only; never copy its wording verbatim.
- Format using Markdown paragraphs and headings.`;

  const sourceText = buildSourceText(sources);
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: sourceText
        ? `REFERENCE MATERIALS (consistency research only — do not copy wording):\n${sourceText}\n\nNow write ${chapterLabel} exactly as instructed.`
        : `Now write ${chapterLabel} exactly as instructed.`
    }
  ];

  const result = await chatWithRetries(messages, { temperature: 0.9, maxTokens: 8192 }, 4);
  const draftContent = (result.content || "").trim();
  if (!draftContent) {
    throw new Error(`Failed to write ${chapterLabel}: the AI returned an empty response.`);
  }

  // Two-Pass Generation: Automatic Style Polish Pass
  if (twoPassPolish) {
    try {
      console.log(`Running Pass 2 (Style Refinement) on chapter ${chapter.chapterNumber}...`);
      const seamHint = previousChapterEnding ? ` It follows a previous chapter that ended near: "${previousChapterEnding.trim().slice(0, 300)}".` : '';
      const polished = await refineChapterText(
        draftContent,
        `Perform a master literary polish pass on this chapter.${seamHint}
        1. Eliminate any remaining AI clichés ('testament to', 'tapestry', 'little did they know', 'beacon', 'delve', 'realm').
        2. Convert passive constructions to active, vivid verbs.
        3. Strengthen character dialogue cadence and sensory atmosphere.
        4. Preserve continuity: keep the opening a direct continuation of the previous chapter's ending. DELETE any opening sentences or paragraphs that recap, summarize, or restate earlier events — the chapter must begin in the middle of new action.
        5. Maintain exact story events, length, POV (${pov}), and tense (${tense}).`
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

// ---------------------------------------------------------------------------
// 3. Text refinement / editing
// ---------------------------------------------------------------------------
export const refineChapterText = async (currentContent: string, instruction: string): Promise<string> => {
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

  const messages: ChatMessage[] = [
    {
      role: "system",
      content: `You are an expert bestseller book editor.

EDITING TASK: ${detailedInstruction}

Return ONLY the rewritten manuscript text in clean Markdown format. Do NOT add conversational intro/outro filler. Do not change the story events.`
    },
    { role: "user", content: `CURRENT TEXT:\n${currentContent}` }
  ];

  const result = await chatWithRetries(messages, { temperature: 0.7, maxTokens: 8192 }, 3);
  return (result.content || "").trim() || currentContent;
};

// ---------------------------------------------------------------------------
// 4. Market trends research (knowledge-based — DeepSeek has no live search)
// ---------------------------------------------------------------------------
export interface TrendResult {
  content: string;
  sources: { title: string; uri: string }[];
}

export const researchBookTrends = async (): Promise<TrendResult> => {
  const messages: ChatMessage[] = [
    {
      role: "user",
      content: `Act as a publishing market analyst. Based on your training knowledge, identify the current top 5 trending ebook topics/genres. For each trend, provide: 1. The Genre/Topic Name. 2. Why it is trending (viral events, seasonal, etc). 3. Estimated gross sales potential or popularity ranking if available. 4. Target audience. 5. A specific 'Book Idea' prompt for a user. Summarize the findings in markdown.`
    }
  ];

  const result = await chatWithRetries(messages, { temperature: 0.7, maxTokens: 4096 }, 2);
  return {
    content: result.content || "No trends found.",
    sources: []
  };
};
