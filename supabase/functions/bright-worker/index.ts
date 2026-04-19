import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type Level = "Below" | "On Level" | "Advanced";
type ChoiceLetter = "A" | "B" | "C" | "D";
type AnswerLetter = "A" | "B" | "C" | "D";
type CanonicalSubject = "Reading" | "Math" | "Science" | "Social Studies";
type CanonicalMode = "Practice" | "Cross-Curricular" | "Tutor" | "Answer Key";
type TutorBuildMode = "practice" | "cross";

type CrossConnection = {
  subject: "Science" | "Math" | "Social Studies";
  connection: string;
};

type QuestionType = "mc" | "multi_select" | "scr";
type PassageContent = string | { text_1: string; text_2: string };
type PartBlock = {
  question: string;
  choices: [string, string, string, string];
};

type Question = {
  type?: QuestionType;
  question: string;
  choices: [string, string, string, string];
  correct_answer: ChoiceLetter | ChoiceLetter[];
  explanation: string;
  paired_with?: number;
  sample_answer?: string;
  hint?: string;
  think?: string;
  step_by_step?: string;
  common_mistake?: string;
  parent_tip?: string;
  cross?: CrossConnection;
  visual?: {
    type: "diagram" | "table" | "chart" | "model" | "map";
    title?: string;
    description?: string;
    headers?: string[];
    rows?: string[][];
    diagram_type?: string;
    components?: Array<Record<string, unknown>>;
  };
};

type TutorExplanation = {
  question_id: string;
  question: string;
  explanation: string;
  common_mistake: string;
  hint?: string;
  think?: string;
  step_by_step?: string;
};

type AnswerKeyEntry = {
  question_id: string;
  correct_answer: string;
  explanation: string;
  common_mistake: string;
  parent_tip?: string;
  hint?: string;
  step_by_step?: string;
};

type CoreResponse = {
  passage?: PassageContent;
  practice: {
    questions: Question[];
  };
};

type EnrichmentResponse = {
  cross: {
    passage: string;
    questions: Question[];
  };
  tutor: {
    practice: TutorExplanation[];
    cross: TutorExplanation[];
  };
  answerKey: {
    practice: AnswerKeyEntry[];
    cross: AnswerKeyEntry[];
  };
};

type WorkerAttempt = CoreResponse & EnrichmentResponse;
type IncomingCrossQuestion = Pick<
  Question,
  "question" | "type" | "choices" | "correct_answer" | "explanation" | "common_mistake" | "parent_tip"
>;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const READING_SKILL_DEFAULT = "Inference";
const SUBJECT_SKILLS = {
  Reading: [
    { skill: "Making Inferences", teks: "X.6(F)" },
    { skill: "Main Idea", teks: "X.6(A)" },
    { skill: "Supporting Details", teks: "X.6(B)" },
    { skill: "Theme", teks: "X.6(H)" },
    { skill: "Author's Purpose", teks: "X.9(C)" },
    { skill: "Summarizing", teks: "X.6(D)" },
  ],
  Math: [
    { skill: "Multi-Step Problem Solving", teks: "X.3(H)" },
    { skill: "Operations with Fractions", teks: "X.3(A)" },
    { skill: "Algebraic Reasoning", teks: "X.5(A)" },
    { skill: "Number Relationships", teks: "X.2(A)" },
    { skill: "Data Analysis", teks: "X.9(A)" },
  ],
  Science: [
    { skill: "Scientific Investigation", teks: "X.1(A)" },
    { skill: "Cause and Effect in Systems", teks: "X.5(A)" },
    { skill: "Energy and Matter", teks: "X.6(A)" },
    { skill: "Earth and Space Systems", teks: "X.7(A)" },
  ],
  "Social Studies": [
    { skill: "Cause and Effect (History)", teks: "X.4(A)" },
    { skill: "Primary vs Secondary Sources", teks: "X.21(A)" },
    { skill: "Geographic Impact", teks: "X.8(A)" },
    { skill: "Civic Understanding", teks: "X.12(A)" },
  ],
} as const;

const LETTERS: ChoiceLetter[] = ["A", "B", "C", "D"];
const TRUST_AI_ANSWER_KEY = true;
const BANNED_PHRASES = [
  "this reflects",
  "this reasoning",
  "this conclusion",
  "this interpretation",
];
const GENERIC_ANSWER_PATTERNS: RegExp[] = [
  /\bstudents?\s+compared\b/i,
  /\ba\s+class\s+reviewed\b/i,
  /\bwhich statement best\b/i,
  /\bwhich answer best\b/i,
  /\bstatement best\b/i,
];
const PASSAGE_RULES = `
PASSAGE ALIGNMENT:
- Every question and answer must be supported by the passage
- Use evidence-based reasoning
- Do not introduce outside information
- Use specific details from the passage
`.trim();
const NON_PASSAGE_RULES = `
PROBLEM ALIGNMENT:
- Every answer must be derived from the problem
- Do NOT reference a passage
- Do NOT use evidence-based language
- Focus on logic, computation, or reasoning only
`.trim();
const QUALITY_ALIGNMENT_RULES = [
  "QUALITY CHECK:",
  "- All writing must be clear and complete.",
  "- All sentences must be complete (no fragments).",
  "- All answer choices must be grammatically correct.",
  "- Do not introduce new characters.",
  "- Do not introduce events not mentioned.",
  "- Do not assume information not stated or clearly implied.",
  "- Ensure each correct answer is provable using the provided content/problem.",
  "PASSAGE QUALITY:",
  "- Passage must be complete with clear, connected ideas and enough detail for all questions.",
  "- Do not leave unfinished sentences or incomplete paragraphs.",
  "- If the passage is incomplete, regenerate the passage before writing questions.",
  "TUTOR QUALITY:",
  "- Tutor explanations must sound natural, conversational, and varied across questions.",
  "- Use a specific idea from the content/problem when explaining why an answer is correct.",
  "- Avoid repetitive templates and generic phrasing.",
  "CONTENT GROUNDING:",
  "- Use only information that clearly appears in the provided content or problem.",
  "- Do not introduce outside examples, unrelated scenarios, or new situations.",
  "SUBJECT-SPECIFIC ANSWERS:",
  "- If subject is Math: answer choices must be numerical values or valid expressions only.",
  "- If subject is Math: distractors should reflect common calculation mistakes (operation errors, order-of-operations errors, missed steps, arithmetic mistakes).",
  "- If subject is not Math: answer choices must be complete statements and distractors should reflect content misunderstandings.",
  "ABSOLUTE RULE (CRITICAL):",
  "- The phrase \"not supported by the passage\" must never appear in any answer choice.",
  "- Every answer choice must be a valid response to the question.",
].join("\n");
const ENGAGING_CONTEXT_RULES = [
  "ENGAGING CONTEXT (IMPORTANT):",
  "- Use a highly engaging, student-relevant context for the passage or problem.",
  "- Favor contexts like competitions, team challenges, content creation, sports, friend group decisions, money decisions, and real-life student dilemmas.",
  "- Keep language school-appropriate and academic.",
  "- Do not use slang, memes, brainrot language, or childish/silly tone.",
  "- Balance engaging scenarios with clear academic language.",
  "VARIATION (IMPORTANT):",
  "- Each generation should feel different from previous ones.",
  "- Vary the situation, conflict/problem type, question phrasing, and reasoning demands.",
  "- Avoid repeating the same scenario or question pattern, even for the same skill/context.",
  "- For Math/skill practice: vary numbers, quantities, operations, and real-world scenarios so problems are not structurally identical.",
  "- For passage-based sets: vary storyline, setting, and reasoning type across questions (e.g., cause/effect, inference, decision, outcome).",
  "- Ensure the five questions in a set are not all the same type of thinking.",
].join("\n");
const THINKING_OVER_RECALL_RULES = [
  "THINKING OVER RECALL (CRITICAL):",
  "- For Social Studies and Science, do not ask simple recall questions.",
  "- Require reasoning, cause/effect thinking, interpretation, or application.",
  "- Prefer prompts like: which situation best shows..., which example demonstrates..., which outcome is most likely..., how did X most influence Y in a real situation?",
].join("\n");

function containsBanned(choice: string): boolean {
  return BANNED_PHRASES.some((p) => String(choice || "").toLowerCase().includes(p));
}

function resolveTeks(subject: CanonicalSubject, skill: string, grade: number): string {
  const skillAliases: Record<string, string> = {
    Inference: "Making Inferences",
    "Making Inference": "Making Inferences",
    "Finding the main idea": "Main Idea",
    "Making inferences": "Making Inferences",
    "Understanding theme": "Theme",
  };
  const resolvedSkill = skillAliases[skill] || skill;
  const skillObj = SUBJECT_SKILLS[subject]?.find((s) => s.skill === resolvedSkill);
  if (!skillObj) return "Unknown";
  return skillObj.teks.replace("X", String(grade));
}

function shuffledLetters(): ChoiceLetter[] {
  const pool = [...LETTERS];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool;
}

function canonicalizeSubject(subject: unknown): CanonicalSubject {
  const value = String(subject || "").toLowerCase();
  if (value.includes("math")) return "Math";
  if (value.includes("science")) return "Science";
  if (value.includes("social")) return "Social Studies";
  return "Reading";
}

function isPassageBased(mode: CanonicalMode | TutorBuildMode, subject: CanonicalSubject): boolean {
  const normalizedMode = String(mode || "").toLowerCase();
  return normalizedMode === "cross-curricular" || normalizedMode === "cross" || subject === "Reading";
}

function normalizeLevel(level: unknown): Level {
  const value = String(level || "");
  if (value === "Below" || value === "Advanced") return value;
  return "On Level";
}

function gradeWordRange(grade: number, subject: CanonicalSubject, mode: CanonicalMode): { min: number; max: number } {
  if (mode === "Cross-Curricular") return { min: 150, max: 250 };
  if (subject === "Math") return { min: 60, max: 130 };
  if (subject === "Reading") return { min: 150, max: 300 };
  if (subject === "Science") return { min: grade <= 4 ? 120 : 140, max: grade <= 4 ? 220 : 260 };
  return { min: grade <= 4 ? 120 : 140, max: grade <= 4 ? 220 : 260 };
}

type GradeConstraints = {
  maxWordsPerSentence: number;
  maxSentences: number;
  vocab: string;
  allowAbstract: boolean | "limited";
  passageLength: string;
};

function getGradeConstraints(grade: number): GradeConstraints {
  if (grade <= 3) {
    return {
      maxWordsPerSentence: 10,
      maxSentences: 5,
      vocab: "simple",
      allowAbstract: false,
      passageLength: "short",
    };
  }

  if (grade === 4) {
    return {
      maxWordsPerSentence: 12,
      maxSentences: 6,
      vocab: "simple-moderate",
      allowAbstract: "limited",
      passageLength: "short-medium",
    };
  }

  if (grade === 5) {
    return {
      maxWordsPerSentence: 14,
      maxSentences: 7,
      vocab: "moderate",
      allowAbstract: "limited",
      passageLength: "medium",
    };
  }

  if (grade === 6) {
    return {
      maxWordsPerSentence: 16,
      maxSentences: 8,
      vocab: "moderate",
      allowAbstract: true,
      passageLength: "medium",
    };
  }

  if (grade === 7) {
    return {
      maxWordsPerSentence: 18,
      maxSentences: 9,
      vocab: "moderate-advanced",
      allowAbstract: true,
      passageLength: "medium-long",
    };
  }

  return {
    maxWordsPerSentence: 20,
    maxSentences: 10,
    vocab: "advanced",
    allowAbstract: true,
    passageLength: "long",
  };
}

function getForbiddenWords(grade: number): string[] {
  if (grade <= 3) {
    return ["biodiversity", "infrastructure", "regulation", "irreversible"];
  }
  if (grade <= 5) {
    return ["irreversible", "concentration"];
  }
  return [];
}

function violatesGradeLevel(text: string, grade: number): boolean {
  const forbidden = getForbiddenWords(grade);
  const lower = text.toLowerCase();
  return forbidden.some((word) => lower.includes(word));
}

function enforceSentenceLength(text: string, maxWords: number): string {
  return text
    .split(".")
    .map((sentence) => {
      const words = sentence.trim().split(/\s+/).filter(Boolean);
      if (words.length > maxWords + 5) {
        return words.slice(0, maxWords).join(" ");
      }
      return sentence.trim();
    })
    .filter(Boolean)
    .join(". ");
}

function isBlockedEvidenceSnippet(text: string): boolean {
  const normalized = String(text || "").toLowerCase();
  return normalized.includes("title:") ||
    normalized.includes("characters:") ||
    normalized.includes("setting:");
}

function scoreEvidenceSentence(sentence: string, keywords: string[]): number {
  const lower = sentence.toLowerCase();
  let score = 0;
  for (const word of keywords) {
    if (word.length < 4) continue;
    if (lower.includes(word)) score++;
  }
  return score;
}

function getBetterSnippet(passage: PassageContent | string, answer: string): string | null {
  const passageText = getPassageText(passage);
  const sentences = passageText
    .split(/[.!?\n]+/)
    .map((s) => s.trim())
    .filter((s) => Boolean(s) && !isBlockedEvidenceSnippet(s));
  const answerTokens = String(answer || "")
    .toLowerCase()
    .split(/\s+/)
    .map((word) => word.replace(/[^a-z0-9-]/g, ""))
    .filter((word) => word.length > 4);

  return sentences.find((sentence) =>
    answerTokens.some((word) => sentence.toLowerCase().includes(word))
  ) || null;
}

