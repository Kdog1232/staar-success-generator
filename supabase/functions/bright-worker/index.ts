import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type Level = "Below" | "On Level" | "Advanced";
type ChoiceLetter = "A" | "B" | "C" | "D";
type AnswerLetter = "A" | "B" | "C" | "D";
type CanonicalSubject = "Reading" | "Math" | "Science" | "Social Studies";
type CanonicalMode = "Practice" | "Cross-Curricular" | "Tutor" | "Answer Key";

type CrossConnection = {
  subject: "Science" | "Math" | "Social Studies";
  connection: string;
};

type QuestionType = "mc" | "part_a" | "part_b" | "part_a_b" | "multi_select" | "scr";
type PassageContent = string | { text_1: string; text_2: string };
type PartABAnswer = { partA: ChoiceLetter; partB: ChoiceLetter };
type PartBlock = {
  question: string;
  choices: [string, string, string, string];
};

type Question = {
  type?: QuestionType;
  question: string;
  choices: [string, string, string, string];
  correct_answer: ChoiceLetter | [ChoiceLetter, ChoiceLetter] | PartABAnswer;
  partA?: PartBlock;
  partB?: PartBlock;
  explanation: string;
  paired_with?: number;
  sample_answer?: string;
  part_b_question?: string;
  part_b_choices?: [string, string, string, string];
  part_b_correct_answer?: ChoiceLetter;
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

function getRelevantSnippet(passage: PassageContent | string, question: string): string | null {
  const sentences = getPassageText(passage)
    .split(/[.!?]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const keywords = question.toLowerCase().split(" ").filter((w) => w.length > 4);

  let best: string | null = null;
  let bestScore = 0;

  for (const sentence of sentences) {
    const lower = sentence.toLowerCase();
    let score = 0;

    for (const word of keywords) {
      if (lower.includes(word)) score++;
    }

    if (score > bestScore) {
      bestScore = score;
      best = sentence;
    }
  }

  return bestScore > 0 ? best : null;
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

function teacherStyleExplanation(passage: PassageContent | string, question: string): string {
  const snippet = getRelevantSnippet(passage, question);
  if (!snippet) {
    return "This answer requires combining multiple details from the passage. Re-read carefully to identify supporting evidence.";
  }
  return `${getExplanationStarter()}: "${snippet}". This detail helps explain why the correct choice is the strongest answer when compared to the other options.`;
}

function buildCrossExplanation(passage: PassageContent | string, question: string): string {
  return teacherStyleExplanation(passage, question);
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

function rigorInstruction(level: Level): string {
  if (level === "Below") return "Use direct reasoning with explicit clues and clearer evidence paths.";
  if (level === "Advanced") return "Increase reasoning depth, abstraction, and evidence precision.";
  return "Use grade-appropriate reasoning rigor.";
}

type RigorProfile = {
  passage: "simple" | "grade" | "complex";
  questionDepth: "low" | "medium" | "high";
  distractorQuality: "obvious" | "plausible" | "subtle";
};

function applyRigor(level: Level): RigorProfile {
  if (level === "Below") {
    return {
      passage: "simple",
      questionDepth: "low",
      distractorQuality: "obvious",
    };
  }

  if (level === "Advanced") {
    return {
      passage: "complex",
      questionDepth: "high",
      distractorQuality: "subtle",
    };
  }

  return {
    passage: "grade",
    questionDepth: "medium",
    distractorQuality: "plausible",
  };
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

function getDifficultyInstructions(level: Level): string {
  if (level === "Below") {
    return "Use explicit main ideas, direct identification questions, and clearly incorrect but plausible distractors.";
  }
  if (level === "On Level") {
    return "Require some inference and include realistic distractors.";
  }
  if (level === "Advanced") {
    return "Use deeper reasoning with multiple ideas or shifts, and subtle distractors close to correct.";
  }
  return "";
}

function getRigorEngineRules(level: Level, subject: CanonicalSubject): string {
  if (level === "Below") {
    if (subject === "Math") return "Below: single-step basic computation with short, clear stems and obviously wrong distractors.";
    if (subject === "Science") return "Below: simple cause/effect with one clear variable and obviously wrong distractors.";
    if (subject === "Social Studies") return "Below: identify event/outcome directly with short stems and clearly wrong distractors.";
    return "Below: informational passage with explicit main idea and direct identification questions; distractors are clearly incorrect but plausible.";
  }
  if (level === "Advanced") {
    if (subject === "Math") return "Advanced: multi-step word problems with embedded reasoning and unnecessary info; distractors are plausible misconception traps.";
    if (subject === "Science") return "Advanced: multi-variable system reasoning; distractors are close alternatives based on common misconceptions.";
    if (subject === "Social Studies") return "Advanced: evaluate impacts or compare decisions across time/policy; distractors are plausible but flawed.";
    return "Advanced: informational passage with multiple ideas/shifts, higher-order synthesis, and subtle distractors with close evidence differences.";
  }
  if (subject === "Math") return "On Level: two-step word problems that apply computation to a context with moderately plausible distractors.";
  if (subject === "Science") return "On Level: system relationships and applied cause/effect with moderately plausible distractors.";
  if (subject === "Social Studies") return "On Level: cause/effect relationship questions with moderate distractor quality.";
  return "On Level: informational passage with moderate inference demand and realistic distractors.";
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
  const effectiveSubject: CanonicalSubject = subject;
  const effectiveSkill: string = skill ?? "Main Idea";
  const skillType = routeBySkill(effectiveSkill);
  const difficulty = getDifficultyInstructions(level);
  const subjectRules = getSubjectInstructions(effectiveSubject);
  const rigorEngineRules = getRigorEngineRules(level, effectiveSubject);

  if (mode === "Cross-Curricular") {
    return `
  Generate CROSS-CURRICULAR content-area literacy practice.

  REQUIREMENTS:

  PASSAGE:
  - Must be a reading passage (informational text)
  - Topic must be based on ${effectiveSubject}
  - Must feel like a textbook or real-world scenario

  QUESTIONS:
  - Must be based on ${effectiveSubject} thinking
  - Must REQUIRE reading the passage to answer
  - Must NOT be generic reading questions only

  SUBJECT ALIGNMENT:

  If subject is Science:
  - cause & effect
  - systems
  - scientific reasoning

  If subject is Social Studies:
  - cause & effect
  - historical decisions
  - economic/civic reasoning

  If subject is Math:
  - word problem interpretation
  - multi-step reasoning
  - quantitative relationships

  CRITICAL:
  - Questions MUST depend on the passage
  - Do NOT generate isolated subject questions
  - Do NOT generate pure ELAR-only questions

  RETURN:
  {
    passage: string,
    questions: [...]
  }
  `;
  }

  return `Generate STAAR-style ${effectiveSubject} questions.

INPUTS:
- Grade: ${grade}
- Subject: ${effectiveSubject}
- Skill: ${effectiveSkill}
- Skill Type: ${skillType}
- Level: ${level}
- Mode: ${mode}

REQUIREMENTS:
- Align all questions to the requested skill: ${effectiveSkill}
- Match level rigor: ${level}
- Include strong distractors and STAAR format (MC, multi-select, SCR)
- Avoid placeholder/filler language

${difficulty}
${subjectRules}
RIGOR ENGINE RULE: ${rigorEngineRules}

Return strict JSON only with:
- passage
- 5 questions
- explanation, common_mistake, and parent_tip fields per question.`;
}

function buildCorePrompt(params: {
  grade: number;
  subject: CanonicalSubject;
  skill: string;
  level: Level;
  teksCode?: string;
}): string {
  const { grade, subject, skill, level, teksCode = "Unknown" } = params;
  const rigor = applyRigor(level);
  const rigorEngineRules = getRigorEngineRules(level, subject);
  const constraints = getGradeConstraints(grade);
  if (subject === "Reading") {
    const readingRange = readingPracticeWordRange(level);
    const mainIdeaStemRule = isMainIdeaSkill(skill)
      ? `- Main Idea question-type lock (5.6A style):
  - Allowed stems only:
    - "What is the main idea of the passage?"
    - "Which statement best describes the main idea?"
  - Not allowed:
    - "What did the character do?"
    - "What lesson did they learn?"`
      : "";
    return `Create JSON only for PRACTICE MODE.
Grade: ${grade}
Subject: ${subject}
Skill: ${skill}
Level: ${level}

Return exactly:
{
  "passage": "REQUIRED informational string (${readingRange.min}–${readingRange.max} words)",
  "practice": { "questions": [5 items with question, choices, correct_answer, explanation] }
}

Rules:
- PRACTICE MODE ONLY. Do not generate cross-curricular content.
- TEKS Alignment Code: ${teksCode}
- Instruction: Design the question to match how this TEKS is assessed on STAAR.
- TEKS alignment: skill "${skill}" at grade ${grade} must be assessed through application (analyze/infer/compare/explain), not definition recall.
- Subject is Reading, so include a new informational passage only (${readingRange.min}–${readingRange.max} words).
- If any instruction conflicts with the required passage length, follow ${readingRange.min}–${readingRange.max} words only.
- Do NOT explicitly state key conclusions in the passage.
- Include details that REQUIRE inference (imply cause, include competing details, delay explanation).
- Grade readability lock (must override level language changes):
  - max words per sentence: ${constraints.maxWordsPerSentence}
  - max sentence count target: ${constraints.maxSentences}
  - vocabulary band: ${constraints.vocab}
  - abstract language allowance: ${String(constraints.allowAbstract)}
  - passage length signal: ${constraints.passageLength}
- Passage genre lock: informational text ONLY. No stories, no characters, no narrative events, no character names.
- Generate exactly 5 STAAR-style reading questions tied directly to that passage.
- Questions MUST NOT be directly answerable from a single sentence.
- Each question must require combining at least TWO details or making an inference.
- No “why did X happen?” when the answer is explicitly stated in the passage.
- Prefer stems such as:
  - "What can the reader conclude..."
  - "Which idea is BEST supported..."
  - "What is most likely..."
  - "Which detail suggests..."
- All 4 answer choices must explicitly reference passage details (events/actions/outcomes).
- Keep all 4 choices similar in structure and length to avoid obvious answer patterns.
- Never use: "best explains", "this shows", "the answer is supported", "it can be inferred".
- Correct answers must include a specific event plus cause/effect OR decision/result reasoning.
- Distractors must use one of: misinterpretation, partial-truth wrong conclusion, overgeneralization, or cause/effect confusion.
- If any choice feels generic or easy, rewrite it with more specific passage evidence.
- ANSWER VALIDATION TYPES:
  - TYPE 1 — TEXT EVIDENCE QUESTIONS:
    - The correct answer MUST match an exact sentence in the passage.
    - If no exact sentence proves the answer, REWRITE the question and choices.
  - TYPE 2 — INFERENCE QUESTIONS:
    - The correct answer MUST be supported by combining TWO OR MORE details from the passage.
    - The answer must NOT be stated word-for-word in a single sentence.
    - The reasoning must logically connect multiple pieces of evidence.
- INFERENCE-SPECIFIC VALIDATION:
  - For inference stems (for example: "What can the reader conclude..." or "What is most likely..."):
    - DO NOT rely on a single sentence.
    - The correct answer MUST require combining multiple details.
    - The answer must be logically derived, not directly stated.
  - EXPLANATION REQUIREMENT:
    - The explanation MUST explicitly reference at least TWO different details from the passage.
    - The explanation must show how those details connect to support the correct answer.
    - DO NOT give a generic explanation.
  - STRICT RULE:
    - If the answer can be found in one sentence, it is NOT valid. Rewrite it.
- STRICT VALIDATION RULES:
  - DO NOT invent evidence.
  - DO NOT create answers based on general knowledge.
  - DO NOT create answers that are "probably true."
  - ONLY use information explicitly stated or clearly implied by the passage.
- DISTRACTOR VALIDATION RULES:
  - Wrong answers must:
    - use real passage details but misinterpret them
    - OR include partial truth with wrong conclusion
  - DO NOT create unrelated or vague distractors.
- FINAL VALIDATION CHECK:
  - For text-evidence questions: "Can the correct answer be underlined in one sentence?"
    - If NO, regenerate that question.
  - For inference questions: "Can I identify at least TWO different passage details that support the answer?"
    - If NO, regenerate that question.
- For Part A / Part B items:
  - Part A must require inference or analysis.
  - Part B must ask for text evidence that supports Part A.
  - Part B answer choices must be specific sentences or details from the passage.
  - The correct Part B answer must directly prove the correct Part A answer.
  - Distractors must be plausible evidence that does NOT support Part A.
- Difficulty behavior lock:
  - Below: shorter passage, explicit main idea, direct identification questions, clearly incorrect but plausible distractors.
  - On Level: moderate passage length, some inference required, realistic distractors.
  - Advanced: complex passage with multiple ideas/shifts, subtle distractors close to correct.
${mainIdeaStemRule}
- Rigor profile:
  - passage complexity: grade-locked readability only (do not change by level)
  - question depth: ${rigor.questionDepth}
  - distractor quality: ${rigor.distractorQuality}
- RIGOR ENGINE: ${rigorEngineRules}
- Use clear, student-friendly STAAR language.
- Every question has 4 distinct, specific answer choices.
- No markdown. JSON only.`;
  }

  return `Create JSON only for PRACTICE MODE.
Grade: ${grade}
Subject: ${subject}
Skill: ${skill}
Level: ${level}

Return exactly:
{
  "practice": { "questions": [5 items with question, choices, correct_answer, explanation] }
}

Rules:
- PRACTICE MODE ONLY. Do not generate cross-curricular content.
- TEKS Alignment Code: ${teksCode}
- Instruction: Design the question to match how this TEKS is assessed on STAAR.
- TEKS alignment: skill "${skill}" at grade ${grade} must be assessed through application (analyze/infer/compare/explain), not definition recall.
- Subject is ${subject}, so DO NOT generate a passage.
- Grade readability lock (must override level language changes):
  - max words per sentence: ${constraints.maxWordsPerSentence}
  - vocabulary band: ${constraints.vocab}
  - abstract language allowance: ${String(constraints.allowAbstract)}
- Generate exactly 5 standalone STAAR-style ${subject} questions.
- Use multi-step reasoning where appropriate.
- Questions MUST NOT be directly answerable from a single sentence.
- Each question must require combining at least TWO details or making an inference.
- No “why did X happen?” when the answer is explicitly stated.
- Prefer stems such as:
  - "What can the reader conclude..."
  - "Which idea is BEST supported..."
  - "What is most likely..."
  - "Which detail suggests..."
- Questions must be subject-driven and not ELAR-framed.
- ANSWER VALIDATION TYPES:
  - TYPE 1 — TEXT EVIDENCE QUESTIONS:
    - The correct answer MUST match an exact statement in the provided stimulus/data/context.
    - If no exact statement proves the answer, REWRITE the question and choices.
  - TYPE 2 — INFERENCE QUESTIONS:
    - The correct answer MUST be supported by combining TWO OR MORE details from the provided information.
    - The answer must NOT be stated word-for-word in a single line or statement.
    - The reasoning must logically connect multiple pieces of evidence.
- INFERENCE-SPECIFIC VALIDATION:
  - For inference stems (for example: "What can be concluded..." or "What is most likely..."):
    - DO NOT rely on a single statement.
    - The correct answer MUST require combining multiple details.
    - The answer must be logically derived, not directly stated.
  - EXPLANATION REQUIREMENT:
    - The explanation MUST explicitly reference at least TWO different details from the provided content.
    - The explanation must show how those details connect to support the correct answer.
    - DO NOT give a generic explanation.
  - STRICT RULE:
    - If the answer can be found in one sentence/statement, it is NOT valid. Rewrite it.
- STRICT VALIDATION RULES:
  - DO NOT invent evidence.
  - DO NOT create answers based on general knowledge.
  - DO NOT create answers that are "probably true."
  - ONLY use information explicitly stated or clearly implied by the provided content.
- DISTRACTOR VALIDATION RULES:
  - Wrong answers must:
    - use real details but misinterpret them
    - OR include partial truth with wrong conclusion
  - DO NOT create unrelated or vague distractors.
- FINAL VALIDATION CHECK:
  - For text-evidence questions: "Can the correct answer be underlined in one statement?"
    - If NO, regenerate that question.
  - For inference questions: "Can I identify at least TWO different supporting details?"
    - If NO, regenerate that question.
- For Part A / Part B items:
  - Part A must require inference or analysis.
  - Part B must ask for text evidence that supports Part A.
  - Part B answer choices must be specific sentences or details from the passage.
  - The correct Part B answer must directly prove the correct Part A answer.
  - Distractors must be plausible evidence that does NOT support Part A.
- Forbidden wording in questions/choices: "main idea", "central idea", "author", "theme", "reader", "claim".
- Rigor profile:
  - question depth: ${rigor.questionDepth}
  - distractor quality: ${rigor.distractorQuality}
- RIGOR ENGINE: ${rigorEngineRules}
- Every question has 4 distinct, specific answer choices.
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
}): string {
  const { grade, subject, skill, practiceQuestions, level, crossPassage = "", teksCode = "Unknown" } = params;
  const rigor = applyRigor(level);
  const rigorEngineRules = getRigorEngineRules(level, subject);
  const constraints = getGradeConstraints(grade);
  const subjectFocus = subject === "Math"
    ? [
      "Math passage must include numbers, quantities, rates, or comparisons.",
      "Questions MUST require calculations or numerical reasoning.",
      "Use stems like: \"What is the total...\", \"How much...\", \"Which calculation...\", \"What is the difference...\".",
      "DO NOT use ELAR wording.",
    ].join("\n- ")
    : subject === "Science"
    ? [
      "Science passage must describe a system, experiment, or process.",
      "Questions must focus on cause/effect, variables, results, and conclusions.",
      "Use stems like: \"What happens when...\", \"Which factor affects...\", \"What can be concluded...\".",
      "DO NOT use ELAR wording.",
    ].join("\n- ")
    : subject === "Social Studies"
    ? [
      "Social Studies passage must include historical or economic context.",
      "Questions must focus on decisions, impact, cause/effect, and influence.",
      "Use stems like: \"Why did...\", \"What was the effect of...\", \"Which factor influenced...\".",
      "DO NOT use ELAR wording.",
    ].join("\n- ")
    : [
      "Reading uses ELAR-style reasoning grounded in the passage.",
    ].join("\n- ");

  const requiredQuestionBlock = `You are an expert STAAR test item writer aligned to Texas Essential Knowledge and Skills (TEKS).

INPUT CONFIGURATION
- Grade Level: ${grade}
- Target Skill: ${skill}
- TEKS Alignment Code: ${teksCode}
- Instruction: Design the question to match how this TEKS is assessed on STAAR.

TEKS ALIGNMENT RULE
- Align the question to how this skill is tested on STAAR.
- Identify the cognitive action students must perform (analyze, infer, compare, explain).
- Build the question to match that cognitive demand.
- Ensure the correct answer requires evidence-based reasoning from the passage.

STAAR DESIGN REQUIREMENTS
- Match STAAR format and rigor.
- Require reasoning, not recall.
- Ground every answer in passage evidence.
- Reflect how TEKS skills are assessed, not just defined.
- ANSWER VALIDATION TYPES:
  - TYPE 1 — TEXT EVIDENCE QUESTIONS:
    - The correct answer MUST match an exact sentence in the cross passage.
    - If no exact sentence proves the answer, REWRITE the question and choices.
  - TYPE 2 — INFERENCE QUESTIONS:
    - The correct answer MUST be supported by combining TWO OR MORE details from the cross passage.
    - The answer must NOT be stated word-for-word in a single sentence.
    - The reasoning must logically connect multiple pieces of evidence.
- INFERENCE-SPECIFIC VALIDATION:
  - For inference stems (for example: "What can the reader conclude..." or "What is most likely..."):
    - DO NOT rely on a single sentence.
    - The correct answer MUST require combining multiple details.
    - The answer must be logically derived, not directly stated.
  - EXPLANATION REQUIREMENT:
    - The explanation MUST explicitly reference at least TWO different details from the cross passage.
    - The explanation must show how those details connect to support the correct answer.
    - DO NOT give a generic explanation.
  - STRICT RULE:
    - If the answer can be found in one sentence, it is NOT valid. Rewrite it.
- STRICT VALIDATION RULES:
  - DO NOT invent evidence.
  - DO NOT create answers based on general knowledge.
  - DO NOT create answers that are "probably true."
  - ONLY use information explicitly stated or clearly implied by the cross passage.

GRADE-LEVEL ADAPTATION
- Grades 3-4: clear inference, concrete reasoning, shorter responses, direct passage links.
- Grades 5-6: multi-step reasoning, combined details, moderate complexity.
- Grades 7-8: abstract thinking, subtle choice differences, multi-layer reasoning.
- Enforce readability from grade only (do not use level to alter vocabulary or sentence complexity):
  - max words per sentence: ${constraints.maxWordsPerSentence}
  - max sentence count target: ${constraints.maxSentences}
  - vocabulary band: ${constraints.vocab}
  - abstract language allowance: ${String(constraints.allowAbstract)}

ANSWER CHOICE RULES
- ALL 4 choices must reference the passage explicitly.
- Include real details, events, or outcomes in each choice.
- Keep choices similar in structure and length.
- Avoid obvious wrong answers.
- Avoid meta-language: "main idea", "this shows", "best explains".

DISTRACTOR DESIGN (TEKS-ALIGNED)
- Each wrong answer must model a realistic student mistake:
  - misinterpretation of evidence
  - partial understanding of the skill
  - incorrect inference
  - cause/effect confusion
- Wrong answers must use real cross passage details with misinterpretation OR partial truth with wrong conclusion.
- DO NOT create unrelated or vague distractors.

CORRECT ANSWER RULE
- The correct answer must use specific passage evidence.
- The correct answer must demonstrate the targeted skill correctly.
- The correct answer must include reasoning (cause/effect, inference, comparison, etc.).

SELF-CHECK (MANDATORY)
- Does the question require the intended TEKS skill?
- Would a student need to APPLY the skill, not define it?
- Are distractors based on realistic student mistakes?
- Is the answer supported by passage evidence?
- For Part A / Part B items:
  - Part A requires inference/analysis.
  - Part B asks only for text evidence supporting Part A.
  - Part B choices are passage-based sentences/details.
  - Correct Part B directly proves correct Part A.
- If not, revise before returning.
- FINAL CHECK:
  - For text-evidence questions: can the correct answer be underlined in one sentence?
    - If NO, regenerate that question.
  - For inference questions: can I identify at least TWO different details supporting the answer?
    - If NO, regenerate that question.

OUTPUT FORMAT FOR EACH cross.questions ITEM:
{
  "question": "...",
  "choices": ["A. ...", "B. ...", "C. ...", "D. ..."],
  "correct_answer": "A"
}

FINAL RULE
Do NOT write a generic question.
Design each item as if it will appear on a STAAR test aligned to TEKS.`;

  const passageDirective = crossPassage.trim()
    ? `\nPassage:\n${crossPassage}\n\nYou MUST use details from this passage in every answer.\n`
    : "";

  return `Generate a NEW cross-curricular passage and cross-curricular questions, then return JSON only:
{
  "cross": {
    "passage": "REQUIRED string (250–300 words, MUST be complete, no cut-off sentences)",
    "questions": [5 subject-aligned questions]
  }
}

Subject: ${subject}
Skill lock: ${skill}

Practice questions:
${JSON.stringify(practiceQuestions.slice(0, 5))}

Rules:
- CROSS-CURRICULAR MODE ONLY.
- CRITICAL: Generate a NEW passage (250–300 words).
- Passage MUST be different from practice passage.
- Passage MUST be aligned to ${subject}.
- Do NOT explicitly state key conclusions.
- Include details that require inference (imply cause, include competing details, delay explanations).
- Questions MUST be based ONLY on this new passage.
- Do NOT reuse or paraphrase the original practice passage.
- If a question can be answered without reading the passage, rewrite it.
- Cross questions must be different from practice questions.
- ALL questions in BOTH practice and cross must assess the selected skill exactly: ${skill}.
- NO skill drift, NO mixed topics in stem/Part A/Part B, NO ELAR language in non-Reading.
- Cross questions MUST be subject-driven for ${subject}.
- DO NOT force question variety.
- Generate the BEST 5 questions for the passage.
- Prioritize inference and evidence-based reasoning.
- Only include vocabulary or structure questions IF they naturally fit the passage.
- If a question type does not fit, DO NOT include it.
- Questions MUST NOT be directly answerable from a single sentence.
- Each question must require combining at least TWO details or making an inference.
- No “why did X happen?” when the answer is explicitly stated.
- Prefer stems such as:
  - "What can the reader conclude..."
  - "Which idea is BEST supported..."
  - "What is most likely..."
  - "Which detail suggests..."
- ${subjectFocus}
- For Math/Science/Social Studies, forbidden wording: "main idea", "central idea", "author", "theme", "reader", "claim".
- Rigor profile:
  - passage complexity: ${rigor.passage}
  - question depth: ${rigor.questionDepth}
  - distractor quality: ${rigor.distractorQuality}
- RIGOR ENGINE: ${rigorEngineRules}
- Each question must include exactly 4 clear, distinct, passage-specific answer choices.
- Choices must be clean answer options only (no explanations or commentary text).
- Validate answer correctness before returning.
- For cross question generation, apply this block exactly:
${requiredQuestionBlock}
- Return cross passage + cross questions only.
- JSON only.${passageDirective}`;
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
  if (params.mode === "core") {
    return buildCorePrompt({
      grade: params.grade,
      subject: params.subject,
      skill: params.skill,
      level: params.level,
      teksCode: params.teksCode,
    });
  }

  return buildEnrichmentPrompt({
    grade: params.grade,
    subject: params.subject,
    skill: params.skill,
    practiceQuestions: params.practiceQuestions || [],
    level: params.level,
    crossPassage: params.crossPassage || "",
    teksCode: params.teksCode,
  });
}

function buildSubjectPassage(subject: CanonicalSubject, level: Level = "On Level"): string {
  const rigor = applyRigor(level);
  if (subject === "Science") {
    if (rigor.passage === "simple") {
      return "Students tested playground surfaces at school. They checked blacktop, grass, and concrete each hour. Blacktop got hottest in direct sun. Grass in the shade stayed cooler. After watering one area, that area warmed up more slowly. Students used this evidence to suggest more shade and lighter materials.";
    }
    if (rigor.passage === "complex") {
      return "During a campus heat-transfer inquiry, student teams tracked how surface composition and environmental conditions influenced recess temperatures. They measured blacktop, concrete, and grass hourly while recording cloud cover, wind speed, and direct-sun exposure.\n\nThe results showed a persistent interaction: darker pavement absorbed and retained heat rapidly, while shaded grass moderated temperature through moisture and airflow. When students repeated the procedure after watering one test area, the rate of temperature increase fell, suggesting that evaporative effects altered heat buildup. In their final report, students connected these observations to design choices, arguing that material selection and shade planning could reduce thermal stress for the wider school community.";
    }
    return "During a campus investigation, students tested how surface type affected temperature at recess. They placed thermometers on blacktop, grass, and concrete every hour and recorded wind speed, cloud cover, and sunlight. The data showed that dark pavement heated fastest in direct sun, while shaded grass stayed cooler because moisture and airflow reduced heat buildup. Students repeated the experiment after watering one section and observed a smaller temperature increase there. In their report, they explained the physical process of heat transfer and used cause-and-effect evidence to recommend shade trees and lighter playground materials.";
  }

  if (subject === "Social Studies") {
    if (rigor.passage === "simple") {
      return "In 1908, town leaders debated a bridge or a bigger rail depot. Farmers wanted the bridge to move crops faster. Merchants wanted rail growth for trade. Leaders first chose rail expansion. Flooding then delayed shipments and raised prices. Later, voters approved money for a bridge. These decisions changed where people lived and worked.";
    }
    if (rigor.passage === "complex") {
      return "In 1908, leaders in a river town argued over two competing transportation investments: a bridge linking both banks or an expanded rail depot intended to attract outside commerce. Farmers favored the bridge for faster crop movement, while merchants expected rail expansion to widen regional trade.\n\nCouncil records show rail improvements were approved first, but repeated flooding disrupted shipments, increased prices, and weakened confidence in that strategy. Over the next several years, population growth on the opposite bank shifted daily travel patterns and voting priorities. When residents later passed a bridge bond, newspapers connected the decision to broader outcomes—migration shifts, business relocation, and new debates over how public funds should balance immediate needs with long-term community stability.";
    }
    return "In 1908, leaders in a river town debated whether to spend limited tax funds on a bridge or a larger rail depot. Farmers argued that a bridge would move crops to market faster, while merchants supported the depot to attract outside trade. Meeting records show that the council first approved rail expansion, but repeated flooding delayed shipments and raised prices. Five years later, after population growth along the opposite bank, voters passed a bond for the bridge. Newspaper timelines and election results suggest that transportation choices changed migration patterns, business investment, and daily life across the town.";
  }

  if (subject === "Math") {
    if (rigor.passage === "simple") {
      return "The student council sold snacks at field day. A combo pack cost $6. Single items cost $2 each. In hour 1, volunteers sold 38 combos and 24 single items. In hour 2, combo sales went down by 8, but single-item sales went up by 15. Students compared both hours to decide what to restock.";
    }
    if (rigor.passage === "complex") {
      return "The student council analyzed field-day snack sales to decide whether future inventory should prioritize combo packs or individual items. A combo pack was priced at $6 and included one drink plus two snacks, while single items were sold for $2 each.\n\nIn the first hour, volunteers recorded 38 combo purchases and 24 single-item purchases. In the second hour, combo volume declined by 8 after families shifted buying behavior, while single-item purchases rose by 15 following an announcement near the gym entrance. Organizers compared the two-hour revenue structure, not just item counts, because price-per-transaction and demand movement could produce different conclusions about total earnings and restocking risk.";
    }
    return "The student council planned a field-day snack sale with two pricing options for families. A combo pack cost $6 and included one drink and two snacks, while single items cost $2 each. In the first hour, volunteers sold 38 combo packs and 24 single items. In the second hour, combo sales dropped by 8, but single-item sales increased by 15 after an announcement. Organizers used these numbers to compare revenue patterns and decide whether to restock combo materials or individual items. Their final decision depended on how the quantities in both hours related to total earnings.";
  }

  if (rigor.passage === "simple") {
    return "A school newspaper team read interviews and survey notes. Some students liked short articles. Others liked longer stories with more examples. Editors checked details to make sure claims matched evidence. They revised headlines to fit what sources actually said.";
  }
  if (rigor.passage === "complex") {
    return "A school newspaper team analyzed interviews, survey data, and meeting notes to explain why students preferred different reading formats. Some readers valued short articles for quick access to key points, while others favored long-form features that developed ideas through examples and context.\n\nAs editors compared quotations across sources, they noticed how wording choices could shift meaning and create apparent disagreement. They revised claims, reorganized evidence, and adjusted headlines to better reflect what the strongest sources supported. Their final publication argued that careful comparison of language and evidence leads to more reliable conclusions, especially when two reports seem to conflict at first glance.";
  }
  return "A school newspaper team reviewed interviews, survey results, and meeting notes to understand why students preferred different reading formats. Some students said short articles helped them find key ideas quickly, while others preferred longer features with more examples and context. Editors compared quotations, checked which claims were supported by multiple sources, and revised headlines to match the evidence in each story. When two reports appeared to conflict, the team re-read the original statements and identified how word choice changed the meaning. Their final publication explained how careful reading and evidence-based reasoning led to clearer conclusions.";
}

function buildMathFallbackChoices(): [string, string, string, string] {
  return [
    "Compute both steps: (18 + 27) × 3 to find total notebook revenue.",
    "Add all given quantities first, then subtract returns to get the final total sold.",
    "Multiply batches by cups per batch, then compare with available inventory.",
    "Use only one operation on one number, which misses a required computation step.",
  ];
}

function buildScienceFallbackChoices(): [string, string, string, string] {
  return [
    "Changing light intensity changed photosynthesis rate, causing different growth outcomes.",
    "The independent variable was water amount, so observations compare response changes.",
    "A controlled experiment isolates one variable to explain the observed relationship.",
    "The conclusion should be based on repeated observations, not a single trial.",
  ];
}

function buildSSFallbackChoices(): [string, string, string, string] {
  return [
    "Flood delays increased prices, so voters later supported a bridge policy change.",
    "Council decisions in the early 1900s shifted trade routes and migration patterns.",
    "Population growth changed public priorities, affecting election outcomes over time.",
    "A transportation policy can reshape jobs, markets, and settlement across a town.",
  ];
}

function getFallbackChoices(subject: CanonicalSubject, skill: string): [string, string, string, string] {
  void skill;
  if (subject === "Math") return buildMathFallbackChoices();
  if (subject === "Science") return buildScienceFallbackChoices();
  if (subject === "Social Studies") return buildSSFallbackChoices();
  const safePassage = buildSubjectPassage("Reading", "On Level");
  const safeQuestion = "Which event in the passage led to a later decision or outcome?";
  return buildReadingChoices(safePassage, safeQuestion, "On Level");
}

function normalizeChoices(choices: unknown): [string, string, string, string] {
  const clean = Array.isArray(choices) ? choices.slice(0, 4) : [];

  while (clean.length < 4) clean.push("");

  return clean.map((c) =>
    String(c || "")
      .replace(/^[A-D]\.\s*/i, "")
      .trim()
  ) as [string, string, string, string];
}

function normalizeAnswer(letter: unknown): ChoiceLetter {
  const v = String(letter ?? "A").trim().toUpperCase();
  if (v.startsWith("B")) return "B";
  if (v.startsWith("C")) return "C";
  if (v.startsWith("D")) return "D";
  return "A";
}

function safeCorrectAnswer(value: unknown): ChoiceLetter {
  const v = String(value || "").trim().toUpperCase();
  if (v === "A" || v === "B" || v === "C" || v === "D") return v;
  return "A";
}

function parseAnswerLetter(value: unknown): ChoiceLetter | null {
  const raw = String(value ?? "").trim().toUpperCase();
  if (raw === "A" || raw === "B" || raw === "C" || raw === "D") return raw;
  if (/^[ABCD][\).\s-]/.test(raw)) return raw[0] as ChoiceLetter;
  return null;
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
  if (typeof answer !== "string") return "";
  const idx = letters.indexOf(answer as ChoiceLetter);
  return idx >= 0 ? String(q.choices[idx] || "").trim() : "";
}

function hasPassageSupportForChoice(passage: string, choice: string): boolean {
  const normalizedPassage = String(passage || "").toLowerCase();
  const choiceTokens = String(choice || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2)
    .slice(0, 4);
  if (!normalizedPassage || choiceTokens.length < 2) return false;
  return normalizedPassage.includes(choiceTokens.join(" "));
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
  const normalizedPassage = String(passage || "").toLowerCase();
  const words = String(choice || "")
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[^a-z0-9]/g, ""))
    .filter((w) => w.length > 3);
  if (!normalizedPassage || words.length === 0) return 0;
  const uniqueWords = Array.from(new Set(words));
  return uniqueWords.reduce((score, word) => score + (normalizedPassage.includes(word) ? 1 : 0), 0);
}

function isValidQuestion(q: Question, passage: PassageContent | string): boolean {
  if (!q || q.type === "part_a_b") return true;
  if (!Array.isArray(q.choices) || q.choices.length !== 4) return false;
  if (typeof q.correct_answer !== "string" || !["A", "B", "C", "D"].includes(q.correct_answer)) return false;
  const correctChoice = getCorrectChoice(q);
  if (!correctChoice) return false;
  const passageText = getPassageText(passage);

  if (hasLooseSupport(passageText, correctChoice)) return true;
  if (hasPassageSupportForChoice(passageText, correctChoice)) return true;

  return false;
}

function validateMCQuestion(q: Question, passage: PassageContent | string): Question {
  if (q.type && q.type !== "mc") {
    return {
      ...q,
      choices: normalizeChoices(q.choices),
    };
  }

  const choices = normalizeChoices(q.choices);
  const { letter: originalLetter } = getQuestionCorrectPair({ ...q, choices });
  const startingLetter = originalLetter || "A";
  const correctText = String(choices[LETTERS.indexOf(startingLetter)] || "").trim();

  const passageText = String(getPassageText(passage) || "");
  const isSupported = hasLooseSupport(passageText, correctText) || hasPassageSupportForChoice(passageText, correctText);
  let resolvedCorrectLetter: ChoiceLetter = startingLetter;

  if (!isSupported) {
    const replacementIndex = choices.findIndex((choice) =>
      hasLooseSupport(passageText, choice) || hasPassageSupportForChoice(passageText, choice)
    );
    if (replacementIndex >= 0) {
      resolvedCorrectLetter = LETTERS[replacementIndex];
    } else {
      const strongestIndex = choices
        .map((choice, index) => ({ index, score: scoreChoiceSupport(passageText, choice) }))
        .sort((a, b) => b.score - a.score)[0];
      resolvedCorrectLetter = LETTERS[strongestIndex?.index ?? 0];
    }
  }

  const finalChoice = String(choices[LETTERS.indexOf(resolvedCorrectLetter)] || "").trim();
  const evidenceSnippet = extractEvidenceSnippet(
    passageText,
    [
      ...String(q.question || "").split(/\s+/).slice(0, 5),
      ...finalChoice.split(/\s+/).slice(0, 6),
    ],
  );
  const syncedExplanation = finalChoice
    ? evidenceSnippet
      ? `The correct answer is ${resolvedCorrectLetter} because the passage states: "${evidenceSnippet}." This supports "${finalChoice}".`
      : `The correct answer is ${resolvedCorrectLetter} because "${finalChoice}" best matches the passage details and question focus.`
    : String(q.explanation || "").trim();

  return {
    ...q,
    choices,
    correct_answer: resolvedCorrectLetter,
    explanation: syncedExplanation,
  };
}

function normalizeMultiSelectAnswer(value: unknown): [ChoiceLetter, ChoiceLetter] {
  const raw = Array.isArray(value) ? value : [];
  const normalized = raw
    .map((entry) => normalizeAnswer(entry))
    .filter((entry, index, list) => list.indexOf(entry) === index);

  if (normalized.length >= 2) return [normalized[0], normalized[1]];
  if (normalized.length === 1) return [normalized[0], normalized[0] === "A" ? "C" : "A"];
  return ["A", "C"];
}

function normalizePartABAnswer(value: unknown): PartABAnswer {
  const entry = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    partA: normalizeAnswer(entry.partA || "A"),
    partB: normalizeAnswer(entry.partB || "B"),
  };
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
    return ensurePassageLength(clampPassageWords(buildSubjectPassage(subject, level), min, max), min, max, subject, mode, grade, level, false);
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

function extractEvidenceSnippet(passage: string, keywords: string[]): string | null {
  const sentences = String(passage || "")
    .split(/[.?!]/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);

  for (const sentence of sentences) {
    for (const keyword of keywords) {
      if (sentence.toLowerCase().includes(keyword.toLowerCase())) {
        return sentence.trim();
      }
    }
  }

  return null;
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

function buildSubjectDistractors(q: Question, passage: string, subject: CanonicalSubject): string {
  const { letter: correctLetter, choice: correctChoice } = getQuestionCorrectPair(q);
  if (!correctLetter) return "";
  const normalizedChoices = normalizeChoices(q.choices);
  const hasPassage = String(passage || "").trim().length > 0;
  const passageDistractors = hasPassage ? buildBetterDistractors(String(passage || ""), correctChoice) : [];
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
  const shouldUsePassage = mode === "Cross-Curricular" || subject === "Reading";
  const passageText = shouldUsePassage ? getPassageText(passage) : "";
  const keywords = questionText.split(/\s+/).slice(0, 5);
  const { letter: correctLetter, choice: correctChoice } = getQuestionCorrectPair(q);
  const snippet = extractEvidenceSnippet(passageText, [...keywords, ...String(correctChoice || "").split(/\s+/).slice(0, 5)]);
  const distractorAnalysis = buildSubjectDistractors(q, passageText, subject);
  const thinkingType = detectThinkingType(questionText);
  const hasEvidence = Boolean(snippet);
  const noEvidenceMessage = "This answer requires combining multiple details from the passage. Re-read carefully to identify supporting evidence.";
  let explanation = subject === "Math"
    ? "Start by identifying what the problem is asking. Then solve step by step by choosing the correct operation, calculating carefully, and checking whether the result is reasonable."
    : subject === "Science"
    ? hasEvidence
      ? `This question requires understanding cause and effect in a system. The data or details show a relationship that leads to the best-supported conclusion, especially in: "${snippet}."`
      : noEvidenceMessage
    : subject === "Social Studies"
    ? hasEvidence
      ? `This question asks you to reason through historical context and decisions. Use the situation described in the source to identify the most supported outcome, such as: "${snippet}."`
      : noEvidenceMessage
    : `
The correct answer is supported by the passage. For example, the text states:
"${snippet}."

A strong reader uses this evidence to connect directly to the question. This detail helps confirm why the correct answer is the best choice.
`.trim();

  if ((subject === "Reading" || shouldUsePassage) && !hasEvidence) {
    explanation = noEvidenceMessage;
  }

  if (thinkingType === "inference") {
    explanation = `${explanation}\n\nFor inference questions, combine clues across the passage instead of searching for one exact phrase.`;
  } else if (thinkingType === "evidence") {
    explanation = `${explanation}\n\nFor evidence questions, choose the answer you can point to directly in the text.`;
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
      : buildReadingChoices(safePassage, leveledStem, level);
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
    const partA = buildPartA(leveledStem, safePassage);
    const partAAnswer = resolvePartABAnswer(partA, correctAnswer);
    const partAChoiceText = partA.choices[LETTERS.indexOf(partAAnswer)] || correctAnswer;
    const partB = buildPartB(safePassage, partAChoiceText);
    const partBAnswer = resolvePartABAnswer(partB, partAChoiceText);
    const question: Question = {
      type,
      question: leveledStem,
      choices: safeChoices,
      correct_answer: resolvedCorrectAnswer,
      partA: undefined,
      partB: undefined,
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

function buildReadingChoices(
  passage: PassageContent | string,
  questionText: string,
  level: Level = "On Level",
): [string, string, string, string] {
  void level;
  const text = getPassageText(passage).trim();
  const cleanSentence = (value: string): string =>
    String(value || "")
      .replace(/\s+/g, " ")
      .replace(/^[^a-zA-Z0-9]+/, "")
      .trim()
      .replace(/\.$/, "");
  const sentences = text
    .split(/[.!?]+/)
    .map((s) => cleanSentence(s))
    .filter((s) => s.split(/\s+/).length >= 8);
  const keywords = passageKeywords(text).filter((token) => token.length >= 4);
  const questionTokens = String(questionText || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 4);
  const baseSentence = (sentences.length
    ? sentences
      .slice()
      .sort((a, b) => {
        const aLower = a.toLowerCase();
        const bLower = b.toLowerCase();
        const score = (candidate: string) =>
          questionTokens.filter((token) => candidate.includes(token)).length +
          keywords.slice(0, 8).filter((token) => candidate.includes(token)).length;
        return score(bLower) - score(aLower);
      })[0]
    : cleanSentence(text)) || "Community members changed decisions after events in the town affected daily routines";
  const baseWords = baseSentence.split(/\s+/).filter(Boolean);
  const subject = baseWords.slice(0, 3).join(" ") || "Community leaders";
  const action = baseWords.slice(3, 8).join(" ") || "reviewed records and changed plans";
  const outcome = baseWords.slice(8, 15).join(" ") || "after new results changed local priorities";

  const correct = `${subject} ${action} ${outcome}`.replace(/\s+/g, " ").trim();
  const distractors = buildStudentMistakeDistractors(text, correct, questionText);
  const choices = [correct, ...distractors];
  const finalChoices = shuffleArray(choices.map((choice) => String(choice).trim()).filter(Boolean));

  while (finalChoices.length < 4) {
    finalChoices.push(`Option ${finalChoices.length + 1}`);
  }

  const correctIndex = finalChoices.findIndex((c) => String(c) === String(correct));
  if (correctIndex === -1) {
    finalChoices[0] = correct;
  }

  return normalizeChoices(finalChoices as [string, string, string, string]);
}

function buildPartA(question: string, passage: PassageContent | string): PartBlock {
  const normalizedQuestion = String(question || "").trim();
  const topic = normalizedQuestion
    .replace(/^part\s*a:\s*/i, "")
    .replace(/\?+$/g, "")
    .replace(/^(what|which|why|how)\s+/i, "")
    .split(/\s+/)
    .slice(0, 8)
    .join(" ")
    .trim();
  const inferenceStem = topic
    ? `What can the reader conclude about ${topic}?`
    : "What can the reader conclude based on details in the passage?";
  return {
    question: `Part A: ${/what can the reader conclude|which idea is best supported|what is most likely|which statement best explains/i.test(normalizedQuestion) ? normalizedQuestion : inferenceStem}`,
    choices: buildReadingChoices(passage, question),
  };
}

function buildPartB(passage: PassageContent | string, correctAnswer: string): PartBlock {
  const text = getPassageText(passage);
  const answerTokens = new Set(
    String(correctAnswer || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((token) => token.length > 4),
  );
  const sentences = text
    .split(/[.!?]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 25);

  const scored = sentences.map((sentence) => {
    const words = sentence.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
    const overlap = words.reduce((score, word) => score + (answerTokens.has(word) ? 1 : 0), 0);
    return { sentence, overlap };
  }).sort((a, b) => b.overlap - a.overlap || b.sentence.length - a.sentence.length);

  const best = scored[0];
  const distractors = scored.slice(1).filter((entry) => entry.overlap < (best?.overlap ?? 0));
  const selectedEntries = [best, ...distractors.slice(0, 3)].filter((entry): entry is { sentence: string; overlap: number } => Boolean(entry));
  const selected = selectedEntries.map((entry) => entry.sentence);
  const choices = selected.slice(0, 4);
  while (choices.length < 4) {
    choices.push(selected[0] || sentences[0] || text.trim() || "The passage provides evidence for the answer.");
  }

  return {
    question: "Part B: Which sentence from the passage best supports the answer to Part A?",
    choices: normalizeChoices(choices as [string, string, string, string]),
  };
}

function resolvePartABAnswer(
  part: PartBlock,
  hint = "",
): ChoiceLetter {
  const normalizedHintWords = String(hint || "")
    .toLowerCase()
    .split(/\W+/)
    .filter((word) => word.length > 3);
  if (!normalizedHintWords.length) return "A";
  let bestIdx = 0;
  let bestScore = -1;
  let secondBestScore = -1;
  for (let i = 0; i < part.choices.length; i++) {
    const choiceText = String(part.choices[i] || "").toLowerCase();
    const score = normalizedHintWords.reduce((total, word) => total + (choiceText.includes(word) ? 1 : 0), 0);
    if (score > bestScore) {
      secondBestScore = bestScore;
      bestScore = score;
      bestIdx = i;
    } else if (score === bestScore) {
      const currentLen = String(part.choices[bestIdx] || "").length;
      const candidateLen = String(part.choices[i] || "").length;
      if (candidateLen > currentLen) {
        bestIdx = i;
      }
    } else if (score > secondBestScore) {
      secondBestScore = score;
    }
  }
  if (bestScore <= 0 || bestScore === secondBestScore) return "A";
  return LETTERS[bestIdx] || "A";
}

function isValidPartAB(q: Question, passage: PassageContent | string): boolean {
  if (!q || q.type !== "part_a_b" || !q.partA || !q.partB) return false;
  const partAStem = String(q.partA.question || "").toLowerCase();
  const partBStem = String(q.partB.question || "").toLowerCase();
  const allowedPartAStem = /(what can the reader conclude|which idea is best supported|what is most likely|which statement best explains)/i
    .test(partAStem);
  const disallowedPartA = /(^|\s)why did .+\?|definition|means|vocabulary|according to the passage, what is/i.test(partAStem);
  if (!allowedPartAStem || disallowedPartA) return false;

  if (!/which (sentence|detail) from the passage best supports the answer to part a/i.test(partBStem)) return false;
  if (!Array.isArray(q.partB.choices) || q.partB.choices.length !== 4) return false;
  if (!Array.isArray(q.partA.choices) || q.partA.choices.length !== 4) return false;

  const passageText = getPassageText(passage).toLowerCase();
  const passageTokens = new Set(
    passageText.replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((token) => token.length > 3),
  );
  const evidenceScores = q.partB.choices.map((choice) => {
    const tokens = String(choice || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
    return tokens.reduce((score, token) => score + (passageTokens.has(token) ? 1 : 0), 0);
  });
  if (evidenceScores.some((score) => score < 3)) return false;

  const answer = normalizePartABAnswer(q.correct_answer);
  const partAIndex = LETTERS.indexOf(answer.partA);
  const partBIndex = LETTERS.indexOf(answer.partB);
  if (partAIndex < 0 || partBIndex < 0) return false;

  const selectedPartAChoice = String(q.partA.choices[partAIndex] || "").toLowerCase();
  const selectedPartBChoice = String(q.partB.choices[partBIndex] || "").toLowerCase();
  const selectedTokens = new Set(selectedPartAChoice.replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((token) => token.length > 3));
  const supportScores = q.partA.choices.map((choice) => {
    const choiceTokens = new Set(String(choice || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((token) => token.length > 3));
    let overlap = 0;
    for (const token of choiceTokens) {
      if (selectedPartBChoice.includes(token) && selectedTokens.has(token)) overlap++;
    }
    return overlap;
  });
  const selectedScore = supportScores[partAIndex] ?? 0;
  const competitorScore = Math.max(...supportScores.filter((_, idx) => idx !== partAIndex), 0);
  if (selectedScore < 2 || selectedScore <= competitorScore) return false;

  return true;
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
  if (q.type === "part_a_b") {
    return "First determine the best answer for Part A, then find the evidence that directly supports it for Part B.";
  }
  if (q.type === "mc") {
    return "What is the question really asking, and which answer choice is best supported by the passage or problem details?";
  }
  return "How should you think about this question? Focus on what the question is asking and compare each answer choice carefully before selecting the best answer.";
}

function resolveCorrectChoiceText(q: Question): string {
  const normalized = normalizeAnswerKeyEntry(q.correct_answer);
  const singleLetter = normalizeAnswer(normalized);
  const letterIndex = LETTERS.indexOf(singleLetter);
  if (q.type === "part_a_b") {
    const partAB = normalizePartABAnswer(q.correct_answer);
    const partAText = q.partA?.choices?.[LETTERS.indexOf(partAB.partA)] || "";
    const partBText = q.partB?.choices?.[LETTERS.indexOf(partAB.partB)] || "";
    return `Part A ${partAB.partA}: ${partAText}; Part B ${partAB.partB}: ${partBText}`.trim();
  }
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

function buildAlignedExplanation(q: Question, passage: PassageContent | string = ""): { why: string; mistake: string; tip: string } {
  const passageText = getPassageText(passage);
  const rawSnippet = getRelevantSnippet(
    passageText && passageText.length > 50
      ? passageText
      : (q.explanation || q.question),
    q.question,
  );
  const cleanedSnippet = String(rawSnippet || "")
    .replace(/\s+/g, " ")
    .replace(/^(This shows how evidence|These examples make it easier|Each detail builds)\b.*$/i, "")
    .trim();
  const backupSnippet = String(q.explanation || q.question)
    .split(/[.!?]+/)
    .map((sentence) => sentence.trim())
    .find((sentence) => sentence.split(/\s+/).filter(Boolean).length >= 8) || String(q.question || "");
  const snippet = cleanedSnippet.split(/\s+/).filter(Boolean).length >= 8
    ? cleanedSnippet
    : backupSnippet;
  const correctLabel = normalizeAnswerKeyEntry(q.correct_answer);
  const correctChoiceText = resolveCorrectChoiceText(q);
  const answerReference = correctChoiceText
    ? `${correctLabel} (${correctChoiceText})`
    : correctLabel;
  return {
    why:
      `For "${q.question}", the correct answer is ${answerReference} because "${snippet}" directly answers what the question is asking. ` +
      "Choices that are only partially correct or not supported by the passage should be eliminated.",
    mistake:
      `A common mistake on "${q.question}" is choosing an option that sounds related but does not match the evidence for ${answerReference}.`,
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
  const rigor = applyRigor(level);
  const crossPassage = buildSubjectPassage(subject, level);
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
      : rigor.questionDepth === "high"
      ? `${stem} Which passage detail best supports your analysis?`
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
    const partA = buildPartA(leveledStem, crossPassage);
    const partAAnswer = resolvePartABAnswer(partA, correctAnswer);
    const partAChoiceText = partA.choices[LETTERS.indexOf(partAAnswer)] || correctAnswer;
    const partB = buildPartB(crossPassage, partAChoiceText);
    const partBAnswer = resolvePartABAnswer(partB, partAChoiceText);

    const question: Question = {
      type,
      question: leveledStem,
      choices: choices as [string, string, string, string],
      correct_answer: resolvedCorrectAnswer,
      partA: undefined,
      partB: undefined,
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
  const crossPassage = buildSubjectPassage(crossSubject, "On Level");
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
    const type: QuestionType = i === 4 ? "scr" : "mc";
    const partA = buildPartA(stem, crossPassage);
    const partASeed = partA.choices[0] || "";
    const partB = buildPartB(crossPassage, partASeed);
    let choices = (crossChoiceBanks[crossSubject]?.[i] ||
      crossChoiceBanks[crossSubject]?.[0] ||
      crossChoiceBanks["Social Studies"][0]) as [string, string, string, string];
    choices = normalizeChoices(choices);
    const question: Question = {
      type,
      question: stem,
      choices,
      correct_answer: type === "scr"
        ? "A"
        : nextSingleAnswer(),
      partA: undefined,
      partB: undefined,
      explanation: "",
      sample_answer: type === "scr"
        ? "The author’s purpose is to inform readers about the topic using evidence and examples. Key details in the passage show how those examples support the central claim."
        : undefined,
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
    console.warn("All questions failed → fallback");
    return buildCrossFallback("Reading", "On Level");
  }

  const passageText = getPassageText(crossPassage).toLowerCase();

  questions.forEach((q) => {
    const hasConnection = q.choices.some((choice) =>
      passageText.includes(choice.split(" ")[0].toLowerCase())
    );

    if (!hasConnection) {
      q.choices = buildReadingChoices(crossPassage, q.question, "On Level");
    }
  });

  return questions;
}

function buildELARFallback(level: Level = "On Level"): { passage: string; questions: Question[] } {
  const crossSubject = randomChoice<CanonicalSubject>(["Science", "Social Studies", "Math"]);
  return {
    passage: buildSubjectPassage(crossSubject, level),
    questions: buildELARCrossQuestions(crossSubject),
  };
}

function buildMathFallback(level: Level = "On Level"): { passage: string; questions: Question[] } {
  return {
    passage: buildSubjectPassage("Math", level),
    questions: buildCrossFallback("Math", level),
  };
}

function buildScienceFallback(level: Level = "On Level"): { passage: string; questions: Question[] } {
  return {
    passage: buildSubjectPassage("Science", level),
    questions: buildCrossFallback("Science", level),
  };
}

function buildSSFallback(level: Level = "On Level"): { passage: string; questions: Question[] } {
  return {
    passage: buildSubjectPassage("Social Studies", level),
    questions: buildCrossFallback("Social Studies", level),
  };
}

function buildSubjectCrossContent(subject: CanonicalSubject, level: Level = "On Level"): { passage: string; questions: Question[] } {
  if (subject === "Math") return buildMathFallback(level);
  if (subject === "Science") return buildScienceFallback(level);
  if (subject === "Social Studies") return buildSSFallback(level);
  const readingFallback = buildELARFallback(level);
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
      return buildELARFallback(level).questions;
    }
    return buildSubjectCrossContent(effectiveSubject, level).questions;
  }

  const effectiveSkill: string = skill ?? "Main Idea";
  const skillText = (effectiveSkill ?? "").toLowerCase();
  const isTheme = skillText.includes("theme");
  const singleAnswerSequence = [...shuffledLetters(), ...shuffledLetters()];
  let singleAnswerIndex = 0;
  const nextSingleAnswer = (): ChoiceLetter => {
    const letter = singleAnswerSequence[singleAnswerIndex % singleAnswerSequence.length];
    singleAnswerIndex += 1;
    return letter;
  };
  const nextMultiAnswer = (): [ChoiceLetter, ChoiceLetter] => {
    const pair = shuffledLetters().slice(0, 2) as [ChoiceLetter, ChoiceLetter];
    return pair[0] === pair[1] ? [pair[0], pair[0] === "A" ? "C" : "A"] : pair;
  };

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

  const fallbackPartPassage = fallbackPassage(effectiveSubject, mode, 5, level);
  return stems.map((stem, i) => {
    const type: QuestionType = i === 3 ? "multi_select" : i === 4 ? "scr" : "mc";
    const baseChoices = normalizeChoices([
      "The plants closest to the lamp grew taller because they received more direct light.",
      "All plants grew at the same rate, so light intensity did not matter in this setup.",
      "Plants farther from the lamp appeared to grow faster because lower heat outweighed reduced light.",
      "Plant height changed randomly and was not related to the light conditions in the investigation.",
    ]);
    const partA = buildPartA(stem, fallbackPartPassage);
    const partASeed = partA.choices[0] || "";
    const partB = buildPartB(fallbackPartPassage, partASeed);
    const question: Question = {
      type,
      question: stem,
      choices: baseChoices,
      correct_answer: type === "multi_select"
        ? nextMultiAnswer()
        : nextSingleAnswer(),
      partA: undefined,
      partB: undefined,
      explanation: "",
      sample_answer: type === "scr"
        ? "The author develops the central idea by introducing a problem and supporting the solution with clear evidence. One detail explains the challenge, and another shows why the response is effective. These details justify the best interpretation."
        : undefined,
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
  const text = String(choice || "").trim();
  return !text;
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
  void level;
  void grade;
  const sanitized: Question[] = incoming.map((item, i) => {
    const q = item && typeof item === "object" ? item as Record<string, unknown> : {};
    if (!q.choices || !Array.isArray(q.choices) || q.choices.length === 0 || q.choices.every((choice) => !String(choice || "").trim())) {
      return buildSafeMC(String(q.question || ""), String(q.explanation || ""));
    }
    const expectedType = (q.type === "part_a_b" || q.type === "multi_select" || q.type === "part_a" || q.type === "part_b")
      ? q.type
      : "mc";
    const type: QuestionType = expectedType;
    const rawQuestion = String(q.question || "").trim();
    const questionText = type === "multi_select" && !/select\s+two\s+answers\./i.test(rawQuestion)
      ? `${rawQuestion.replace(/\s+$/g, "")} Select TWO answers.`
      : rawQuestion;

    let normalizedChoices = normalizeChoices(q.choices);
    const normalizedCorrectAnswer = type === "multi_select"
      ? normalizeMultiSelectAnswer(q.correct_answer || "")
      : type === "part_a_b"
      ? normalizePartABAnswer(q.correct_answer || "")
      : safeCorrectAnswer(q.correct_answer);
    const correctChoiceIndex = type === "mc" ? LETTERS.indexOf(normalizedCorrectAnswer as AnswerLetter) : -1;
    const correctChoiceText = normalizedChoices[correctChoiceIndex >= 0 ? correctChoiceIndex : 0];
    if (type === "mc" && normalizedChoices.some(isWeakDistractor)) {
      const fixedDistractors = fixDistractors(subject, questionText, correctChoiceText, passage);
      if (fixedDistractors.length > 0) {
        normalizedChoices = normalizeChoices([correctChoiceText, ...fixedDistractors.slice(0, 3)]);
      }
    }

    const isReadingMainIdea = subject === "Reading" && isMainIdeaSkill(skill);
    let normalizedQuestionText = questionText;
    if (isReadingMainIdea && !isAllowedMainIdeaStem(normalizedQuestionText)) {
      normalizedQuestionText = i % 2 === 0
        ? "What is the main idea of the passage?"
        : "Which statement best describes the main idea?";
    }

    const base: Question = {
      type,
      question: normalizedQuestionText,
      choices: normalizedChoices,
      correct_answer: normalizedCorrectAnswer,
      partA: type === "part_a_b"
        ? {
          question: String((q.partA as Record<string, unknown> | undefined)?.question || "").trim() || "Part A: What is the best answer?",
          choices: normalizeChoices((q.partA as Record<string, unknown> | undefined)?.choices || q.choices || []),
        }
        : undefined,
      partB: type === "part_a_b"
        ? {
          question: String((q.partB as Record<string, unknown> | undefined)?.question || "").trim() || "Part B: Which evidence best supports Part A?",
          choices: normalizeChoices((q.partB as Record<string, unknown> | undefined)?.choices || q.choices || []),
        }
        : undefined,
      explanation: String(q.explanation || "").trim(),
      paired_with: typeof q.paired_with === "number" ? q.paired_with : undefined,
      sample_answer: String(q.sample_answer || "").trim(),
      part_b_question: type === "part_a" || type === "part_b"
        ? String(q.part_b_question || "").trim()
        : undefined,
      part_b_choices: type === "part_a" || type === "part_b"
        ? normalizeChoices(q.part_b_choices || [])
        : undefined,
      part_b_correct_answer: type === "part_a" || type === "part_b"
        ? normalizeAnswer(q.part_b_correct_answer || "")
        : undefined,
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

  const passageText = getPassageText(passage);
  const validatedQuestions = questions.map((q) => validateMCQuestion(q, passageText));
  const clean = validatedQuestions.filter((q) => isValidQuestion(q, passageText));
  if (clean.length < 3) {
    console.log("⚠️ Too few valid questions, retrying...");
    return [];
  }
  questions = clean;
  console.log("🔥 VALIDATION COMPLETE — CLEAN QUESTIONS:", questions.length);
  const alignedSet = questions.map((question) => {
    if (question.type === "part_a_b" && !isValidPartAB(question, passage)) {
      console.warn("⚠️ Invalid Part A/B — keeping original instead of fallback");
      return question;
    }
    return question;
  });

  if (mode === "Cross-Curricular") {
    return alignedSet.filter((question) => {
      if (!Array.isArray(question.choices) || question.choices.length !== 4) return false;
      if (typeof question.correct_answer !== "string") return false;
      if (!["A", "B", "C", "D"].includes(question.correct_answer)) return false;
      if (!String(question.explanation || "").trim()) return false;
      return true;
    });
  }

  return alignedSet;
}

function validateSkillAlignment(skill: string, questions: Question[]): boolean {
  if (!skill || !Array.isArray(questions) || questions.length === 0) return false;
  const tokens = String(skill)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 3);
  return questions.every((q) => {
    const text = `${q?.question || ""} ${(q?.choices || []).join(" ")}`.toLowerCase();
    const overlap = tokens.filter((token) => text.includes(token)).length;
    if (tokens.length <= 2) return overlap >= 1;
    return overlap >= 2;
  });
}

function getPassageText(passage: PassageContent | string): string {
  if (typeof passage === "string") return passage;
  return `${passage?.text_1 || ""} ${passage?.text_2 || ""}`.trim();
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

function hasInvalidPartABSet(questions: Question[], passage: PassageContent | string): boolean {
  return Array.isArray(questions) && questions.some((question) => question.type === "part_a_b" && !isValidPartAB(question, passage));
}

function validateDistractorQuality(questions: Question[], passage: PassageContent | string): boolean {
  const text = getPassageText(passage);
  const keys = passageKeywords(text).slice(0, 6);
  const weakPatterns = /(unrelated|not supported|random|impossible|always|never|all of the above|none of the above)/i;

  const choiceSets: string[][] = questions.flatMap((q) => {
    if (q.type === "part_a_b") {
      return [q.partA?.choices || q.choices, q.partB?.choices || q.choices];
    }
    return [q.choices];
  });

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

function validateCrossPassage(passage: string): boolean {
  const text = passage.toLowerCase();
  return !text.includes("students read an informational text");
}

function normalizeAnswerKeyEntry(value: unknown): string {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const partAB = normalizePartABAnswer(value);
    return `Part A: ${partAB.partA}, Part B: ${partAB.partB}`;
  }
  if (Array.isArray(value)) {
    const letters = value.map((entry) => normalizeAnswer(entry));
    return letters.join(", ");
  }
  return normalizeAnswer(value);
}

function ensureQuestionId(question: Question, index: number, mode: "practice" | "cross"): string {
  return `${mode}_q${index + 1}`;
}

function extractKeyTopic(passage: string): string {
  const keys = passageKeywords(String(passage || ""));
  return keys[0] || "the passage topic";
}

function buildPracticeTutorFallback(subject: CanonicalSubject, question: Question): TutorExplanation {
  const promptFocus = String(question.question || "").trim();
  const aligned = buildAlignedExplanation(question);
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
  const aligned = buildAlignedExplanation(question, passage);
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
  const aligned = buildAlignedExplanation(question);
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
  const aligned = buildAlignedExplanation(question, passage);
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
  void passageText;
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
      const baseExplanation = String(q.explanation || "").trim() ||
        (correctAnswer ? `The validated correct answer is ${correctAnswer}.` : "Use the validated question answer and supporting evidence.");
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
  return questions.slice(0, 5).map((q, index) => {
    try {
      const support = buildSupportContent(subject, q, index, level, mode === "cross" ? "Cross-Curricular" : "Practice", passageText, "Answer Key");
      const { letter } = getQuestionCorrectPair(q);
      return {
        question_id: ensureQuestionId(q, index, mode),
        correct_answer: letter || "",
        explanation: String(q.explanation || "").trim() || support.explanation || "",
        common_mistake: support.common_mistake || "",
        parent_tip: support.parent_tip
          ? (String(support.parent_tip).startsWith("👨‍👩‍👧 Parent Tip")
            ? String(support.parent_tip)
            : `👨‍👩‍👧 Parent Tip:\n${support.parent_tip}`)
          : "",
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
  const defaultQuestions = mode === "cross" ? buildCrossFallback(subject) : buildPracticeFallback("Main Idea", subject);
  const baseQuestions = sourceQuestions.slice(0, 5);
  while (baseQuestions.length < 5) baseQuestions.push(defaultQuestions[baseQuestions.length]);
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
  const defaultQuestions = mode === "cross" ? buildCrossFallback(subject) : buildPracticeFallback("Main Idea", subject);
  const baseQuestions = sourceQuestions.slice(0, 5);
  while (baseQuestions.length < 5) baseQuestions.push(defaultQuestions[baseQuestions.length]);
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

function safeFallback(reason: string): PipelineResult {
  console.warn("Pipeline fallback triggered:", reason);
  const level: Level = "On Level";
  const passage = fallbackPassageContent("Reading", "Practice", 5, READING_SKILL_DEFAULT, level);
  return {
    questions: buildPracticeFallback(READING_SKILL_DEFAULT, "Reading", level, passage),
    tutor: { practice: [], cross: [] },
    answerKey: { practice: [], cross: [] },
  };
}

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

function guaranteeOutput(result: PipelineResult): PipelineResult {
  if (!result.questions || result.questions.length === 0) {
    console.warn("Empty result → fallback");
    return safeFallback("pipeline_guard");
  }

  return result;
}

function enrichOutput(result: PipelineResult): PipelineResult {
  return {
    questions: result.questions,
    tutor: result.tutor || { practice: [], cross: [] },
    answerKey: result.answerKey || { practice: [], cross: [] },
  };
}

async function runPipeline(input: PipelineInput): Promise<PipelineResult> {
  const generate = () => generateQuestions(input);
  let result = generate();
  if (!result.questions?.length) {
    console.warn("No questions returned, retrying once...");
    result = generate(); // retry once
  }
  result = normalizeOutput(result);
  result = guaranteeOutput(result);
  result = enrichOutput(result);
  return result;
}

function buildFallbackResponse(
  grade: number,
  subject: CanonicalSubject,
  skill: string,
  level: Level = "On Level",
): WorkerAttempt {
  const effectiveSubject = subject;
  const crossContent = effectiveSubject === "Reading"
    ? buildELARFallback(level)
    : buildSubjectCrossContent(effectiveSubject, level);
  console.log("🧠 CROSS SUBJECT:", effectiveSubject);
  const practicePassage = fallbackPassageContent(effectiveSubject, "Practice", grade, skill, level);
  const practiceQuestions = buildPracticeFallback(skill, effectiveSubject, level, practicePassage);
  const crossTutor = sanitizeTutorExplanations([], crossContent.questions, effectiveSubject, "cross", crossContent.passage);
  const practiceTutor = sanitizeTutorExplanations([], practiceQuestions, effectiveSubject, "practice");
  return {
    passage: subject === "Reading" ? practicePassage : "",
    practice: { questions: practiceQuestions },
    cross: { passage: crossContent.passage, questions: crossContent.questions },
    tutor: { practice: practiceTutor, cross: crossTutor },
    answerKey: {
      practice: sanitizeAnswerKey([], practiceQuestions, effectiveSubject, practiceTutor, "practice"),
      cross: sanitizeAnswerKey([], crossContent.questions, effectiveSubject, crossTutor, "cross", crossContent.passage),
    },
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    });
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
    new Response(JSON.stringify(payload), {
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
    const gradeSafeCrossPassage = violatesGradeLevel(crossPassage, grade)
      ? getPassageText(fallbackPassageContent(subject, "Cross-Curricular", grade, skill, level))
      : enforceSentenceLength(crossPassage, constraints.maxWordsPerSentence);
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
    const practiceQuestions = data?.practice?.questions || [];
    const cross = await generateCross({
      grade,
      subject,
      skill,
      level,
      practiceQuestions,
    });
    cross.questions = cross.questions.map((q) => validateMCQuestion(q, cross.passage));
    return jsonResponse({
      teks: teksCode,
      skill,
      grade,
      ...(subject === "Reading"
        ? {
          passage: ensurePassageLength(
            getPassageText(data.passage || ""),
            readingPracticeWordRange(level).min,
            readingPracticeWordRange(level).max,
            subject,
            contentMode,
            grade,
            level,
          ),
        }
        : {}),
      practice: {
        questions: practiceQuestions,
      },
      cross,
      tutor: {
        practice: sanitizeTutorExplanations([], practiceQuestions, subject, "practice"),
        cross: sanitizeTutorExplanations([], cross.questions, subject, "cross", cross.passage),
      },
      answerKey: {
        practice: sanitizeAnswerKey([], practiceQuestions, subject, sanitizeTutorExplanations([], practiceQuestions, subject, "practice"), "practice"),
        cross: sanitizeAnswerKey(
          [],
          cross.questions,
          subject,
          sanitizeTutorExplanations([], cross.questions, subject, "cross", cross.passage),
          "cross",
          cross.passage,
        ),
      },
    });
  };
  const returnEnrichment = (data: EnrichmentResponse) =>
    {
      const practiceQuestions = (data as Partial<WorkerAttempt>)?.practice?.questions || [];
      const crossPassage = String(data?.cross?.passage || "");
      const crossQuestions = (data?.cross?.questions || []).map((q) => validateMCQuestion(q, crossPassage));
      const safeCross = crossQuestions.length ? { passage: crossPassage, questions: crossQuestions } : { passage: "", questions: [] };
      const safeTutor = data?.tutor?.practice?.length === 5
        ? { practice: data.tutor.practice, cross: data?.tutor?.cross || [] }
        : buildTutorFromPractice(practiceQuestions);
      const safeAnswerKey = data?.answerKey?.practice?.length === 5
        ? { practice: data.answerKey.practice, cross: data?.answerKey?.cross || [] }
        : buildAnswerKeyFromPractice(practiceQuestions);
      assertSupportIntegrity({
        practice: { questions: [] },
        cross: { questions: safeCross.questions },
        tutor: safeTutor,
        answerKey: safeAnswerKey,
      });
      return jsonResponse({
        teks: teksCode,
        skill,
        grade,
        practice: {
          questions: [],
        },
        cross: safeCross,
        tutor: safeTutor,
        answerKey: safeAnswerKey,
      });
    };

  const safeFallback = (reason: string, error?: string) => {
    console.log("🚨 FALLBACK TRIGGERED:", reason);
    if (error) console.log("🚨 FALLBACK ERROR:", error);
    const payload = buildFallbackResponse(grade, effectiveSubject, effectiveSkill, level);
    if (effectiveMode === "enrichment") {
      return returnEnrichment(payload);
    }
    return returnCore(payload);
  };

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
          ).map((q) => validateMCQuestion(q, crossContent.passage)),
        },
      });
    }

    if (effectiveMode === "support") {
      const core = buildFallbackResponse(grade, effectiveSubject, effectiveSkill, level);
      const practiceQuestions = core.practice?.questions || [];
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
        getPassageText(core.passage || ""),
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
      const tutor = {
        practice: generateTutor(practiceQuestionSet, subject, "practice", level, getPassageText(core.passage || "")),
        cross: generateTutor(crossQuestionSet, subject, "cross", level, crossPassage),
      };
      const answerKey = {
        practice: generateAnswerKey(practiceQuestionSet, subject, "practice", level, getPassageText(core.passage || "")),
        cross: generateAnswerKey(crossQuestionSet, subject, "cross", level, crossPassage),
      };

      return jsonResponse({
        teks: teksCode,
        skill,
        grade,
        tutor,
        answerKey,
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
    const MAX_ATTEMPTS = 2;
    const start = Date.now();
    const MAX_TIMEOUT_MS = 45000;
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
        console.warn("⚠️ FALLBACK TRIGGERED: exceeded max time");
        break;
      }
      if (attempts > 0 && Date.now() - start > 20000) {
        console.warn("⚠️ Skipping retry due to time limit");
        break;
      }
      attempts++;
      try {
        if (effectiveMode === "core") {
          console.time("OPENAI_CALL");
          const aiStartTime = Date.now();
          const aiRes = await fetch("https://api.openai.com/v1/responses", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${Deno.env.get("OPENAI_API_KEY")}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: "gpt-4o-mini",
              input: buildGenerationPrompt({
                mode: "core",
                grade,
                subject,
                skill: effectiveSkill,
                level,
                teksCode,
              }),
              max_output_tokens: 1800,
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
            if (!rawPassage || rawWordCount < 20) {
              markRetry("no_questions_returned");
              continue;
            }
            if (!/[.!?]["')\]]?\s*$/.test(rawPassage)) {
              console.warn("⚠️ Truncated passage detected — retrying AI generation");
              markRetry("truncated_passage");
              continue;
            }
            if (isWeakPassage(rawPassage, grade)) {
              console.warn("⚠️ Weak generation — retrying AI generation");
              markRetry("weak_passage");
              continue;
            }
            if (violatesGradeLevel(rawPassage, grade)) {
              console.warn("⚠️ Passage too advanced — retrying AI generation for grade:", grade);
              markRetry("grade_violation");
              continue;
            }
            if (hasNarrativeReadingSignals(rawPassage)) {
              console.log("🧪 Narrative detected preview:", rawPassage.slice(0, 100));
              console.warn("⚠️ Narrative reading passage detected; regenerating once with informational lock.");
              markRetry("narrative_output_filtered");
              continue;
            }
            safePassage = enforceSentenceLength(rawPassage, constraints.maxWordsPerSentence);
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
          if (practiceQuestions.length < 5 && attempts === 1) {
            markRetry("bad_question");
            continue;
          }
          if (hasInvalidPartABSet(practiceQuestions, safePassage)) {
            markRetry("invalid_part_ab");
            continue;
          }
          if (subject === "Reading" && safePassage && practiceQuestions?.length) {
            const lightweightTutor = practiceQuestions.map((q, index) => ({
              question_id: ensureQuestionId(q, index, "practice"),
              question: q.question,
              explanation: "Review the passage and identify key supporting details.",
              common_mistake: "Choosing an answer without pointing to clear text evidence.",
            }));
            const lightweightAnswerKey = practiceQuestions.map((q, index) => ({
              question_id: ensureQuestionId(q, index, "practice"),
              correct_answer: normalizeAnswerKeyEntry(q.correct_answer),
              explanation: "Review the passage and identify key supporting details.",
              common_mistake: "Choosing an answer without pointing to clear text evidence.",
              parent_tip: "👨‍👩‍👧 Parent Tip:\nAsk your student to underline one detail that proves the answer choice.",
            }));
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
          if (pipelineQuestions.length < 5 && attempts === 1) {
            markRetry("bad_question");
            continue;
          }
          if (hasInvalidPartABSet(pipelineQuestions, safePassage)) {
            markRetry("invalid_part_ab");
            continue;
          }
          const outputValid = isValidOutput(pipelineQuestions, safePassage);
          if (!outputValid) {
            markRetry(!pipelineQuestions.length ? "bad_question" : "no_questions_returned");
            continue;
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
        const fallbackPracticePassage = fallbackPassageContent(effectiveSubject, "Practice", grade, effectiveSkill, level);
        const corePassageForChecks = corePassageFromRequest || getPassageText(fallbackPracticePassage);
        const normalizedPractice = sanitizeQuestions(
          priorPractice,
          effectiveSubject,
          "Practice",
          effectiveSkill,
          level,
          corePassageForChecks,
          grade,
        );
        if (normalizedPractice.length < 5 && attempts === 1) {
          markRetry("bad_question");
          continue;
        }
        if (hasInvalidPartABSet(normalizedPractice, corePassageForChecks)) {
          markRetry("invalid_part_ab");
          continue;
        }
        console.log("🧠 CROSS SUBJECT:", effectiveSubject);
        const crossContent = effectiveSubject === "Reading"
          ? buildELARFallback(level)
          : buildSubjectCrossContent(effectiveSubject, level);
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
          const gradeSafeCrossPassage = violatesGradeLevel(crossPassage, grade)
            ? (console.warn("⚠️ Passage too advanced for grade:", grade),
              getPassageText(fallbackPassageContent(effectiveSubject, "Cross-Curricular", grade, effectiveSkill, level)))
            : enforceSentenceLength(crossPassage, constraints.maxWordsPerSentence);
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
          if (pipelineCrossQuestions.length < 5 && attempts === 1) {
            markRetry("bad_question");
            continue;
          }
          if (hasInvalidPartABSet(pipelineCrossQuestions, gradeSafeCrossPassage)) {
            markRetry("invalid_part_ab");
            continue;
          }
          const payload = {
            cross: {
              passage: gradeSafeCrossPassage,
              questions: pipelineCrossQuestions.map((q) => validateMCQuestion(q, gradeSafeCrossPassage)),
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
        const enrichRes = await fetch("https://api.openai.com/v1/responses", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${Deno.env.get("OPENAI_API_KEY")}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            input: buildGenerationPrompt({
              mode: "enrichment",
              grade,
              subject: effectiveSubject,
              skill: effectiveSkill,
              practiceQuestions: normalizedPractice,
              level,
              crossPassage: baseCrossPassage,
              teksCode,
            }),
            max_output_tokens: 2200,
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
          console.warn("⚠️ Passage too advanced for grade:", grade);
          subjectCrossPassage = getPassageText(fallbackPassageContent(effectiveSubject, "Cross-Curricular", grade, effectiveSkill, level));
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
        if (crossQuestions.length < 5 && attempts === 1) {
          markRetry("bad_question");
          continue;
        }
        if (hasInvalidPartABSet(crossQuestions, subjectCrossPassage)) {
          markRetry("invalid_part_ab");
          continue;
        }
        if (!crossValid) {
          markRetry(crossQuestions.length < 3 ? "bad_question" : "no_questions_returned");
          continue;
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
          console.warn("⚠️ Practice tutor misaligned — using fallback");
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
            questions: crossQuestions.map((q) => validateMCQuestion(q, subjectCrossPassage)),
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
        markRetry("no_questions_returned");
        if (isTimedOut()) {
          console.warn("⚠️ FALLBACK TRIGGERED: exceeded max time");
        }
      }
    }

    if (bestAttempt) {
      returnType = "BEST_ATTEMPT";
      logReturnMetrics();
      return returnEnrichment(bestAttempt);
    }
    if (attempts >= 2) {
      console.log("🚨 FALLBACK TRIGGERED AFTER ATTEMPTS");
      returnType = "FALLBACK";
      logReturnMetrics();
      return safeFallback(retryFailureReason);
    }
    returnType = "NO_RESULT";
    logReturnMetrics();
    return jsonResponse({ error: "no_usable_output", retryFailureReason }, 500);
  } catch (err) {
    console.error("🔥 EDGE FUNCTION ERROR:", err);
    return safeFallback("no_questions_returned");
  }
});
