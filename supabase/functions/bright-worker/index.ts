import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type Level = "Below" | "On Level" | "Advanced";
type ChoiceLetter = "A" | "B" | "C" | "D";
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
  parent_tip: string;
  hint?: string;
  think?: string;
  step_by_step?: string;
};

type AnswerKeyEntry = {
  question_id: string;
  correct_answer: string;
  explanation: string;
  common_mistake: string;
  parent_tip: string;
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
type IncomingCrossQuestion = Partial<
  Pick<Question, "question" | "type" | "correct_answer" | "explanation" | "common_mistake" | "parent_tip">
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

function canonicalizeMode(mode: unknown): CanonicalMode | "support" | "cross" {
  const value = String(mode || "").toLowerCase();
  if (value === "cross" || value.includes("cross")) return "cross";
  if (value === "support") return "support";
  if (value.includes("tutor")) return "Tutor";
  if (value.includes("answer")) return "Answer Key";
  return "Practice";
}

function isCrossCurricularMode(mode: CanonicalMode | "cross"): boolean {
  return mode === "cross" || mode === "Cross-Curricular";
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

function toCanonicalMode(value: CanonicalMode | "support" | "cross"): CanonicalMode {
  if (value === "cross") return "Cross-Curricular";
  if (value === "support") return "Practice";
  return value;
}

function gradeWordRange(grade: number, subject: CanonicalSubject, mode: CanonicalMode): { min: number; max: number } {
  if (mode === "Cross-Curricular") return { min: 150, max: 250 };
  if (subject === "Math") return { min: 60, max: 130 };
  if (subject === "Reading") return { min: 150, max: 300 };
  if (subject === "Science") return { min: grade <= 4 ? 120 : 140, max: grade <= 4 ? 220 : 260 };
  return { min: grade <= 4 ? 120 : 140, max: grade <= 4 ? 220 : 260 };
}

function rigorInstruction(level: Level): string {
  if (level === "Below") return "Use simpler language while keeping the same thinking depth and rigor.";
  if (level === "Advanced") return "Increase reasoning depth, abstraction, and evidence precision.";
  return "Use grade-level language and reasoning rigor.";
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
    return "Use a shorter informational passage, explicit main ideas, direct identification questions, and clearly incorrect but plausible distractors.";
  }
  if (level === "On Level") {
    return "Use a moderate-length informational passage, require some inference, and include realistic distractors.";
  }
  if (level === "Advanced") {
    return "Use a complex informational passage with multiple ideas or shifts, deeper reasoning, and subtle distractors close to correct.";
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
- Passage genre lock: informational text ONLY. No stories, no characters, no narrative events, no character names.
- Generate exactly 5 STAAR-style reading questions tied directly to that passage.
- All 4 answer choices must explicitly reference passage details (events/actions/outcomes).
- Keep all 4 choices similar in structure and length to avoid obvious answer patterns.
- Never use: "best explains", "this shows", "the answer is supported", "it can be inferred".
- Correct answers must include a specific event plus cause/effect OR decision/result reasoning.
- Distractors must use one of: misinterpretation, partial-truth wrong conclusion, overgeneralization, or cause/effect confusion.
- If any choice feels generic or easy, rewrite it with more specific passage evidence.
- Difficulty behavior lock:
  - Below: shorter passage, explicit main idea, direct identification questions, clearly incorrect but plausible distractors.
  - On Level: moderate passage length, some inference required, realistic distractors.
  - Advanced: complex passage with multiple ideas/shifts, subtle distractors close to correct.
${mainIdeaStemRule}
- Rigor profile:
  - passage complexity: ${rigor.passage}
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
- Generate exactly 5 standalone STAAR-style ${subject} questions.
- Use multi-step reasoning where appropriate.
- Questions must be subject-driven and not ELAR-framed.
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
      "Reading uses ELAR-style focus: central idea, inference, evidence, structure.",
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

GRADE-LEVEL ADAPTATION
- Grades 3-4: clear inference, concrete reasoning, shorter responses, direct passage links.
- Grades 5-6: multi-step reasoning, combined details, moderate complexity.
- Grades 7-8: abstract thinking, subtle choice differences, multi-layer reasoning.

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

CORRECT ANSWER RULE
- The correct answer must use specific passage evidence.
- The correct answer must demonstrate the targeted skill correctly.
- The correct answer must include reasoning (cause/effect, inference, comparison, etc.).

SELF-CHECK (MANDATORY)
- Does the question require the intended TEKS skill?
- Would a student need to APPLY the skill, not define it?
- Are distractors based on realistic student mistakes?
- Is the answer supported by passage evidence?
- If not, revise before returning.

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
    "passage": "REQUIRED string (250–300 words)",
    "questions": [5 subject-aligned questions]
  },
  "tutor": {
    "practice": [5 entries],
    "cross": [5 entries]
  },
  "answerKey": {
    "practice": [5 entries],
    "cross": [5 entries]
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
- Questions MUST be based ONLY on this new passage.
- Do NOT reuse or paraphrase the original practice passage.
- If a question can be answered without reading the passage, rewrite it.
- Cross questions must be different from practice questions.
- ALL questions in BOTH practice and cross must assess the selected skill exactly: ${skill}.
- NO skill drift, NO mixed topics in stem/Part A/Part B, NO ELAR language in non-Reading.
- Cross questions MUST be subject-driven for ${subject}.
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
- Tutor entries (practice + cross) must include: question_id, question, explanation, common_mistake, parent_tip, hint, think, step_by_step.
- Answer key entries (practice + cross) must include: question_id, correct_answer, explanation, common_mistake, parent_tip.
- Cross tutor + answer key must reference cross passage evidence.
- JSON only.${passageDirective}`;
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
  const safePassage = fallbackPassage("Reading", "Practice", 5, "On Level");
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
  if (cleaned.includes("The report adds key evidence")) {
    console.log("⚠️ BAD PASSAGE DETECTED — USING FALLBACK");
    return fallbackPassage(subject, mode, grade, level);
  }
  const words = cleaned.split(" ").filter(Boolean);
  if (words.length >= min && words.length <= max) return cleaned;
  if (words.length > max) return words.slice(0, max).join(" ");
  if (words.length < min) {
    console.warn("Short passage — expanding instead of fallback");

    let expanded = cleaned;

    while (expanded.split(/\s+/).length < min) {
      expanded += " This shows how evidence, decisions, and outcomes are connected in real-world situations.";
    }

    return expanded.split(/\s+/).slice(0, max).join(" ");
  }
  // NEVER fallback here — just return cleaned
  return cleaned;
}

function isWeakPassage(passage: PassageContent | string): boolean {
  const text = getPassageText(passage).trim();
  return !text || text.split(/\s+/).filter(Boolean).length < 200;
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

function buildSupportContent(
  subject: CanonicalSubject,
  questionText: string,
  type: QuestionType,
  index: number,
  level: Level = "On Level",
  mode: CanonicalMode = "Practice",
  passage: PassageContent | string = "",
): { explanation: string; common_mistake: string; parent_tip: string; hint: string; think: string; step_by_step: string } {
  const usesVisual = /(table|diagram|model|map|chart)/i.test(questionText);
  const isReading = subject === "Reading";
  const isCross = mode === "Cross-Curricular";
  const shouldUsePassage = isCross || isReading;
  const passagePayload = passage && typeof passage === "object" ? passage as Record<string, string> : {};
  const passageText = shouldUsePassage
    ? (typeof passage === "string"
      ? passage
      : (passagePayload.text || passagePayload.text_1 || ""))
    : "";
  const passageSnippet = passageText
    ? passageText.split(".").slice(0, 2).join(".").trim()
    : "";
  const sourceRef = shouldUsePassage
    ? "the passage"
    : usesVisual
    ? "the visual and scenario details"
    : "the scenario details";
  const subjectConcept = subject === "Math"
    ? "the mathematical relationship in the problem"
    : subject === "Science"
    ? "the scientific cause-and-effect relationship"
    : subject === "Social Studies"
    ? "the historical or civic cause-and-effect relationship"
    : "the central idea and supporting evidence";

  let explanation;
  if (shouldUsePassage) {
    explanation = `The answer is correct because the passage shows that ${passageSnippet}.`;
  } else {
    explanation = "The answer is correct because it applies the concept accurately.";
  }

  const common_mistake = shouldUsePassage
    ? "A common mistake is choosing an answer that sounds correct but is not supported by the passage. Students must verify answers using evidence."
    : "Students may choose an answer that looks familiar but does not match the concept being tested.";

  const parent_tip = shouldUsePassage
    ? `Ask your child: "Where in the passage do you see this?" Have them point to a sentence like: "${passageSnippet}".`
    : "Ask your child to explain how they solved the problem step by step.";

  const hintVariants = [
    `Find the detail in ${usesVisual ? "the visual and scenario" : "the scenario"} that directly supports the concept.`,
    `Locate the key evidence first, then match it to the answer choice that best fits the concept.`,
    `Underline one clue from the prompt before choosing an answer.`,
    `Use the model/data to eliminate options that only partly fit the concept.`,
    `Focus on what changed in the scenario and which option explains that change best.`,
  ];

  const thinkVariants = [
    "Eliminate answers that are partly true but do not fully match the evidence.",
    "Check whether each option explains the concept, not just a related vocabulary word.",
    "Compare two close options and ask which one has direct evidence in the prompt.",
    "Look for cause-and-effect language to confirm the strongest answer.",
    "Test every option against the data/model before selecting.",
  ];

  const stepVariants = [
    "1) Identify the concept being tested. 2) Match evidence from the prompt. 3) Confirm why other options are weaker.",
    "1) Read the stem carefully. 2) Mark the strongest clue. 3) Choose the option with direct support.",
    "1) Use the scenario or visual first. 2) Eliminate partial truths. 3) Select the best-supported answer.",
    "1) Identify what must be explained. 2) Compare evidence across choices. 3) Verify the final choice.",
    "1) Decode the question focus. 2) Cross-check with data/model details. 3) Defend the answer with evidence.",
  ];

  const hint = shouldUsePassage
    ? "Go back to the passage and find the sentence that supports the answer."
    : `Think about the key concept needed to solve this problem using ${sourceRef}.`;
  const think = thinkVariants[index % thinkVariants.length];
  const step_by_step = mode === "Cross-Curricular"
    ? "1) Read the question. 2) Find the related part of the passage. 3) Match evidence to the best answer."
    : level === "Below"
    ? "1) Read the question. 2) Find one direct clue. 3) Do the needed step/calculation. 4) Check one wrong choice and explain why it is wrong."
    : level === "Advanced"
    ? "1) Identify the target concept. 2) Compare close options. 3) Eliminate misconception traps. 4) Justify why each wrong option fails."
    : stepVariants[index % stepVariants.length];

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
  const singleAnswerSequence = [...shuffledLetters(), ...shuffledLetters()];
  let singleAnswerIndex = 0;
  const nextSingleAnswer = (): ChoiceLetter => {
    const letter = singleAnswerSequence[singleAnswerIndex % singleAnswerSequence.length];
    singleAnswerIndex += 1;
    return letter;
  };
  const mathChoiceBanks: [string, string, string, string][] = [
    ["$135", "$81", "$45", "$162"],
    ["9 pages", "41 pages", "23 pages", "5 pages"],
    ["12 cups", "7 cups", "9 cups", "1 cup"],
    ["101 students", "84 students", "59 students", "125 students"],
    ["79 apples", "103 apples", "41 apples", "127 apples"],
  ];

  return stems.map((stem, i) => {
    const type: QuestionType = i === 1 ? "part_a_b" : "mc";
    let leveledStem = stem;
    if (level === "Below") {
      leveledStem = `${leveledStem.split("?")[0]}?`;
    } else if (level === "On Level") {
      if (subject !== "Reading") leveledStem = `${leveledStem} Use two steps to justify your choice.`;
    } else {
      leveledStem = subject === "Math"
        ? `${leveledStem} Include only relevant numbers and ignore extra information to solve.`
        : `${leveledStem} Compare at least two plausible interpretations before selecting the best answer.`;
    }
    const support = buildSupportContent(subject, stem, "mc", i, level, "Practice", passage || "");
    const partAChoices: [string, string, string, string] = subject === "Math"
      ? [
        "She needs 9 more pages because 14 + 18 + 9 = 41 and 50 - 41 = 9.",
        "She needs 23 more pages because 14 + 9 = 23.",
        "She needs 5 more pages because 50 - 45 = 5.",
        "She does not need more pages because she already read 50 pages.",
      ]
      : subject === "Science"
      ? [
        "The plant near the window received more light energy for photosynthesis.",
        "The plant near the window had less water, so it always grows taller.",
        "Plants in dark places grow fastest because they save energy.",
        "Light does not affect growth when plants are in the same room.",
      ]
      : subject === "Social Studies"
      ? [
        "Rivers gave settlers water and transportation routes for trade.",
        "Rivers were chosen mainly because they had fewer storms every year.",
        "Settlers avoided rivers because travel was harder there.",
        "Rivers were important only for recreation, not survival or trade.",
      ]
      : [
        "Editors compared interviews and survey results, then revised headlines so each claim matched the strongest source evidence.",
        "Editors kept the first draft headline even when later quotes changed what the article was really saying.",
        "Editors replaced survey evidence with a new fact about cafeteria prices that did not appear in their notes.",
        "Editors removed conflicting quotes and based the final conclusion on only one student comment.",
      ];

    const partBChoices: [string, string, string, string] = subject === "Math"
      ? [
        "The stem states she read 14 pages Friday, 18 Saturday, and 9 Sunday before comparing to 50.",
        "The stem states she read only Friday and Saturday pages and skipped Sunday.",
        "The stem states the goal changed from 50 pages to 41 pages.",
        "The stem states page totals should be multiplied instead of added.",
      ]
      : subject === "Science"
      ? [
        "The scenario compares a plant near a window with one in a dark corner.",
        "The scenario says both plants got the same amount of sunlight all day.",
        "The scenario says growth was measured only by leaf color, not height.",
        "The scenario says the dark-corner plant received stronger light.",
      ]
      : subject === "Social Studies"
      ? [
        "The question asks why settlers built near rivers, linking resources and movement.",
        "The question says rivers were not used for crops, trade, or travel.",
        "The question states towns were built far from water for safety.",
        "The question says rivers mattered only after railroads were built.",
      ]
      : [
        "The final publication says the team re-read original statements and adjusted wording so claims matched verified sources.",
        "The final publication says headline wording never affected meaning as long as articles stayed the same length.",
        "The final publication says interview quotes were optional because survey totals alone answer every question.",
        "The final publication says conflicting reports should be combined without checking the original statements.",
      ];
    const safePassage =
      passage && String(passage).trim().length > 0
        ? passage
        : fallbackPassage("Reading", "Practice", 5, "On Level");
    let choices = subject === "Math"
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
    if (subject === "Reading") {
      choices = buildReadingChoices(safePassage, leveledStem, level);
    }
    const safeChoices = normalizeChoices(choices as [string, string, string, string]);
    const safePartAChoices = normalizeChoices(partAChoices);
    const safePartBChoices = normalizeChoices(partBChoices);
    const question: Question = {
      type,
      question: leveledStem,
      choices: safeChoices,
      correct_answer: type === "part_a_b"
        ? { partA: nextSingleAnswer(), partB: nextSingleAnswer() }
        : nextSingleAnswer(),
      partA: type === "part_a_b"
        ? {
          question: `Part A: ${leveledStem}`,
          choices: safePartAChoices,
        }
        : undefined,
      partB: type === "part_a_b"
        ? {
          question: subject === "Math"
            ? "Part B: Which step shows the correct reasoning for your Part A answer?"
            : subject === "Science"
            ? "Part B: Which evidence from the scenario supports your Part A answer?"
            : subject === "Social Studies"
            ? "Part B: Which detail from the event timeline best supports your Part A answer?"
            : "Part B: Which sentence best supports your Part A answer?",
          choices: safePartBChoices,
        }
        : undefined,
      explanation: support.explanation,
      hint: support.hint,
      think: support.think,
      step_by_step: support.step_by_step,
      common_mistake: support.common_mistake,
      parent_tip: support.parent_tip,
    };
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
  const keywordA = keywords[0] || "community";
  const keywordB = keywords[1] || "results";
  const keywordC = keywords[2] || "decisions";

  const correct = `${subject} ${action} ${outcome}`.replace(/\s+/g, " ").trim();
  const candidateSet = buildDistractors(correct, sentences, [keywordA, keywordB, keywordC]);
  if (validateChoices(candidateSet, text)) return candidateSet;

  const fallbackSentences = sentences.length ? sentences : [baseSentence];
  const regenerated = buildDistractors(
    `${fallbackSentences[0] || baseSentence}`.replace(/\s+/g, " ").trim(),
    fallbackSentences,
    [keywordA, keywordB, keywordC],
  );

  return validateChoices(regenerated, text) ? regenerated : buildSSFallbackChoices();
}

function buildDistractors(
  correct: string,
  sentences: string[],
  keywords: string[],
): [string, string, string, string] {
  const clean = (value: string): string => String(value || "").replace(/\s+/g, " ").replace(/\.$/, "").trim();
  const splitWords = (value: string): string[] => clean(value).toLowerCase().split(/\s+/).filter(Boolean);
  const pickRandom = <T>(items: T[]): T => items[Math.floor(Math.random() * items.length)];

  const base = clean(correct);
  const sourceSentences = sentences.map((sentence) => clean(sentence)).filter((sentence) => sentence.split(/\s+/).length >= 8);
  const normalizedKeywords = keywords.map((token) => clean(token).toLowerCase()).filter((token) => token.length >= 4);
  const fallbackKeyword = normalizedKeywords[0] || "";

  const connectorParts = base.split(/\b(because|so|therefore|as a result|after|before|when|while|since)\b/i).map((part) => clean(part)).filter(Boolean);
  const connectors = ["because", "so", "therefore", "as a result", "after", "before", "when", "while", "since"];
  const tokenizedBase = splitWords(base);

  const hasPassageGrounding = (choice: string): boolean => {
    const text = choice.toLowerCase();
    const sentenceOverlap = sourceSentences.some((sentence) => {
      const tokens = splitWords(sentence).filter((token) => token.length >= 4);
      let overlap = 0;
      for (const token of tokens) {
        if (text.includes(token)) overlap += 1;
      }
      return overlap >= 2;
    });
    const keywordOverlap = normalizedKeywords.some((keyword) => text.includes(keyword));
    return sentenceOverlap || keywordOverlap || (!!fallbackKeyword && text.includes(fallbackKeyword));
  };

  const hasSubjectActionOutcome = (choice: string): boolean => {
    const words = splitWords(choice);
    const hasAction = /\b(is|are|was|were|led|caused|made|showed|changed|increased|decreased|supported|delayed|improved|reduced|allowed|prevented|helped|pushed|kept|moved|shifted|grew)\b/i.test(choice);
    const hasOutcomeSignal = /\b(so|therefore|result|outcome|eventually|later|then|which|leading|causing|meant|left|created)\b/i.test(choice) || words.length >= 12;
    return words.length >= 8 && hasAction && hasOutcomeSignal;
  };

  const sharesRepeatedStructure = (choice: string): boolean => {
    const tokens = splitWords(choice);
    if (tokens.length < 6 || tokenizedBase.length < 6) return false;
    const baseBigrams = new Set(tokenizedBase.slice(0, -1).map((w, i) => `${w} ${tokenizedBase[i + 1]}`));
    const choiceBigrams = tokens.slice(0, -1).map((w, i) => `${w} ${tokens[i + 1]}`);
    const overlap = choiceBigrams.filter((pair) => baseBigrams.has(pair)).length;
    const ratio = overlap / Math.max(1, choiceBigrams.length);
    return ratio >= 0.65;
  };

  const isWeakChoice = (choice: string): boolean => {
    return splitWords(choice).length < 8 || sharesRepeatedStructure(choice) || !hasSubjectActionOutcome(choice);
  };

  const sampleSentencePool = sourceSentences.length ? sourceSentences : [base];

  const buildCompetingClaims = (): [string, string, string, string] => {
    const baseSentence = pickRandom(sampleSentencePool);
    const altSentence = pickRandom(sampleSentencePool);
    const detailSentence = pickRandom(sampleSentencePool);

    const baseDetail = connectorParts[0] || baseSentence;
    const baseOutcome = connectorParts.slice(1).join(" ") || base;

    const detailTokens = splitWords(detailSentence);
    const emphasizedDetail = clean(detailTokens.slice(0, Math.min(10, detailTokens.length)).join(" ")) || baseDetail;

    const contextA = clean(baseSentence.split(/[,;:]/)[0]);
    const contextB = clean(altSentence.split(/[,;:]/)[0]);

    const missedOutcomeTemplates = [
      `${emphasizedDetail} and this explains part of the situation, yet the larger result in the passage comes from another step`,
      `${emphasizedDetail}, which is accurate, though it leaves out what ultimately changed in the passage`,
      `${emphasizedDetail}, but that point alone cannot account for the final development described by the author`,
    ];

    const reversedLogicTemplates = [
      `The later outcome happened first, and only afterward did ${clean(baseDetail).toLowerCase()} shape events`,
      `${clean(baseOutcome)} happened before ${clean(baseDetail).toLowerCase()}, so the sequence in the passage is reversed`,
      `${clean(baseDetail)} appears after the final result, which flips the cause-and-effect relationship described in the text`,
    ];

    const contextShiftTemplates = [
      `${contextA} supports a similar idea, but it applies to ${contextB.toLowerCase()} rather than the decision described in the question`,
      `${contextB} reflects the same theme, yet it is tied to a different part of the passage than the one being asked about`,
      `${contextA} fits the passage details, but it transfers that reasoning to ${contextB.toLowerCase()} instead of the original context`,
    ];

    const distractorB = clean(pickRandom(missedOutcomeTemplates));
    const distractorC = clean(pickRandom(reversedLogicTemplates));
    const distractorD = clean(pickRandom(contextShiftTemplates));

    return [base, distractorB, distractorC, distractorD];
  };

  for (let attempt = 0; attempt < 10; attempt++) {
    const candidateChoices = buildCompetingClaims();
    const shuffled = [...candidateChoices];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    const uniqueCount = new Set(shuffled.map((choice) => choice.toLowerCase())).size;
    const allGrounded = shuffled.every((choice) => hasPassageGrounding(choice));
    const allStrong = shuffled.every((choice) => !isWeakChoice(choice));
    const nonBaseWithConnectorShift = shuffled.filter((choice) => choice !== base).some((choice) => connectors.some((connector) => choice.toLowerCase().includes(connector)));

    if (uniqueCount === 4 && allGrounded && allStrong && nonBaseWithConnectorShift) {
      return shuffled as [string, string, string, string];
    }
  }

  const fallbackSentence = pickRandom(sampleSentencePool);
  const fallbackAlt = pickRandom(sampleSentencePool);
  return [
    base,
    clean(`${fallbackSentence} and this detail is accurate, yet it does not include the full chain of events in the passage`),
    clean(`The passage sequence is reversed here: ${base} is treated as happening after the final result`),
    clean(`${fallbackAlt} uses a valid idea from the text but applies it to a different situation than the question asks about`),
  ];
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
    const type: QuestionType = i === 1 ? "part_a_b" : "mc";
    const leveledStem = level === "Below"
      ? `${stem.split("?")[0]}?`
      : level === "Advanced"
      ? `${stem} Compare close alternatives and identify why the strongest distractor is still wrong.`
      : rigor.questionDepth === "high"
      ? `${stem} Which passage detail best supports your analysis?`
      : `${stem} Use two linked details to support your reasoning.`;
    const support = buildSupportContent(subject, leveledStem, "mc", i, level, "Cross-Curricular", crossPassage);
    const choices = choiceBanks[i % choiceBanks.length];
    const partAChoices: [string, string, string, string] = subject === "Math"
      ? [
        "After combo sales dropped by 8, single-item sales rose by 15, changing which items drove total earnings.",
        "After combo sales dropped by 8, both combo and single-item sales decreased in hour two.",
        "After combo sales dropped by 8, prices changed, so the two hours cannot be compared.",
        "After combo sales dropped by 8, organizers stopped tracking sales data entirely.",
      ]
      : subject === "Science"
      ? [
        "After watering one section, the temperature increased less there, supporting a moisture-related effect.",
        "After watering one section, blacktop heated faster than before because water traps heat.",
        "After watering one section, all surfaces showed identical temperatures every hour.",
        "After watering one section, students removed wind and sunlight from the experiment.",
      ]
      : [
        "After flooding delayed shipments and raised prices, voters later approved the bridge bond.",
        "After flooding delayed shipments, leaders canceled all transportation projects permanently.",
        "After flooding delayed shipments, population declined on both riverbanks.",
        "After flooding delayed shipments, merchants ended local trade immediately.",
      ];
    const partBChoices: [string, string, string, string] = subject === "Math"
      ? [
        "The passage states hour-two single-item sales increased by 15 after the announcement.",
        "The passage states single-item prices increased from $2 to $6 in hour two.",
        "The passage states combo sales increased by 15 after the announcement.",
        "The passage states no hour-two sales were recorded.",
      ]
      : subject === "Science"
      ? [
        "The report notes a smaller temperature increase after one section was watered.",
        "The report notes watering caused blacktop to absorb more heat than direct sun.",
        "The report notes airflow and moisture were unrelated to temperature changes.",
        "The report notes students ignored surface type during data collection.",
      ]
      : [
        "Meeting records and election results show a shift from rail-first planning to the bridge bond.",
        "Records show flooding improved rail shipments, so no transportation change was needed.",
        "Election results show voters rejected the bridge after flooding delays.",
        "Records show the bridge was built before the first rail decision in 1908.",
      ];

    return {
      type,
      question: leveledStem,
      choices: choices as [string, string, string, string],
      correct_answer: type === "part_a_b"
        ? { partA: nextSingleAnswer(), partB: nextSingleAnswer() }
        : nextSingleAnswer(),
      partA: type === "part_a_b"
        ? {
          question: `Part A: ${leveledStem}`,
          choices: partAChoices,
        }
        : undefined,
      partB: type === "part_a_b"
        ? {
          question: subject === "Math"
            ? "Part B: Which step from the passage data best proves the Part A solution?"
            : subject === "Science"
            ? "Part B: Which evidence from the investigation best supports Part A?"
            : "Part B: Which historical detail best supports Part A?",
          choices: partBChoices,
        }
        : undefined,
      explanation: support.explanation,
      hint: support.hint,
      think: support.think,
      step_by_step: support.step_by_step,
      common_mistake: support.common_mistake,
      parent_tip: support.parent_tip,
    };
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
    const type: QuestionType = i === 1 ? "part_a_b" : i === 4 ? "scr" : "mc";
    const support = buildSupportContent("Reading", stem, type, i, "On Level", "Cross-Curricular", crossPassage);
    const partAChoices: [string, string, string, string] = crossSubject === "Science"
      ? [
        "The passage shows temperature results changed when moisture and sunlight conditions changed.",
        "The passage shows results stayed the same across all surfaces and conditions.",
        "The passage shows students ignored data and used opinions only.",
        "The passage shows watering increased temperature more than direct sunlight.",
      ]
      : crossSubject === "Math"
      ? [
        "The passage shows hour-two single-item demand changed after the announcement and affected earnings decisions.",
        "The passage shows combo and single-item prices became identical in hour two.",
        "The passage shows no sales data were collected in the second hour.",
        "The passage shows only combo sales determine total revenue.",
      ]
      : [
        "The passage shows transportation decisions shifted after flooding delays and later voter action.",
        "The passage shows leaders never changed transportation plans over time.",
        "The passage shows election results rejected all transportation projects.",
        "The passage shows flooding had no effect on trade or prices.",
      ];
    const partBChoices: [string, string, string, string] = crossSubject === "Science"
      ? [
        "It states a watered section showed a smaller temperature increase in repeated testing.",
        "It states blacktop cooled faster than shaded grass in direct sun.",
        "It states wind and moisture were removed from the investigation.",
        "It states thermometers were used only once before recommendations.",
      ]
      : crossSubject === "Math"
      ? [
        "It states combo sales dropped by 8 while single-item sales increased by 15 in hour two.",
        "It states prices changed from $6 and $2 to higher values in hour two.",
        "It states both combo and single-item sales dropped in hour two.",
        "It states organizers ignored hour-one data during planning.",
      ]
      : [
        "It states flooding delayed shipments and, years later, voters passed a bridge bond.",
        "It states flooding improved rail shipping and lowered prices immediately.",
        "It states population growth reduced the need for transportation changes.",
        "It states bridge approval happened before any rail debate in 1908.",
      ];
    let choices = (crossChoiceBanks[crossSubject]?.[i] ||
      crossChoiceBanks[crossSubject]?.[0] ||
      crossChoiceBanks["Social Studies"][0]) as [string, string, string, string];
    choices = normalizeChoices(choices);
    return {
      type,
      question: stem,
      choices,
      correct_answer: type === "scr"
        ? "A"
        : type === "part_a_b"
        ? { partA: nextSingleAnswer(), partB: nextSingleAnswer() }
        : nextSingleAnswer(),
      partA: type === "part_a_b"
        ? {
          question: `Part A: ${stem}`,
          choices: partAChoices,
        }
        : undefined,
      partB: type === "part_a_b"
        ? {
          question: "Part B: Which sentence from the passage best supports your Part A answer?",
          choices: partBChoices,
        }
        : undefined,
      explanation: support.explanation,
      sample_answer: type === "scr"
        ? "The author’s purpose is to inform readers about the topic using evidence and examples. Key details in the passage show how those examples support the central claim."
        : undefined,
      hint: support.hint,
      think: support.think,
      step_by_step: support.step_by_step,
      common_mistake: support.common_mistake,
      parent_tip: support.parent_tip,
    };
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

  return stems.map((stem, i) => {
    const type: QuestionType = i === 1 ? "part_a_b" : i === 3 ? "multi_select" : i === 4 ? "scr" : "mc";
    const support = buildSupportContent(effectiveSubject, stem, type, i, level, mode, "");
    const baseChoices = normalizeChoices([
      "The plants closest to the lamp grew taller because they received more direct light.",
      "All plants grew at the same rate, so light intensity did not matter in this setup.",
      "Plants farther from the lamp appeared to grow faster because lower heat outweighed reduced light.",
      "Plant height changed randomly and was not related to the light conditions in the investigation.",
    ], effectiveSubject, skill);
    const partBChoices = normalizeChoices([
      "The investigation compared plant growth at different distances from the lamp over two weeks.",
      "The passage says all plants were measured only once at the end of the week.",
      "The class ignored light distance and focused only on soil color.",
      "The scenario states that light intensity never changed during the test.",
    ], effectiveSubject, skill);
    const question: Question = {
      type,
      question: stem,
      choices: baseChoices,
      correct_answer: type === "multi_select"
        ? nextMultiAnswer()
        : type === "part_a_b"
        ? { partA: nextSingleAnswer(), partB: nextSingleAnswer() }
        : nextSingleAnswer(),
      partA: type === "part_a_b"
        ? {
          question: `Part A: ${stem}`,
          choices: baseChoices,
        }
        : undefined,
      partB: type === "part_a_b"
        ? {
          question: "Part B: Which evidence best supports your Part A answer?",
          choices: partBChoices,
        }
        : undefined,
      explanation: support.explanation,
      sample_answer: type === "scr"
        ? "The author develops the central idea by introducing a problem and supporting the solution with clear evidence. One detail explains the challenge, and another shows why the response is effective. These details justify the best interpretation."
        : undefined,
      hint: support.hint,
      think: support.think,
      step_by_step: support.step_by_step,
      common_mistake: support.common_mistake,
      parent_tip: support.parent_tip,
    };

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

function sanitizeQuestions(
  raw: unknown,
  subject: CanonicalSubject,
  mode: CanonicalMode,
  skill: string,
  level: Level = "On Level",
  passage: PassageContent | string = "",
): Question[] {
  const incoming = Array.isArray(raw) ? raw.slice(0, 5) : [];
  const fallback = fallbackQuestionSet(subject, mode, skill, level);
  void subject;
  void skill;
  void passage;
  const replaceWithFallback = (index: number): Question => ({ ...fallback[index] });
  let missingOrEmptyChoicesDetected = false;
  const sanitized: Question[] = incoming.map((item, i) => {
    const q = item && typeof item === "object" ? item as Record<string, unknown> : {};
    if (!q.choices || !Array.isArray(q.choices) || q.choices.length === 0 || q.choices.every((choice) => !String(choice || "").trim())) {
      missingOrEmptyChoicesDetected = true;
      return replaceWithFallback(i);
    }
    const expectedType = fallback[i].type || "mc";
    const type: QuestionType = expectedType;
    const rawQuestion = String(q.question || fallback[i].question).trim() || fallback[i].question;
    const questionText = type === "multi_select" && !/select\s+two\s+answers\./i.test(rawQuestion)
      ? `${rawQuestion.replace(/\s+$/g, "")} Select TWO answers.`
      : rawQuestion;

    let normalizedChoices = normalizeChoices(q.choices);

    const fallbackPartA = fallback[i].partA || {
      question: "Part A: What is the best answer?",
      choices: normalizeChoices(fallback[i].choices),
    };
    const fallbackPartB = fallback[i].partB || {
      question: "Part B: Which evidence best supports Part A?",
      choices: normalizeChoices(fallback[i].choices),
    };

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
      correct_answer: type === "multi_select"
        ? normalizeMultiSelectAnswer(q.correct_answer || fallback[i].correct_answer)
        : type === "part_a_b"
        ? normalizePartABAnswer(q.correct_answer || fallback[i].correct_answer)
        : normalizeAnswer(q.correct_answer || fallback[i].correct_answer),
      partA: type === "part_a_b"
        ? {
          question: String((q.partA as Record<string, unknown> | undefined)?.question || fallbackPartA.question).trim() || fallbackPartA.question,
          choices: normalizeChoices((q.partA as Record<string, unknown> | undefined)?.choices || fallbackPartA.choices),
        }
        : undefined,
      partB: type === "part_a_b"
        ? {
          question: String((q.partB as Record<string, unknown> | undefined)?.question || fallbackPartB.question).trim() || fallbackPartB.question,
          choices: normalizeChoices((q.partB as Record<string, unknown> | undefined)?.choices || fallbackPartB.choices),
        }
        : undefined,
      explanation: String(q.explanation || fallback[i].explanation).trim() || fallback[i].explanation,
      paired_with: typeof q.paired_with === "number" ? q.paired_with : fallback[i].paired_with,
      sample_answer: String(q.sample_answer || fallback[i].sample_answer || "").trim() || fallback[i].sample_answer,
      part_b_question: type === "part_a" || type === "part_b"
        ? (String(q.part_b_question || fallback[i].part_b_question || "").trim() || fallback[i].part_b_question)
        : undefined,
      part_b_choices: type === "part_a" || type === "part_b"
        ? normalizeChoices(q.part_b_choices || fallback[i].part_b_choices)
        : undefined,
      part_b_correct_answer: type === "part_a" || type === "part_b"
        ? normalizeAnswer(q.part_b_correct_answer || fallback[i].part_b_correct_answer)
        : undefined,
      hint: String(q.hint || fallback[i].hint || "").trim(),
      think: String(q.think || fallback[i].think || "").trim(),
      step_by_step: String(q.step_by_step || fallback[i].step_by_step || "").trim(),
      common_mistake: String(q.common_mistake || fallback[i].common_mistake || "").trim(),
      parent_tip: String(q.parent_tip || fallback[i].parent_tip || "").trim(),
      visual: sanitizeVisual(q.visual) || fallback[i].visual,
    };
    return base;
  });

  while (sanitized.length < 5) sanitized.push(replaceWithFallback(sanitized.length));
  let questions = sanitized.slice(0, 5);

  questions = questions.map((q) => ({
    ...q,
    choices: normalizeChoices(q.choices),
  }));
  console.log("🔥 VALIDATION COMPLETE — CLEAN QUESTIONS:", questions.length);
  const finalSet = questions;

  if (
    missingOrEmptyChoicesDetected ||
    finalSet.some((q) =>
      !Array.isArray(q?.choices) ||
      q.choices.every((choice) => !String(choice || "").trim())
    )
  ) {
    return fallback.slice(0, 5).map((q) => ({ ...q }));
  }

  return finalSet;
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
  if (!Array.isArray(questions) || questions.length === 0) return false;
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
  if (subject === "Math") {
    return {
      question_id: "",
      question: promptFocus,
      explanation: "The correct answer comes from solving the math problem step by step using the quantities shown.",
      common_mistake: "Students may miscalculate, use the wrong operation, or skip a step in the computation.",
      parent_tip: "Ask your child to show each step and explain why each operation is used.",
      hint: "Break the problem into smaller parts before combining results.",
      think: "Check whether each number in the question was used correctly.",
      step_by_step: "Identify numbers → choose operations → solve each step → check reasonableness.",
    };
  }
  if (subject === "Science") {
    return {
      question_id: "",
      question: promptFocus,
      explanation: "The correct answer follows the scientific relationship shown in the scenario or data.",
      common_mistake: "Students may confuse cause and effect or mix up which variable changed.",
      parent_tip: "Ask your child which variable changed and what result was observed.",
      hint: "Focus on how one factor affects another in the system.",
      think: "Match the claim to the observed result, not just science vocabulary.",
      step_by_step: "Identify variables → find cause/effect relationship → apply the concept to the choices.",
    };
  }
  if (subject === "Social Studies") {
    return {
      question_id: "",
      question: promptFocus,
      explanation: "The correct answer reflects the historical cause, decision, or outcome in the event context.",
      common_mistake: "Students may choose a statement that sounds true but is not tied to the event or policy outcome.",
      parent_tip: "Ask your child what changed as a result of the event or decision in the question.",
      hint: "Track the cause, then connect it to the most direct impact.",
      think: "Check timeline order and who was affected by the decision.",
      step_by_step: "Identify event/context → determine cause or decision → determine impact/outcome.",
    };
  }
  return {
    question_id: "",
    question: promptFocus,
    explanation: "The correct answer is supported by text evidence connected to the question.",
    common_mistake: "Students may choose an answer that sounds plausible but is not supported by the text evidence.",
    parent_tip: "Ask your child to point to the exact sentence that supports the answer choice.",
    hint: "Look back at the text and find the best supporting detail.",
    think: "Eliminate choices that are not directly supported.",
    step_by_step: "Read question → locate evidence in text → match evidence to the best choice.",
  };
}

function buildCrossTutorFallback(subject: CanonicalSubject, question: Question, passage: string): TutorExplanation {
  const topic = extractKeyTopic(passage);
  const subjectFocus = subject === "Math"
    ? "quantitative relationships in the scenario"
    : subject === "Science"
    ? "the scientific system and variable relationships"
    : subject === "Social Studies"
    ? "historical decisions and outcomes"
    : "text evidence and interpretation";
  return {
    question_id: "",
    question: String(question.question || "").trim(),
    explanation: `The correct answer is supported by passage details about ${topic} and aligns with ${subjectFocus}.`,
    common_mistake: "A common mistake is choosing an option that sounds correct but is not supported by passage evidence.",
    parent_tip: "Ask your child to cite one specific sentence from the passage that proves the answer.",
    hint: "Look back at the passage section connected to this question.",
    think: "Compare close choices and keep only the option directly supported by the passage.",
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
  if (subject === "Math") {
    return {
      explanation: "This answer is correct because the required math operations were applied in the correct order.",
      common_mistake: "Students may choose an answer from a partial calculation that skips one step.",
      parent_tip: "Have your child explain each computation step before checking the final answer.",
    };
  }
  if (subject === "Science") {
    return {
      explanation: "This answer is correct because it matches the scientific relationship shown by the variables and observations.",
      common_mistake: "Students may select a choice with science terms that does not match the observed relationship.",
      parent_tip: "Ask your child to explain which variable changed and what effect it produced.",
    };
  }
  if (subject === "Social Studies") {
    return {
      explanation: "This answer is correct because it reflects the historical cause/effect or policy impact in context.",
      common_mistake: "Students may pick an option that is historically plausible but not supported by the event details.",
      parent_tip: "Ask your child to connect the event, decision, and outcome in one sentence.",
    };
  }
  return {
    explanation: "This answer is correct because it is directly supported by relevant text evidence.",
    common_mistake: "Students may choose an answer that is related to the topic but not supported by the text.",
    parent_tip: "Ask your child to cite the exact evidence that proves the answer.",
  };
}

function buildCrossAnswerFallback(
  subject: CanonicalSubject,
  question: Question,
  passage: string,
): Pick<AnswerKeyEntry, "explanation" | "common_mistake" | "parent_tip"> {
  const topic = extractKeyTopic(passage);
  void question;
  const subjectPhrase = subject === "Math"
    ? "the passage's numerical relationships"
    : subject === "Science"
    ? "the passage's scientific process"
    : subject === "Social Studies"
    ? "the passage's historical context"
    : "the passage's key details";
  return {
    explanation: `This answer is correct based on passage evidence about ${topic} and ${subjectPhrase}.`,
    common_mistake: "Choosing an answer that sounds reasonable but is not supported by passage evidence.",
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

function sanitizeTutorExplanations(
  raw: unknown,
  sourceQuestions: Question[],
  subject: CanonicalSubject,
  mode: "practice" | "cross",
  crossPassage = "",
): TutorExplanation[] {
  const incoming = Array.isArray(raw) ? raw.slice(0, 5) : [];
  const defaultQuestions = mode === "cross" ? buildCrossFallback(subject) : buildPracticeFallback("Main Idea", subject);
  const baseQuestions = sourceQuestions.slice(0, 5);
  while (baseQuestions.length < 5) baseQuestions.push(defaultQuestions[baseQuestions.length]);
  const sanitized = baseQuestions.slice(0, 5).map((q, index) => {
    const item = incoming[index];
    const entry = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const fallback = getTutorFallback(mode, subject, q, crossPassage);
    const base = {
      question_id: ensureQuestionId(q, index, mode),
      question: String(q.question || "").trim(),
      explanation: String(q.explanation || fallback.explanation).trim() || fallback.explanation,
      common_mistake: String(q.common_mistake || fallback.common_mistake).trim() || fallback.common_mistake,
      parent_tip: String(q.parent_tip || fallback.parent_tip).trim() || fallback.parent_tip,
      hint: String(q.hint || fallback.hint || "").trim() || (fallback.hint || "Use evidence linked to the question."),
      think: String(q.think || fallback.think || "").trim() || (fallback.think || "Eliminate unsupported options."),
      step_by_step: String(q.step_by_step || fallback.step_by_step || "").trim() || (fallback.step_by_step || "Read, find evidence, and confirm."),
    };
    const explanation = String(entry.explanation || base.explanation).trim() || base.explanation;
    const resolvedExplanation = mode === "cross" && crossPassage && !/\bpassage\b/i.test(explanation)
      ? `${explanation} Use details from the cross passage.`
      : explanation;
    return {
      question_id: base.question_id,
      question: String(entry.question || base.question).trim() || base.question,
      explanation: resolvedExplanation,
      common_mistake: String(entry.common_mistake || base.common_mistake).trim() || base.common_mistake,
      parent_tip: String(entry.parent_tip || base.parent_tip).trim() || base.parent_tip,
      hint: String(entry.hint || base.hint || "").trim() || base.hint,
      think: String(entry.think || base.think || "").trim() || base.think,
      step_by_step: String(entry.step_by_step || base.step_by_step || "").trim() || base.step_by_step,
    };
  });
  return sanitized.slice(0, 5);
}

function sanitizeAnswerKey(
  raw: unknown,
  sourceQuestions: Question[],
  subject: CanonicalSubject,
  tutor: TutorExplanation[],
  mode: "practice" | "cross",
  crossPassage = "",
): AnswerKeyEntry[] {
  const incoming = Array.isArray(raw) ? raw.slice(0, 5) : [];
  const defaultQuestions = mode === "cross" ? buildCrossFallback(subject) : buildPracticeFallback("Main Idea", subject);
  const baseQuestions = sourceQuestions.slice(0, 5);
  while (baseQuestions.length < 5) baseQuestions.push(defaultQuestions[baseQuestions.length]);
  const sanitized = baseQuestions.slice(0, 5).map((q, index) => {
    const item = incoming[index];
    const entry = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const fallback = getAnswerFallback(mode, subject, q, crossPassage);
    const base = {
      question_id: ensureQuestionId(q, index, mode),
      correct_answer: normalizeAnswerKeyEntry(q.correct_answer),
      explanation: tutor[index]?.explanation || q.explanation || fallback.explanation,
      common_mistake: tutor[index]?.common_mistake || q.common_mistake || fallback.common_mistake,
      parent_tip: tutor[index]?.parent_tip || q.parent_tip || fallback.parent_tip,
    };
    const explanation = String(entry.explanation || base.explanation).trim() || base.explanation;
    return {
      question_id: base.question_id,
      correct_answer: normalizeAnswerKeyEntry(entry.correct_answer || entry.answer || base.correct_answer),
      explanation: mode === "cross" && crossPassage && !/\bpassage\b/i.test(explanation)
        ? `${explanation} Refer to evidence in the cross passage.`
        : explanation,
      common_mistake: String(entry.common_mistake || base.common_mistake).trim() || base.common_mistake,
      parent_tip: String(entry.parent_tip || base.parent_tip).trim() || base.parent_tip,
    };
  });
  return sanitized.slice(0, 5);
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
      tutorEntry?.common_mistake && tutorEntry?.parent_tip,
    );
    const answerRequired = Boolean(
      answerEntry?.correct_answer && answerEntry?.explanation &&
      answerEntry?.common_mistake && answerEntry?.parent_tip &&
      answerEntry?.hint && answerEntry?.step_by_step,
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
  let result = generateQuestions(input); // existing logic
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
  let mode: CanonicalMode | "support" | "cross" = "Practice";
  let requestMode: "core" | "enrichment" = "core";
  let effectiveMode: "core" | "cross" | "support" | "enrichment" = "core";
  let effectiveSubject: CanonicalSubject = "Reading";
  let effectiveSkill = READING_SKILL_DEFAULT;
  let teksCode = "Unknown";

  const jsonResponse = (payload: Record<string, unknown>, status = 200) =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  const returnCore = (data: CoreResponse) =>
    jsonResponse(subject === "Reading"
      ? {
        teks: teksCode,
        skill,
        grade,
        passage: ensurePassageLength(
          getPassageText(data.passage || ""),
          readingPracticeWordRange(level).min,
          readingPracticeWordRange(level).max,
          subject,
          toCanonicalMode(mode),
          grade,
          level,
        ),
        practice: data.practice,
      }
      : {
        teks: teksCode,
        skill,
        grade,
        practice: data.practice,
      });
  const returnEnrichment = (data: EnrichmentResponse) =>
    jsonResponse({
      teks: teksCode,
      skill,
      grade,
      cross: data.cross,
      tutor: data.tutor,
      answerKey: data.answerKey,
    });

  const safeFallback = (reason: string, error?: string) => {
    console.log("🚨 FALLBACK TRIGGERED:", reason);
    if (error) console.log("🚨 FALLBACK ERROR:", error);
    const payload = buildFallbackResponse(grade, effectiveSubject, effectiveSkill, level);
    if (requestMode === "enrichment") {
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
      contentMode: incomingContentMode,
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
    const rawMode = String(body?.mode || "").toLowerCase();

    if (rawMode === "cross" || rawMode === "cross-curricular") {
      effectiveMode = "cross";
    } else if (rawMode === "support") {
      effectiveMode = "support";
    } else if (rawMode === "enrichment") {
      effectiveMode = "enrichment";
    } else {
      effectiveMode = "core";
    }
    requestMode = effectiveMode === "enrichment" ? "enrichment" : "core";
    mode = canonicalizeMode(incomingContentMode);
    effectiveSubject = subject;
    effectiveSkill = skill ?? "Main Idea";

    console.log("🔥 FINAL MODE:", mode);

    // 🚀 NEW MODE ROUTING
    if (mode === "cross") {
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
          ),
        },
      });
    }

    if (mode === "support") {
      const core = buildFallbackResponse(grade, effectiveSubject, effectiveSkill, level);
      const practiceQuestions = core.practice?.questions || [];
      const bodyCross = body?.cross && typeof body.cross === "object"
        ? body.cross as Record<string, unknown>
        : {};
      const crossQuestions: IncomingCrossQuestion[] = Array.isArray(bodyCross.questions)
        ? bodyCross.questions as IncomingCrossQuestion[]
        : [];
      const crossPassage = String(bodyCross.passage || "");

      const tutor = practiceQuestions.map((q, i) => ({
        question_id: `practice_${i}`,
        question: q.question,
        ...buildSupportContent(subject, q.question, q.type || "mc", i, level, "Practice", core.passage || ""),
      }));

      const crossTutor = crossQuestions.map((q, i) => ({
        question_id: `cross_${i}`,
        question: q.question,
        ...buildSupportContent(
          subject,
          q.question,
          q.type || "mc",
          i,
          level,
          "Cross-Curricular",
          crossPassage,
        ),
      }));

      const answerKey = practiceQuestions.map((q, i) => ({
        question_id: `practice_${i}`,
        correct_answer: String(q.correct_answer),
        explanation: q.explanation || "",
        common_mistake: q.common_mistake || "",
        parent_tip: q.parent_tip || "",
      }));

      const crossAnswerKey = crossQuestions.map((q, i) => ({
        question_id: `cross_${i}`,
        correct_answer: String(q.correct_answer),
        explanation: q.explanation || "",
        common_mistake: q.common_mistake || "",
        parent_tip: q.parent_tip || "",
      }));

      return jsonResponse({
        teks: teksCode,
        skill,
        grade,
        tutor: {
          practice: tutor,
          cross: crossTutor,
        },
        answerKey: {
          practice: answerKey,
          cross: crossAnswerKey,
        },
      });
    }
    console.log("🔥 RAW MODE:", rawMode);
    console.log("🔥 EFFECTIVE MODE:", effectiveMode);
    console.log("🧠 REQUEST MODE:", requestMode);
    console.log("🧠 CONTENT MODE:", mode);
    console.log("🧠 SUBJECT:", subject);
    console.log("🧠 EFFECTIVE SUBJECT:", effectiveSubject);
    const readingRange = readingPracticeWordRange(level);
    const range = subject === "Reading" ? readingRange : { min: 250, max: 300 };

    let attempts = 0;
    const MAX_ATTEMPTS = 2;
    const start = Date.now();
    const MAX_TIMEOUT_MS = 30000;
    const isTimedOut = () => Date.now() - start > MAX_TIMEOUT_MS;
    let retryFailureReason = "no_questions_returned";
    let bestAttempt: WorkerAttempt | null = null;
    let returnType = "UNKNOWN";
    const logReturnMetrics = () => {
      console.log("🔁 ATTEMPTS USED:", attempts);
      console.log("🎯 RETURN TYPE:", returnType);
      console.log("⏱ TOTAL TIME:", Date.now() - start, "ms");
    };
    while (attempts < MAX_ATTEMPTS) {
      if (isTimedOut()) {
        retryFailureReason = "no_questions_returned";
        console.warn("⚠️ FALLBACK TRIGGERED: exceeded max time");
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
              input: buildCorePrompt({
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
            retryFailureReason = "no_questions_returned";
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
            retryFailureReason = "no_questions_returned";
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
            retryFailureReason = "malformed_json";
            continue;
          }

          const parsedPassage = parsed.passage;
          const passage = parsedPassage && typeof parsedPassage === "object" && !Array.isArray(parsedPassage)
            ? {
              text_1: ensurePassageLength(
                clampPassageWords(String((parsedPassage as Record<string, unknown>).text_1 || ""), range.min, range.max),
                range.min,
                range.max,
                subject,
                mode,
                grade,
                level,
              ),
              text_2: ensurePassageLength(
                clampPassageWords(String((parsedPassage as Record<string, unknown>).text_2 || ""), range.min, range.max),
                range.min,
                range.max,
                subject,
                mode,
                grade,
                level,
              ),
            }
            : ensurePassageLength(
              clampPassageWords(String(parsedPassage || ""), range.min, range.max),
              range.min,
              range.max,
              subject,
              mode,
              grade,
              level,
            );
          const safePassage = subject === "Reading"
            ? (
              typeof passage === "string"
                ? passage
                : (passage.text_1 && passage.text_2 ? passage : null)
            )
            : "";
          if (subject === "Reading" && (!safePassage || !getPassageText(safePassage).trim())) {
            retryFailureReason = "no_questions_returned";
            continue;
          }
          if (subject === "Reading" && hasNarrativeReadingSignals(safePassage)) {
            console.warn("⚠️ Narrative reading passage detected; regenerating once with informational lock.");
            retryFailureReason = "narrative_output_filtered";
            continue;
          }

          const practiceQuestions = sanitizeQuestions(
            parsed?.practice && typeof parsed.practice === "object"
              ? (parsed.practice as Record<string, unknown>).questions
              : parsed.questions,
            effectiveSubject,
            "Practice",
            effectiveSkill,
            level,
            subject === "Reading" ? safePassage : "",
          );

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
          );
          const outputValid = isValidOutput(pipelineQuestions, safePassage);
          if (!outputValid) {
            retryFailureReason = "no_questions_returned";
            continue;
          }

          const payload: CoreResponse = {
            passage: subject === "Reading"
              ? ensurePassageLength(getPassageText(safePassage), range.min, range.max, subject, mode, grade, level)
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
          return safeFallback("no_questions_returned");
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
        );
        console.log("🧠 CROSS SUBJECT:", effectiveSubject);
        const crossContent = effectiveSubject === "Reading"
          ? buildELARFallback(level)
          : buildSubjectCrossContent(effectiveSubject, level);
        const baseCrossPassage = crossContent.passage;
        if (baseCrossPassage === corePassageForChecks) {
          console.log("⚠️ Cross passage duplication detected");
        }

        if (effectiveMode === "cross") {
          const crossPassage = ensurePassageLength(
            baseCrossPassage,
            250,
            300,
            effectiveSubject,
            "Cross-Curricular",
            grade,
            level,
          );
          const crossQuestions = sanitizeQuestions(
            crossContent.questions || [],
            effectiveSubject,
            "Cross-Curricular",
            effectiveSkill,
            level,
            crossPassage,
          );
          const result = await runPipeline({
            stems: crossQuestions,
            crossSubject: effectiveSubject,
            subject: effectiveSubject,
            crossPassage,
            questions: crossQuestions,
          });
          const pipelineCrossQuestions = sanitizeQuestions(
            result.questions,
            effectiveSubject,
            "Cross-Curricular",
            effectiveSkill,
            level,
            crossPassage,
          );
          const payload = {
            cross: {
              passage: crossPassage,
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

        if (effectiveMode === "support") {
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
            input: buildEnrichmentPrompt({
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
          retryFailureReason = "no_questions_returned";
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
        subjectCrossPassage = ensurePassageLength(
          subjectCrossPassage,
          250,
          300,
          effectiveSubject,
          "Cross-Curricular",
          grade,
          level,
        );

        let crossQuestions = sanitizeQuestions(
          parsedCross.questions || [],
          effectiveSubject,
          "Cross-Curricular",
          effectiveSkill,
          level,
          subjectCrossPassage,
        );
        const crossValid = isValidOutput(crossQuestions, subjectCrossPassage);
        if (!crossValid) {
          retryFailureReason = "no_questions_returned";
          continue;
        }

        const parsedTutor = parsed?.tutor && typeof parsed.tutor === "object"
          ? parsed.tutor as Record<string, unknown>
          : {};
        const parsedAnswerKey = parsed?.answerKey && typeof parsed.answerKey === "object"
          ? parsed.answerKey as Record<string, unknown>
          : {};

        const tutorPractice = sanitizeTutorExplanations(
          parsedTutor.practice || parsedTutor.explanations || [],
          normalizedPractice,
          effectiveSubject,
          "practice",
        );
        let tutorCross = sanitizeTutorExplanations(
          parsedTutor.cross || [],
          crossQuestions,
          effectiveSubject,
          "cross",
          subjectCrossPassage,
        );

        const answerKeyPractice = sanitizeAnswerKey(
          parsedAnswerKey.practice || parsedAnswerKey.answers || [],
          normalizedPractice,
          effectiveSubject,
          tutorPractice,
          "practice",
        );
        let answerKeyCross = sanitizeAnswerKey(
          parsedAnswerKey.cross || [],
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
          cross: { passage: subjectCrossPassage, questions: crossQuestions },
          tutor: { practice: tutorPractice, cross: tutorCross },
          answerKey: { practice: answerKeyPractice, cross: answerKeyCross },
        };
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
        retryFailureReason = "no_questions_returned";
        if (isTimedOut()) {
          console.warn("⚠️ FALLBACK TRIGGERED: exceeded max time");
        }
      }
    }

    if (bestAttempt) {
      returnType = "BEST_ATTEMPT";
      logReturnMetrics();
      if (requestMode === "enrichment") {
        return returnEnrichment(bestAttempt);
      }
      if (effectiveMode === "cross") {
        return jsonResponse({ teks: teksCode, skill, grade, cross: bestAttempt.cross });
      }
      if (effectiveMode === "support") {
        return jsonResponse({
          teks: teksCode,
          skill,
          grade,
          tutor: bestAttempt.tutor,
          answerKey: bestAttempt.answerKey,
        });
      }
      return returnCore(bestAttempt);
    }
    returnType = "FALLBACK";
    logReturnMetrics();
    return safeFallback(retryFailureReason);
  } catch (err) {
    console.error("🔥 EDGE FUNCTION ERROR:", err);
    return safeFallback("no_questions_returned");
  }
});