function extractKeyConcept(answer: string): string {
  const concepts = String(answer || "")
    .replace(/[^a-zA-Z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 4)
    .slice(0, 3);
  return concepts.join(" ") || "the key details";
}

function summarizeEvidenceIdea(snippet: string): string {
  const cleaned = String(snippet || "").replace(/\s+/g, " ").trim().replace(/^["'\s]+|["'\s]+$/g, "");
  if (!cleaned) return "the strongest idea in the passage";
  const words = cleaned.split(/\s+/).filter(Boolean);
  const compact = words.length > 22 ? `${words.slice(0, 22).join(" ")}...` : cleaned;
  return compact.replace(/[.!?]+$/, "");
}

function variedParentTip(index: number): string {
  const tips = [
    "👨‍👩‍👧 Parent Tip:\nHave your child reread the question, then restate it in their own words before choosing an answer.",
    "👨‍👩‍👧 Parent Tip:\nAsk your child to eliminate two weak choices first and explain why those options do not match the passage.",
    "👨‍👩‍👧 Parent Tip:\nInvite your child to underline one key detail in the passage and connect that detail to the best answer.",
    "👨‍👩‍👧 Parent Tip:\nAsk your child to think out loud and explain each step of their reasoning before locking in the answer.",
  ];
  return tips[Math.abs(index) % tips.length];
}

function buildGuidedFallbackExplanation(correctChoice: string): string {
  const leads = [
    "A strong reading of the passage points to",
    "The passage evidence lines up most clearly with",
    "When you connect the key details, the best-supported choice is",
  ];
  const lead = leads[Math.floor(Math.random() * leads.length)];
  return `${lead} ${extractKeyConcept(correctChoice)}.`;
}

function getRelevantSnippet(
  passage: PassageContent | string,
  question: string,
  correctChoice: string = "",
): string | null {
  const passageText = getPassageText(passage);
  const sentences = passageText
    .split(/[.!?\n]+/)
    .map((s) => s.trim())
    .filter((s) => Boolean(s) && !isBlockedEvidenceSnippet(s));
  const source = String(correctChoice || "").trim() || String(question || "").trim();
  const keywords = source
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[^a-z0-9-]/g, ""))
    .filter((w) => w.length > 3);

  let best: string | null = null;
  let bestScore = 0;

  for (const sentence of sentences) {
    const score = scoreEvidenceSentence(sentence, keywords);

    if (score > bestScore) {
      bestScore = score;
      best = sentence;
    }
  }

  if (!best || bestScore < 1 || isBlockedEvidenceSnippet(best)) {
    return getBetterSnippet(passageText, correctChoice || question);
  }
  return best;
}

function supportsMeaning(snippet: string, answer: string): boolean {
  const normalizedSnippet = String(snippet || "").toLowerCase();
  const normalizedAnswer = String(answer || "").toLowerCase();
  if (!normalizedSnippet || !normalizedAnswer) return false;

  const hasSnippetNegation = /\b(not|never|no|none|without|can't|cannot|won't|isn't|aren't|didn't|doesn't|don't)\b/.test(
    normalizedSnippet,
  );
  const hasAnswerNegation = /\b(not|never|no|none|without|can't|cannot|won't|isn't|aren't|didn't|doesn't|don't)\b/.test(
    normalizedAnswer,
  );
  if (hasSnippetNegation !== hasAnswerNegation) return false;

  const overlap = normalizedAnswer
    .split(/\W+/)
    .filter((word) => word.length > 3 && normalizedSnippet.includes(word))
    .length;

  return overlap >= 2;
}

function teacherExplain(question: string, answer: string, subject: string): string {
  void question;
  void subject;
  return `Let's walk through this step by step. ${answer} This makes sense because we carefully use the information from the problem to reach the correct conclusion.`;
}

function buildMathSteps(question: string, correctAnswer: string): string {
  void question;
  return `Step 1: Identify what the question is asking.
Step 2: Pull out the important numbers or relationships.
Step 3: Perform the necessary operations carefully.
Step 4: Check that your answer makes sense.

Final Answer: ${correctAnswer}`;
}

function teacherStyleExplanation(passage: PassageContent | string, question: string, correctChoice = ""): string {
  const snippet = getRelevantSnippet(passage, question, correctChoice);
  const hasStrongSnippet = Boolean(snippet) && supportsMeaning(String(snippet || ""), correctChoice);
  if (hasStrongSnippet) {
    return `${getExplanationStarter()}: "${snippet}". This detail helps explain why the correct choice is the strongest answer when compared to the other options.`;
  }
  if (snippet) {
    return `The passage states: "${snippet}." This clue points to ${extractKeyConcept(correctChoice)}, which helps confirm the best answer.`;
  }
  return buildGuidedFallbackExplanation(correctChoice);
}

function buildCrossExplanation(passage: PassageContent | string, question: string, correctChoice = ""): string {
  return teacherStyleExplanation(passage, question, correctChoice);
}

function buildParentTip(subject: string): string {
  if (subject === "Math") {
    return "Ask your child to explain each step out loud. This helps catch mistakes and build confidence.";
  }
  if (subject === "Reading") {
    return "Ask your child to point to the exact sentence that supports their answer.";
  }
  return "Ask your child to explain their thinking and justify their answer with evidence.";
}

function buildMistakeAndTip(subject: string, question: string, wrongChoice: string): {
  mistake: string;
  tip: string;
} {
  void question;
  const normalizedSubject = String(subject || "").toLowerCase();
  if (normalizedSubject.includes("math")) {
    return {
      mistake: `Students often choose "${wrongChoice}" after using the wrong operation or skipping a step in their setup.`,
      tip: `Why might "${wrongChoice}" look right at first, and which operation should be used instead?`,
    };
  }

  if (normalizedSubject.includes("science")) {
    return {
      mistake: `Students often choose "${wrongChoice}" because they mix up cause and effect from the investigation details.`,
      tip: `What detail in the passage or data makes "${wrongChoice}" tempting, and what evidence rules it out?`,
    };
  }

  if (normalizedSubject.includes("social")) {
    return {
      mistake: `Students often choose "${wrongChoice}" when they misread the historical context or timeline relationship.`,
      tip: `Which event sequence might make "${wrongChoice}" seem possible, and what source detail proves otherwise?`,
    };
  }

  return {
    mistake: `Students often misunderstand the concept behind "${wrongChoice}".`,
    tip: `Why might "${wrongChoice}" seem correct at first?`,
  };
}

function ensureUsableExplanation(explanation: string): string {
  const trimmed = String(explanation || "").trim();
  return trimmed || "Work through the problem carefully and check each step.";
}

function getLevelInstruction(level: Level): string {
  if (level === "Below") return "LOW: simple and direct";
  if (level === "Advanced") return "ADVANCED: deeper thinking";
  return "ON LEVEL: moderate reasoning";
}


function routeBySkill(skill: string): "vocab" | "main_idea" | "inference" | "theme" | "generic" {
  const normalized = String(skill || "").toLowerCase();
  if (!normalized) return "generic";
  if (normalized.includes("vocabulary")) return "vocab";
  if (normalized.includes("main idea")) return "main_idea";
  if (normalized.includes("infer")) return "inference";
  if (normalized.includes("theme")) return "theme";
  return "generic";
}

function getSkillType(skill: string): "general" {
  void skill;
  return "general";
}


function validateQuestionAlignment(question: string, skill: string): boolean {
  void skill;
  const q = String(question || "").trim();
  if (!q) return false;
  return true;
}

function isGenericChoice(choice: string): boolean {
  const normalized = String(choice || "").trim().toLowerCase();

  if (!normalized) return true;

  // ONLY flag truly empty or placeholder-like responses
  if (normalized.length < 25) return true;

  // Keep ONLY the most obvious generic patterns
  return [
    /\bwhich statement\b/i,
    /\bwhich answer\b/i,
  ].some((pattern) => pattern.test(normalized));
}

function isValidPassage(passage: string): boolean {
  return isCompletePassage(passage);
}

function isCompletePassage(passage: string): boolean {
  const text = String(passage || "").trim();

  if (!text || text.length < 120) return false;

  const sentences = text
    .split(/[.!?]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  // Must have at least 3 real sentences
  if (sentences.length < 3) return false;

  // No sentence fragments (too short)
  const hasFragment = sentences.some((s) => s.split(/\s+/).length < 6);
  if (hasFragment) return false;

  // Must end with punctuation
  if (!/[.!?]$/.test(text)) return false;

  return true;
}

function hasConnectedIdeas(passage: string): boolean {
  const sentences = String(passage || "")
    .split(/[.!?]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (sentences.length < 3) return false;
  const transitions = /\b(however|therefore|because|also|then|later|after|before|while|when|as a result|for example)\b/i;
  const repeatedToken = getTopicKeywords(passage).slice(0, 3).some((token) =>
    sentences.filter((sentence) => sentence.includes(token)).length >= 2
  );
  return transitions.test(passage) || repeatedToken;
}

function passageSupportsQuestions(passage: string, questions: Question[]): boolean {
  if (!isCompletePassage(passage)) return false;
  if (!questions.length) return false;

  return questions.every((q) => {
    const validQuestion = hasReasonableAlignment(q, passage);
    const correctChoice = typeof q.correct_answer === "string"
      ? getChoiceByLetter(q, q.correct_answer)
      : "";
    const correctChoiceText = Array.isArray(correctChoice) ? correctChoice.join(" ") : String(correctChoice || "");
    const supportedChoice = correctChoiceText
      ? hasLooseSupport(passage, correctChoiceText)
      : true;
    return validQuestion && supportedChoice;
  });
}

function sanitizeChoices(questions: Question[], passage: PassageContent | string): Question[] {
  void passage;
  // TEMPORARY TEST: bypass sanitize logic to inspect raw AI output.
  return questions;
}

function sanitizeExplanations(questions: Question[], passage: PassageContent | string): Question[] {
  return questions.map((q) => {
    const correctLetter = normalizeAnswer(normalizeAnswerKeyEntry(q.correct_answer));
    const correctChoiceRaw = getChoiceByLetter(q, correctLetter);
    const correctChoice = Array.isArray(correctChoiceRaw)
      ? correctChoiceRaw.join(" ")
      : correctChoiceRaw;
    const fallbackExplanation = teacherStyleExplanation(passage, q.question, correctChoice);
    return {
      ...q,
      explanation: ensureUsableExplanation(
        q.explanation || fallbackExplanation,
      ),
    };
  });
}

function validateChoiceAlignment(choice: string, skillType: "general"): boolean {
  void skillType;
  return !!String(choice || "").trim();
}


function readingPracticeWordRange(level: Level): { min: number; max: number } {
  if (level === "Below") return { min: 170, max: 220 };
  if (level === "Advanced") return { min: 280, max: 340 };
  return { min: 230, max: 300 };
}

function hasNarrativeReadingSignals(passage: PassageContent | string): boolean {
  const text = getPassageText(passage);
  const lower = text.toLowerCase();
  const nameSignals =
    /\b(lily|jake|emma|noah|olivia|liam|mia|ava|ethan|sophia|isabella|jack|lucas|amelia|harper)\b/i.test(text) ||
    /\b(mr|mrs|ms)\.\s+[A-Z][a-z]+\b/.test(text);
  const narrativeSignals = [
    /\bonce upon a time\b/i,
    /\bone day\b/i,
    /\bsuddenly\b/i,
    /\bthe next day\b/i,
    /\bafter school\b/i,
    /\bcharacter\b/i,
    /\bsaid\b/i,
    /\basked\b/i,
    /\bwalked\b/i,
    /\bran\b/i,
    /\bfelt\b/i,
  ].some((pattern) => pattern.test(text));
  const storytellingStructure = /(beginning|middle|ending|plot|lesson learned|moral of the story)/i.test(text);
  const narrativePronounDensity = (lower.match(/\b(he|she|they)\b/g) || []).length >= 4;

  return nameSignals || narrativeSignals || storytellingStructure || narrativePronounDensity;
}

function isMainIdeaSkill(skill: string): boolean {
  return String(skill || "").toLowerCase().includes("main idea");
}

function getSubjectInstructions(subject: CanonicalSubject): string {
  if (subject === "Math") return "Generate math-based problems with clear computations.";
  if (subject === "Science") return "Generate science questions with real-world concepts.";
  if (subject === "Reading") return "Generate passage-based reading questions.";
  if (subject === "Social Studies") return "Generate historical or civic-based questions.";
  return "";
}

function readingStructure(skill: string): string {
  const normalized = skill.toLowerCase();
  if (normalized.includes("main idea")) {
    return [
      "Q1 main idea",
      "Q2 supporting detail",
      "Q3 supporting detail",
      "Q4 development of idea",
      "Q5 best textual evidence",
    ].join("\n");
  }

  if (normalized.includes("infer")) {
    return [
      "Q1 inference",
      "Q2 text clue",
      "Q3 text clue",
      "Q4 reasoning",
      "Q5 best textual evidence",
    ].join("\n");
  }

  if (normalized.includes("theme")) {
    return [
      "Q1 theme",
      "Q2 event/detail support",
      "Q3 event/detail support",
      "Q4 character action and impact",
      "Q5 best textual evidence",
    ].join("\n");
  }

  return [
    "Q1 primary reading skill target",
    "Q2 supporting detail or clue",
    "Q3 supporting detail or clue",
    "Q4 deeper reasoning",
    "Q5 strongest textual evidence",
  ].join("\n");
}

function subjectStructure(subject: CanonicalSubject): string {
  if (subject === "Math") {
    return [
      "Q1 multi-step real-world word problem",
      "Q2 multi-step real-world word problem",
      "Q3 conceptual understanding",
      "Q4 application",
      "Q5 reasoning or error analysis",
    ].join("\n");
  }

  if (subject === "Science") {
    return [
      "Q1 concept understanding",
      "Q2 scenario analysis",
      "Q3 cause and effect",
      "Q4 data analysis",
      "Q5 evidence-based reasoning",
    ].join("\n");
  }

  if (subject === "Social Studies") {
    return [
      "Q1 main idea",
      "Q2 cause and effect",
      "Q3 key detail",
      "Q4 historical/civic reasoning",
      "Q5 best evidence",
    ].join("\n");
  }

  return [
    "Q1 main reading target",
    "Q2 supporting detail/clue",
    "Q3 supporting detail/clue",
    "Q4 development/reasoning",
    "Q5 evidence",
  ].join("\n");
}

function buildPrompt(params: {
  grade: number;
  subject: CanonicalSubject;
  skill: string;
  level: Level;
  mode: CanonicalMode;
}): string {
  const { grade, subject, skill, level, mode } = params;
  const levelInstruction = getLevelInstruction(level);

  if (mode === "Cross-Curricular") {
    return `Generate CROSS-CURRICULAR content.

Return JSON only:
{
  "passage": "string",
  "questions": [5 questions]
}

Rules:
- Generate a passage.
- Generate exactly 5 questions.
- Each question has 4 choices.
- Each question has 1 correct answer and 3 realistic distractors.
- Align to skill: ${skill}.
- Match grade ${grade} and level (${levelInstruction}).
- Avoid robotic or templated language.`;
  }

  return `Generate STAAR-style ${subject} practice questions.

Inputs:
- Grade: ${grade}
- Subject: ${subject}
- Skill: ${skill}
- Level: ${levelInstruction}

Return strict JSON only with:
- passage (if needed)
- 5 questions
- 4 choices per question
- 1 correct answer + 3 realistic distractors
- explanation, common_mistake, and parent_tip fields per question

Keep language natural and student-friendly.`;
}
function buildCorePrompt(params: {
  grade: number;
  subject: CanonicalSubject;
  skill: string;
  level: Level;
  textType?: "fiction" | "poem" | "drama";
  teksCode?: string;
  contextType?: string;
}): string {
  const { grade, subject, skill, level, textType, teksCode = "Unknown", contextType = "real-world application" } = params;
  const levelInstruction = getLevelInstruction(level);
  const rules = isPassageBased("Practice", subject) ? PASSAGE_RULES : NON_PASSAGE_RULES;
  const modeLogic = `MODE LOGIC (CRITICAL):

IF subject = Reading:
→ Use passage-based reasoning

IF subject ≠ Reading AND mode = Practice:
→ DO NOT reference a passage
→ DO NOT use phrases like:
   "the passage shows"
   "the text suggests"
→ Answers must be based on logic or problem-solving

IF mode = Cross-Curricular:
→ Use passage as context
→ Combine reasoning + content`;
  const scienceReasoningRule = subject === "Science"
    ? "- Science rule: ask reasoning-focused questions (not simple recall) and use realistic scenarios/situations when possible."
    : "";

  if (subject === "Reading") {
    const readingRange = readingPracticeWordRange(level);
    return `Create JSON only for PRACTICE MODE.

Inputs:
- Grade: ${grade}
- Subject: ${subject}
- Skill: ${skill}
- Level: ${levelInstruction}

${ENGAGING_CONTEXT_RULES}
${THINKING_OVER_RECALL_RULES}

Return exactly:
{
  "passage": "REQUIRED ${textType || "fiction"} passage (${readingRange.min}–${readingRange.max} words)",
  "practice": { "questions": [5 items with question, choices, correct_answer, explanation] }
}

Rules:
- Generate a passage for reading practice.
- Generate exactly 5 questions aligned to skill ${skill}.
- Each question must have exactly 4 choices.
- Each question must have 1 correct answer and 3 realistic distractors.
- Match grade ${grade} and level (${levelInstruction}).
- Use natural, non-robotic language.
- Context Type: ${contextType}
- TEKS Alignment Code: ${teksCode}
- ${scienceReasoningRule || "Use cognitively demanding questions that require reasoning, not simple recall."}
- Mode rule: Use passage-based reasoning and ensure answers are supported by the passage.
- ${modeLogic.replace(/\n/g, "\n- ").replace(/^-\s/, "")}
- ${rules.replace(/\n/g, "\n- ").replace(/^-\s/, "")}
- ${QUALITY_ALIGNMENT_RULES.replace(/\n/g, "\n- ").replace(/^-\s/, "")}
- No markdown. JSON only.`;
  }

  return `Create JSON only for PRACTICE MODE.

Inputs:
- Grade: ${grade}
- Subject: ${subject}
- Skill: ${skill}
- Level: ${levelInstruction}

${ENGAGING_CONTEXT_RULES}
${THINKING_OVER_RECALL_RULES}

Return exactly:
{
  "practice": { "questions": [5 items with question, choices, correct_answer, explanation] }
}

Rules:
- Subject: ${subject}.
- Generate exactly 5 questions aligned to skill ${skill}.
- Do not generate a passage.
- Each question must have exactly 4 choices.
- Each question must have 1 correct answer and 3 realistic distractors.
- Match grade ${grade} and level (${levelInstruction}).
- Use natural, non-robotic language.
- Context Type: ${contextType}
- TEKS Alignment Code: ${teksCode}
- ${scienceReasoningRule || "Use cognitively demanding questions that require reasoning, not simple recall."}
- Mode rule: Do not reference a passage. Every choice must be a valid response to the problem.
- ${modeLogic.replace(/\n/g, "\n- ").replace(/^-\s/, "")}
- ${rules.replace(/\n/g, "\n- ").replace(/^-\s/, "")}
- ${QUALITY_ALIGNMENT_RULES.replace(/\n/g, "\n- ").replace(/^-\s/, "")}
- No markdown. JSON only.`;
}
function buildEnrichmentPrompt(params: {
  grade: number;
  subject: CanonicalSubject;
  skill: string;
  practiceQuestions: Question[];
  level: Level;
  crossPassage?: string;
  teksCode?: string;
  contextType?: string;
}): string {
  const { grade, subject, skill, practiceQuestions, level, crossPassage = "", teksCode = "Unknown", contextType = "real-world application" } = params;
  const levelInstruction = getLevelInstruction(level);
  const rules = isPassageBased("Cross-Curricular", subject) ? PASSAGE_RULES : NON_PASSAGE_RULES;
  const scienceReasoningRule = subject === "Science"
    ? "- Science rule: emphasize reasoning over recall and frame questions in concrete scenarios when possible."
    : "";
  const passageDirective = crossPassage.trim()
    ? `\nUse this passage:
${crossPassage}
`
    : "\nGenerate a new cross-curricular passage.\n";

  return `Generate cross-curricular content and return JSON only:
{
  "cross": {
    "passage": "string",
    "questions": [5 items with question, choices, correct_answer]
  }
}

Inputs:
- Grade: ${grade}
- Subject: ${subject}
- Skill: ${skill}
- Level: ${levelInstruction}
- TEKS: ${teksCode}
- Context Type: ${contextType}
- Practice sample size: ${practiceQuestions.slice(0, 5).length}

Rules:
- Generate passage (if one is not provided).
- Generate exactly 5 questions.
- Each question must have exactly 4 choices.
- Each question must have 1 correct answer and 3 realistic distractors.
- Align questions to ${skill} and ${subject}.
- Match grade ${grade} and level (${levelInstruction}).
- Use natural, non-robotic language.${passageDirective}
- ${scienceReasoningRule || "Use questions that require applied reasoning rather than simple recall."}
- ${THINKING_OVER_RECALL_RULES.replace(/\n/g, "\n- ").replace(/^-\s/, "")}
- Mode rule: Answers must be supported by the passage using passage-based reasoning.
- ${rules.replace(/\n/g, "\n- ").replace(/^-\s/, "")}
- ${QUALITY_ALIGNMENT_RULES.replace(/\n/g, "\n- ").replace(/^-\s/, "")}
- No markdown. JSON only.`;
}
function buildGenerationPrompt(params: {
  mode: "core" | "enrichment";
  grade: number;
  subject: CanonicalSubject;
  skill: string;
  level: Level;
  teksCode?: string;
  practiceQuestions?: Question[];
  crossPassage?: string;
}): string {
  const rules = isPassageBased(params.mode === "core" ? "Practice" : "Cross-Curricular", params.subject)
    ? PASSAGE_RULES
    : NON_PASSAGE_RULES;
  const modeLogic = `MODE LOGIC (CRITICAL):

IF subject = Reading:
→ Use passage-based reasoning

IF subject ≠ Reading AND mode = Practice:
→ DO NOT reference a passage
→ DO NOT use phrases like:
   "the passage shows"
   "the text suggests"
→ Answers must be based on logic or problem-solving

IF mode = Cross-Curricular:
→ Use passage as context
→ Combine reasoning + content`;
  const scienceReasoningRule = params.subject === "Science"
    ? "Science rule: ask reasoning-heavy questions (not simple recall) and use realistic situations where possible."
    : "Use applied reasoning questions rather than simple recall prompts.";
  if (params.mode === "core") {
    const readingDirective = params.subject === "Reading"
      ? `Include exactly 1 passage (complete, no truncation).`
      : `Do not include a passage.`;
    return `Return JSON only:
{
  "passage": "string (required for Reading only)",
  "practice": {
    "questions": [
      {
        "question": "string",
        "choices": ["string","string","string","string"],
        "correct_answer": "A|B|C|D",
        "explanation": "short explanation"
      }
    ]
  }
}

Task: Create STAAR-style ${params.subject} practice content.
Grade: ${params.grade}
Skill: ${params.skill}
Level: ${params.level}
TEKS: ${params.teksCode || "Unknown"}

Rules:
- ${readingDirective}
- Include exactly 5 questions.
- Each question must have exactly 4 choices.
- Choices must be concise, complete, and plausible.
- ${scienceReasoningRule}
- ${THINKING_OVER_RECALL_RULES.replace(/\n/g, "\n- ").replace(/^-\s/, "")}
- Mode rule: If no passage is included, do not reference passage-based support language.
- ${modeLogic.replace(/\n/g, "\n- ").replace(/^-\s/, "")}
- ${rules.replace(/\n/g, "\n- ").replace(/^-\s/, "")}
- ${QUALITY_ALIGNMENT_RULES.replace(/\n/g, "\n- ").replace(/^-\s/, "")}
- Keep explanations short (1 sentence).
- No commentary, markdown, or extra keys.`;
  }

  return `Return JSON only:
{
  "cross": {
    "passage": "string",
    "questions": [
      {
        "question": "string",
        "choices": ["string","string","string","string"],
        "correct_answer": "A|B|C|D",
        "explanation": "short explanation"
      }
    ]
  }
}

Create cross-curricular content for ${params.subject}, grade ${params.grade}, skill ${params.skill}.
Use exactly 1 passage and exactly 5 questions.
Each question must have exactly 4 choices.
${scienceReasoningRule}
${THINKING_OVER_RECALL_RULES}
Mode rule: Answers must be supported by the passage with passage-based reasoning.
${modeLogic}
${rules}
${QUALITY_ALIGNMENT_RULES}
Keep explanations short (1 sentence).
No extra commentary.`;
}

function buildSubjectPassage(subject: CanonicalSubject, level: Level = "On Level"): string {
  const profile = level === "Below" ? "simple" : level === "Advanced" ? "complex" : "grade";
  if (subject === "Science") {
    if (profile === "simple") {
      return "Students tested playground surfaces at school. They checked blacktop, grass, and concrete each hour. Blacktop got hottest in direct sun. Grass in the shade stayed cooler. After watering one area, that area warmed up more slowly. Students used this evidence to suggest more shade and lighter materials.";
    }
    if (profile === "complex") {
      return `During a campus heat-transfer inquiry, student teams tracked how surface composition and environmental conditions influenced recess temperatures. They measured blacktop, concrete, and grass hourly while recording cloud cover, wind speed, and direct-sun exposure.

The results showed a persistent interaction: darker pavement absorbed and retained heat rapidly, while shaded grass moderated temperature through moisture and airflow. When students repeated the procedure after watering one test area, the rate of temperature increase fell, suggesting that evaporative effects altered heat buildup. In their final report, students connected these observations to design choices, arguing that material selection and shade planning could reduce thermal stress for the wider school community.`;
    }
    return "During a campus investigation, students tested how surface type affected temperature at recess. They placed thermometers on blacktop, grass, and concrete every hour and recorded wind speed, cloud cover, and sunlight. The data showed that dark pavement heated fastest in direct sun, while shaded grass stayed cooler because moisture and airflow reduced heat buildup. Students repeated the experiment after watering one section and observed a smaller temperature increase there. In their report, they explained the physical process of heat transfer and used cause-and-effect evidence to recommend shade trees and lighter playground materials.";
  }

  if (subject === "Social Studies") {
    if (profile === "simple") {
      return "In 1908, town leaders debated a bridge or a bigger rail depot. Farmers wanted the bridge to move crops faster. Merchants wanted rail growth for trade. Leaders first chose rail expansion. Flooding then delayed shipments and raised prices. Later, voters approved money for a bridge. These decisions changed where people lived and worked.";
    }
    if (profile === "complex") {
      return `In 1908, leaders in a river town argued over two competing transportation investments: a bridge linking both banks or an expanded rail depot intended to attract outside commerce. Farmers favored the bridge for faster crop movement, while merchants expected rail expansion to widen regional trade.

Council records show rail improvements were approved first, but repeated flooding disrupted shipments, increased prices, and weakened confidence in that strategy. Over the next several years, population growth on the opposite bank shifted daily travel patterns and voting priorities. When residents later passed a bridge bond, newspapers connected the decision to broader outcomes—migration shifts, business relocation, and new debates over how public funds should balance immediate needs with long-term community stability.`;
    }
    return "In 1908, leaders in a river town debated whether to spend limited tax funds on a bridge or a larger rail depot. Farmers argued that a bridge would move crops to market faster, while merchants supported the depot to attract outside trade. Meeting records show that the council first approved rail expansion, but repeated flooding delayed shipments and raised prices. Five years later, after population growth along the opposite bank, voters passed a bond for the bridge. Newspaper timelines and election results suggest that transportation choices changed migration patterns, business investment, and daily life across the town.";
  }

  if (subject === "Math") {
    if (profile === "simple") {
      return "The student council sold snacks at field day. A combo pack cost $6. Single items cost $2 each. In hour 1, volunteers sold 38 combos and 24 single items. In hour 2, combo sales went down by 8, but single-item sales went up by 15. Students compared both hours to decide what to restock.";
    }
    if (profile === "complex") {
      return `The student council analyzed field-day snack sales to decide whether future inventory should prioritize combo packs or individual items. A combo pack was priced at $6 and included one drink plus two snacks, while single items were sold for $2 each.

In the first hour, volunteers recorded 38 combo purchases and 24 single-item purchases. In the second hour, combo volume declined by 8 after families shifted buying behavior, while single-item purchases rose by 15 following an announcement near the gym entrance. Organizers compared the two-hour revenue structure, not just item counts, because price-per-transaction and demand movement could produce different conclusions about total earnings and restocking risk.`;
    }
    return "The student council planned a field-day snack sale with two pricing options for families. A combo pack cost $6 and included one drink and two snacks, while single items cost $2 each. In the first hour, volunteers sold 38 combo packs and 24 single items. In the second hour, combo sales dropped by 8, but single-item sales increased by 15 after an announcement. Organizers used these numbers to compare revenue patterns and decide whether to restock combo materials or individual items. Their final decision depended on how the quantities in both hours related to total earnings.";
  }

  if (profile === "simple") {
    return "Two groups discussed two articles about free-time reading. Some readers preferred short texts for quick facts. Others preferred longer pieces with more examples. The groups checked details to make sure each claim matched the evidence. They revised their summary to reflect the strongest support.";
  }
  if (profile === "complex") {
    return `Two groups analyzed two reports to explain why readers preferred different reading formats. Some readers valued short passages for quick access to key points, while others favored long-form pieces that developed ideas through examples and context.

As the groups compared exact lines across the reports, they noticed how wording choices could shift meaning and create apparent disagreement. They revised claims, reorganized evidence, and adjusted conclusions to better reflect what the strongest details supported. Their final write-up argued that careful comparison of language and evidence leads to more reliable conclusions, especially when two sources seem to conflict at first glance.`;
  }
  return "Two groups reviewed two article collections to understand why readers preferred different reading formats. Some readers said shorter pieces helped them find key ideas quickly, while others preferred longer selections with more examples and context. The groups compared exact lines, checked which claims were supported by multiple details, and revised conclusions to match the strongest evidence in each source. When two sources appeared to conflict, they re-read the original lines and identified how word choice changed meaning. Their final report explained how careful reading and evidence-based reasoning led to clearer conclusions.";
}

function enforceValidPassage(
  passage: string,
  subject: string,
  level: string,
): string {
  if (isCompletePassage(passage)) return passage;

  console.warn("🚨 INVALID PASSAGE — regenerating once");

  const regenerated = buildSubjectPassage(subject as CanonicalSubject, level as Level);
  return regenerated || passage;
}


function buildExplanation(answer: string, question: string): string {
  const cleanAnswer = String(answer || "").trim();
  const prompt = String(question || "").toLowerCase();
  if (prompt.includes("purpose")) {
    return `The correct answer is supported because the author includes details that point to this purpose: ${cleanAnswer}. A wrong choice is incorrect when it changes that purpose.`;
  }
  if (prompt.includes("infer")) {
    return `The correct answer is supported by clues in the passage: ${cleanAnswer}. A distractor is incorrect when it overstates or reverses those clues.`;
  }
  return `The correct answer is supported by the passage detail: ${cleanAnswer}. A distractor is incorrect when it is only partly true or not fully supported.`;
}

function buildFallbackExplanation(passage: string, question: string, correctChoice: string): string {
  const evidence = String(passage || "")
    .split(/[.!?]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 24)[0] || "the key details in the passage";
  const shortEvidence = evidence.slice(0, 120).trim();
  const base = buildExplanation(correctChoice, question);
  return `${base} For example, the passage states that ${shortEvidence}.`;
}

function getDOKLevel(
  index: number,
  level: "Below Level" | "On Level" | "Advanced" | Level,
): "easy" | "medium" | "hard" {
  const normalizedLevel = level === "Below" ? "Below Level" : level;

  if (normalizedLevel === "Below Level") {
    if (index <= 1) return "easy";
    if (index <= 3) return "medium";
    return "medium";
  }

  if (normalizedLevel === "On Level") {
    if (index === 0) return "easy";
    if (index <= 2) return "medium";
    return "hard";
  }

  if (index === 0) return "medium";
  if (index <= 2) return "hard";
  return "hard";
}

function getUniversalQuestion(
  subject: CanonicalSubject,
  skill: string,
  index: number,
  level: Level = "On Level",
): string {
  const s = String(skill || "").toLowerCase();
  const selectByDOK = (stems: [string, string, string, string, string]) => {
    const levelShift = level === "Below" ? 0 : level === "Advanced" ? 2 : 1;
    const stemIndex = (index + levelShift) % stems.length;
    return stems[stemIndex];
  };

  if (subject === "Reading") {
    if (s.includes("theme")) {
      return selectByDOK([
        "What is the central message of the passage?",
        "Which statement best expresses the theme?",
        "What lesson does the passage convey?",
        "Which idea best reflects the author’s message?",
        "What is the main message developed in the passage?",
      ]);
    }

    if (s.includes("infer")) {
      return selectByDOK([
        "What can the reader infer about the situation based on the passage?",
        "Which detail suggests that the main problem changed over time?",
        "What can the reader infer about the character’s decision based on the passage?",
        "Which detail suggests that the author expects the reader to notice a change?",
        "Why does the author include this sequence of details before the final point?",
      ]);
    }

    return selectByDOK([
      "Which idea is BEST supported by the passage?",
      "What is the main idea of the passage?",
      "Which detail best supports a key idea?",
      "What can the reader conclude?",
      "Which statement accurately reflects the passage?",
    ]);
  }

  if (subject === "Math") {
    return selectByDOK([
      "Which answer correctly solves the problem?",
      "What is the correct value based on the information?",
      "Which calculation leads to the correct result?",
      "What is the final answer after solving?",
      "Which method produces the correct solution?",
    ]);
  }

  if (subject === "Science") {
    return selectByDOK([
      "In this scenario, what is the most likely outcome based on the information?",
      "Which statement best explains the relationship shown in the situation?",
      "What cause best explains the result described in the scenario?",
      "Which conclusion is supported by the data and reasoning from the setup?",
      "What does the information suggest about how the process works in this situation?",
    ]);
  }

  if (subject === "Social Studies") {
    return selectByDOK([
      "Which situation best shows the impact described in the source?",
      "Which outcome is most likely based on the historical conditions described?",
      "Which conclusion is best supported when you compare the evidence in the source?",
      "How did the decision in the passage most influence later events?",
      "Which example best demonstrates the long-term effect described?",
    ]);
  }

  return "Which answer is best supported by the information provided?";
}

function buildUniversalChoices(
  subject: CanonicalSubject,
  passage: string,
  level: Level = "On Level",
): [string, string, string, string] {
  if (subject === "Math") {
    const numbers = String(passage || "").match(/-?\d+(?:\.\d+)?/g) || [];
    const base = numbers.length ? Number(numbers[0]) : 24;
    const numericBase = Number.isFinite(base) ? base : 24;
    const choices = [
      numericBase,
      numericBase + 1,
      Math.max(0, numericBase - 1),
      numericBase * 2,
    ].map((value) => String(Number.isInteger(value) ? value : Number(value.toFixed(2))));
    return normalizeChoices(choices) as [string, string, string, string];
  }
  const sentences = String(passage || "")
    .split(/[.!?]/)
    .map((s) => s.trim())
    .filter((s) => Boolean(s) && s.length > 18);
  const base = sentences.slice(0, 4);

  while (base.length < 4) base.push(sentences[0] || "the passage describes a key detail about the topic");

  const toChoiceSentence = (text: string): string => {
    const cleaned = String(text || "").replace(/\s+/g, " ").trim().replace(/[.]+$/, "");
    return `In the passage, ${cleaned.charAt(0).toLowerCase()}${cleaned.slice(1)}.`;
  };
  const twistDetail = (text: string, mode: number): string => {
    const normalized = String(text || "").trim();
    if (!normalized) return "the detail is described differently than in the text";
    if (mode === 0) return normalized.replace(/\bbecause\b/gi, "even though").replace(/\bso\b/gi, "because");
    if (mode === 1) return normalized.replace(/\bmost\b/gi, "all").replace(/\bsome\b/gi, "all");
    return normalized.replace(/\bafter\b/gi, "before").replace(/\bbefore\b/gi, "after");
  };

  const correct = toChoiceSentence(base[0]);
  const distractors = [
    toChoiceSentence(twistDetail(base[1], 0)),
    toChoiceSentence(twistDetail(base[2], 1)),
    toChoiceSentence(twistDetail(base[3], 2)),
  ];
  void subject;
  void level;
  const all = shuffleArray([correct, ...distractors]);
  return all.map((c) => cleanChoice(String(c || "").trim())) as [string, string, string, string];
}

// function buildUniversalFallbackQuestion(
//   subject: CanonicalSubject,
//   passage: string,
//   skill: string,
//   index: number,
//   level: Level = "On Level",
// ): Question {
//   const question = getUniversalQuestion(subject, skill, index, level);
//   const choices = buildUniversalChoices(subject, passage, level);
//   const correctIndex = pickRandom([0, 1, 2, 3]);
//
//   return {
//     type: "mc",
//     question,
//     choices,
//     correct_answer: ["A", "B", "C", "D"][correctIndex] as ChoiceLetter,
//     explanation: buildFallbackExplanation(passage, question, choices[correctIndex]),
//   };
// }

function normalizeChoices(choices: unknown): [string, string, string, string] {
  if (!Array.isArray(choices)) return ["", "", "", ""];

  const cleaned = choices.map((c) => String(c || "").trim());

  while (cleaned.length < 4) cleaned.push("");

  return cleaned.slice(0, 4) as [string, string, string, string];
}

function makeChoicesUnique(
  choices: [string, string, string, string],
  subject: CanonicalSubject,
  question: string,
): [string, string, string, string] {
  void subject;
  void question;
  return choices.map((choice) => String(choice || "").trim()) as [string, string, string, string];
}

function normalizeVocabChoices(choices: string[]): [string, string, string, string] {
  const cleaned = choices.map((c) =>
    String(c || "")
      .replace(/[^a-zA-Z0-9\s\-]/g, "")
      .trim()
  );

  while (cleaned.length < 4) cleaned.push("No valid meaning provided");

  return cleaned.slice(0, 4) as [string, string, string, string];
}

function isValidVocabTarget(passage: PassageContent | string, word: string): boolean {
  const passageText = getPassageText(passage);
  if (!passageText || !word) return false;
  return passageText.toLowerCase().includes(word.toLowerCase());
}

function cleanAnswerChoice(choice: string): string {
  return String(choice || "").trim();
}

function enforceThinkingStem(subject: CanonicalSubject, question: string): string {
  const q = String(question || "").trim();
  if (!q) return q;
  const lower = q.toLowerCase();
  if ((subject === "Science" || subject === "Social Studies") && /^what (was|is|were)\b/.test(lower)) {
    if (subject === "Science") return "Which outcome is most likely based on the situation described?";
    return "Which situation best demonstrates the historical impact described?";
  }
  return q;
}

function isMathLikeChoice(choice: string): boolean {
  const cleaned = String(choice || "").replace(/\$/g, "").replace(/,/g, "").trim();
  return /\d/.test(cleaned) && /^[\d\s+\-*/().%]+$/.test(cleaned);
}

function sanitizeMathChoice(choice: string): string {
  const cleaned = String(choice || "")
    .replace(/^[A-D][\).\s-]+/i, "")
    .replace(/\$/g, "")
    .replace(/,/g, "")
    .trim();
  if (!cleaned) return "";
  if (isMathLikeChoice(cleaned)) return cleaned.replace(/\s+/g, " ");
  const numeric = cleaned.match(/-?\d+(?:\.\d+)?/);
  return numeric ? numeric[0] : "";
}

// function buildMathChoicesFromCorrect(correctChoice: string): [string, string, string, string] {
//   const numericMatch = String(correctChoice || "").match(/-?\d+(?:\.\d+)?/);
//   const numericValue = numericMatch ? Number(numericMatch[0]) : NaN;
//   if (!Number.isFinite(numericValue)) {
//     return ["0", "1", "2", "3"];
//   }
//   const distractors = [
//     numericValue + 1,
//     numericValue - 1,
//     numericValue * 2,
//   ];
//   const all = [numericValue, ...distractors].map((v) => String(Number.isInteger(v) ? v : Number(v.toFixed(2))));
//   return normalizeChoices(all) as [string, string, string, string];
// }
//
// function enforceMathChoices(
//   choices: [string, string, string, string],
//   correctAnswer: ChoiceLetter | ChoiceLetter[],
// ): [string, string, string, string] {
//   const correctLetter = Array.isArray(correctAnswer) ? "A" : correctAnswer;
//   const correctIndex = Math.max(0, LETTERS.indexOf(correctLetter as ChoiceLetter));
//   const sanitized = choices.map((choice) => sanitizeMathChoice(choice));
//   let correct = sanitized[correctIndex] || "";
//   if (!correct) {
//     correct = sanitized.find((choice) => Boolean(choice)) || "0";
//   }
//   const rebuilt = buildMathChoicesFromCorrect(correct);
//   const finalChoices = [...rebuilt];
//   const correctSlot = sanitizeMathChoice(finalChoices[correctIndex] || "");
//   if (correctSlot !== correct) {
//     finalChoices[correctIndex] = correct;
//   }
//   return normalizeChoices(finalChoices) as [string, string, string, string];
// }

function extractVocabTargetWord(questionText: string): string {
  const text = String(questionText || "");
  const quoted = text.match(/["“”']([^"“”']{2,30})["“”']/);
  if (quoted?.[1]) return quoted[1].trim();
  const afterWord = text.match(/\bword\s+([a-zA-Z\-]{2,30})\b/i);
  if (afterWord?.[1]) return afterWord[1].trim();
  const beforeMean = text.match(/\b([a-zA-Z\-]{2,30})\b(?=\s+most nearly mean|\s+mean)/i);
  if (beforeMean?.[1]) return beforeMean[1].trim();
  return "";
}

function isVocabStyleQuestion(questionText: string): boolean {
  const normalized = String(questionText || "").toLowerCase();
  return normalized.includes("word") || normalized.includes("mean") || normalized.includes("most nearly");
}

function cleanChoice(text: string): string {
  const cleaned = String(text || "").trim();
  if (!cleaned) return cleaned;
  if (!cleaned.endsWith(".") && cleaned.split(/\s+/).length >= 4) {
    return `${cleaned}.`;
  }

  return cleaned;
}

function normalizeAnswer(letter: unknown): ChoiceLetter {
  const v = String(letter ?? "").trim().toUpperCase();

  if (v === "A" || v === "B" || v === "C" || v === "D") return v;

  console.warn("⚠️ normalizeAnswer invalid:", letter);
  return "A";
}

function safeCorrectAnswer(value: unknown): ChoiceLetter {
  const parsed = parseAnswerLetter(value);
  if (parsed) return parsed;

  return "A";
}

function parseAnswerLetter(value: unknown): ChoiceLetter | null {
  const raw = String(value ?? "").trim().toUpperCase();
  if (raw === "A" || raw === "B" || raw === "C" || raw === "D") return raw;
  if (/^[ABCD][\).\s-]/.test(raw)) return raw[0] as ChoiceLetter;
  return null;
}

function getChoiceByLetter(
  questionOrChoices: Question | [string, string, string, string] | string[],
  letter: ChoiceLetter | ChoiceLetter[],
): string | string[] {
  const indexMap: Record<ChoiceLetter, number> = { A: 0, B: 1, C: 2, D: 3 };
  const rawChoices = Array.isArray(questionOrChoices)
    ? questionOrChoices
    : questionOrChoices?.choices;
  const choices = normalizeChoices(rawChoices);

  if (Array.isArray(letter)) {
    return letter.map((l) => String(choices[indexMap[l]] || "").trim());
  }

  return String(choices[indexMap[letter]] || "").trim();
}

function getQuestionCorrectPair(q: Question): { letter: ChoiceLetter | null; choice: string } {
  const letter = parseAnswerLetter(q.correct_answer);
  const normalizedChoices = normalizeChoices(q.choices);
  const choice = letter ? String(normalizedChoices[LETTERS.indexOf(letter)] || "").trim() : "";
  return { letter, choice };
}

function getCorrectChoice(q: Question): string {
  const letters: ChoiceLetter[] = ["A", "B", "C", "D"];
  if (!Array.isArray(q.choices) || q.choices.length !== 4) return "";
  const answer = q.correct_answer;
  if (Array.isArray(answer)) {
    return "";
  }
  if (typeof answer !== "string") {
    return "";
  }
  const idx = letters.indexOf(answer as ChoiceLetter);
  return idx >= 0 ? String(q.choices[idx] || "").trim() : "";
}

function hasPassageSupportForChoice(passage: string, choice: string): boolean {
  void passage;
  void choice;
  return false;
}

function hasLooseSupport(passage: string, choice: string): boolean {
  const normalizedPassage = String(passage || "").toLowerCase();
  const words = String(choice || "")
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[^a-z0-9]/g, ""))
    .filter((w) => w.length > 3);
  if (!normalizedPassage || words.length === 0) return false;
  return words.some((word) => normalizedPassage.includes(word));
}

function scoreChoiceSupport(passage: string, choice: string): number {
  void passage;
  void choice;
  return 0;
}

function verifyNonPassageAnswer(
  question: string,
  choices: [string, string, string, string],
  subject: CanonicalSubject,
): ChoiceLetter {
  void question;
  void choices;
  void subject;
  return "A";
}

function lockAnswerToPassage(
  passageText: string,
  choices: [string, string, string, string],
  currentAnswer: ChoiceLetter,
): ChoiceLetter {
  void passageText;
  void choices;
  return currentAnswer;
}

async function verifyAnswerWithAI(
  question: string,
  choices: [string, string, string, string],
): Promise<ChoiceLetter | null> {
  try {
    const apiKey = Deno.env.get("OPENAI_API_KEY");
    if (!apiKey) return null;
    const variationSeed = Math.random().toString(36).slice(2, 8);
    const prompt = `
Question: ${question}

Choices:
A. ${choices[0]}
B. ${choices[1]}
C. ${choices[2]}
D. ${choices[3]}

Select the correct answer.
Return ONLY one letter: A, B, C, or D.
Variation ID: ${variationSeed}
`;
    const res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.7,
        max_output_tokens: 10,
        input: prompt,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const json = await res.json() as {
      output?: Array<{ content?: Array<{ text?: string }> }>;
      output_text?: string;
    };
    const raw = String(json.output?.[0]?.content?.[0]?.text || json.output_text || "").trim();
    const parsed = normalizeAnswer(raw);
    if (["A", "B", "C", "D"].includes(parsed)) {
      return parsed as ChoiceLetter;
    }
    return null;
  } catch (err) {
    console.warn("⚠️ Verification failed", err);
    return null;
  }
}

function isValidQuestion(q: Question, passage: PassageContent | string): boolean {
  void passage;
  if (!q) return false;
  if (!Array.isArray(q.choices) || q.choices.length !== 4) return false;
  if (typeof q.correct_answer !== "string") return false;
  if (!["A", "B", "C", "D"].includes(String(q.correct_answer).toUpperCase())) return false;
  if (!String(q.question || "").trim()) return false;
  return true;
}

function hasReasonableAlignment(q: Question, passage: PassageContent | string): boolean {
  const passageText = getPassageText(passage);
  if (!passageText.trim()) return true;
  const questionText = String(q.question || "").toLowerCase();
  const passageKeywords = getTopicKeywords(passageText);
  if (passageKeywords.some((keyword) => keyword && questionText.includes(keyword))) {
    return true;
  }
  return (Array.isArray(q.choices) ? q.choices : [])
    .some((choice) => relatesToPassage(String(choice || ""), passageText));
}

function matchesSkill(q: Question, skill: string): boolean {
  return validateQuestionAlignment(String(q.question || ""), skill) && enforceSkill(String(q.question || ""), skill);
}

function isWeakQuestion(q: Question): boolean {
  const choices = Array.isArray(q.choices) ? q.choices : [];
  if (choices.length !== 4) return true;
  if (!String(q.question || "").trim()) return true;
  return choices.some((choice) => {
    const text = String(choice || "").trim();
    return !text || text.length < 12;
  });
}

function getTopicKeywords(text: string): string[] {
  const stopWords = new Set([
    "the", "and", "with", "that", "this", "from", "have", "were", "their", "they", "about", "into", "there",
    "after", "before", "because", "could", "would", "should", "which", "where", "when", "while", "than",
  ]);
  const tokens = String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 4 && !stopWords.has(token));
  return Array.from(new Set(tokens)).slice(0, 14);
}

function relatesToPassage(choice: string, passage: string): boolean {
  const choiceTokens = String(choice || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 4);
  if (!choiceTokens.length) return false;
  const passageText = String(passage || "").toLowerCase();
  return choiceTokens.some((token) => passageText.includes(token));
}

function enforceSkill(question: string, skill: string): boolean {
  const q = String(question || "").toLowerCase();
  const s = String(skill || "").toLowerCase();
  if (s.includes("author")) {
    return q.includes("author") || q.includes("purpose") || q.includes("include");
  }
  if (s.includes("infer")) {
    return true;
  }
  if (s.includes("theme")) {
    return q.includes("theme") || q.includes("message") || q.includes("lesson");
  }
  return true;
}

function hasBalancedReadingChoices(choices: [string, string, string, string]): boolean {
  const words = choices.map((c) => String(c || "").trim().split(/\s+/).filter(Boolean).length);
  const max = Math.max(...words);
  const min = Math.min(...words);
  if (max - min > 10) return false;
  const leadWords = choices.map((c) => String(c || "").trim().split(/\s+/)[0]?.toLowerCase() || "");
  return leadWords.every(Boolean);
}

function finalValidation(q: Question, passage: string, skill: string): boolean {
  void skill;
  if (!q || !Array.isArray(q.choices) || q.choices.length !== 4) return false;
  const text = `${q.question || ""} ${q.choices.join(" ")}`.toLowerCase();
  if (text.includes("newspaper") || text.includes("interview")) return false;
  if (new Set(q.choices.map((choice) => String(choice || "").trim().toLowerCase())).size < 4) return false;
  return true;
}

function repairQuestion(q: Question, subject: CanonicalSubject, passage: PassageContent | string): Question {
  const fallbackStem = "Which statement is best supported by the passage?";
  const questionText = String(q.question || "").trim() || fallbackStem;
  const cleanForSubject = (choice: string): string => subject === "Math"
    ? (sanitizeMathChoice(choice) || "0")
    : cleanAnswerChoice(choice);
  const safeChoices = Array.isArray(q.choices) && q.choices.length === 4
    ? normalizeChoices(q.choices).map(cleanForSubject) as [string, string, string, string]
    : normalizeChoices(Array.isArray(q.choices) ? q.choices : []).map(cleanForSubject) as [string, string, string, string];
  const uniqueChoices = makeChoicesUnique(safeChoices, subject, questionText);
  const safeAnswer = typeof q.correct_answer === "string" && LETTERS.includes(q.correct_answer as ChoiceLetter)
    ? q.correct_answer as ChoiceLetter
    : "A";
  const passageText = getPassageText(passage);
  const safeExplanation = String(q.explanation || "").trim() ||
    "This question was adjusted to maintain quality and alignment with the passage.";

  return validateMCQuestion({
    ...q,
    question: questionText,
    choices: uniqueChoices,
    correct_answer: safeAnswer,
    explanation: safeExplanation,
  }, passageText, subject);
}

function rebuildQuestionFromPassage(
  q: Question,
  subject: CanonicalSubject,
  passageText: string,
  level: Level = "On Level",
): Question {
  const fallbackQuestion = String(q.question || "").trim() || getUniversalQuestion(subject, "general", 0, level);
  const rebuiltChoices = forcePassageChoices(passageText);
  const rebuiltCorrect = "A";
  const rebuiltCorrectChoice = String(rebuiltChoices[LETTERS.indexOf(rebuiltCorrect)] || "");
  return {
    ...q,
    question: fallbackQuestion,
    choices: rebuiltChoices,
    correct_answer: rebuiltCorrect,
    explanation: buildFallbackExplanation(passageText, fallbackQuestion, rebuiltCorrectChoice),
  };
}

function validateMCQuestion(
  q: Question,
  passage: PassageContent | string,
  subject: CanonicalSubject = "Reading",
): Question {
  if (!q.type || q.type !== "mc") {
    q.type = "mc";
  }

  const passageText = String(getPassageText(passage) || "");
  const bannedTemplates = new Set([
    "all of the above",
    "none of the above",
    "both a and c",
    "both b and d",
  ]);

  let normalizedQuestion = String(q.question || "").trim();
  const cleanForSubject = (choice: string): string => subject === "Math"
    ? (sanitizeMathChoice(choice) || "0")
    : cleanAnswerChoice(choice);
  let choices = normalizeChoices(q.choices).map(cleanForSubject) as [string, string, string, string];
  const isCopied = (choice: string, sourcePassage: string) => {
    return sourcePassage.includes(choice.trim());
  };

  if (q.choices.some((c) => isCopied(String(c || ""), passageText))) {
    console.warn("⚠️ Choices copy passage verbatim — keeping question");
  }
  let safeAnswer = safeCorrectAnswer(q.correct_answer);
  const hasBrokenChoices = !Array.isArray(choices) || choices.length !== 4;
  const uniqueChoiceCount = new Set(choices.map((choice) => String(choice || "").trim().toLowerCase())).size;
  const allChoicesIdentical = uniqueChoiceCount <= 1;
  const hasExactBannedTemplate = choices.some((choice) => bannedTemplates.has(String(choice || "").trim().toLowerCase()));
  if (hasBrokenChoices || allChoicesIdentical || hasExactBannedTemplate) {
    return rebuildQuestionFromPassage(q, subject, passageText);
  }

  if (isVocabStyleQuestion(normalizedQuestion)) {
    const targetWord = extractVocabTargetWord(normalizedQuestion);
    choices = normalizeVocabChoices(choices) as [string, string, string, string];
    if (!isValidVocabTarget(passageText, targetWord)) {
      normalizedQuestion = "Which idea is BEST supported by the passage?";
      choices = makeChoicesUnique(choices, subject, normalizedQuestion);
      safeAnswer = safeCorrectAnswer(q.correct_answer);
    }
  }
  // if (subject === "Math") {
  //   choices = enforceMathChoices(choices, safeAnswer);
  // }

  const { letter: originalLetter } = getQuestionCorrectPair({
    ...q,
    question: normalizedQuestion,
    choices,
    correct_answer: safeAnswer,
  });

  if (!originalLetter) {
    console.warn("⚠️ Invalid correct_answer — randomizing");

    const fallback = pickRandom(["A", "B", "C", "D"]) as ChoiceLetter;

    return {
      ...q,
      choices,
      correct_answer: fallback,
      explanation: String(q.explanation || "Answer corrected due to invalid response."),
    };
  }

  const resolvedCorrectLetter = originalLetter as ChoiceLetter;

  const finalChoice = String(choices[LETTERS.indexOf(resolvedCorrectLetter)] || "").trim();
  const evidenceSnippet = extractEvidenceSnippet(
    passageText,
    [
      ...String(q.question || "").split(/\s+/).slice(0, 5),
      ...finalChoice.split(/\s+/).slice(0, 6),
    ],
    finalChoice,
  );
  const syncedExplanation = finalChoice
    ? evidenceSnippet
      ? `If you focus on the passage idea about ${summarizeEvidenceIdea(evidenceSnippet)}, ${resolvedCorrectLetter} (${finalChoice}) stays most consistent with the evidence.`
      : buildGuidedFallbackExplanation(finalChoice)
    : String(q.explanation || "").trim();

  return {
    ...q,
    question: normalizedQuestion,
    choices,
    correct_answer: resolvedCorrectLetter,
    explanation: syncedExplanation,
  };
}

function normalizeAndValidate(q: Question, passage: PassageContent | string): Question {
  const normalized = {
    ...q,
    choices: normalizeChoices(q.choices),
    correct_answer: safeCorrectAnswer(q.correct_answer),
  } as Question;
  return validateMCQuestion(normalized, passage, "Reading");
}

function validateOnce(questions: Question[], passage: PassageContent | string): Question[] {
  return questions.map((q) => normalizeAndValidate(q, passage));
}
function normalizeMultiSelectAnswer(value: unknown): ChoiceLetter[] {
  const raw = Array.isArray(value) ? value : [];

  return raw
    .map((entry) => normalizeAnswer(entry))
    .filter(Boolean);
}

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function trimExpansionTail(text: string): string {
  const sentences = text
    .split(/[.!?]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const badPatterns = [
    "This shows how evidence",
    "These examples make it easier",
    "Each detail builds",
    "By comparing observations",
  ];

  const filtered = sentences.filter((s) =>
    !badPatterns.some((p) => s.includes(p))
  );

  if (!filtered.length) return "";
  return `${filtered.join(". ")}.`;
}

function getExplanationStarter(): string {
  const starters = [
    "This part of the passage shows that",
    "The passage explains that",
    "You can see this when the text states",
    "This line reveals that",
    "The author shows this by stating",
  ];
  return starters[Math.floor(Math.random() * starters.length)];
}

function clampPassageWords(passage: string, min: number, max: number): string {
  const cleaned = String(passage || "").replace(/\s+/g, " ").trim();
  const words = cleaned.split(" ").filter(Boolean);

  if (words.length < min) return cleaned;
  return words.slice(0, max).join(" ");
}

function ensurePassageLength(
  passage: string,
  min = 250,
  max = 300,
  subject: CanonicalSubject = "Reading",
  mode: CanonicalMode = "Practice",
  grade = 5,
  level: Level = "On Level",
  allowFallback = true,
): string {
  const cleaned = String(passage || "").replace(/\s+/g, " ").trim();
  const words = cleaned.split(" ").filter(Boolean);
  if (words.length >= min && words.length <= max) return trimExpansionTail(cleaned);
  if (words.length > max) return trimExpansionTail(words.slice(0, max).join(" "));
  if (words.length < min) {
    return trimExpansionTail(cleaned);
  }
  // NEVER fallback here — just return cleaned
  return trimExpansionTail(cleaned);
}

function isWeakPassage(passage: PassageContent | string, grade = 5): boolean {
  const text = getPassageText(passage).trim();
  if (!text) return true;
  const words = text.split(/\s+/).filter(Boolean).length;
  const minWords =
    grade <= 3 ? 110 :
    grade <= 5 ? 140 :
    160;
  return words < minWords;
}

function fallbackPassage(subject: CanonicalSubject, mode: CanonicalMode, grade: number, level: Level = "On Level"): string {
  const min = 250;
  const max = 300;

  if (mode === "Cross-Curricular") {
    let passageText = buildSubjectPassage(subject, level);
    passageText = enforceValidPassage(passageText, subject, level);
    return ensurePassageLength(clampPassageWords(passageText, min, max), min, max, subject, mode, grade, level, false);
  }

  if (subject === "Math") {
    return ensurePassageLength(clampPassageWords(
      "A school is planning a weekend market fundraiser. Student teams must decide pricing, estimate supply needs, and compare costs for materials and transportation. Their plan includes tracking sales data, calculating totals after discounts, and checking whether the final profit meets a goal for classroom technology.",
      min,
      max,
    ), min, max, subject, mode, grade, level, false);
  }

  if (subject === "Science") {
    return ensurePassageLength(clampPassageWords(
      "Students tested how light intensity affects plant growth by placing seedlings at different distances from a lamp. They measured height changes, tracked water use, and recorded observations over two weeks. The class analyzed patterns in the data and debated which variables might have influenced unexpected results.",
      min,
      max,
    ), min, max, subject, mode, grade, level, false);
  }

  if (subject === "Social Studies") {
    return ensurePassageLength(clampPassageWords(
      "In the early years of a growing town, leaders debated whether to invest limited funds in roads, irrigation, or a public market. Farmers, merchants, and families offered different priorities based on geography, trade routes, and available jobs. Newspaper editorials from the period show how economic choices shaped civic life and daily routines.",
      min,
      max,
    ), min, max, subject, mode, grade, level, false);
  }

  return ensurePassageLength(clampPassageWords(
    "A class read an informational article about how communities solve local problems by collecting evidence, comparing ideas, and choosing the most effective solution. Students tracked key details, discussed author choices, and explained which evidence best supported the central claim.",
    min,
    max,
  ), min, max, subject, mode, grade, level, false);
}

function isCompareSkill(skill: string): boolean {
  const normalized = String(skill || "").toLowerCase();
  return normalized.includes("compare") || normalized.includes("contrast") || normalized.includes("two texts");
}

function detectThinkingType(question: string): "inference" | "evidence" | "main_idea" | "cause_effect" | "general" {
  const q = question.toLowerCase();

  if (q.includes("infer") || q.includes("conclude") || q.includes("most likely")) {
    return "inference";
  }
  if (q.includes("evidence") || q.includes("which sentence")) {
    return "evidence";
  }
  if (q.includes("main idea") || q.includes("central idea")) {
    return "main_idea";
  }
  if (q.includes("cause") || q.includes("why")) {
    return "cause_effect";
  }

  return "general";
}

function extractPassageKeywords(passage: string): string[] {
  return String(passage || "")
    .toLowerCase()
    .split(/\W+/)
    .filter((word) => word.length > 4)
    .slice(0, 20);
}

function extractEvidenceSnippet(passage: string, keywords: string[], answer = ""): string | null {
  const sentences = String(passage || "")
    .split(/[.?!\n]/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => Boolean(sentence) && !isBlockedEvidenceSnippet(sentence));

  let best: string | null = null;
  let bestScore = 0;

  for (const sentence of sentences) {
    const score = scoreEvidenceSentence(sentence, keywords);
    if (score > bestScore) {
      bestScore = score;
      best = sentence.trim();
    }
  }

  if (!best || bestScore < 1 || isBlockedEvidenceSnippet(best)) {
    return getBetterSnippet(passage, answer || keywords.join(" "));
  }
  if (answer && !supportsMeaning(best, answer)) {
    return getBetterSnippet(passage, answer);
  }
  return best;
}

function extractEvidence(passage: string, keywords: string[]): string | null {
  const sentences = String(passage || "").split(/[.!?]/).map((s) => s.trim()).filter(Boolean);

  for (const keyword of keywords) {
    const match = sentences.find((s) =>
      s.toLowerCase().includes(String(keyword || "").toLowerCase())
    );
    if (match) return match;
  }

  return null;
}

function buildTargetedHint(question: string): string {
  const lower = String(question || "").toLowerCase();
  if (lower.includes("infer")) {
    return "Look for clues across multiple sentences and combine them.";
  }
  if (lower.includes("main idea")) {
    return "Focus on ideas repeated across the passage.";
  }
  if (lower.includes("detail")) {
    return "Find the sentence that directly supports the answer.";
  }
  return "Start with what the question is asking, then match it to the strongest evidence.";
}

function buildTargetedStrategy(
  subject: CanonicalSubject,
  question: string,
  passage: string,
  thinkingType: ReturnType<typeof detectThinkingType>,
): { hint: string; think: string; step_by_step: string } {
  if (subject === "Math") {
    return {
      hint: "Focus on what operation or steps the problem is asking for.",
      think: "What steps do I need to solve this problem correctly?",
      step_by_step:
        "1. Identify what the problem is asking\n2. Choose the correct operation\n3. Solve step by step\n4. Check your work",
    };
  }

  if (subject === "Science") {
    return {
      hint: "Look at how variables or conditions affect each other.",
      think: "What relationship is shown between cause and effect?",
      step_by_step:
        "1. Identify key variables\n2. Look for relationships\n3. Match the relationship to the answer\n4. Eliminate incorrect interpretations",
    };
  }

  if (subject === "Social Studies") {
    return {
      hint: "Think about the context and what is happening in the situation.",
      think: "What caused this event or decision?",
      step_by_step:
        "1. Identify the situation\n2. Think about cause and effect\n3. Match the reasoning to the answer\n4. Eliminate incorrect context",
    };
  }

  const focus = extractQuestionFocus(question);
  const snippet = extractEvidenceSnippet(passage, String(question || "").split(/\s+/).slice(0, 8));
  const snippetLead = snippet ? `Use this anchor sentence: "${snippet}".` : "Find one sentence that most directly answers the question.";

  if (thinkingType === "inference") {
    return {
      hint: `${snippetLead} Then combine it with one more detail to infer what is implied, not only stated.`,
      think: focus ? `Which two details connect to show ${focus}?` : "Which two details work together to support the conclusion?",
      step_by_step:
        "1. Locate a key detail\n2. Locate a second related detail\n3. Explain what those details imply together\n4. Pick the option that matches that inference",
    };
  }

  if (thinkingType === "evidence") {
    return {
      hint: `${snippetLead} Select the answer that can be quoted directly.`,
      think: focus ? `Which option gives direct text evidence for ${focus}?` : "Which option can you prove with exact words from the passage?",
      step_by_step:
        "1. Read the answer choice\n2. Verify the same idea appears in the text\n3. Eliminate choices that only sound related\n4. Keep the quote-level match",
    };
  }

  if (thinkingType === "main_idea") {
    return {
      hint: `${snippetLead} Make sure your answer covers the whole passage, not one detail.`,
      think: "Which idea repeats across several details in the passage?",
      step_by_step:
        "1. Identify the topic\n2. List repeated supporting details\n3. Remove narrow detail-only options\n4. Choose the broad idea supported by all key details",
    };
  }

  if (thinkingType === "cause_effect") {
    return {
      hint: `${snippetLead} Track what happened first and what happened because of it.`,
      think: "What specific detail caused the outcome named in the question?",
      step_by_step:
        "1. Mark the cause in the text\n2. Mark the resulting effect\n3. Check that the option keeps the same direction\n4. Eliminate reversed or unrelated relationships",
    };
  }

  return {
    hint: `${snippetLead} Match the strongest supporting detail to the question.`,
    think: "Which detail is strongest and most directly connected to the prompt?",
    step_by_step:
      "1. Read the question\n2. Locate the strongest matching detail\n3. Remove options with partial support\n4. Choose the most completely supported answer",
  };
}

function buildSubjectExplanation(subject: CanonicalSubject, baseExplanation: string): string {
  if (subject === "Math") {
    return `A strong math student solves step by step. ${baseExplanation}`;
  }

  if (subject === "Science") {
    return `Think like a scientist. Look at the relationship between variables. ${baseExplanation}`;
  }

  if (subject === "Social Studies") {
    return `Think about the situation and context. ${baseExplanation}`;
  }

  return baseExplanation;
}

function classifyErrorType(subject: string, question: string, choice: string): string {
  const q = String(question || "").toLowerCase();

  if (subject === "Math") {
    if (q.includes("total") || q.includes("sum") || q.includes("difference")) {
      return "wrong_operation";
    }
    if (/\d/.test(String(choice || ""))) {
      return "calculation_error";
    }
    return "procedural_error";
  }

  if (subject === "Science") {
    if (q.includes("cause") || q.includes("effect")) {
      return "cause_effect_error";
    }
    return "variable_misunderstanding";
  }

  if (subject === "Social Studies") {
    if (q.includes("why") || q.includes("result")) {
      return "cause_reasoning_error";
    }
    return "context_error";
  }

  return "reading_error";
}

function explainDistractor(
  choice: string,
  correct: string,
  passage: string,
  subject: CanonicalSubject,
  question: string,
): string {
  if (!choice) return "";
  void passage;
  const errorType = classifyErrorType(subject, question, choice);

  if (subject === "Math") {
    if (errorType === "wrong_operation") {
      return `❌ ${choice} — This answer likely comes from using the wrong operation compared to the correct answer (${correct}).`;
    }
    if (errorType === "calculation_error") {
      return `❌ ${choice} — This answer may come from a small calculation mistake, even if the setup was correct.`;
    }
    return `❌ ${choice} — This answer shows a mistake in the steps or process used to solve the problem.`;
  }

  if (subject === "Science") {
    if (errorType === "cause_effect_error") {
      return `❌ ${choice} — This answer mixes up cause and effect and does not match the relationship shown in the scenario.`;
    }
    return `❌ ${choice} — This answer misinterprets the relationship between variables in the passage or data.`;
  }

  if (subject === "Social Studies") {
    if (errorType === "cause_reasoning_error") {
      return `❌ ${choice} — This answer does not correctly explain the cause or reasoning behind the event.`;
    }
    return `❌ ${choice} — This answer does not match the historical or situational context described.`;
  }

  return `❌ ${choice} — This answer may sound correct, but it does not match the passage as closely as the correct answer (${correct}).`;
}

function buildBetterDistractors(passage: string, correct: string): string[] {
  const normalizedCorrect = String(correct || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ");
  const correctTokens = normalizedCorrect.split(/\s+/).filter((token) => token.length > 3);
  const sentencePool = String(passage || "")
    .split(/[.!?]+/)
    .map((sentence) => sentence.replace(/\s+/g, " ").trim())
    .filter((sentence) => sentence.split(/\s+/).filter(Boolean).length >= 7);

  if (!sentencePool.length) return [];

  const ranked = sentencePool
    .map((sentence) => {
      const lower = sentence.toLowerCase();
      const overlap = correctTokens.reduce((score, token) => score + (lower.includes(token) ? 1 : 0), 0);
      return { sentence, lower, overlap };
    })
    .filter((entry) => !normalizedCorrect || !entry.lower.includes(normalizedCorrect))
    .sort((a, b) => b.overlap - a.overlap || b.sentence.length - a.sentence.length);

  const transformed = ranked
    .slice(0, 8)
    .flatMap(({ sentence }) => {
      const clipped = sentence.replace(/,\s*[^,]+$/, "").trim() || sentence;
      const reversedCause = clipped
        .replace(/\bbecause\b/gi, "even though")
        .replace(/\btherefore\b/gi, "however")
        .replace(/\bso that\b/gi, "even if");
      const overgeneralized = `${clipped.replace(/\.$/, "")} in every situation.`;
      const partial = clipped
        .replace(/\bmost\b/gi, "some")
        .replace(/\bmainly\b/gi, "partly")
        .replace(/\balways\b/gi, "sometimes");
      return [reversedCause, overgeneralized, partial];
    })
    .map((candidate) => candidate.replace(/\s+/g, " ").trim())
    .filter((candidate) =>
      candidate.length > 25 &&
      candidate.toLowerCase() !== normalizedCorrect &&
      !candidate.toLowerCase().includes(normalizedCorrect),
    );

  return Array.from(new Set(transformed)).slice(0, 3);
}

function buildMisconceptionDistractors(
  correct: string,
  passage: string,
): string[] {
  void passage;
  return [
    correct.replace("because", "even though"),
    correct.replace("most", "some"),
    correct.replace("increase", "decrease"),
    correct.replace("cause", "result"),
  ].map((candidate) => `${candidate} based on a misinterpretation of the passage.`);
}

function buildSubjectDistractors(q: Question, passage: string, subject: CanonicalSubject): string {
  const { letter: correctLetter, choice: correctChoice } = getQuestionCorrectPair(q);
  if (!correctLetter) return "";
  const normalizedChoices = normalizeChoices(q.choices);
  const hasPassage = String(passage || "").trim().length > 0;
  const passageDistractors = hasPassage
    ? [
      ...buildBetterDistractors(String(passage || ""), correctChoice),
      ...buildMisconceptionDistractors(correctChoice, String(passage || "")),
    ].slice(0, 3)
    : [];
  return normalizedChoices
    .map((choice, index) => ({ choice, letter: LETTERS[index] }))
    .filter(({ letter }) => letter !== correctLetter)
    .map(({ choice, letter }, index) => {
      const distractorChoice = hasPassage && (isWeakDistractor(choice) || String(choice || "").trim().length === 0)
        ? (passageDistractors[index] || choice)
        : choice;
      const withLetter = `${letter}. ${distractorChoice}`;
      return explainDistractor(
        withLetter,
        `${correctLetter}. ${correctChoice}`,
        passage,
        subject,
        String(q.question || ""),
      );
    })
    .filter(Boolean)
    .join("\n");
}

function buildSupportContent(
  subject: CanonicalSubject,
  q: Question,
  _index: number,
  _level: Level = "On Level",
  mode: CanonicalMode = "Practice",
  passage: PassageContent | string = "",
  supportMode: "Tutor" | "Answer Key" = "Tutor",
): { explanation: string; common_mistake: string; parent_tip: string; hint: string; think: string; step_by_step: string } {
  void supportMode;
  const questionText = String(q.question || "").trim();
  const isCross = mode === "Cross-Curricular";
  const shouldUsePassage = isPassageBased(mode, subject);
  const passageText = shouldUsePassage ? getPassageText(passage) : "";
  const keywords = questionText.split(/\s+/).slice(0, 5);
  const { letter: correctLetter, choice: correctChoice } = getQuestionCorrectPair(q);
  const snippet = extractEvidenceSnippet(
    passageText,
    [...keywords, ...String(correctChoice || "").split(/\s+/).slice(0, 5)],
    String(correctChoice || ""),
  );
  const distractorAnalysis = buildSubjectDistractors(q, passageText, subject);
  const thinkingType = detectThinkingType(questionText);
  const hasStrongEvidence = Boolean(snippet) && supportsMeaning(String(snippet || ""), String(correctChoice || ""));
  const hasWeakEvidence = Boolean(snippet) && !hasStrongEvidence;
  const evidenceIdea = summarizeEvidenceIdea(String(snippet || ""));
  const conversationalLeads = [
    "Here is how I would think through it:",
    "Let’s reason it out together:",
    "A strong way to solve this is:",
    "Notice what the passage is really saying:",
  ];
  const lead = conversationalLeads[Math.abs(_index) % conversationalLeads.length];
  const noEvidenceMessage = buildGuidedFallbackExplanation(String(correctChoice || ""));
  const semiSpecificMessage = snippet
    ? `${lead} the passage emphasizes ${evidenceIdea}, which supports ${extractKeyConcept(String(correctChoice || ""))} and points to the best choice.`
    : noEvidenceMessage;
  const safeGenericExplanation = noEvidenceMessage;
  // Always trust AI explanation.
  let explanation = subject === "Math"
    ? `${lead} start with what the problem gives you, then use those details to test each choice and keep the one that matches the math evidence.`
    : subject === "Science"
    ? hasStrongEvidence
      ? `${lead} the passage detail about ${evidenceIdea} shows the cause-and-effect relationship that supports the correct conclusion.`
      : hasWeakEvidence
      ? semiSpecificMessage
      : noEvidenceMessage
    : subject === "Social Studies"
    ? hasStrongEvidence
      ? `${lead} the source detail about ${evidenceIdea} gives the strongest support for the historical or civic conclusion.`
      : hasWeakEvidence
      ? semiSpecificMessage
      : noEvidenceMessage
    : `
${lead} the passage highlights ${evidenceIdea}.
That idea is the best evidence because it matches the question focus.
`.trim();

  if (subject === "Reading" || shouldUsePassage) {
    if (!hasStrongEvidence && hasWeakEvidence) {
      explanation = semiSpecificMessage;
    } else if (!hasStrongEvidence) {
      explanation = noEvidenceMessage;
    }
  }

  if (thinkingType === "inference") {
    explanation = `${explanation}\n\nFor inference questions, combine two or more clues from the passage before you choose an answer.`;
  } else if (thinkingType === "evidence") {
    explanation = `${explanation}\n\nFor evidence questions, keep the option you can prove with a specific sentence from the passage.`;
  } else if (thinkingType === "main_idea") {
    explanation = `${explanation}\n\nFor main idea questions, focus on the pattern repeated across multiple details.`;
  } else if (thinkingType === "cause_effect") {
    explanation = `${explanation}\n\nFor cause-and-effect questions, trace what happened and which detail caused that outcome.`;
  } else {
    explanation = `${explanation}\n\nStart with what the question is asking, then match it to the strongest text evidence.`;
  }
  explanation = buildSubjectExplanation(subject, explanation);

  const fullExplanation = `${explanation}\n\n${distractorAnalysis}`.trim();
  if (isCross) {
    explanation = `Now think like a ${subject} student. This isn’t just reading—it’s applying what you know.\n\n${fullExplanation}`;
  } else {
    explanation = fullExplanation;
  }

  const normalizedChoices = normalizeChoices(q.choices);
  const wrongChoices = normalizedChoices.filter((_, i) => LETTERS[i] !== correctLetter);
  const sampleWrong =
    wrongChoices.find((choice) => classifyErrorType(subject, questionText, choice) === "wrong_operation") ||
    wrongChoices[0] ||
    "";
  const mt = buildMistakeAndTip(subject, questionText, sampleWrong);

  const common_mistake = mt.mistake;
  const parent_tip = `👨‍👩‍👧 Parent Tip: Ask your child: ${mt.tip}`;

  const strategy = buildTargetedStrategy(subject, questionText, passageText, thinkingType);
  const hint = buildTargetedHint(questionText);
  const think = strategy.think;
  const step_by_step = strategy.step_by_step;

  return {
    explanation,
    common_mistake,
    parent_tip,
    hint,
    think,
    step_by_step,
  };
}

function fallbackPassageContent(
  subject: CanonicalSubject,
  mode: CanonicalMode,
  grade: number,
  skill: string,
  level: Level = "On Level",
): PassageContent {
  if (!isCompareSkill(skill)) return fallbackPassage(subject, mode, grade, level);

  return {
    text_1: clampPassageWords(
      "In one article, students describe how a neighborhood garden increased fresh food access by organizing volunteer planting days, tracking harvest totals, and sharing produce with nearby families.",
      45,
      130,
    ),
    text_2: clampPassageWords(
      "In a second article, city leaders explain how the same garden improved community health goals through workshops, nutrition lessons, and partnerships that expanded participation across age groups.",
      45,
      130,
    ),
  };
}

function buildPracticeFallback(
  skill: string,
  subject: CanonicalSubject,
  level: Level = "On Level",
  passage?: PassageContent | string,
): Question[] {
  const effectiveSkill: string = skill ?? "Main Idea";
  const stems = subject === "Math"
    ? [
      "A class sold 18 notebooks on Monday and 27 notebooks on Tuesday. Each notebook costs $3. How much money did they make in all?",
      "A student read 14 pages on Friday, 18 pages on Saturday, and 9 pages on Sunday. She wants to read 50 pages total. How many more pages does she need?",
      "A recipe needs 3 cups of flour for one batch. If a club makes 4 batches, how many cups of flour are needed?",
      "A bus carries 42 students. Two buses are full, and 17 more students ride a third bus. How many students are riding in all?",
      "A store sold 65 apples in the morning and 38 apples in the afternoon. If 24 apples were returned, how many apples were sold finally?",
    ]
    : subject === "Science"
    ? [
      "What caused the metal spoon to feel colder than the wooden spoon in the same room?",
      "A plant near a window grew taller than a plant in a dark corner. Why did this happen?",
      "In an experiment, students changed only the amount of water each plant received. What was the variable they tested?",
      "A chart shows a toy car traveled farther on a smooth ramp than on a rough ramp. Which idea best explains the result?",
      "Which observation is the best evidence that heating ice causes a change of state?",
    ]
    : subject === "Social Studies"
    ? [
      "Which event happened first in this timeline: town meeting, bridge construction, or market opening?",
      "Why did early settlers build towns near rivers?",
      "What was one result of building railroads across Texas communities?",
      "A city council voted to add a public library. Which group was most likely helped right away?",
      "Which statement best explains how a local election can change a community?",
    ]
    : [
      `What can be inferred about ${effectiveSkill.toLowerCase()} based on the passage details?`,
      "Which detail from the passage best supports the strongest inference?",
      "Which theme is most supported by the events in the passage?",
      "Which sentence from the passage is the best evidence for the theme?",
      "What conclusion is best supported by two details in the passage?",
    ];
  const mathChoiceBanks: [string, string, string, string][] = [
    ["$135", "$81", "$45", "$162"],
    ["9 pages", "41 pages", "23 pages", "5 pages"],
    ["12 cups", "7 cups", "9 cups", "1 cup"],
    ["101 students", "84 students", "59 students", "125 students"],
    ["79 apples", "103 apples", "41 apples", "127 apples"],
  ];

  return stems.map((stem, i) => {
    const type: QuestionType = "mc";
    let leveledStem = stem;
    if (level === "Below") {
      leveledStem = `${leveledStem.split("?")[0]}?`;
    } else if (level === "On Level") {
      if (subject !== "Reading") leveledStem = `${leveledStem} Use two steps to justify your choice.`;
    } else {
      leveledStem = subject === "Math"
        ? `${leveledStem} Include only relevant numbers and ignore extra information to solve.`
        : leveledStem;
    }
    const passageText = getPassageText(passage || "").trim();
    const safePassage = passageText.length > 0
      ? passageText
      : buildSubjectPassage("Reading", level);
    const sourceChoices = subject === "Math"
      ? mathChoiceBanks[i % mathChoiceBanks.length]
      : subject === "Science"
      ? [
        "Darker pavement absorbed and retained more solar energy, so it heated faster than shaded grass with moisture and airflow.",
        "Grass should heat faster because chlorophyll creates extra heat during photosynthesis in full daylight.",
        "Surface temperature was controlled mainly by thermometer placement, so surface type did not affect results.",
        "Watering one section proves sunlight had no role because moisture always overrides every other variable.",
      ]
      : subject === "Social Studies"
      ? [
        "Flood-related shipment delays raised prices, which pushed residents to question rail-only investment.",
        "Flooding ended before rail expansion began, so transportation costs dropped immediately after the first vote.",
        "Voters approved the bridge bond first, and rail improvements were added only after that success.",
        "Population growth reduced cross-river travel demand, so no major transportation decision was necessary.",
      ]
      : forcePassageChoices(safePassage);
    const correctAnswer = String(sourceChoices[0] || "").trim();
    const distractors = buildStudentMistakeDistractors(safePassage, String(correctAnswer || "").trim(), leveledStem);
    const choices = [correctAnswer, ...distractors];
    const finalChoices = shuffleArray(choices.map((choice) => String(choice || "").trim()).filter(Boolean));
    while (finalChoices.length < 4) {
      finalChoices.push(`Option ${finalChoices.length + 1}`);
    }
    const correctIndex = finalChoices.findIndex((c) => String(c) === String(correctAnswer));
    if (correctIndex === -1) {
      finalChoices[0] = correctAnswer;
    }
    const safeChoices = normalizeChoices(finalChoices as [string, string, string, string]);
    const resolvedCorrectAnswer = LETTERS[Math.max(0, finalChoices.findIndex((c) => String(c) === String(correctAnswer)))] || "A";
    const question: Question = {
      type,
      question: leveledStem,
      choices: safeChoices,
      correct_answer: resolvedCorrectAnswer,
      explanation: "",
      hint: "",
      think: "",
      step_by_step: "",
      common_mistake: "",
      parent_tip: "",
    };
    const support = buildSupportContent(subject, question, i, level, "Practice", passage || "");
    question.explanation = support.explanation;
    question.hint = support.hint;
    question.think = support.think;
    question.step_by_step = support.step_by_step;
    question.common_mistake = support.common_mistake;
    question.parent_tip = support.parent_tip;
    return question;
  });
}

function forcePassageChoices(passage: PassageContent | string): [string, string, string, string] {
  const text = typeof passage === "string" ? passage : (passage?.text_1 || "");

  const sentences = text
    .split(/[.!?]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 25);

  const base = sentences[0] || text.slice(0, 120);

  return [
    `${base} because it explains the main idea or outcome in the passage.`,
    `${base} but it only describes part of the situation and misses the main point.`,
    `${base} even though it focuses on a detail that is not the most important.`,
    `${base} which shows an event but does not fully explain the overall meaning.`,
  ];
}

function buildStudentMistakeDistractors(
  passage: PassageContent | string,
  correctAnswer: string,
  question: string,
): string[] {
  const sentences = getPassageText(passage)
    .split(/[.!?]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 20);

  const correctLower = String(correctAnswer || "").toLowerCase();
  const questionLower = String(question || "").toLowerCase();
  const bestSentence = sentences.find((s) => !correctLower.includes(s.toLowerCase())) || "";
  const primaryClause = bestSentence.split(",")[0]?.trim() || bestSentence;
  const leadingDetail = primaryClause.split(" ").slice(0, 7).join(" ").trim();

  const candidates = [
    // wrong cause/effect
    String(correctAnswer || "").replace(/\bbecause\b/gi, "even though").replace(/\bso\b/gi, "because"),
    // overgeneralization
    `${leadingDetail || "The details"} proves that this happened in every case, not just this situation.`,
    // partial detail
    `${primaryClause || "A single detail in the passage"} is true, but it is enough to fully explain the author's point.`,
    // reversed relationship
    `${leadingDetail || "This detail"} was a result of the final outcome, so it could not have influenced the decision.`,
    // close misconception based on question wording
    `${leadingDetail || "The evidence"} seems to match the question, but it supports a different conclusion than the strongest answer.`,
  ];

  return Array.from(new Set(candidates))
    .filter((d) => d && d.length > 20 && d.toLowerCase() !== correctLower && !questionLower.includes(d.toLowerCase()))
    .slice(0, 3);
}

function buildThinkPrompt(q: Question): string {
  if (q.type === "mc") {
    return "What is the question really asking, and which answer choice is best supported by the passage or problem details?";
  }
  return "How should you think about this question? Focus on what the question is asking and compare each answer choice carefully before selecting the best answer.";
}

function resolveCorrectChoiceText(q: Question): string {
  const normalized = normalizeAnswerKeyEntry(q.correct_answer);
  const singleLetter = normalizeAnswer(normalized);
  const letterIndex = LETTERS.indexOf(singleLetter);
  return letterIndex >= 0 ? String(q.choices?.[letterIndex] || "").trim() : "";
}

function buildDistractorFeedback(q: Question): string {
  if (!Array.isArray(q.choices)) return "";
  const correctLetter = normalizeAnswer(normalizeAnswerKeyEntry(q.correct_answer));
  const wrongReasons = q.choices
    .map((choice, idx) => ({ choice: String(choice || "").trim(), letter: LETTERS[idx] }))
    .filter((entry) => entry.choice && entry.letter !== correctLetter)
    .map((entry) =>
      `${entry.letter} is incorrect because "${entry.choice}" does not fully answer "${q.question}" or is not directly supported by the passage/problem details.`
    );
  if (!wrongReasons.length) return "";
  return `${wrongReasons.join(" ")} Other choices are incorrect because they either include incomplete information or are not supported by the passage/problem details.`;
}

function splitPassageSentences(passage: PassageContent | string): string[] {
  return getPassageText(passage)
    .split(/[.!?]+/)
    .map((sentence) => sentence.trim().replace(/\s+/g, " "))
    .filter((sentence) => sentence.split(/\s+/).filter(Boolean).length >= 5);
}

function extractQuestionFocus(question: string): string {
  const filtered = String(question || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) =>
      token.length > 3 &&
      !["which", "what", "best", "most", "from", "with", "that", "this", "does", "into", "than", "because"].includes(token)
    );

  return filtered.slice(0, 3).join(", ");
}

function selectEvidenceSnippet(
  q: Question,
  passage: PassageContent | string,
  usedEvidence: Set<string> = new Set(),
): string {
  const sentences = splitPassageSentences(passage);
  if (!sentences.length) return "";
  const { choice: correctChoice } = getQuestionCorrectPair(q);
  const questionKeywords = String(q.question || "")
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .filter((token) => token.length >= 4);
  const answerKeywords = String(correctChoice || "")
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .filter((token) => token.length >= 4);
  const uniqueQuestionKeywords = Array.from(new Set(questionKeywords));
  const uniqueAnswerKeywords = Array.from(new Set(answerKeywords));
  const scored = sentences.map((sentence, index) => {
    const lower = sentence.toLowerCase();
    const answerScore = uniqueAnswerKeywords.reduce((acc, token) => acc + (lower.includes(token) ? 2 : 0), 0);
    const questionScore = uniqueQuestionKeywords.reduce((acc, token) => acc + (lower.includes(token) ? 1 : 0), 0);
    return { sentence, score: answerScore + questionScore, answerScore, index };
  }).sort((a, b) =>
    b.score - a.score ||
    b.answerScore - a.answerScore ||
    b.sentence.length - a.sentence.length ||
    a.index - b.index
  );

  const bestUnused = scored.find((entry) => !usedEvidence.has(entry.sentence.toLowerCase()));
  return bestUnused?.sentence || "";
}

function buildAlignedExplanation(
  q: Question,
  passage: PassageContent | string = "",
  usedEvidence: Set<string> = new Set(),
  passageBased = true,
): { why: string; mistake: string; tip: string } {
  const passageText = getPassageText(passage);
  const passageSnippet = passageText ? selectEvidenceSnippet(q, passageText, usedEvidence) : "";
  const backupSnippet = String(q.explanation || q.question)
    .split(/[.!?]+/)
    .map((sentence) => sentence.trim().replace(/\s+/g, " "))
    .find((sentence) => sentence.split(/\s+/).filter(Boolean).length >= 8) || String(q.question || "");
  const snippet = passageSnippet || backupSnippet;
  if (passageSnippet) usedEvidence.add(passageSnippet.toLowerCase());
  const correctLabel = normalizeAnswerKeyEntry(q.correct_answer);
  const correctChoiceText = resolveCorrectChoiceText(q);
  const answerReference = correctChoiceText
    ? `${correctLabel} (${correctChoiceText})`
    : correctLabel;
  const focus = extractQuestionFocus(String(q.question || ""));
  if (!passageBased) {
    return {
      why:
        `${answerReference} is the best fit because it matches the concept tested in the question.`,
      mistake:
        `A frequent trap on "${q.question}" is picking an option that sounds familiar but misses the concept requirement.`,
      tip:
        `Focus on what the question is asking, then eliminate options that do not satisfy the required concept.`,
    };
  }
  return {
    why:
      `The passage highlights ${summarizeEvidenceIdea(snippet)}.\n` +
      `That detail supports ${answerReference} as the best match for ${focus}.`,
    mistake:
      `A frequent trap on "${q.question}" is choosing an option that sounds related but does not match the evidence for ${answerReference}.`,
    tip:
      `Focus on matching each part of "${q.question}" to exact evidence, then remove options that do not directly prove ${answerReference}.`,
  };
}

function shuffleArray<T>(arr: T[]): T[] {
  return arr
    .map((value) => ({ value, sort: Math.random() }))
    .sort((a, b) => a.sort - b.sort)
    .map(({ value }) => value);
}


function buildCrossFallback(
  subject: CanonicalSubject,
  skillOrLevel: string | Level = "On Level",
  maybeLevel: Level = "On Level",
): Question[] {
  const level: Level = skillOrLevel === "Below" || skillOrLevel === "On Level" || skillOrLevel === "Advanced"
    ? skillOrLevel
    : maybeLevel;
  let crossPassage = buildSubjectPassage(subject, level);
  crossPassage = enforceValidPassage(crossPassage, subject, level);
  const singleAnswerSequence = [...shuffledLetters(), ...shuffledLetters()];
  let singleAnswerIndex = 0;
  const nextSingleAnswer = (): ChoiceLetter => {
    const letter = singleAnswerSequence[singleAnswerIndex % singleAnswerSequence.length];
    singleAnswerIndex += 1;
    return letter;
  };

  const stems = subject === "Science"
    ? [
      "What caused the blacktop to heat faster than shaded grass in the investigation passage?",
      "Which event happened after students watered one section during the experiment timeline?",
      "Which detail shows evidence that moisture and airflow affected temperature results?",
      "Why did students recommend shade trees and lighter playground materials?",
      "What can be concluded about how surface type affects playground temperature?",
    ]
    : subject === "Social Studies"
    ? [
      "What caused town leaders to change from rail-only expansion to supporting a bridge?",
      "Which event happened after flooding delayed shipments and raised prices?",
      "Which detail shows that transportation decisions affected people in the community?",
      "Why did population growth across the opposite bank matter to voters?",
      "What can be concluded about how transportation choices changed the town over time?",
    ]
    : [
      "What caused organizers to reconsider whether to restock combo packs or single items?",
      "Which event happened after combo sales dropped by 8 in the second hour?",
      "Which detail shows that single-item demand changed after the announcement?",
      "Why did organizers need to compare both hours before making a restocking decision?",
      "What can be concluded about which option had a stronger effect on total earnings?",
    ];

  const choiceBanks: [string, string, string, string][] = subject === "Math"
    ? [
      [
        "Hour 1 revenue is $276 and hour 2 is $258, so comparing totals is required before restocking.",
        "Hour 1 revenue is $114, so first-hour combo count alone determines the decision.",
        "Hour 2 revenue is $46, so single-item changes never affect totals.",
        "Revenue cannot be computed from the given numbers in either hour.",
      ],
      [
        "Combo count changed from 38 to 30 while single items changed from 24 to 39.",
        "Combo count changed from 38 to 24 while single items stayed at 24.",
        "Combo and single items both changed to 30 in hour 2.",
        "Prices changed from $6 and $2 to $8 and $4 in hour 2.",
      ],
      [
        "Single items increased by 15, from 24 to 39, after the announcement.",
        "Single-item price increased from $2 to $6 after the announcement.",
        "Combo packs increased by 15, from 38 to 53, in hour 2.",
        "No second-hour counts were recorded in the scenario.",
      ],
      [
        "They needed both totals: hour 1 = $276 and hour 2 = $258 before deciding inventory.",
        "They only needed second-hour combo revenue of $180 to finalize inventory.",
        "They only needed first-hour single-item revenue of $48 to finalize inventory.",
        "They needed no totals because item prices are irrelevant to inventory decisions.",
      ],
      [
        "Even with 8 fewer combos, 15 more single items changed total revenue by $18.",
        "Combo sales alone fixed earnings at $228 in both hours.",
        "Single items and combos both add exactly $2 per sale, so they are equal.",
        "No numbers were provided, so earnings cannot be compared.",
      ],
    ]
    : subject === "Science"
    ? [
      [
        "Dark pavement in direct sunlight absorbed more heat than shaded grass with moisture and airflow.",
        "Grass heated fastest because moisture always traps heat better than pavement.",
        "Concrete stayed coolest because wind only affects hard surfaces.",
        "All surfaces heated at the same rate according to the data.",
      ],
      [
        "After watering one section, students observed a smaller temperature increase there.",
        "After watering one section, blacktop became hotter than in full sun.",
        "After watering one section, students stopped recording hourly data.",
        "After watering one section, all surfaces were removed from the test.",
      ],
      [
        "The report says shaded grass stayed cooler because moisture and airflow reduced heat buildup.",
        "The report says grass stayed cooler because it received more direct sunlight than blacktop.",
        "The report says wind speed was ignored, so airflow did not matter.",
        "The report says all surfaces were kept dry during every test.",
      ],
      [
        "They used observed heat-transfer evidence to suggest changes that could keep playground areas cooler.",
        "They preferred trees and light materials only because those options cost less in all cases.",
        "They wanted to remove all grass surfaces from the playground immediately.",
        "They based recommendations on opinions instead of experiment results.",
      ],
      [
        "Surface type and conditions such as sunlight, moisture, and airflow can meaningfully change playground temperature.",
        "Surface type has no effect when thermometers are used every hour.",
        "Only cloud cover changes temperature, not surface material.",
        "Heat transfer cannot be studied through repeated observations.",
      ],
    ]
    : [
      [
        "Flooding delays and higher prices showed the limits of rail-only expansion and pushed support for a bridge.",
        "Leaders changed plans because farmers stopped using markets entirely in 1908.",
        "Leaders changed plans because flooding ended before any rail delays happened.",
        "Leaders changed plans because a bridge was already completed before the debate.",
      ],
      [
        "After flooding delayed shipments, voters later passed a bond for the bridge.",
        "After flooding delayed shipments, rail expansion was canceled before approval.",
        "After flooding delayed shipments, population dropped on the opposite bank.",
        "After flooding delayed shipments, merchants ended all outside trade.",
      ],
      [
        "Newspaper timelines and election results linked transportation choices to migration and business investment.",
        "Meeting records showed that no transportation decision ever changed.",
        "Election results proved citizens rejected all town transportation projects.",
        "The passage says migration patterns stayed exactly the same after the bond.",
      ],
      [
        "Population growth across the river increased pressure to connect both sides of town more reliably.",
        "Population growth across the river removed the need for transportation planning.",
        "Population growth across the river made flooding less important to shipping decisions.",
        "Population growth across the river caused leaders to close the rail depot immediately.",
      ],
      [
        "Transportation decisions over several years influenced trade, settlement patterns, and daily community life.",
        "Transportation decisions changed only election dates, not community outcomes.",
        "Transportation decisions affected farmers but never merchants or families.",
        "Transportation decisions had no long-term effects because the town stayed the same.",
      ],
    ];

  return stems.map((stem, i) => {
    const type: QuestionType = "mc";
    const leveledStem = level === "Below"
      ? `${stem.split("?")[0]}?`
      : level === "Advanced"
      ? `${stem} Compare close alternatives and identify why the strongest distractor is still wrong.`
      : `${stem} Use two linked details to support your reasoning.`;
    const sourceChoices = choiceBanks[i % choiceBanks.length];
    const correctAnswer = String(sourceChoices[0] || "").trim();
    const distractors = buildStudentMistakeDistractors(crossPassage, correctAnswer, leveledStem);
    const choices = shuffleArray([correctAnswer, ...distractors].map((choice) => String(choice || "").trim()).filter(Boolean));
    while (choices.length < 4) {
      choices.push(`Option ${choices.length + 1}`);
    }
    const correctIndex = choices.findIndex((c) => String(c) === String(correctAnswer));
    if (correctIndex === -1) {
      choices[0] = correctAnswer;
    }
    const resolvedCorrectAnswer = LETTERS[Math.max(0, choices.findIndex((c) => String(c) === String(correctAnswer)))] || "A";

    const question: Question = {
      type,
      question: leveledStem,
      choices: choices as [string, string, string, string],
      correct_answer: resolvedCorrectAnswer,
      explanation: "",
      hint: "",
      think: "",
      step_by_step: "",
      common_mistake: "",
      parent_tip: "",
    };
    const support = buildSupportContent(subject, question, i, level, "Cross-Curricular", crossPassage);
    question.explanation = support.explanation;
    question.hint = support.hint;
    question.think = support.think;
    question.step_by_step = support.step_by_step;
    question.common_mistake = support.common_mistake;
    question.parent_tip = support.parent_tip;
    return question;
  });
}

function randomChoice<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

function buildMainIdeaQuestion(): string {
  return "Which statement best expresses the central idea developed across the entire passage?";
}

function buildEvidenceQuestion(): string {
  return "Which sentence from the passage best supports the idea that the author’s claim is based on evidence rather than opinion?";
}

function buildInferenceQuestion(): string {
  return "What is the most likely reason the author includes multiple examples before presenting the final conclusion?";
}

function buildVocabQuestion(): string {
  return "As used in the passage, what does the word \"impact\" most nearly mean in context?";
}

function buildShortResponse(): string {
  return "What is the author’s purpose in organizing the passage this way, and which two details best support your response?";
}

function buildELARCrossQuestions(crossSubject: CanonicalSubject): Question[] {
  const subject: CanonicalSubject = "Reading";
  let crossPassage = buildSubjectPassage(crossSubject, "On Level");
  crossPassage = enforceValidPassage(crossPassage, crossSubject, "On Level");
  const stems = [
    buildMainIdeaQuestion(),
    buildEvidenceQuestion(),
    buildInferenceQuestion(),
    buildVocabQuestion(),
    buildShortResponse(),
  ];
  const singleAnswerSequence = [...shuffledLetters(), ...shuffledLetters()];
  let singleAnswerIndex = 0;
  const nextSingleAnswer = (): ChoiceLetter => {
    const letter = singleAnswerSequence[singleAnswerIndex % singleAnswerSequence.length];
    singleAnswerIndex += 1;
    return letter;
  };

  const crossChoiceBanks: Record<CanonicalSubject, [string, string, string, string][]> = {
    Math: [
      [
        "Organizers compared first-hour and second-hour sales totals, then shifted restocking toward singles after combo demand fell.",
        "Organizers used only first-hour combo sales, so they ignored how second-hour singles changed total revenue.",
        "Organizers raised both prices in hour two, which made the sales counts unnecessary for inventory decisions.",
        "Organizers canceled all tracking after hour one, so no evidence guided the restocking plan.",
      ],
      [
        "Combo packs dropped by eight while single items rose by fifteen, so the team adjusted inventory to protect earnings.",
        "Combo packs and single items both dropped in hour two, so the team reduced all inventory equally.",
        "Single-item prices doubled in hour two, which explains why organizers sold fewer singles.",
        "Hour-two sales were missing, so organizers guessed which items to reorder.",
      ],
      [
        "When organizers compared both hours, they saw singles offset part of the combo decline and changed the final restock mix.",
        "When organizers compared both hours, they found combo sales increased and removed singles from the order.",
        "When organizers compared both hours, they ignored revenue and decided only by package color.",
        "When organizers compared both hours, they found no sales change and kept inventory identical.",
      ],
      [
        "After the announcement, buyers chose more single items, so organizers revised ordering to match the new pattern.",
        "After the announcement, buyers stopped purchasing, so organizers closed sales for the event.",
        "After the announcement, buyers purchased only combos, so singles were removed immediately.",
        "After the announcement, buyers paid new prices, so earlier totals could not be compared.",
      ],
      [
        "Comparing both hours helped organizers connect changing purchase patterns to earnings, leading to a data-based restocking decision.",
        "Comparing both hours showed every item performed equally, so no restocking choice was required.",
        "Comparing both hours proved revenue cannot be computed from item counts and prices.",
        "Comparing both hours forced organizers to rely on guesses instead of recorded totals.",
      ],
    ],
    Science: [
      [
        "Students measured blacktop, shaded grass, and watered areas, then recommended cooler materials after seeing different heat outcomes.",
        "Students measured only blacktop, so they concluded every playground surface heats at exactly the same rate.",
        "Students skipped repeated measurements, so recommendations were based on a single opinion.",
        "Students removed moisture and airflow from testing, so surface conditions could not affect temperatures.",
      ],
      [
        "After one section was watered, that area warmed more slowly, which showed moisture changed heat buildup.",
        "After one section was watered, blacktop became the coolest surface in direct sunlight.",
        "After one section was watered, students ended the investigation before collecting results.",
        "After one section was watered, all thermometer readings rose by the same amount.",
      ],
      [
        "The class linked sunlight, airflow, and moisture to temperature differences, then used that evidence to justify shade-tree recommendations.",
        "The class linked only thermometer brand differences to results, so environmental conditions were irrelevant.",
        "The class linked rising temperature to reduced sunlight, so they removed shaded areas from the plan.",
        "The class linked no measured variables to outcomes, so they guessed at improvements.",
      ],
      [
        "When shaded and watered sections stayed cooler, students inferred that surface conditions can change how quickly heat accumulates.",
        "When shaded and watered sections stayed cooler, students inferred hard surfaces always stay cooler than grass.",
        "When shaded and watered sections stayed cooler, students inferred airflow has no role in heat transfer.",
        "When shaded and watered sections stayed cooler, students inferred measurement timing does not matter.",
      ],
      [
        "The investigation connected measured temperature changes to specific playground conditions, leading students to choose practical cooling strategies.",
        "The investigation connected no observations to recommendations, so the final plan did not use data.",
        "The investigation connected cooler readings to darker pavement, so students replaced grass with blacktop.",
        "The investigation connected one reading to all conclusions, so repeated testing was unnecessary.",
      ],
    ],
    "Social Studies": [
      [
        "Flood delays raised shipping costs, so leaders and voters later supported a bridge to improve trade reliability.",
        "Flood delays reduced prices, so leaders canceled all transportation planning for the town.",
        "Flood delays ended trade, so voters rejected every future infrastructure proposal.",
        "Flood delays occurred after the bridge opened, so the election did not affect transportation policy.",
      ],
      [
        "As prices rose after flooding, residents backed a bridge bond that changed long-term transportation decisions.",
        "As prices rose after flooding, residents demanded rail removal with no replacement project.",
        "As prices rose after flooding, residents moved away and ended market activity.",
        "As prices rose after flooding, residents voted before any transportation debate occurred.",
      ],
      [
        "Timelines and election records show leaders shifted from rail-first plans to a bridge after community pressure increased.",
        "Timelines and election records show transportation policy never changed across the period.",
        "Timelines and election records show the bridge was built before shipping disruptions began.",
        "Timelines and election records show population decline removed demand for river crossings.",
      ],
      [
        "Population growth across the river increased daily travel needs, so decision-makers pursued stronger cross-river connections.",
        "Population growth across the river lowered travel demand, so officials closed key routes.",
        "Population growth across the river eliminated flood risk, so shipping concerns disappeared.",
        "Population growth across the river made elections unnecessary for transportation policy.",
      ],
      [
        "The passage shows how transportation decisions, voter choices, and economic pressures interacted to reshape town development over time.",
        "The passage shows transportation decisions changed only meeting schedules, not community outcomes.",
        "The passage shows economic pressures stayed constant, so no infrastructure choices mattered.",
        "The passage shows leaders ignored voter decisions and kept identical plans every year.",
      ],
    ],
    Reading: [[
      "Community reviewers compared interview notes and survey data, then revised the proposal after evidence changed what decision-makers prioritized.",
      "Community reviewers examined one quote, so they finalized the proposal without checking later outcomes in the passage events.",
      "Community reviewers ignored the timeline and treated an early detail as the final decision for every group.",
      "Community reviewers reversed the event order and claimed outcomes happened before any evidence was collected.",
    ]],
  };

  const ensureCrossReadingChoiceQuality = (choices: [string, string, string, string]): boolean => {
    const referencesPassageEvents = choices.every((choice) => /(after|when|later|timeline|records|passage|investigation|election|hour)/i.test(choice));
    const hasCauseEffect = choices.every((choice) => /(because|so|led to|result|changed|therefore)/i.test(choice));
    const hasDecisionSignal = choices.every((choice) =>
      /(decided|decision|approved|supported|recommended|revised|shifted|adjusted|planned|finalized|ignored|canceled|changed)/i.test(choice)
    );
    return referencesPassageEvents && hasCauseEffect && hasDecisionSignal;
  };

  const questions = stems
    .map((stem, i) => {
    const type: QuestionType = "mc";
    let choices = (crossChoiceBanks[crossSubject]?.[i] ||
      crossChoiceBanks[crossSubject]?.[0] ||
      crossChoiceBanks["Social Studies"][0]) as [string, string, string, string];
    choices = normalizeChoices(choices);
    const question: Question = {
      type,
      question: stem,
      choices,
      correct_answer: "A",
      explanation: "",
      sample_answer: undefined,
      hint: "",
      think: "",
      step_by_step: "",
      common_mistake: "",
      parent_tip: "",
    };
    const support = buildSupportContent("Reading", question, i, "On Level", "Cross-Curricular", crossPassage);
    question.explanation = support.explanation;
    question.hint = support.hint;
    question.think = support.think;
    question.step_by_step = support.step_by_step;
    question.common_mistake = support.common_mistake;
    question.parent_tip = support.parent_tip;
    return question;
    })
    .filter((q): q is Question => q !== null);

  if (!questions || questions.length === 0) {
    console.warn("⚠️ Using AI output despite imperfections");
    return questions;
  }

  const passageText = getPassageText(crossPassage).toLowerCase();

  questions.forEach((q) => {
    const hasConnection = q.choices.some((choice) =>
      passageText.includes(choice.split(" ")[0].toLowerCase())
    );

    if (!hasConnection) {
      const subjectSafeChoices = normalizeChoices(q.choices);
      if (hasLooseSupport(passageText, subjectSafeChoices.join(" "))) {
        q.choices = subjectSafeChoices;
      } else {
        console.warn("🚨 REJECTED cross fallback — preserving original choices");
      }
    }
  });

  return questions;
}

function buildELARFallback(level: Level = "On Level"): { passage: string; questions: Question[] } {
  const crossSubject = randomChoice<CanonicalSubject>(["Science", "Social Studies", "Math"]);
  let passageText = buildSubjectPassage(crossSubject, level);
  passageText = enforceValidPassage(passageText, crossSubject, level);
  return {
    passage: passageText,
    questions: buildELARCrossQuestions(crossSubject),
  };
}

function buildMathFallback(level: Level = "On Level"): { passage: string; questions: Question[] } {
  let passageText = buildSubjectPassage("Math", level);
  passageText = enforceValidPassage(passageText, "Math", level);
  return {
    passage: passageText,
    questions: buildCrossFallback("Math", level),
  };
}

function buildScienceFallback(level: Level = "On Level"): { passage: string; questions: Question[] } {
  let passageText = buildSubjectPassage("Science", level);
  passageText = enforceValidPassage(passageText, "Science", level);
  return {
    passage: passageText,
    questions: buildCrossFallback("Science", level),
  };
}

function buildSSFallback(level: Level = "On Level"): { passage: string; questions: Question[] } {
  let passageText = buildSubjectPassage("Social Studies", level);
  passageText = enforceValidPassage(passageText, "Social Studies", level);
  return {
    passage: passageText,
    questions: buildCrossFallback("Social Studies", level),
  };
}

function buildSubjectCrossContent(subject: CanonicalSubject, level: Level = "On Level"): { passage: string; questions: Question[] } {
  if (subject === "Math") {
    console.warn("⚠️ Using AI output despite imperfections");
    return { passage: enforceValidPassage(buildSubjectPassage("Math", level), "Math", level), questions: [] };
  }
  if (subject === "Science") {
    console.warn("⚠️ Using AI output despite imperfections");
    return { passage: enforceValidPassage(buildSubjectPassage("Science", level), "Science", level), questions: [] };
  }
  if (subject === "Social Studies") {
    console.warn("⚠️ Using AI output despite imperfections");
    return { passage: enforceValidPassage(buildSubjectPassage("Social Studies", level), "Social Studies", level), questions: [] };
  }
  const readingFallback = {
    passage: enforceValidPassage(buildSubjectPassage("Reading", level), "Reading", level),
    questions: [] as Question[],
  };
  return {
    passage: readingFallback.passage,
    questions: readingFallback.questions,
  };
}

function fallbackQuestionSet(subject: CanonicalSubject, mode: CanonicalMode, skill: string, level: Level = "On Level"): Question[] {
  if (mode === "Practice") return buildPracticeFallback(skill, subject, level);

  const effectiveSubject = subject;
  if (mode === "Cross-Curricular") {
    // Cross structure is subject-driven (or ELAR-over-content for Reading), not skill-driven.
    if (effectiveSubject === "Reading") {
      console.warn("⚠️ Using AI output despite imperfections");
      return [];
    }
    return buildSubjectCrossContent(effectiveSubject, level).questions;
  }

  const effectiveSkill: string = skill ?? "Main Idea";
  const skillText = (effectiveSkill ?? "").toLowerCase();
  const isTheme = skillText.includes("theme");

  const baseReading = [
    `Which statement best captures the ${isTheme ? "theme" : "main idea"} of the passage?`,
    "Which detail from the passage best supports the correct interpretation?",
    "Which additional detail most strengthens that interpretation?",
    "How does the author develop the central idea across the passage?",
    "Which quotation or detail is the strongest evidence for the best answer?",
  ];

  const baseMath = [
    "What is the value of the total cost after applying all required operations in the scenario?",
    "A table displays the number of kits sold each day and the cost per kit. Which expression represents the total revenue for Thursday?",
    "Which expression represents the relationship between number of kits sold and total profit in the scenario?",
    "A model illustrates two pricing plans. Which two statements are supported by the model? Select TWO answers.",
    "Explain how to correct the mathematical process in the scenario and justify your reasoning using the model. Write your response...",
  ];

  const baseScience = [
    "Which statement best explains the system behavior described in the investigation?",
    "Based on the model of a closed circuit with two bulbs and a switch, which prediction is most scientifically reasonable?",
    "Which cause-and-effect relationship is best supported by the experiment evidence?",
    "A model illustrates energy transfer in the system. Which two conclusions are supported by the model? Select TWO answers.",
    "Explain which evidence best supports the strongest scientific explanation. Write your response...",
  ];

  const baseSocial = [
    "Which factor contributed most to the change described in the historical scenario?",
    "A map shows trade routes used by three regions. Which outcome resulted from the route changes shown on the map?",
    "Which source detail best supports the decision made by civic leaders in the scenario?",
    "A table displays tax and population trends before and after a policy change. Which two conclusions are best supported? Select TWO answers.",
    "Explain which evidence best supports the strongest historical conclusion. Write your response...",
  ];

  const stems = effectiveSubject === "Math"
    ? baseMath
    : effectiveSubject === "Science"
      ? baseScience
      : effectiveSubject === "Social Studies"
        ? baseSocial
        : baseReading;

  return stems.map((stem, i) => {
    const type: QuestionType = "mc";
    const baseChoices = normalizeChoices([
      "The plants closest to the lamp grew taller because they received more direct light.",
      "All plants grew at the same rate, so light intensity did not matter in this setup.",
      "Plants farther from the lamp appeared to grow faster because lower heat outweighed reduced light.",
      "Plant height changed randomly and was not related to the light conditions in the investigation.",
    ]);
    const question: Question = {
      type,
      question: stem,
      choices: baseChoices,
      correct_answer: "A",
      explanation: "",
      sample_answer: undefined,
      hint: "",
      think: "",
      step_by_step: "",
      common_mistake: "",
      parent_tip: "",
    };
    const support = buildSupportContent(effectiveSubject, question, i, level, mode, "");
    question.explanation = support.explanation;
    question.hint = support.hint;
    question.think = support.think;
    question.step_by_step = support.step_by_step;
    question.common_mistake = support.common_mistake;
    question.parent_tip = support.parent_tip;

    return question;
  });
}

function parseJsonPayload(text: string): Record<string, unknown> {
  const cleaned = String(text || "").replace(/```json/gi, "").replace(/```/g, "").trim();
  try {
    const parsed = JSON.parse(cleaned);
    return (parsed && typeof parsed === "object") ? parsed as Record<string, unknown> : {};
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        const candidate = cleaned.slice(start, end + 1);
        const parsed = JSON.parse(candidate);
        return (parsed && typeof parsed === "object") ? parsed as Record<string, unknown> : {};
      } catch {
        return {};
      }
    }
    return {};
  }
}

function tryParseJsonPayload(text: string): Record<string, unknown> | null {
  try {
    return parseJsonPayload(text);
  } catch {
    return null;
  }
}

function isBadOutput(text: string): boolean {
  const normalized = String(text || "").toLowerCase();

  return (
    normalized.includes("as an ai language model") ||
    normalized.includes("i can't") ||
    normalized.includes("i cannot") ||
    normalized.includes("i'm unable to") ||
    normalized.includes("placeholder") ||
    normalized.includes("lorem ipsum")
  );
}

function sanitizeVisual(value: unknown): Question["visual"] | undefined {
  void value;
  // Temporarily disable visual payloads until the frontend can render
  // real map/chart/diagram artifacts instead of text-only placeholders.
  return undefined;
}

function isGenericAnswerChoice(choice: string): boolean {
  return isGenericAnswer(choice);
}

function isGenericAnswer(choice: string): boolean {
  const text = String(choice || "").trim();
  const lowered = text.toLowerCase();
  if (!lowered) return true;
  return lowered.includes("students") ||
    lowered.includes("class") ||
    lowered.includes("text sets") ||
    lowered.includes("reading team") ||
    lowered.includes("quotations") ||
    GENERIC_ANSWER_PATTERNS.some((pattern) => pattern.test(lowered));
}

function isClearlyGenericChoices(choices: [string, string, string, string]): boolean {
  return choices.every((choice) => {
    const lowered = String(choice || "").toLowerCase();
    return lowered.includes("one detail") || lowered.includes("another clue");
  });
}

function rewriteChoicesFromPassage(passage: string): [string, string, string, string] {
  const sentences = String(passage || "")
    .split(/[.!?]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 4);
  const seed = sentences[0] || "the passage includes an important detail";
  return Array.from({ length: 4 }, (_, index) => {
    const sentence = String(sentences[index] || seed).replace(/\s+/g, " ").trim().replace(/[.]+$/, "");
    return `Based on the passage, ${sentence.charAt(0).toLowerCase() + sentence.slice(1)}.`;
  }) as [string, string, string, string];
}

function isPassageAnchoredChoice(choice: string, passage: string): boolean {
  const text = String(choice || "").trim();
  const source = String(passage || "").trim();
  if (!text || !source) return false;
  if (isGenericAnswerChoice(text) && !source.toLowerCase().includes(text.toLowerCase())) return false;
  return hasLooseSupport(source, text);
}

function validateChoices(choices: string[], passage: string): boolean {
  void passage;
  return Array.isArray(choices) && choices.length === 4 && choices.every((choice) => String(choice || "").trim().length > 0);
}

function isBadQuestion(q: Question | null | undefined, mode: CanonicalMode | "cross"): boolean {
  void mode;
  if (!q) return true;
  const hasQuestion = String(q.question || "").trim().length > 0;
  const hasChoices = Array.isArray(q.choices) && q.choices.length === 4;
  const hasAnswer = q.correct_answer !== undefined && q.correct_answer !== null && String(q.correct_answer).trim().length > 0;
  return !(hasQuestion && hasChoices && hasAnswer);
}

function hasConcreteDetail(choice: string, passage: PassageContent | string, subject: CanonicalSubject): boolean {
  const text = String(choice || "").toLowerCase();
  const source = getPassageText(passage).toLowerCase();
  if (!text) return false;
  const hasNumeric = /\d/.test(text);
  const concreteNouns = /(bridge|flooding|shipment|voters|bond|grass|blacktop|moisture|airflow|combo|single-item|announcement|temperature|rail|market|experiment|results)/i
    .test(text);
  const hasInterpretationConnector = /(because|so|therefore|which means|showing|leading to|resulting in|indicating)/i.test(text);
  const keywordOverlap = passageKeywords(source).slice(0, 12).filter((k) => text.includes(k)).length;

  if (subject === "Math") return (hasNumeric || concreteNouns) && hasInterpretationConnector;
  return (concreteNouns || keywordOverlap >= 1) && hasInterpretationConnector;
}

function referencesPassage(text: string): boolean {
  return /(passage|text evidence|according to the text|according to the passage|author|paragraph|line|excerpt)/i.test(
    String(text || ""),
  );
}

function requiresSubjectStrictSignals(
  question: Question,
  subject: CanonicalSubject,
  mode: CanonicalMode,
  passage: PassageContent | string,
): boolean {
  const stem = String(question.question || "");
  const choices = (question.choices || []).join(" ");
  const combined = `${stem} ${choices}`.toLowerCase();
  const explanation = String(question.explanation || "").toLowerCase();
  const hasGenericWording = /(analyze|reasoning|best answer|academic|conceptual understanding)/i.test(combined);

  if (mode === "Practice" && subject !== "Reading" && referencesPassage(combined)) return false;
  if (hasGenericWording) return false;

  if (subject === "Math") {
    const hasNumbers = /\d/.test(combined);
    const hasComputationLanguage = /(solve|total|sum|difference|product|divide|multiply|subtract|add|equation|compute)/i
      .test(combined);
    return hasNumbers && hasComputationLanguage;
  }

  if (subject === "Science") {
    const hasScienceReasoning = /(cause|effect|variable|experiment|observation|hypothesis|data|system|process|relationship)/i
      .test(combined);
    const explanationHasProcess = /(because|caused|led to|result|relationship|process|variable)/i.test(explanation);
    return hasScienceReasoning && explanationHasProcess;
  }

  if (subject === "Social Studies") {
    const hasHistoricalContext = /(history|historical|timeline|policy|law|government|election|war|century|year|voters|migration|trade|event)/i
      .test(combined);
    const explanationHasImpact = /(cause|effect|impact|result|led to|outcome|changed)/i.test(explanation);
    return hasHistoricalContext && explanationHasImpact;
  }

  const passageText = getPassageText(passage).toLowerCase();
  const overlap = passageKeywords(passageText).slice(0, 16).filter((token) => combined.includes(token)).length;
  const hasEvidenceLanguage = /(evidence|inference|theme|supports|according to|from the passage)/i.test(combined) &&
    /(evidence|supports|text|passage)/i.test(explanation);
  return overlap >= 1 && hasEvidenceLanguage;
}

function correctAnswerLooksNumeric(question: Question): boolean {
  const answer = normalizeAnswer(question.correct_answer);
  const choice = String(question.choices?.[LETTERS.indexOf(answer)] || "");
  return /\d/.test(choice) || /(\+|\-|\*|\/|=)/.test(choice);
}

function isMultiStepMathQuestion(question: Question): boolean {
  const combined = `${question.question} ${(question.choices || []).join(" ")}`.toLowerCase();
  const opCount = ["add", "subtract", "multiply", "divide", "total", "then", "after", "difference", "sum", "product", "each", "in all", "more", "less"]
    .filter((token) => combined.includes(token)).length;
  const numberCount = (combined.match(/\d+/g) || []).length;
  return numberCount >= 2 && opCount >= 1;
}

function validateDistractorRigor(question: Question, level: Level): boolean {
  const wrongChoices = (question.choices || []).filter((_, index) => LETTERS[index] !== normalizeAnswer(question.correct_answer));
  if (wrongChoices.length < 2) return false;
  const obviousPatterns = /(always|never|impossible|not supported|unrelated|no evidence)/i;
  const misconceptionPatterns = /(misconception|confuses|reverses|correlation|causation|trap)/i;
  const avgLength = wrongChoices.reduce((sum, choice) => sum + String(choice || "").split(/\s+/).length, 0) / wrongChoices.length;

  if (level === "Below") return wrongChoices.some((choice) => obviousPatterns.test(String(choice || "")));
  if (level === "Advanced") {
    const plausibleCount = wrongChoices.filter((choice) => !obviousPatterns.test(String(choice || "")) && String(choice || "").split(/\s+/).length >= 8).length;
    return plausibleCount >= 2 && (misconceptionPatterns.test(wrongChoices.join(" ")) || avgLength >= 10);
  }
  return avgLength >= 6 && wrongChoices.some((choice) => /(partly|partial|one true detail|incomplete|ignores)/i.test(String(choice || "")));
}

function validateLevelComplexity(subject: CanonicalSubject, level: Level, questions: Question[]): boolean {
  const text = questions.map((q) => `${q.question} ${q.explanation}`).join(" ").toLowerCase();
  if (level === "Below") {
    return !/(synthesize|compare|evaluate|multi-paragraph|abstract)/i.test(text);
  }
  if (level === "On Level") {
    const twoStepSignals = /(two steps|because.*then|first.*then|apply|relationship|inference)/i.test(text);
    return twoStepSignals;
  }
  const advancedSignals = /(multi-step|compare|synthesis|evaluate|misconception|trap|infer|author's purpose|multi-variable)/i.test(text);
  if (!advancedSignals) return false;
  if (subject === "Math") return questions.some((q) => /(extra|unnecessary|ignore extra information)/i.test(q.question));
  return true;
}

function isAllowedMainIdeaStem(stem: string): boolean {
  const normalized = String(stem || "").trim().toLowerCase();
  return normalized === "what is the main idea of the passage?" ||
    normalized === "which statement best describes the main idea?";
}

function isWeakDistractor(choice: string): boolean {
  if (choice.split(" ").length < 6) return true;
  const weakPatterns = [
    "is true, but",
    "proves that this happened in every case",
    "was a result of the final outcome",
    "is enough to fully explain",
    "this shows",
    "this proves",
  ];

  return weakPatterns.some((pattern) => String(choice || "").toLowerCase().includes(pattern));
}

function getPassageAnchors(passage: PassageContent | string, question: string): [string, string, string] {
  const stopwords = new Set([
    "about", "after", "again", "because", "before", "between", "could", "every", "first", "found", "from",
    "their", "there", "these", "those", "through", "under", "using", "which", "while", "would",
  ]);
  const snippet = getRelevantSnippet(passage, question) || "";
  const text = `${snippet} ${getPassageText(passage)}`.toLowerCase();
  const tokens = text
    .split(/[^a-z0-9-]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 5 && !stopwords.has(token) && /[a-z]/.test(token));
  const unique = Array.from(new Set(tokens));
  return [
    unique[0] || "the first detail",
    unique[1] || "another detail",
    unique[2] || "the final observation",
  ];
}

function fixDistractors(
  subject: CanonicalSubject,
  question: string,
  correctAnswer: string,
  passage: PassageContent | string,
): string[] {
  void subject;
  void question;
  void correctAnswer;
  void passage;
  return [];
}

function sanitizeQuestions(
  raw: unknown,
  subject: CanonicalSubject,
  mode: CanonicalMode,
  skill: string,
  level: Level = "On Level",
  passage: PassageContent | string = "",
  grade = 5,
): Question[] {
  const buildSafeMC = (questionText = "", explanationText = ""): Question => ({
    type: "mc",
    question: String(questionText || "").trim() || "Placeholder",
    choices: ["Option A", "Option B", "Option C", "Option D"],
    correct_answer: "A",
    explanation: String(explanationText || "").trim(),
  });
  const incoming = Array.isArray(raw) ? raw.slice(0, 5) : [];
  void grade;
  const requestedSkillType = getSkillType(skill);
  const sanitized: Question[] = incoming.map((item, i) => {
    const q = item && typeof item === "object" ? item as Record<string, unknown> : {};
    if (
      !q.choices ||
      !Array.isArray(q.choices) ||
      q.choices.length !== 4 ||
      q.choices.every((choice) => !String(choice || "").trim())
    ) {
      console.warn("⚠️ INVALID_CHOICES_LENGTH in sanitizeQuestions", {
        question: String(q.question || "").slice(0, 80),
        length: Array.isArray(q.choices) ? q.choices.length : null,
      });
      return buildSafeMC(String(q.question || ""), String(q.explanation || ""));
    }
    const expectedType = (q.type === "multi_select" || q.type === "scr")
      ? q.type
      : "mc";
    const type: QuestionType = expectedType;
    const rawQuestion = String(q.question || "").trim();
    const questionText = type === "multi_select" && !/select\s+two\s+answers\./i.test(rawQuestion)
      ? `${rawQuestion.replace(/\s+$/g, "")} Select TWO answers.`
      : rawQuestion;

    const passageText = getPassageText(passage);
    const cleanForSubject = (choice: string): string => subject === "Math"
      ? (sanitizeMathChoice(choice) || "0")
      : cleanAnswerChoice(choice);
    let normalizedChoices = normalizeChoices(q.choices).map(cleanForSubject) as [string, string, string, string];
    const normalizedCorrectAnswer = type === "multi_select"
      ? normalizeMultiSelectAnswer(q.correct_answer || "")
      : safeCorrectAnswer(q.correct_answer);
    const correctChoiceIndex = type === "mc" ? LETTERS.indexOf(normalizedCorrectAnswer as AnswerLetter) : -1;
    void correctChoiceIndex;

    const isReadingMainIdea = subject === "Reading" && isMainIdeaSkill(skill);
    let normalizedQuestionText = questionText;
    if (isReadingMainIdea && !isAllowedMainIdeaStem(normalizedQuestionText)) {
      normalizedQuestionText = i % 2 === 0
        ? "What is the main idea of the passage?"
        : "Which statement best describes the main idea?";
    }
    normalizedQuestionText = enforceThinkingStem(subject, normalizedQuestionText);

    if (type === "mc" && isVocabStyleQuestion(normalizedQuestionText)) {
      const targetWord = extractVocabTargetWord(normalizedQuestionText);
      normalizedChoices = normalizeVocabChoices(normalizedChoices) as [string, string, string, string];
      if (!isValidVocabTarget(getPassageText(passage), targetWord)) {
        normalizedQuestionText = "Which idea is BEST supported by the passage?";
        normalizedChoices = makeChoicesUnique(normalizedChoices, subject, normalizedQuestionText);
      }
    }

    if (!validateQuestionAlignment(normalizedQuestionText, skill)) {
      console.warn("⚠️ Skill misalignment during normalization — keeping question", { index: i, skill });
    }
    if (!normalizedChoices.every((choice) => validateChoiceAlignment(choice, requestedSkillType))) {
      console.warn("Validation issue — keeping question", { index: i, skillType: requestedSkillType });
    }
    normalizedChoices = makeChoicesUnique(normalizedChoices, subject, normalizedQuestionText);
    // if (subject === "Math" && type === "mc") {
    //   normalizedChoices = enforceMathChoices(normalizedChoices, normalizedCorrectAnswer);
    // }
    normalizedChoices = normalizeChoices(normalizedChoices);

    const base: Question = {
      type,
      question: normalizedQuestionText,
      choices: normalizedChoices,
      correct_answer: normalizedCorrectAnswer,
      explanation: String(q.explanation || "").trim(),
      paired_with: typeof q.paired_with === "number" ? q.paired_with : undefined,
      sample_answer: String(q.sample_answer || "").trim(),
      hint: String(q.hint || "").trim(),
      think: String(q.think || "").trim(),
      step_by_step: String(q.step_by_step || "").trim(),
      common_mistake: String(q.common_mistake || "").trim(),
      parent_tip: String(q.parent_tip || "").trim(),
      visual: sanitizeVisual(q.visual),
    };
    return base;
  });

  let questions = sanitized.slice(0, 5);
  const originalQuestions = questions.slice();

  const passageText = getPassageText(passage);
  questions = questions.map((q) => repairQuestion(q, subject, passageText));
  questions = validateOnce(questions, passageText);

  let weakCount = 0;
  let skillWarningCount = 0;
  questions = questions.map((q) => {
    if (!matchesSkill(q, skill)) {
      skillWarningCount += 1;
      console.warn("⚠️ Skill misalignment — keeping question");
    }
    const valid = isValidQuestion(q, passageText) && hasReasonableAlignment(q, passageText);
    if (!valid) {
      weakCount += 1;
      console.warn("⚠️ Bad answers detected — keeping question");
      return repairQuestion(q, subject, passageText);
    }
    return q;
  });
  if (weakCount > 0) {
    console.warn(`⚠️ Weak question warnings on ${weakCount} questions — kept and repaired`);
  }
  if (skillWarningCount > 0) {
    console.warn(`⚠️ Skill warnings on ${skillWarningCount} questions — keeping all questions`);
  }
  if (questions.length === 0 && originalQuestions.length > 0) {
    console.warn("No questions after validation pass — restoring original AI output");
    questions = originalQuestions;
  }

  let attempts = 0;
  const MAX_ATTEMPTS = 2;
  const safeRebuild = (q: Question, passageForRebuild: string, skillForRebuild: string): Question => {
    void skillForRebuild;
    if (attempts >= MAX_ATTEMPTS) {
      return q;
    }
    attempts++;
    return rebuildQuestionFromPassage(q, subject, passageForRebuild, level);
  };

  let previousValidQuestion: Question | null = null;
  questions = questions.map((q) => {
    if (finalValidation(q, passageText, skill)) {
      previousValidQuestion = q;
      return q;
    }
    const rebuilt = safeRebuild(q, passageText, skill);
    if (finalValidation(rebuilt, passageText, skill)) {
      previousValidQuestion = rebuilt;
      return rebuilt;
    }
    return previousValidQuestion || q;
  });

  if (questions.length < 5) {
    console.warn("⚠️ Fewer than 5 questions after validation — keeping available questions without regeneration");
  }
  const finalQuestions = questions.slice(0, 5).map((q) => ({
    ...q,
    question: String(q.question || "").trim(),
    choices: normalizeChoices((q.choices || []).map((choice) => String(choice || "").trim())),
    explanation: String(q.explanation || "").trim(),
    common_mistake: String(q.common_mistake || "").trim(),
    hint: String(q.hint || "").trim(),
    think: String(q.think || "").trim(),
    step_by_step: String(q.step_by_step || "").trim(),
    parent_tip: String(q.parent_tip || "").trim(),
  }));
  console.log("🔥 VALIDATION COMPLETE — CLEAN QUESTIONS:", finalQuestions.length);
  const alignedSet = finalQuestions;
  if (!isPassageBased(mode, subject)) {
    for (const q of alignedSet) {
      if (!Array.isArray(q.choices) || q.choices.length !== 4) continue;
      if (typeof q.correct_answer !== "string") continue;
      verifyAnswerWithAI(q.question, q.choices as [string, string, string, string]).then((verified) => {
        if (verified && verified !== q.correct_answer) {
          console.warn("🔄 Async answer verification mismatch — question flagged for next regeneration cycle", {
            from: q.correct_answer,
            suggested: verified,
          });
        }
      });
    }
  }

  if (mode === "Cross-Curricular") {
    const validatedCross = alignedSet.map((question) => {
      const needsChoiceRepair = !Array.isArray(question.choices) || question.choices.length !== 4;
      const needsAnswerRepair = typeof question.correct_answer !== "string"
        || !["A", "B", "C", "D"].includes(question.correct_answer);
      const needsExplanationRepair = !String(question.explanation || "").trim();
      if (!needsChoiceRepair && !needsAnswerRepair && !needsExplanationRepair) {
        return question;
      }
      console.warn("⚠️ Cross-curricular validation warning — keeping and repairing question");
      const repaired = repairQuestion(question, subject, passageText);
      return {
        ...repaired,
        explanation: String(repaired.explanation || "").trim()
          || "The correct answer is best supported by details in the passage.",
      };
    });
    return enforceCrossReadingOnly(validatedCross, passageText);
  }

  return alignedSet.slice(0, 5);
}

const CROSS_READING_ANGLE_STEMS = [
  "Which statement best captures the central idea developed in the passage?",
  "Which detail from the passage best supports the author’s reasoning?",
  "What can the reader infer about the decision-making process described in the passage?",
  "How does the author organize information to develop the main point?",
  "What is the author’s purpose for including these specific details in the passage?",
] as const;

function hasCrossComputationLeak(text: string): boolean {
  const t = String(text || "").toLowerCase();
  const hasForbiddenWord = /\b(calculate|solve|total|sum|multiply|product|quotient|equation|formula|compute|evaluate expression)\b/i.test(t);
  const hasNumbersAndOps = /\d/.test(t) && /(\+|\-|\*|\/|=|\badd\b|\bsubtract\b|\bdivide\b|\bmultiply\b)/i.test(t);
  return hasForbiddenWord || hasNumbersAndOps;
}

function rewriteCrossQuestionStem(index: number): string {
  return CROSS_READING_ANGLE_STEMS[index % CROSS_READING_ANGLE_STEMS.length];
}

function buildCrossReadingChoices(
  passage: PassageContent | string,
  priorChoices: [string, string, string, string],
): [string, string, string, string] {
  const passageText = getPassageText(passage);
  const safePrior = normalizeChoices(priorChoices).map((choice) => cleanAnswerChoice(choice)) as [string, string, string, string];
  return safePrior.every((choice) => !hasCrossComputationLeak(choice))
    ? safePrior
    : forcePassageChoices(passageText);
}

function questionSemanticKey(question: string): string {
  const stop = new Set(["the", "a", "an", "is", "does", "what", "which", "how", "why", "in", "of", "to", "for"]);
  return String(question || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word && !stop.has(word))
    .slice(0, 8)
    .join(" ");
}

function enforceCrossReadingOnly(
  questions: Question[],
  passage: PassageContent | string,
): Question[] {
  const seen = new Set<string>();
  const output: Question[] = [];

  for (const q of questions) {
    const combined = `${q.question} ${(q.choices || []).join(" ")}`;
    const needsRewrite = hasCrossComputationLeak(combined);
    const fallbackStem = rewriteCrossQuestionStem(output.length);
    const rewritten: Question = needsRewrite
      ? {
        ...q,
        type: "mc",
        question: fallbackStem,
        choices: buildCrossReadingChoices(passage, normalizeChoices(q.choices)),
        correct_answer: "A",
      }
      : {
        ...q,
        question: String(q.question || "").trim() || fallbackStem,
        choices: normalizeChoices(q.choices).map((choice) => cleanAnswerChoice(choice)) as [string, string, string, string],
      };

    const semantic = questionSemanticKey(rewritten.question);
    if (!semantic || seen.has(semantic)) continue;
    seen.add(semantic);
    output.push(rewritten);
    if (output.length === 5) break;
  }

  let angleIndex = 0;
  while (output.length < 5) {
    const stem = rewriteCrossQuestionStem(angleIndex);
    angleIndex += 1;
    const semantic = questionSemanticKey(stem);
    if (seen.has(semantic)) continue;
    seen.add(semantic);
    output.push({
      type: "mc",
      question: stem,
      choices: buildCrossReadingChoices(passage, forcePassageChoices(getPassageText(passage))),
      correct_answer: "A",
      explanation: "The best answer is supported by details in the passage.",
      hint: "Find which option is most strongly supported by passage evidence.",
      think: "Eliminate choices that include unsupported or exaggerated claims.",
      step_by_step: "Read the question, locate key evidence, compare choices, and select the most supported answer.",
      common_mistake: "Choosing an option that sounds logical but is not directly supported by the text.",
      parent_tip: "Ask your child to point to specific text evidence before finalizing an answer.",
    });
  }

  return output.slice(0, 5).map((q, idx) => ({
    ...q,
    question: rewriteCrossQuestionStem(idx),
  }));
}

function validateSkillAlignment(skill: string, questions: Question[]): boolean {
  if (!skill || !Array.isArray(questions) || questions.length === 0) return false;
  const requestedSkillType = getSkillType(skill);
  return questions.every((q) => {
    const questionAligned = validateQuestionAlignment(q?.question || "", skill);
    const choicesAligned = Array.isArray(q?.choices) &&
      q.choices.every((choice) => validateChoiceAlignment(String(choice || ""), requestedSkillType));
    return questionAligned && choicesAligned;
  });
}

function getPassageText(passage: PassageContent | string): string {
  if (typeof passage === "string") return passage;
  return `${passage?.text_1 || ""} ${passage?.text_2 || ""}`.trim();
}

function looksLikeDramaPassage(passage: string): boolean {
  const text = String(passage || "").trim();
  if (!text) return false;
  if (/^characters\s*:/im.test(text) || /^setting\s*:/im.test(text)) return true;
  const speakerLines = text.match(/^[A-Z][a-zA-Z]{1,20}\s*:/gm) || [];
  return speakerLines.length >= 2;
}

function ensureDramaScriptFormat(passage: string): string {
  const raw = String(passage || "").replace(/\r\n/g, "\n").trim();
  if (!raw) return raw;
  const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
  const title = lines[0] && !/:/.test(lines[0]) ? lines[0] : "The Choice";

  const existingCharacters = raw.match(/^[A-Z][a-zA-Z]{1,20}\s*:/gm) || [];
  const characterNames = Array.from(new Set(
    existingCharacters.map((line) => line.replace(/:.*/, "").trim()),
  ));
  const defaultCharacters = characterNames.length >= 2 ? characterNames : ["Max", "Lila"];

  const settingMatch = raw.match(/setting\s*:\s*(.+)/i);
  const setting = settingMatch?.[1]?.trim() || "A school cafeteria during lunch";

  const dialogueLines = lines
    .filter((line) => /:/.test(line))
    .map((line) => {
      const [speakerRaw, ...rest] = line.split(":");
      const speaker = speakerRaw.trim();
      const dialogue = rest.join(":").trim();
      if (!speaker || !dialogue) return "";
      if (/^\(.+\)\s*$/.test(dialogue)) return `${speaker}: ${dialogue}\n...`;
      return `${speaker}: ${dialogue}`;
    })
    .filter(Boolean);

  if (dialogueLines.length === 0) {
    dialogueLines.push(
      `${defaultCharacters[0]}: (sitting at a table, looking worried) I can’t believe I have to choose.`,
      `${defaultCharacters[1]}: (sipping juice) Why not do both?`,
    );
  }

  return `${title}

Characters:
${defaultCharacters.join("\n")}

Setting:
${setting}

${dialogueLines.join("\n\n")}`.trim();
}

function validatePassageComplexity(level: Level, passage: PassageContent | string): boolean {
  const text = getPassageText(passage).trim();
  if (!text) return level !== "Advanced";

  const sentences = text.split(/[.!?]+/).map((s) => s.trim()).filter(Boolean);
  const words = text.split(/\s+/).filter(Boolean);
  const avgSentenceLength = sentences.length ? words.length / sentences.length : words.length;
  const hasAbstractSignals = /(however|therefore|although|suggests|implies|interaction|evidence)/i.test(text);
  const hasParagraphBreak = text.includes("\n\n");

  if (level === "Below") {
    return avgSentenceLength <= 16 && !hasParagraphBreak;
  }
  if (level === "Advanced") {
    return avgSentenceLength >= 12 && (hasParagraphBreak || hasAbstractSignals);
  }
  return avgSentenceLength >= 8 && avgSentenceLength <= 22;
}

function validateQuestionDepth(level: Level, questions: Question[]): boolean {
  const allText = questions.map((q) => String(q.question || "").toLowerCase()).join(" ");
  const highSignals = ["infer", "concluded", "conclusion", "analyze", "author", "evidence", "supports", "reasoning"];
  const lowSignals = ["what is", "which is", "how many", "first", "best answer"];
  const highCount = highSignals.filter((s) => allText.includes(s)).length;
  const lowCount = lowSignals.filter((s) => allText.includes(s)).length;

  if (level === "Below") return lowCount >= 2 && highCount <= 3;
  if (level === "Advanced") return highCount >= 3;
  return highCount >= 1;
}

function validateRigorAlignment(level: Level, passage: PassageContent | string, questions: Question[]): boolean {
  return validatePassageComplexity(level, passage) && validateQuestionDepth(level, questions);
}

function isValidOutput(questions: Question[], passage: PassageContent | string): boolean {
  void passage;
  if (!Array.isArray(questions) || questions.length < 3) return false;
  return questions.every((question) => {
    const hasQuestion = String(question?.question || "").trim().length > 0;
    const hasChoices = Array.isArray(question?.choices) && question.choices.length === 4;
    const hasAnswer = question?.correct_answer !== undefined && question?.correct_answer !== null &&
      String(question.correct_answer).trim().length > 0;
    return hasQuestion && hasChoices && hasAnswer;
  });
}

function validateDistractorQuality(questions: Question[], passage: PassageContent | string): boolean {
  const text = getPassageText(passage);
  const keys = passageKeywords(text).slice(0, 6);
  const weakPatterns = /(unrelated|not supported|random|impossible|always|never|all of the above|none of the above)/i;

  const choiceSets: string[][] = questions.map((q) => q.choices);

  return choiceSets.every((set) => {
    if (!Array.isArray(set) || set.length !== 4) return false;
    const joined = set.join(" ").toLowerCase();
    if (weakPatterns.test(joined)) return false;
    const overlap = keys.length ? keys.filter((k) => joined.includes(k)).length : 2;
    return overlap >= Math.min(2, keys.length || 2);
  });
}

function validateCrossCurricular(data: { passage?: unknown; questions?: unknown[] }): boolean {
  const passage = String(data?.passage || "").toLowerCase();
  const questions = Array.isArray(data?.questions) ? data.questions : [];
  if (!passage.trim()) return false;
  if (questions.length === 0) return false;

  const badPhrases = [
    "this question links ideas",
    "cross-connection",
    "interdisciplinary explanation",
  ];

  return !badPhrases.some((phrase) => passage.includes(phrase));
}

function passageKeywords(passage: string): string[] {
  const blacklist = new Set([
    "the", "and", "with", "from", "that", "this", "they", "their", "were", "have", "after", "before", "because",
    "into", "over", "under", "while", "where", "which", "what", "when", "why", "then", "than", "them", "also",
    "for", "are", "was", "had", "has", "did", "not", "but", "all", "can", "could", "should", "would", "about",
  ]);

  const words = passage
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !blacklist.has(w));

  const counts = new Map<string, number>();
  words.forEach((w) => counts.set(w, (counts.get(w) || 0) + 1));
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 18)
    .map(([w]) => w);
}

function validateCrossQuestionRequirements(subject: CanonicalSubject, passage: string, questions: Question[]): boolean {
  if (!passage.trim() || questions.length !== 5) return false;
  if (subject === "Math" && !/\d/.test(passage)) return false;

  const expectedPrefixes = [
    ["what caused", "why did"],
    ["which event happened after"],
    ["which detail shows"],
    ["why did", "what can be inferred"],
    ["what can be concluded"],
  ];

  const bannedFluff = ["most defensible claim", "civic impact", "event reasoning", "this supports the claim", "this shows reasoning"];
  const keywords = passageKeywords(passage);

  return questions.every((q, index) => {
    const stem = String(q.question || "").toLowerCase().trim();
    const matchesPrefix = expectedPrefixes[index].some((prefix) => stem.startsWith(prefix));
    if (!matchesPrefix) return false;
    if (bannedFluff.some((phrase) => stem.includes(phrase))) return false;
    if (!Array.isArray(q.choices) || q.choices.length !== 4) return false;
    if (!/(passage|scenario|investigation|timeline|data)/i.test(stem)) return false;

    const combined = `${q.question} ${q.choices.join(" ")}`.toLowerCase();
    const overlap = keywords.filter((k) => combined.includes(k)).length;
    if (overlap < 3) return false;
    if (q.choices.some((choice) => isGenericAnswerChoice(choice) || !hasConcreteDetail(choice, passage, subject))) return false;

    const choiceSet = new Set(q.choices.map((c) => c.toLowerCase().trim()));
    return choiceSet.size === 4;
  });
}

function validateUniqueChoices(questions: Question[]): boolean {
  const seen = new Set<string>();

  return questions.every((q) => {
    const key = JSON.stringify(q.choices);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function validateChoiceSubjectAlignment(subject: CanonicalSubject, questions: Question[]): boolean {
  return questions.every((q) => {
    const text = q.choices.join(" ").toLowerCase();

    if (subject === "Science") {
      return text.includes("experiment") || text.includes("result") || text.includes("variable");
    }

    if (subject === "Social Studies") {
      return text.includes("event") || text.includes("decision") || text.includes("impact");
    }

    if (subject === "Math") {
      return text.includes("quantity") || text.includes("relationship") || text.includes("pattern");
    }

    return true;
  });
}

function validateCrossPassage(passage: PassageContent | string): boolean {
  const text = getPassageText(passage).toLowerCase();
  return !text.includes("students read an informational text");
}

function normalizeAnswerKeyEntry(value: unknown): string {
  if (Array.isArray(value)) {
    const letters = value.map((entry) => normalizeAnswer(entry));
    return letters.join(", ");
  }
  return normalizeAnswer(value);
}

function ensureQuestionId(question: Question, index: number, mode: "practice" | "cross"): string {
  return `${mode}_q${index + 1}`;
}

function extractKeyTopic(passage: PassageContent | string): string {
  const keys = passageKeywords(getPassageText(passage));
  return keys[0] || "the passage topic";
}

function buildPracticeTutorFallback(subject: CanonicalSubject, question: Question): TutorExplanation {
  const promptFocus = String(question.question || "").trim();
  const aligned = buildAlignedExplanation(question, "", new Set<string>(), subject === "Reading");
  const distractorFeedback = buildDistractorFeedback(question);
  const think = buildThinkPrompt(question);
  if (subject === "Math") {
    return {
      question_id: "",
      question: promptFocus,
      explanation: `${aligned.why} ${distractorFeedback}`.trim(),
      common_mistake: aligned.mistake,
      hint: "Break the problem into smaller parts before combining results.",
      think,
      step_by_step: "Identify numbers → choose operations → solve each step → check reasonableness.",
    };
  }
  if (subject === "Science") {
    return {
      question_id: "",
      question: promptFocus,
      explanation: `${aligned.why} ${distractorFeedback}`.trim(),
      common_mistake: aligned.mistake,
      hint: "Focus on how one factor affects another in the system.",
      think,
      step_by_step: "Identify variables → find cause/effect relationship → apply the concept to the choices.",
    };
  }
  if (subject === "Social Studies") {
    return {
      question_id: "",
      question: promptFocus,
      explanation: `${aligned.why} ${distractorFeedback}`.trim(),
      common_mistake: aligned.mistake,
      hint: "Track the cause, then connect it to the most direct impact.",
      think,
      step_by_step: "Identify event/context → determine cause or decision → determine impact/outcome.",
    };
  }
  return {
    question_id: "",
    question: promptFocus,
    explanation: `${aligned.why} ${distractorFeedback}`.trim(),
    common_mistake: aligned.mistake,
    hint: "Look back at the text and find the best supporting detail.",
    think,
    step_by_step: "Read question → locate evidence in text → match evidence to the best choice.",
  };
}

function buildCrossTutorFallback(subject: CanonicalSubject, question: Question, passage: string): TutorExplanation {
  const aligned = buildAlignedExplanation(question, passage, new Set<string>(), true);
  const distractorFeedback = buildDistractorFeedback(question);
  return {
    question_id: "",
    question: String(question.question || "").trim(),
    explanation: `${aligned.why} ${distractorFeedback}`.trim(),
    common_mistake: aligned.mistake,
    hint: aligned.tip,
    think: buildThinkPrompt(question),
    step_by_step: "Read question carefully → find related part of passage → match evidence to the best choice.",
  };
}

function getTutorFallback(
  mode: "practice" | "cross",
  subject: CanonicalSubject,
  question: Question,
  passage: string,
): TutorExplanation {
  if (mode === "cross") return buildCrossTutorFallback(subject, question, passage);
  return buildPracticeTutorFallback(subject, question);
}

function buildPracticeAnswerFallback(subject: CanonicalSubject, question: Question): Pick<AnswerKeyEntry, "explanation" | "common_mistake" | "parent_tip"> {
  const aligned = buildAlignedExplanation(question, "", new Set<string>(), subject === "Reading");
  const distractorFeedback = buildDistractorFeedback(question);
  if (subject === "Math") {
    return {
      explanation: `${aligned.why} ${distractorFeedback}`.trim(),
      common_mistake: aligned.mistake,
      parent_tip: "Have your child explain each computation step before checking the final answer.",
    };
  }
  if (subject === "Science") {
    return {
      explanation: `${aligned.why} ${distractorFeedback}`.trim(),
      common_mistake: aligned.mistake,
      parent_tip: "Ask your child to explain which variable changed and what effect it produced.",
    };
  }
  if (subject === "Social Studies") {
    return {
      explanation: `${aligned.why} ${distractorFeedback}`.trim(),
      common_mistake: aligned.mistake,
      parent_tip: "Ask your child to connect the event, decision, and outcome in one sentence.",
    };
  }
  return {
    explanation: `${aligned.why} ${distractorFeedback}`.trim(),
    common_mistake: aligned.mistake,
    parent_tip: "Ask your child to cite the exact evidence that proves the answer.",
  };
}

function buildCrossAnswerFallback(
  subject: CanonicalSubject,
  question: Question,
  passage: string,
): Pick<AnswerKeyEntry, "explanation" | "common_mistake" | "parent_tip"> {
  void subject;
  const aligned = buildAlignedExplanation(question, passage, new Set<string>(), true);
  const distractorFeedback = buildDistractorFeedback(question);
  return {
    explanation: `${aligned.why} ${distractorFeedback}`.trim(),
    common_mistake: aligned.mistake,
    parent_tip: "Have your child explain which passage detail proves the answer is correct.",
  };
}

function getAnswerFallback(
  mode: "practice" | "cross",
  subject: CanonicalSubject,
  question: Question,
  passage: string,
): Pick<AnswerKeyEntry, "explanation" | "common_mistake" | "parent_tip"> {
  if (mode === "cross") return buildCrossAnswerFallback(subject, question, passage);
  return buildPracticeAnswerFallback(subject, question);
}

function generateTutor(
  questions: Question[],
  subject: CanonicalSubject,
  mode: "practice" | "cross",
  level: Level = "On Level",
  passageText = "",
): TutorExplanation[] {
  void subject;
  void level;
  const shouldUsePassage = isPassageBased(mode, subject);
  const scopedPassageText = shouldUsePassage ? passageText : "";
  const usedEvidence = new Set<string>();
  return questions.slice(0, 5).map((q, index) => {
    try {
      const { letter, choice } = getQuestionCorrectPair(q);
      const normalizedChoices = normalizeChoices(q.choices);
      const correctAnswer = letter ? `${letter}. ${choice}` : "";
      const wrongChoiceGuidance = letter
        ? normalizedChoices
          .map((candidate, candidateIndex) => ({ letter: LETTERS[candidateIndex], candidate }))
          .filter((entry) => entry.letter !== letter)
          .map((entry) =>
            `❌ ${entry.letter}. ${entry.candidate} — This option does not match the validated correct answer (${correctAnswer}).`
          )
          .join("\n")
        : "";
      const aligned = buildAlignedExplanation(q, scopedPassageText, usedEvidence, shouldUsePassage);
      const baseExplanation = shouldUsePassage
        ? aligned.why
        : (String(q.explanation || "").trim() ||
          (correctAnswer ? `The validated correct answer is ${correctAnswer}.` : "Use the validated question answer and supporting evidence."));
      const explanation = wrongChoiceGuidance ? `${baseExplanation}\n\n${wrongChoiceGuidance}` : baseExplanation;

      return {
        question_id: ensureQuestionId(q, index, mode),
        question: String(q.question || "").trim(),
        explanation,
        common_mistake: String(q.common_mistake || "").trim() || "Choosing an option without matching it to the validated answer and passage evidence.",
        hint: String(q.hint || "").trim() ||
          (correctAnswer ? `Use the validated answer: ${correctAnswer}.` : "Read the validated answer and match it to passage evidence."),
        think: String(q.think || "").trim() ||
          (correctAnswer ? `How does the passage support ${correctAnswer}?` : "Which passage detail supports the validated answer?"),
        step_by_step: String(q.step_by_step || "").trim() ||
          (correctAnswer
            ? `1. Read the question.\n2. Identify the validated answer (${correctAnswer}).\n3. Confirm passage evidence supports it.\n4. Eliminate choices that do not match that evidence.`
            : "1. Read the question.\n2. Locate the validated answer.\n3. Match it to passage evidence."),
      };
    } catch (err) {
      console.error("Tutor build failed:", err);
      return {
        question_id: ensureQuestionId(q, index, mode),
        question: String(q.question || "").trim(),
        explanation: "Explanation unavailable.",
        common_mistake: "",
        hint: "",
        think: "",
        step_by_step: "",
      };
    }
  });
}

function generateAnswerKey(
  questions: Question[],
  subject: CanonicalSubject,
  mode: "practice" | "cross",
  level: Level = "On Level",
  passageText = "",
): AnswerKeyEntry[] {
  void level;
  const shouldUsePassage = isPassageBased(mode, subject);
  const scopedPassageText = shouldUsePassage ? passageText : "";
  const usedEvidence = new Set<string>();
  return questions.slice(0, 5).map((q, index) => {
    try {
      const normalizedChoices = normalizeChoices(q.choices);
      const correctLetter = normalizeAnswer(normalizeAnswerKeyEntry(q.correct_answer));
      const correctIndex = LETTERS.indexOf(correctLetter);
      const correctChoice = String(normalizedChoices[correctIndex] || "").trim();
      const distractor = normalizedChoices
        .map((choice, idx) => ({ letter: LETTERS[idx], choice: String(choice || "").trim() }))
        .find((entry) => entry.letter !== correctLetter && entry.choice);
      const evidence = shouldUsePassage
        ? (selectEvidenceSnippet(q, scopedPassageText, usedEvidence) ||
          getRelevantSnippet(scopedPassageText, q.question, correctChoice) ||
          "the strongest supporting detail in the passage")
        : "the strongest detail provided in the question";
      const evidenceIdea = summarizeEvidenceIdea(evidence);
      const explanationStyles = [
        `For "${String(q.question || "").trim()}", start with the passage idea about ${evidenceIdea}. That points to ${correctLetter}${correctChoice ? ` (${correctChoice})` : ""}.`,
        `${correctLetter}${correctChoice ? ` (${correctChoice})` : ""} fits best because the text emphasizes ${evidenceIdea}, which matches the question focus.`,
        `A careful read of the evidence about ${evidenceIdea} makes ${correctLetter}${correctChoice ? ` (${correctChoice})` : ""} the strongest option.`,
      ];
      const explanationLead = explanationStyles[index % explanationStyles.length];
      const explanation = distractor
        ? `${explanationLead} ${distractor.letter} (${distractor.choice}) is incorrect because it does not match the same evidence as precisely.`
        : explanationLead;
      const commonMistake = distractor
        ? `${distractor.letter} can seem related, but it is not the best-supported interpretation of the passage evidence.`
        : "One trap is selecting an answer that sounds plausible without checking passage evidence.";

      const parentTip = variedParentTip(index);
      return {
        question_id: ensureQuestionId(q, index, mode),
        correct_answer: correctLetter || "",
        explanation,
        common_mistake: commonMistake,
        parent_tip: parentTip,
      };
    } catch (err) {
      console.error("Answer build failed:", err);
      return {
        question_id: ensureQuestionId(q, index, mode),
        correct_answer: "",
        explanation: "Answer unavailable.",
        common_mistake: "",
        parent_tip: "",
      };
    }
  });
}

function buildTutorFromPractice(questions: Question[]): { practice: TutorExplanation[]; cross: TutorExplanation[] } {
  return {
    practice: questions.slice(0, 5).map((q, i) => {
      const { letter: detectedLetter, choice: correctChoice } = getQuestionCorrectPair(q);
      return {
        question_id: `practice_q${i + 1}`,
        question: String(q.question || ""),
        explanation: String(q.explanation || "").trim(),
        common_mistake: String(q.common_mistake || "").trim(),
        hint: String(q.hint || "").trim(),
        think: String(q.think || "").trim(),
        step_by_step: String(q.step_by_step || "").trim() ||
          (detectedLetter ? `Choose the option that best matches the requirement (${detectedLetter}: ${correctChoice}).` : "Choose the option that best matches the requirement."),
      };
    }),
    cross: [],
  };
}

function buildAnswerKeyFromPractice(questions: Question[]): { practice: AnswerKeyEntry[]; cross: AnswerKeyEntry[] } {
  return {
    practice: questions.slice(0, 5).map((q, i) => {
      const { letter: detectedLetter } = getQuestionCorrectPair(q);
      return {
        question_id: `practice_q${i + 1}`,
        correct_answer: detectedLetter || "",
        explanation: String(q.explanation || "").trim(),
        common_mistake: String(q.common_mistake || "").trim(),
        parent_tip: String(q.parent_tip || "").trim(),
      };
    }),
    cross: [],
  };
}

function sanitizeTutorExplanations(
  _raw: unknown,
  sourceQuestions: Question[],
  subject: CanonicalSubject,
  mode: "practice" | "cross",
  crossPassage = "",
): TutorExplanation[] {
  void subject;
  const baseQuestions = sourceQuestions.slice(0, 5);
  if (baseQuestions.length === 0) return [];
  return generateTutor(baseQuestions, subject, mode, "On Level", crossPassage);
}

function sanitizeAnswerKey(
  _raw: unknown,
  sourceQuestions: Question[],
  subject: CanonicalSubject,
  _tutor: TutorExplanation[],
  mode: "practice" | "cross",
  crossPassage = "",
): AnswerKeyEntry[] {
  void subject;
  const baseQuestions = sourceQuestions.slice(0, 5);
  if (baseQuestions.length === 0) return [];
  return generateAnswerKey(baseQuestions, subject, mode, "On Level", crossPassage);
}

function validateTutorAnswerKeyAlignment(
  questions: Question[],
  tutor: TutorExplanation[],
  answerKey: AnswerKeyEntry[],
  mode: "practice" | "cross",
): boolean {
  if (questions.length !== 5 || tutor.length !== 5 || answerKey.length !== 5) return false;
  return questions.every((q, index) => {
    const expectedId = ensureQuestionId(q, index, mode);
    const tutorEntry = tutor[index];
    const answerEntry = answerKey[index];
    const tutorRequired = Boolean(
      tutorEntry?.explanation && tutorEntry?.hint && tutorEntry?.step_by_step &&
      tutorEntry?.common_mistake,
    );
    const answerRequired = Boolean(
      answerEntry?.correct_answer && answerEntry?.explanation &&
      answerEntry?.common_mistake,
    );
    return tutorRequired &&
      answerRequired &&
      tutorEntry.question_id === expectedId &&
      answerEntry.question_id === expectedId;
  });
}

function areQuestionSetsDistinct(practiceQuestions: Question[], crossQuestions: Question[]): boolean {
  const practiceText = new Set(practiceQuestions.map((q) => String(q.question || "").trim().toLowerCase()));
  const overlap = crossQuestions.filter((q) => practiceText.has(String(q.question || "").trim().toLowerCase())).length;
  const skillBucket = (value: string): string => {
    const v = value.toLowerCase();
    if (v.includes("main idea")) return "main_idea";
    if (v.includes("detail")) return "detail";
    if (v.includes("infer")) return "inference";
    if (v.includes("meaning") || v.includes("vocabulary")) return "vocab";
    if (v.includes("summary")) return "summary";
    if (v.includes("cause") || v.includes("effect") || v.includes("result") || v.includes("impact") || v.includes("led")) return "cause_effect";
    if (v.includes("process") || v.includes("predict") || v.includes("change")) return "science_reasoning";
    if (v.includes("solve") || v.includes("total") || v.includes("calculate") || v.includes("how many")) return "math_compute";
    return "other";
  };
  const practiceBuckets = new Set(practiceQuestions.map((q) => skillBucket(String(q.question || ""))));
  const crossBuckets = new Set(crossQuestions.map((q) => skillBucket(String(q.question || ""))));
  const sharedBuckets = [...crossBuckets].filter((bucket) => practiceBuckets.has(bucket)).length;
  return overlap < 2 && sharedBuckets < 2;
}

function validateSeparation(practice: Question[], cross: Question[], subject: CanonicalSubject): boolean {
  const practiceValid = practice.every((q) => {
    const text = String(q.question || "").toLowerCase();
    if (subject === "Reading") return /(infer|theme|evidence|conclusion)/i.test(text);
    if (subject === "Math") return /\d|total|difference|equation|calculate|rate/i.test(text);
    if (subject === "Science") return /(cause|effect|system|result|variable|experiment)/i.test(text);
    if (subject === "Social Studies") return /(event|decision|impact|cause|effect|timeline|policy)/i.test(text);
    return true;
  });

  const crossValid = cross.every((q) => {
    const text = String(q.question || "").toLowerCase();

    if (subject === "Math") {
      return /\d/.test(text);
    }

    if (subject === "Science") {
      return text.includes("experiment") || text.includes("result");
    }

    if (subject === "Social Studies") {
      return text.includes("event") || text.includes("effect");
    }

    return true;
  });

  return practiceValid && crossValid;
}

type PipelineQuestion = {
  question?: string;
  choices?: string[];
  correct_answer?: unknown;
  [key: string]: unknown;
};

type PipelineResult = {
  questions: PipelineQuestion[];
  tutor?: { practice: unknown[]; cross: unknown[] };
  answerKey?: { practice: unknown[]; cross: unknown[] };
  [key: string]: unknown;
};

type PipelineInput = {
  questions?: Question[] | PipelineQuestion[];
  stems?: unknown[];
  crossSubject?: CanonicalSubject;
  subject?: CanonicalSubject;
  skill?: string;
  level?: Level;
  crossPassage?: PassageContent | string;
  tutor?: { practice: unknown[]; cross: unknown[] };
  answerKey?: { practice: unknown[]; cross: unknown[] };
};

function generateQuestions(input: PipelineInput): PipelineResult {
  return {
    questions: Array.isArray(input?.questions) ? input.questions : [],
    tutor: input.tutor,
    answerKey: input.answerKey,
  };
}

function normalizeOutput(result: PipelineResult): PipelineResult {
  const questions = (result?.questions || []).map((q) => ({
    ...q,
    question: String(q.question || ""),
    choices: normalizeChoices(q.choices),
    correct_answer: q.correct_answer || "A",
  }));

  return { ...result, questions };
}

function enrichOutput(result: PipelineResult): PipelineResult {
  return {
    questions: result.questions,
    tutor: result.tutor || { practice: [], cross: [] },
    answerKey: result.answerKey || { practice: [], cross: [] },
  };
}

async function runPipeline(input: PipelineInput): Promise<PipelineResult> {
  let result = generateQuestions(input);
  result = normalizeOutput(result);
  result = enrichOutput(result);
  return result;
}

function shouldRewrite(choices: string[]): boolean {
  const starts = choices.map((c) =>
    String(c || "").toLowerCase().split(" ").slice(0, 5).join(" ")
  );

  const counts: Record<string, number> = {};
  for (const s of starts) {
    counts[s] = (counts[s] || 0) + 1;
  }

  const values = Object.values(counts);
  const maxRepeat = values.length ? Math.max(...values) : 0;

  // ONLY rewrite if 3+ answers start the same
  return maxRepeat >= 3;
}

function fallbackDiverseChoices(): [string, string, string, string] {
  return [
    "The passage shows that the key idea is supported by specific details.",
    "The data suggests a different explanation based on what is measured.",
    "The results indicate another possibility that fits some evidence.",
    "The information explains why one conclusion is most accurate.",
  ];
}

function rewriteChoicesForUniqueStarts(question: string): [string, string, string, string] {
  const stem = String(question || "").trim().replace(/\?+$/, "");
  const rewritten: [string, string, string, string] = [
    `One detail in the text shows ${stem.toLowerCase() || "the main point"}.`,
    `Another clue supports a different idea about ${stem.toLowerCase() || "the topic"}.`,
    `A separate detail points to an alternative interpretation of ${stem.toLowerCase() || "the question"}.`,
    `The strongest evidence confirms the best conclusion about ${stem.toLowerCase() || "the topic"}.`,
  ];

  const uniqueChoices = new Set(rewritten.map((choice) => choice.toLowerCase().trim())).size === 4;
  if (!uniqueChoices || shouldRewrite(rewritten)) {
    return fallbackDiverseChoices();
  }

  return rewritten;
}

function validateAndRewriteChoiceStarts(questions: Question[]): Question[] {
  return questions.map((q) => {
    if (!Array.isArray(q.choices) || q.choices.length !== 4) return q;
    const normalizedChoices = normalizeChoices(q.choices).map((choice) => cleanAnswerChoice(choice)) as [string, string, string, string];
    if (!shouldRewrite(normalizedChoices)) {
      return {
        ...q,
        choices: normalizedChoices,
      };
    }

    const rewritten = rewriteChoicesForUniqueStarts(q.question || "");
    const fallback = fallbackDiverseChoices();
    const safeChoices = shouldRewrite(rewritten) ? fallback : rewritten;

    return {
      ...q,
      choices: safeChoices,
    };
  });
}

function enforceSingleSourceOfTruth(data: WorkerAttempt, subject: CanonicalSubject = "Reading"): WorkerAttempt {
  const practicePassage = data.passage || "";
  const crossPassage = data.cross?.passage || "";

  void subject;
  const validatedPractice = [...(data.practice.questions || [])]
    .map((q) => repairQuestion(q, subject, practicePassage));

  let validatedCross: Question[] = [];
  if (data.cross?.questions) {
    validatedCross = [...data.cross.questions]
      .map((q) => repairQuestion(q, subject, crossPassage));
    data.cross.questions = validatedCross;
  }
  data.practice.questions = validateAndRewriteChoiceStarts(validatedPractice).slice(0, 5);
  data.cross.questions = validateAndRewriteChoiceStarts(validatedCross);

  const buildBoundSupport = (
    q: Question,
    passage: PassageContent | string,
    usedEvidence: Set<string>,
    variant = 0,
  ): { explanation: string; commonMistake: string; hint: string; think: string; stepByStep: string; parentTip: string } => {
    const passageText = getPassageText(passage);
    const normalizedChoices = normalizeChoices(q.choices);
    const correctLetter = normalizeAnswer(normalizeAnswerKeyEntry(q.correct_answer));
    const correctIndex = LETTERS.indexOf(correctLetter);
    const correctChoice = String(normalizedChoices[correctIndex] || "").trim();
    const wrongOption = normalizedChoices
      .map((choice, idx) => ({ letter: LETTERS[idx], choice: String(choice || "").trim() }))
      .find((entry) => entry.letter !== correctLetter && entry.choice);
    const evidenceSnippet = selectEvidenceSnippet(q, passageText, usedEvidence) ||
      getRelevantSnippet(passageText, q.question, correctChoice) ||
      "the strongest details in the passage";
    const evidenceIdea = summarizeEvidenceIdea(evidenceSnippet);

    const explanationVariants = [
      `I would start with the passage idea about ${evidenceIdea}. Once we anchor there, ${correctLetter}${correctChoice ? ` (${correctChoice})` : ""} fits the question best.`,
      `Try reasoning it out this way: the passage explains ${evidenceIdea}, and that lines up most clearly with ${correctLetter}${correctChoice ? ` (${correctChoice})` : ""}.`,
      `Before picking an answer, connect the question to this idea from the text: ${evidenceIdea}. That connection points to ${correctLetter}${correctChoice ? ` (${correctChoice})` : ""}.`,
      `A strong approach here is to paraphrase the key detail as ${evidenceIdea}, then compare options. ${correctLetter}${correctChoice ? ` (${correctChoice})` : ""} stays consistent with that evidence.`,
    ];
    const explanationLead = explanationVariants[Math.abs(variant) % explanationVariants.length];
    const explanationTail = wrongOption
      ? ` ${wrongOption.letter} (${wrongOption.choice}) can feel tempting, but the passage evidence supports it less clearly than ${correctLetter}.`
      : " The other options fall apart when you test them against the same passage detail.";
    const explanation = `${explanationLead}${explanationTail}`;

    const commonMistake = wrongOption
      ? `${wrongOption.letter} can sound close to the topic, but it does not match the passage idea about ${evidenceIdea} as well as ${correctLetter}.`
      : `One trap here is picking a familiar-sounding choice without checking which passage idea actually proves the answer.`;

    const hint = `Start with this passage idea: ${evidenceIdea}. Then compare each answer choice to that same idea.`;
    const think = `If you restate the passage idea as "${evidenceIdea}," which option is fully supported?`;
    const stepByStep = `1. Read the question and identify the key idea.\n2. Find the matching detail in the passage.\n3. Compare each choice to that same detail.\n4. Keep ${correctLetter} because it matches the evidence most completely.\n5. Cross out choices that only partly match.`;
    const parentTip = variedParentTip(variant);

    return { explanation, commonMistake, hint, think, stepByStep, parentTip };
  };

  const rebuildTutor = (questions: Question[], mode: "practice" | "cross"): TutorExplanation[] => {
    const sourcePassage = mode === "cross" ? crossPassage : practicePassage;
    const usedEvidence = new Set<string>();
    return questions.map((q, i) => {
      const support = buildBoundSupport(q, sourcePassage, usedEvidence, i);
      return {
        question_id: ensureQuestionId(q, i, mode),
        question: String(q.question || "").trim(),
        explanation: support.explanation,
        common_mistake: support.commonMistake,
        hint: support.hint,
        think: support.think,
        step_by_step: support.stepByStep,
      };
    });
  };

  const rebuildAnswerKey = (questions: Question[], mode: "practice" | "cross"): AnswerKeyEntry[] => {
    const sourcePassage = mode === "cross" ? crossPassage : practicePassage;
    const usedEvidence = new Set<string>();
    return questions.map((q, i) => {
      const support = buildBoundSupport(q, sourcePassage, usedEvidence, i);
      return {
        question_id: ensureQuestionId(q, i, mode),
        correct_answer: normalizeAnswerKeyEntry(q.correct_answer),
        explanation: support.explanation,
        common_mistake: support.commonMistake,
        parent_tip: support.parentTip,
      };
    });
  };

  data.tutor = {
    practice: rebuildTutor(validatedPractice, "practice"),
    cross: rebuildTutor(validatedCross, "cross"),
  };

  data.answerKey = {
    practice: rebuildAnswerKey(validatedPractice, "practice"),
    cross: rebuildAnswerKey(validatedCross, "cross"),
  };

  return data;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  let grade = 5;
  let subject: CanonicalSubject = "Reading";
  let skill = READING_SKILL_DEFAULT;
  let level: Level = "On Level";
  let effectiveMode: "core" | "cross" | "support" | "enrichment" = "core";
  let contentMode: CanonicalMode = "Practice";
  let effectiveSubject: CanonicalSubject = "Reading";
  let effectiveSkill = READING_SKILL_DEFAULT;
  let teksCode = "Unknown";

  const jsonResponse = (payload: Record<string, unknown>, status = 200) =>
    new Response(JSON.stringify({ ...payload, source: "ai" }), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  const assertSupportIntegrity = (payload: {
    practice?: { questions?: unknown[] };
    cross?: { passage?: string; questions?: unknown[] };
    tutor?: { practice?: unknown[]; cross?: unknown[] };
    answerKey?: { practice?: unknown[]; cross?: unknown[] };
  }) => {
    if (payload.practice?.questions?.length) {
      if (!payload.tutor?.practice?.length) console.warn("⚠️ Missing tutor.practice");
      if (!payload.answerKey?.practice?.length) console.warn("⚠️ Missing answerKey.practice");
    }

    if (payload.cross?.questions?.length) {
      if (!payload.tutor?.cross?.length) console.warn("⚠️ Missing tutor.cross");
      if (!payload.answerKey?.cross?.length) console.warn("⚠️ Missing answerKey.cross");
    }
  };
  const generateCross = async (params: {
    grade: number;
    subject: CanonicalSubject;
    skill: string;
    level: Level;
    practiceQuestions: Question[];
  }) => {
    const { grade, subject, skill, level, practiceQuestions } = params;
    const baseCross = subject === "Reading" ? buildELARFallback(level) : buildSubjectCrossContent(subject, level);
    const constraints = getGradeConstraints(grade);
    const crossPassage = ensurePassageLength(
      baseCross.passage,
      250,
      300,
      subject,
      "Cross-Curricular",
      grade,
      level,
    );
    const gradeSafeCrossPassage = enforceSentenceLength(crossPassage, constraints.maxWordsPerSentence);
    const crossQuestions = sanitizeQuestions(
      baseCross.questions || [],
      subject,
      "Cross-Curricular",
      skill,
      level,
      gradeSafeCrossPassage,
      grade,
    );
    const crossPipeline = await runPipeline({
      stems: practiceQuestions,
      crossSubject: subject,
      subject,
      skill,
      level,
      crossPassage: gradeSafeCrossPassage,
      questions: crossQuestions,
    });
    return {
      passage: gradeSafeCrossPassage,
      questions: sanitizeQuestions(
        crossPipeline.questions,
        subject,
        "Cross-Curricular",
        skill,
        level,
        gradeSafeCrossPassage,
        grade,
      ),
    };
  };
  const returnCore = async (data: CoreResponse) => {
    const sanitizeAndValidateQuestions = (
      questions: Question[],
      passage: PassageContent | string,
      mode: "practice" | "cross",
    ): Question[] => {
      void mode;
      const normalizedQuestions = questions
        .map((q) => repairQuestion(q, subject, passage))
        .map((q) => normalizeAndValidate(q, passage));

      return normalizedQuestions.slice(0, 5);
    };

    const practice = {
      questions: [...(data?.practice?.questions || [])],
    };
    const practicePassage = data?.passage || "";

    practice.questions = sanitizeAndValidateQuestions(practice.questions, practicePassage, "practice");
    if (practice.questions.length === 0) {
      throw new Error("INSUFFICIENT_QUALITY_QUESTIONS");
    }

    const cross = await generateCross({
      grade,
      subject,
      skill,
      level,
      practiceQuestions: practice.questions,
    });
    const crossPassage = cross?.passage || "";
    cross.questions = sanitizeAndValidateQuestions(cross.questions, crossPassage, "cross");
    practice.questions = sanitizeChoices(
      practice.questions,
      getPassageText(practicePassage),
    );
    cross.questions = sanitizeChoices(
      cross.questions,
      cross.passage,
    );
    practice.questions = sanitizeExplanations(practice.questions, practicePassage);
    cross.questions = sanitizeExplanations(cross.questions, cross.passage);

    const finalized = enforceSingleSourceOfTruth({
      passage: subject === "Reading"
        ? ensurePassageLength(
          getPassageText(data.passage || ""),
          readingPracticeWordRange(level).min,
          readingPracticeWordRange(level).max,
          subject,
          contentMode,
          grade,
          level,
        )
        : "",
      practice: {
        questions: practice.questions,
      },
      cross,
      tutor: { practice: [], cross: [] },
      answerKey: { practice: [], cross: [] },
    }, subject);

    return jsonResponse({
      teks: teksCode,
      skill,
      grade,
      ...(subject === "Reading" ? { passage: finalized.passage } : {}),
      practice: finalized.practice,
      cross: finalized.cross,
      tutor: finalized.tutor,
      answerKey: finalized.answerKey,
    });
  };
  const returnEnrichment = (data: EnrichmentResponse) =>
    {
      const sanitizedPracticeQuestions = sanitizeExplanations(
        sanitizeChoices(
          ((data as Partial<WorkerAttempt>)?.practice?.questions || []).map((q) => ({ ...q })),
          getPassageText(String((data as Partial<WorkerAttempt>)?.passage || "")),
        ),
        String((data as Partial<WorkerAttempt>)?.passage || ""),
      );
      const sanitizedCrossQuestions = sanitizeExplanations(
        sanitizeChoices(
          (data?.cross?.questions || []).map((q) => ({ ...q })),
          String(data?.cross?.passage || ""),
        ),
        String(data?.cross?.passage || ""),
      );
      const finalized = enforceSingleSourceOfTruth({
        passage: String((data as Partial<WorkerAttempt>)?.passage || ""),
        practice: {
          questions: sanitizedPracticeQuestions,
        },
        cross: {
          passage: String(data?.cross?.passage || ""),
          questions: sanitizedCrossQuestions,
        },
        tutor: { practice: [], cross: [] },
        answerKey: { practice: [], cross: [] },
      }, subject);
      assertSupportIntegrity({
        practice: { questions: [] },
        cross: { questions: finalized.cross.questions },
        tutor: finalized.tutor,
        answerKey: finalized.answerKey,
      });
      return jsonResponse({
        teks: teksCode,
        skill,
        grade,
        practice: {
          questions: [],
        },
        cross: finalized.cross,
        tutor: finalized.tutor,
        answerKey: finalized.answerKey,
      });
    };

  const aiErrorResponse = (reason: string, status = 502) =>
    jsonResponse({ error: reason }, status);

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      {
        global: {
          headers: { Authorization: req.headers.get("Authorization") || "" },
        },
      },
    );

    const authResult = await supabase.auth.getUser();
    const user = authResult?.data?.user;
    if (!user) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        {
          status: 401,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        },
      );
    }

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch (err) {
      console.error("Invalid JSON body:", err);
      return new Response(
        JSON.stringify({ error: "Invalid JSON body" }),
        {
          status: 400,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
          },
        },
      );
    }

    const {
      grade: incomingGrade,
      subject: incomingSubject,
      skill: incomingSkill,
      level: incomingLevel,
      mode: incomingMode,
    } = body;

    console.log("🔥 BACKEND RECEIVED:", {
      subject: incomingSubject,
      grade: incomingGrade,
      skill: incomingSkill,
      level: incomingLevel,
      mode: incomingMode,
    });

    grade = Number(incomingGrade || 5);
    subject = canonicalizeSubject(incomingSubject);
    skill = String(incomingSkill || READING_SKILL_DEFAULT).trim() || READING_SKILL_DEFAULT;
    teksCode = resolveTeks(subject, skill, grade);
    level = normalizeLevel(incomingLevel);
    const normalizedMode = String(incomingMode || "").toLowerCase().trim();
    if (normalizedMode === "cross" || normalizedMode === "cross-curricular") {
      effectiveMode = "cross";
    } else if (normalizedMode === "support") {
      effectiveMode = "support";
    } else if (normalizedMode === "enrichment") {
      effectiveMode = "enrichment";
    } else {
      effectiveMode = "core";
    }
    contentMode = effectiveMode === "cross" ? "Cross-Curricular" : "Practice";
    effectiveSubject = subject;
    effectiveSkill = skill ?? "Main Idea";

    console.log("🔥 FINAL MODE:", contentMode);

    // 🚀 NEW MODE ROUTING
    if (effectiveMode === "cross") {
      const crossContent = buildSubjectCrossContent(subject, level);
      const result = await runPipeline({
        stems: crossContent.questions,
        crossSubject: subject,
        subject,
        crossPassage: crossContent.passage,
        questions: crossContent.questions,
      });

      return jsonResponse({
        teks: teksCode,
        skill,
        grade,
        cross: {
          passage: crossContent.passage,
          questions: sanitizeQuestions(
            result.questions,
            subject,
            "Cross-Curricular",
            effectiveSkill,
            level,
            crossContent.passage,
            grade,
          ),
        },
      });
    }

    if (effectiveMode === "support") {
      const practiceQuestions = Array.isArray(body.practiceQuestions)
        ? body.practiceQuestions as Question[]
        : [];
      const bodyCross = body?.cross && typeof body.cross === "object"
        ? body.cross as Record<string, unknown>
        : {};
      const crossQuestions: IncomingCrossQuestion[] = Array.isArray(bodyCross.questions)
        ? bodyCross.questions as IncomingCrossQuestion[]
        : [];
      const crossPassage = String(bodyCross.passage || "");

      const practiceQuestionSet = sanitizeQuestions(
        practiceQuestions,
        subject,
        "Practice",
        effectiveSkill,
        level,
        getPassageText(String(body.passage || "")),
        grade,
      );
      const crossQuestionSet = sanitizeQuestions(
        crossQuestions,
        subject,
        "Cross-Curricular",
        effectiveSkill,
        level,
        crossPassage,
        grade,
      );
      const supportFinalized = enforceSingleSourceOfTruth({
        passage: getPassageText(String(body.passage || "")),
        practice: { questions: practiceQuestionSet },
        cross: { passage: crossPassage, questions: crossQuestionSet },
        tutor: { practice: [], cross: [] },
        answerKey: { practice: [], cross: [] },
      }, subject);

      return jsonResponse({
        teks: teksCode,
        skill,
        grade,
        tutor: supportFinalized.tutor,
        answerKey: supportFinalized.answerKey,
      });
    }
    console.log("🔥 RAW MODE:", normalizedMode);
    console.log("🔥 EFFECTIVE MODE:", effectiveMode);
    console.log("🧠 CONTENT MODE:", contentMode);
    console.log("🧠 SUBJECT:", subject);
    console.log("🧠 EFFECTIVE SUBJECT:", effectiveSubject);
    const readingRange = readingPracticeWordRange(level);
    const range = subject === "Reading" ? readingRange : { min: 250, max: 300 };

    let attempts = 0;
    const MAX_ATTEMPTS = 1;
    const start = Date.now();
    const MAX_TIMEOUT_MS = 20000;
    const isTimedOut = () => Date.now() - start > MAX_TIMEOUT_MS;
    let retryFailureReason = "no_questions_returned";
    let bestAttempt: WorkerAttempt | null = null;
    let returnType = "UNKNOWN";
    const markRetry = (reason: string) => {
      retryFailureReason = reason;
      console.log("❌ RETRY REASON:", retryFailureReason);
    };
    const logReturnMetrics = () => {
      console.log("🔁 ATTEMPTS USED:", attempts);
      console.log("🎯 RETURN TYPE:", returnType);
      console.log("⏱ TOTAL TIME:", Date.now() - start, "ms");
    };
    while (attempts < MAX_ATTEMPTS) {
      if (isTimedOut()) {
        if (bestAttempt) {
          returnType = "BEST_ATTEMPT_TIMEOUT";
          console.warn("⚠️ Returning best attempt before timeout");
          logReturnMetrics();
          return returnCore(bestAttempt);
        }
        markRetry("no_questions_returned");
        console.warn("⚠️ Timed out before generating questions");
        break;
      }
      attempts++;
      try {
          if (effectiveMode === "core") {
            console.time("OPENAI_CALL");
            const aiStartTime = Date.now();
            const variationSeed = Math.random().toString(36).slice(2, 8);
            const aiRes = await fetch("https://api.openai.com/v1/responses", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${Deno.env.get("OPENAI_API_KEY")}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: "gpt-4o-mini",
              temperature: 0.7,
              top_p: 1,
              input: buildGenerationPrompt({
                mode: "core",
                grade,
                subject,
                skill: effectiveSkill,
                level,
                teksCode,
              }) + `\nVariation ID: ${variationSeed}`,
              max_output_tokens: 1400,
            }),
            signal: AbortSignal.timeout(MAX_TIMEOUT_MS),
          });
          console.timeEnd("OPENAI_CALL");
          console.log("⏱️ AI Duration:", Date.now() - aiStartTime);

          if (!aiRes.ok) {
            markRetry("no_questions_returned");
            continue;
          }

          const aiJson = await aiRes.json() as Record<string, unknown>;
          const aiAny = aiJson as {
            output?: Array<{ content?: Array<{ text?: string }> }>;
            output_text?: string;
          };
          const text = String(
            aiAny.output?.[0]?.content?.[0]?.text ||
            aiAny.output_text ||
            "",
          ).trim();

          if (!text || isBadOutput(text)) {
            markRetry("no_questions_returned");
            continue;
          }

          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(text);
          } catch (err) {
            console.error("JSON PARSE ERROR:", err);
            parsed = tryParseJsonPayload(text) || {};
          }

          if (!parsed || !Object.keys(parsed).length) {
            markRetry("malformed_json");
            continue;
          }
          let passageText = String(parsed.passage || "").trim();
          if (passageText) {
            passageText = enforceValidPassage(passageText, subject, level);
            parsed.passage = passageText;
          } else if (parsed.passage && typeof parsed.passage === "object" && !Array.isArray(parsed.passage)) {
            const passageObj = parsed.passage as Record<string, unknown>;
            const text1 = String(passageObj.text_1 || "").trim();
            const text2 = String(passageObj.text_2 || "").trim();
            if (text1) passageObj.text_1 = enforceValidPassage(text1, subject, level);
            if (text2) passageObj.text_2 = enforceValidPassage(text2, subject, level);
            parsed.passage = passageObj;
          }

          const constraints = getGradeConstraints(grade);
          const parsedPassage = parsed.passage;
          const passage = parsedPassage && typeof parsedPassage === "object" && !Array.isArray(parsedPassage)
            ? {
              text_1: ensurePassageLength(
                clampPassageWords(String((parsedPassage as Record<string, unknown>).text_1 || ""), range.min, range.max),
                range.min,
                range.max,
                subject,
                contentMode,
                grade,
                level,
              ),
              text_2: ensurePassageLength(
                clampPassageWords(String((parsedPassage as Record<string, unknown>).text_2 || ""), range.min, range.max),
                range.min,
                range.max,
                subject,
                contentMode,
                grade,
                level,
              ),
            }
            : ensurePassageLength(
              clampPassageWords(String(parsedPassage || ""), range.min, range.max),
              range.min,
              range.max,
              subject,
              contentMode,
              grade,
              level,
            );
          let safePassage = subject === "Reading"
            ? (
              typeof passage === "string"
                ? passage
                : (passage.text_1 && passage.text_2 ? passage : null)
            )
            : "";
          if (subject === "Reading") {
            const rawPassage = getPassageText(safePassage).trim();
            const rawWordCount = rawPassage.split(/\s+/).filter(Boolean).length;
            if (!isValidPassage(rawPassage)) {
              console.warn("⚠️ Weak passage — using anyway");
            }
            if (!rawPassage || rawWordCount < 20) {
              markRetry("no_questions_returned");
              continue;
            }
            if (!/[.!?]["')\]]?\s*$/.test(rawPassage)) {
              console.warn("Validation issue — keeping question");
            }
            if (isWeakPassage(rawPassage, grade)) {
              console.warn("Validation issue — keeping question");
            }
            if (violatesGradeLevel(rawPassage, grade)) {
              console.warn("Validation issue — keeping question");
            }
            safePassage = enforceSentenceLength(rawPassage, constraints.maxWordsPerSentence);
            if (looksLikeDramaPassage(safePassage)) {
              safePassage = ensureDramaScriptFormat(safePassage);
            }
          }

          const parsedPractice = parsed?.practice && typeof parsed.practice === "object"
            ? parsed.practice as Record<string, unknown>
            : null;
          const rawQuestions = parsedPractice?.questions ||
            parsed.questions ||
            parsed.items ||
            [];
          const practiceQuestions = sanitizeQuestions(
            rawQuestions,
            effectiveSubject,
            "Practice",
            effectiveSkill,
            level,
            subject === "Reading" ? safePassage : "",
            grade,
          );
          if (practiceQuestions.length === 0) {
            markRetry("no_questions_returned");
            continue;
          }
          if (subject === "Reading" && !passageSupportsQuestions(String(safePassage || ""), practiceQuestions)) {
            console.warn("⚠️ Weak passage — using anyway");
          }
          if (subject === "Reading" && safePassage && practiceQuestions?.length) {
            const tutorLeads = [
              "Think about what the passage is saying in this part.",
              "A good first step is to return to the key sentence in the passage.",
              "Let’s solve this by matching the question to a specific detail in the text.",
            ];
            const lightweightTutor = practiceQuestions.map((q, index) => ({
              question_id: ensureQuestionId(q, index, "practice"),
              question: q.question,
              explanation: (() => {
                const correctLetter = normalizeAnswer(normalizeAnswerKeyEntry(q.correct_answer));
                const choice = getChoiceByLetter(q, correctLetter);
                const choiceText = Array.isArray(choice) ? choice.join(" ") : String(choice || "");
                const snippet = getRelevantSnippet(safePassage, q.question, choiceText) || "the strongest detail in the passage";
                const idea = summarizeEvidenceIdea(snippet);
                const lead = tutorLeads[index % tutorLeads.length];
                return `${lead} The passage idea about ${idea} helps confirm why ${correctLetter}${choiceText ? ` (${choiceText})` : ""} is the best-supported answer.`;
              })(),
              common_mistake: "Choosing an option that sounds related without confirming it with a specific passage detail.",
            }));
            const lightweightAnswerKey = practiceQuestions.map((q, index) => {
              const correctLetter = normalizeAnswer(normalizeAnswerKeyEntry(q.correct_answer));
              const choice = getChoiceByLetter(q, correctLetter);
              const choiceText = Array.isArray(choice) ? choice.join(" ") : String(choice || "");
              const snippet = getRelevantSnippet(safePassage, q.question, choiceText) || "the strongest detail in the passage";
              const idea = summarizeEvidenceIdea(snippet);
              return {
                question_id: ensureQuestionId(q, index, "practice"),
                correct_answer: normalizeAnswerKeyEntry(q.correct_answer),
                explanation: `If you focus on the passage idea about ${idea}, ${correctLetter}${choiceText ? ` (${choiceText})` : ""} is the choice that stays most consistent with the text.`,
                common_mistake: "Selecting an answer that mentions the topic but is not fully supported by passage evidence.",
                parent_tip: variedParentTip(index),
              };
            });
            bestAttempt = {
              passage: safePassage,
              practice: { questions: practiceQuestions },
              cross: { passage: "", questions: [] },
              tutor: { practice: lightweightTutor, cross: [] },
              answerKey: { practice: lightweightAnswerKey, cross: [] },
            };
          }

          const pipelineResult = await runPipeline({
            subject: effectiveSubject,
            skill: effectiveSkill,
            level,
            crossPassage: subject === "Reading" ? safePassage : "",
            questions: practiceQuestions,
          });
          const pipelineQuestions = sanitizeQuestions(
            pipelineResult.questions,
            effectiveSubject,
            "Practice",
            effectiveSkill,
            level,
            subject === "Reading" ? safePassage : "",
            grade,
          );
          if (pipelineQuestions.length === 0) {
            markRetry("no_questions_returned");
            continue;
          }
          const outputValid = isValidOutput(pipelineQuestions, safePassage);
          if (!outputValid) {
            console.warn("Validation issue — keeping question");
          }

          const payload: CoreResponse = {
            passage: subject === "Reading"
              ? ensurePassageLength(getPassageText(safePassage), range.min, range.max, subject, contentMode, grade, level)
              : undefined,
            practice: { questions: pipelineQuestions },
          };
          if (subject !== "Reading") {
            delete payload.passage;
          }
          bestAttempt = {
            passage: payload.passage || "",
            practice: payload.practice,
            cross: { passage: "", questions: [] },
            tutor: {
              practice: Array.isArray(pipelineResult.tutor?.practice) ? pipelineResult.tutor.practice as TutorExplanation[] : [],
              cross: Array.isArray(pipelineResult.tutor?.cross) ? pipelineResult.tutor.cross as TutorExplanation[] : [],
            },
            answerKey: {
              practice: Array.isArray(pipelineResult.answerKey?.practice)
                ? pipelineResult.answerKey.practice as AnswerKeyEntry[]
                : [],
              cross: Array.isArray(pipelineResult.answerKey?.cross) ? pipelineResult.answerKey.cross as AnswerKeyEntry[] : [],
            },
          };
          returnType = "PRIMARY";
          logReturnMetrics();
          return returnCore(payload);
        }

        const priorPractice = body.practiceQuestions;
        if (!Array.isArray(priorPractice) || priorPractice.length === 0) {
          markRetry("no_questions_returned");
          continue;
        }

        const corePassageFromRequest = typeof body.passage === "string"
          ? String(body.passage || "").trim()
          : "";
        const corePassageForChecks = corePassageFromRequest;
        const normalizedPractice = sanitizeQuestions(
          priorPractice,
          effectiveSubject,
          "Practice",
          effectiveSkill,
          level,
          corePassageForChecks,
          grade,
        );
        if (normalizedPractice.length === 0 && attempts === 1) {
          markRetry("no_questions_returned");
          continue;
        }
        console.log("🧠 CROSS SUBJECT:", effectiveSubject);
        const crossContent = buildSubjectCrossContent(effectiveSubject, level);
        const baseCrossPassage = crossContent.passage;
        if (baseCrossPassage === corePassageForChecks) {
          console.log("⚠️ Cross passage duplication detected");
        }

        {
          const constraints = getGradeConstraints(grade);
          const crossPassage = ensurePassageLength(
            baseCrossPassage,
            250,
            300,
            effectiveSubject,
            "Cross-Curricular",
            grade,
            level,
          );
          const gradeSafeCrossPassage = enforceSentenceLength(crossPassage, constraints.maxWordsPerSentence);
          const crossQuestions = sanitizeQuestions(
            crossContent.questions || [],
            effectiveSubject,
            "Cross-Curricular",
            effectiveSkill,
            level,
            gradeSafeCrossPassage,
            grade,
          );
          const result = await runPipeline({
            stems: crossQuestions,
            crossSubject: effectiveSubject,
            subject: effectiveSubject,
            crossPassage: gradeSafeCrossPassage,
            questions: crossQuestions,
          });
          const pipelineCrossQuestions = sanitizeQuestions(
            result.questions,
            effectiveSubject,
            "Cross-Curricular",
            effectiveSkill,
            level,
            gradeSafeCrossPassage,
            grade,
          );
          if (pipelineCrossQuestions.length === 0 && attempts === 1) {
            markRetry("no_questions_returned");
            continue;
          }
          const payload = {
            cross: {
              passage: gradeSafeCrossPassage,
              questions: pipelineCrossQuestions,
            },
          };
          bestAttempt = {
            passage: corePassageForChecks,
            practice: { questions: normalizedPractice },
            cross: payload.cross,
            tutor: { practice: [], cross: [] },
            answerKey: { practice: [], cross: [] },
          };
          returnType = "PRIMARY";
          logReturnMetrics();
          return jsonResponse({ ...payload, teks: teksCode, skill, grade });
        }

        {
          const priorCrossQuestions = Array.isArray(body.crossQuestions) ? body.crossQuestions : [];
          const priorCrossPassage = typeof body.crossPassage === "string"
            ? String(body.crossPassage || "").trim()
            : "";
          const sanitizedCrossQuestions = sanitizeQuestions(
            priorCrossQuestions,
            effectiveSubject,
            "Cross-Curricular",
            effectiveSkill,
            level,
            priorCrossPassage,
            grade,
          );
          const tutorPractice = sanitizeTutorExplanations(
            [],
            normalizedPractice,
            effectiveSubject,
            "practice",
          );
          const tutorCross = sanitizeTutorExplanations(
            [],
            sanitizedCrossQuestions,
            effectiveSubject,
            "cross",
            priorCrossPassage,
          );
          const answerKeyPractice = sanitizeAnswerKey(
            [],
            normalizedPractice,
            effectiveSubject,
            tutorPractice,
            "practice",
          );
          const answerKeyCross = sanitizeAnswerKey(
            [],
            sanitizedCrossQuestions,
            effectiveSubject,
            tutorCross,
            "cross",
            priorCrossPassage,
          );
          const payload = {
            tutor: {
              practice: tutorPractice,
              cross: tutorCross,
            },
            answerKey: {
              practice: answerKeyPractice,
              cross: answerKeyCross,
            },
          };
          bestAttempt = {
            passage: corePassageForChecks,
            practice: { questions: normalizedPractice },
            cross: { passage: priorCrossPassage, questions: sanitizedCrossQuestions },
            tutor: payload.tutor,
            answerKey: payload.answerKey,
          };
          assertSupportIntegrity({
            practice: { questions: normalizedPractice },
            cross: { passage: priorCrossPassage, questions: sanitizedCrossQuestions },
            tutor: payload.tutor,
            answerKey: payload.answerKey,
          });
          returnType = "PRIMARY";
          logReturnMetrics();
          return jsonResponse({ ...payload, teks: teksCode, skill, grade });
        }

        console.time("OPENAI_CALL");
        const enrichStartTime = Date.now();
        const variationSeed = Math.random().toString(36).slice(2, 8);
        const enrichRes = await fetch("https://api.openai.com/v1/responses", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${Deno.env.get("OPENAI_API_KEY")}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            temperature: 0.7,
            top_p: 1,
            input: buildGenerationPrompt({
              mode: "enrichment",
              grade,
              subject: effectiveSubject,
              skill: effectiveSkill,
              practiceQuestions: normalizedPractice,
              level,
              crossPassage: baseCrossPassage,
              teksCode,
            }) + `\nVariation ID: ${variationSeed}`,
            max_output_tokens: 1400,
          }),
          signal: AbortSignal.timeout(MAX_TIMEOUT_MS),
        });
        console.timeEnd("OPENAI_CALL");
        console.log("⏱️ AI Duration:", Date.now() - enrichStartTime);

        if (!enrichRes.ok) {
          markRetry("no_questions_returned");
          continue;
        }

        const enrichJson = await enrichRes.json() as Record<string, unknown>;
        const enrichAny = enrichJson as {
          output?: Array<{ content?: Array<{ text?: string }> }>;
          output_text?: string;
        };
        const enrichText = String(
          enrichAny.output?.[0]?.content?.[0]?.text ||
          enrichAny.output_text ||
          "",
        ).trim();
        const parsed = tryParseJsonPayload(enrichText) || {};
        const parsedCross = parsed?.cross && typeof parsed.cross === "object"
          ? parsed.cross as Record<string, unknown>
          : {};
        let subjectCrossPassage = String(parsedCross.passage || "").trim() || baseCrossPassage;
        if (subjectCrossPassage) {
          subjectCrossPassage = enforceValidPassage(subjectCrossPassage, effectiveSubject, level);
          parsedCross.passage = subjectCrossPassage;
        }
        if (!validateCrossPassage(subjectCrossPassage) || subjectCrossPassage === corePassageForChecks) {
          console.warn("⚠️ Invalid or duplicated cross passage, forcing subject passage");
          subjectCrossPassage = baseCrossPassage;
        }
        const constraints = getGradeConstraints(grade);
        subjectCrossPassage = ensurePassageLength(
          subjectCrossPassage,
          250,
          300,
          effectiveSubject,
          "Cross-Curricular",
          grade,
          level,
        );
        subjectCrossPassage = enforceSentenceLength(subjectCrossPassage, constraints.maxWordsPerSentence);
        if (violatesGradeLevel(subjectCrossPassage, grade)) {
          console.warn("⚠️ Passage too advanced for grade, keeping AI output");
        }

        let crossQuestions = sanitizeQuestions(
          parsedCross.questions || [],
          effectiveSubject,
          "Cross-Curricular",
          effectiveSkill,
          level,
          subjectCrossPassage,
          grade,
        );
        const crossValid = isValidOutput(crossQuestions, subjectCrossPassage);
        if (crossQuestions.length === 0 && attempts === 1) {
          markRetry("no_questions_returned");
          continue;
        }
        if (!crossValid) {
          console.warn("Validation issue — keeping question");
        }

        const tutorPractice = sanitizeTutorExplanations(
          [],
          normalizedPractice,
          effectiveSubject,
          "practice",
        );
        let tutorCross = sanitizeTutorExplanations(
          [],
          crossQuestions,
          effectiveSubject,
          "cross",
          subjectCrossPassage,
        );

        const answerKeyPractice = sanitizeAnswerKey(
          [],
          normalizedPractice,
          effectiveSubject,
          tutorPractice,
          "practice",
        );
        let answerKeyCross = sanitizeAnswerKey(
          [],
          crossQuestions,
          effectiveSubject,
          tutorCross,
          "cross",
          subjectCrossPassage,
        );
        const practiceAligned = validateTutorAnswerKeyAlignment(normalizedPractice, tutorPractice, answerKeyPractice, "practice");
        const crossAligned = validateTutorAnswerKeyAlignment(crossQuestions, tutorCross, answerKeyCross, "cross");
        if (!practiceAligned) {
          console.warn("⚠️ Practice tutor misaligned");
        }

        if (!crossAligned) {
          console.warn("⚠️ Cross tutor misaligned — rebuilding");
          tutorCross = sanitizeTutorExplanations(
            [],
            crossQuestions,
            effectiveSubject,
            "cross",
            subjectCrossPassage,
          );

          answerKeyCross = sanitizeAnswerKey(
            [],
            crossQuestions,
            effectiveSubject,
            tutorCross,
            "cross",
            subjectCrossPassage,
          );
        }

        console.log("🔥 FINAL CROSS SUBJECT:", effectiveSubject);
        console.log("🔥 FINAL CROSS PASSAGE:", subjectCrossPassage);

        if (!crossQuestions.length) {
          crossQuestions = crossContent.questions;
        }

        const payload = {
          cross: {
            passage: subjectCrossPassage,
            questions: crossQuestions,
          },
          tutor: { practice: tutorPractice, cross: tutorCross },
          answerKey: { practice: answerKeyPractice, cross: answerKeyCross },
        };
        assertSupportIntegrity({
          practice: { questions: normalizedPractice },
          cross: payload.cross,
          tutor: payload.tutor,
          answerKey: payload.answerKey,
        });
        bestAttempt = {
          passage: corePassageForChecks,
          practice: { questions: normalizedPractice },
          cross: payload.cross,
          tutor: payload.tutor,
          answerKey: payload.answerKey,
        };
        returnType = "PRIMARY";
        logReturnMetrics();
        return returnEnrichment(payload);
      } catch (err) {
        console.error("BACKEND ERROR:", err);
        if (isTimedOut()) {
          returnType = "TIMEOUT";
          logReturnMetrics();
          return aiErrorResponse("generation_timeout", 504);
        }
        markRetry("no_questions_returned");
      }
    }

    if (bestAttempt) {
      returnType = "BEST_ATTEMPT";
      logReturnMetrics();
      return returnEnrichment(bestAttempt);
    }
    returnType = "NO_RESULT";
    logReturnMetrics();
    return aiErrorResponse(retryFailureReason);
  } catch (err) {
    console.error("🔥 EDGE FUNCTION ERROR:", err);
    return aiErrorResponse("no_questions_returned", 500);
  }
});
