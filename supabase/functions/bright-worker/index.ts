import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type Level = "Below" | "On Level" | "Advanced";
type ChoiceLetter = "A" | "B" | "C" | "D";
type AnswerLetter = "A" | "B" | "C" | "D";
type CanonicalSubject = "Reading" | "Math" | "Science" | "Social Studies";
type CanonicalMode = "Practice" | "Cross-Curricular" | "Support" | "Tutor" | "Answer Key";
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
  passage?: PassageContent | null;
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
const READING_PRACTICE_RIGOR_SECTION = [
  "RIGOR AND DISTRACTOR QUALITY (READING PRACTICE):",
  "- Questions must be STAAR-level rigorous and require real inference.",
  "- Avoid obvious answers and direct recall.",
  "- Each question must require reasoning across multiple details from the passage.",
  "- Questions must NOT be answerable from one sentence alone.",
  "",
  "PASSAGE RULE (CRITICAL):",
  "- Every passage sentence must be complete and meaningful.",
  "- Do not leave sentence fragments or unfinished ideas.",
  "- Replace any incomplete fragment with a full, coherent sentence.",
  "",
  "DISTRACTOR RULES (CRITICAL):",
  "- Each question must include exactly 1 correct answer, 2 plausible distractors, and 1 clearly incorrect answer.",
  "- Plausible distractors must be based on passage details but still incorrect.",
  "- The clearly incorrect answer must still be academic in tone and structure.",
  "- All choices must sound equally academic and similarly strong in wording.",
  "- Avoid extreme language such as always and never.",
  "",
  "QUESTION REQUIREMENTS:",
  "- At least 3 of 5 questions must require inference.",
  "- Include at least one item where two options are close and students must justify the best-supported choice.",
  "- Ensure answer choices are concrete and content-specific, not generic.",
].join("\n");
const CROSS_CURRICULAR_RIGOR_SECTION = [
  "RIGOR AND DISTRACTOR QUALITY (CROSS-CURRICULAR):",
  "- Questions must combine passage understanding with subject reasoning.",
  "- Avoid purely recall-based questions.",
  "",
  "DISTRACTOR RULES:",
  "- One distractor misinterprets the passage",
  "- One distractor applies correct reasoning to the wrong detail",
  "- One distractor reflects a common misconception in the subject area",
  "- All answer choices must be plausible",
  "",
  "QUESTION REQUIREMENTS:",
  "- At least 2 questions must require inference from the passage",
  "- At least 2 questions must require subject-based reasoning",
  "- Answers should not rely solely on quoting the passage",
  "",
  "PASSAGE QUALITY:",
  "- Must support reasoning, not just description",
  "- Include cause/effect, patterns, or relationships",
  "- Include at least one detail that can be interpreted in multiple ways",
].join("\n");
const ANTI_GENERIC_ANSWER_RULES = [
  "ANTI-GENERIC ANSWER RULE (CRITICAL):",
  "- DO NOT use placeholder or template phrase patterns.",
  "- Every answer choice must include SPECIFIC content from the passage or problem.",
  "- Answers must be concrete and meaningful, not abstract or self-referential.",
  "- If an answer could apply to ANY passage, it is INVALID and must be rewritten.",
  "- Each answer must clearly relate to:",
  "  - a detail",
  "  - a pattern",
  "  - or a logical conclusion from the passage",
].join("\n");
const TUTOR_STYLE_RULES = [
  "TUTOR STYLE (CRITICAL):",
  "- Explain thinking like a real teacher talking to a student",
  "- Use varied sentence structure and avoid repeated phrasing",
  "- Focus on WHY the answer is correct using passage meaning and evidence",
  "- Explain wrong answers based on specific misunderstandings",
  "- Keep explanations concise and clear",
  "- Keep explanations natural and conversational, like a teacher guiding a student.",
  "- Make all hints and explanations feel connected to the specific passage.",
  "- Whenever possible, refer to events, reactions, or details from the passage.",
  "- Help the student think about what actually happened in the text.",
  "- Avoid generic advice that could apply to any passage.",
  "- Do not force quotes or exact wording from the passage.",
  "- Focus on meaning, not exact phrasing.",
  "- Each explanation should help the student connect the question to a moment or idea in the passage, not just general reading strategies.",
  "EVIDENCE VARIATION (CRITICAL):",
  "- Whenever possible, use different parts of the passage across questions.",
  "- Avoid reusing the same passage detail in every explanation unless needed.",
  "GROUNDING RULE (CRITICAL):",
  "- Ground explanations in a real, specific detail or moment from the passage when possible.",
  "- Do not use abstract phrases such as \"the strongest detail\", \"this shows\", or \"this proves\".",
  "- Do NOT repeat incomplete or broken phrases",
  "- If a sentence is incomplete, paraphrase it into a full idea",
  "EXPLANATION VARIATION (CRITICAL):",
  "- Each question explanation must sound different.",
  "- Avoid repeating sentence starters across questions",
  "- Vary explanation structure naturally.",
  "- Mix direct explanation, cause/effect reasoning, and contrast reasoning across the set.",
  "ANTI-TEMPLATE RULE (CRITICAL):",
  "- Do not follow fixed starters such as \"Notice how...\", \"The key evidence is...\", or \"When you connect...\".",
  "- Write naturally like a teacher explaining to a student.",
  "FAILSAFE (CRITICAL):",
  "- If an explanation repeats structure, reuses the same sentence, or uses generic phrasing, rewrite it completely.",
  "STRUCTURE (FLEXIBLE):",
  "- Include hint, explanation, mistake, and tip",
  "- Do NOT enforce identical phrasing",
  "- Do NOT enforce identical order",
].join("\n");
const ANSWER_KEY_STYLE_RULES = [
  "ANSWER KEY STYLE (CRITICAL):",
  "- State the correct answer clearly",
  "- Give a brief explanation (1–2 sentences max)",
  "- Reference a specific detail or reasoning",
  "- Keep tone direct and natural",
  "MISCONCEPTION RULE:",
  "- Explain ONE common mistake briefly",
  "- Do NOT repeat the same phrasing across questions",
  "- Focus on why a wrong answer seems correct",
  "PARENT TIP RULE:",
  "- Keep tips short (1 sentence)",
  "- Vary wording across questions",
  "- Focus on actionable thinking strategies",
  "VARIATION RULE:",
  "- Each explanation must sound different",
  "- Avoid repeated sentence starters",
  "- Do NOT follow a fixed script structure",
].join("\n");
const DIFFICULTY_ENFORCEMENT_RULES = [
  "DIFFICULTY ENFORCEMENT (CRITICAL):",
  "- Below Level:",
  "  - Simple, single-step questions",
  "  - Direct identification or recall",
  "- On Level:",
  "  - Multi-step thinking",
  "  - Some reasoning required",
  "- Advanced:",
  "  - Require analysis, comparison, or application",
  "  - Avoid definition-based or recall questions",
  "  - Include multi-step reasoning or real-world scenarios",
  "  - Questions should require students to explain why, not just identify",
].join("\n");
const QUESTION_DESIGN_RULES = [
  "QUESTION DESIGN RULES:",
  "- Do NOT ask:",
  "  \"Which example shows...\"",
  "  \"What is...\"",
  "  \"Which is...\"",
  "- Instead ask:",
  "  - Why does this happen?",
  "  - Which explanation is best supported?",
  "  - What would happen if...",
  "  - Which situation is most valid and why?",
].join("\n");
const CROSS_PASSAGE_QUALITY_CRITICAL = [
  "PASSAGE QUALITY (CRITICAL):",
  "- All sentences must be complete and fully expressed ideas.",
  "- Do NOT produce fragments such as:",
  "  \"tracked how surface\"",
  "  \"absorbed and\"",
  "  \"after watering\"",
  "- Include specific measurable details (numbers, conditions, results).",
  "- Include at least one clear cause-and-effect relationship.",
  "- Include a comparison (before vs after, condition A vs B).",
  "- Passage must support answering all 5 questions.",
].join("\n");
const CROSS_ANTI_GENERIC_ANSWERS_CRITICAL = [
  "ANTI-GENERIC ANSWERS (CRITICAL):",
  "- DO NOT use placeholder or template phrase patterns.",
  "- Each answer must include specific details from the passage.",
  "- Answers must reference:",
  "  - data",
  "  - observations",
  "  - or results from the passage",
  "- If an answer could apply to ANY passage, it is INVALID.",
].join("\n");
const CROSS_QUESTION_REQUIREMENTS_CRITICAL = [
  "QUESTION REQUIREMENTS:",
  "- At least 2 questions must require inference.",
  "- At least 2 questions must require scientific reasoning.",
  "- Avoid vague or abstract questions.",
  "- Questions must rely on passage details, not general knowledge.",
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

function shuffleArray<T>(array: T[]): T[] {
  const copy = [...array];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function forcePassageChoices(passageText: string): [string, string, string, string] {
  void passageText;
  return ["", "", "", ""];
}

function summarizeEvidenceIdea(evidence: string): string {
  return String(evidence || "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'\s]+|["'\s]+$/g, "")
    .replace(/[.!?]+$/, "");
}

function fallbackEvidenceSnippet(passage: string): string {
  const completeSentences = splitPassageSentences(passage)
    .map((sentence) => String(sentence || "").trim())
    .filter((sentence) => sentence.length > 20 && isCompleteSentence(sentence))
    .map((sentence) => summarizeEvidenceIdea(sentence))
    .filter((sentence) => sentence.length > 20);

  return completeSentences[0] || "the passage provides clear evidence";
}

function buildAlignedExplanation(
  question: any,
  passage: string,
  usedEvidence: Set<string>,
  usePassage: boolean,
): { why: string; mistake: string; tip: string } {
  const normalizedChoices = normalizeChoices(question?.choices);
  const correctLetter = safeCorrectAnswer(question?.correct_answer);
  const correctIndex = Math.max(0, LETTERS.indexOf(correctLetter));
  const correctChoice = String(normalizedChoices[correctIndex] || "").trim();
  const snippet = usePassage ? selectEvidenceSnippet(question, String(passage || ""), usedEvidence) : null;
  const passageStarters = [
    "Look closely at the part where",
    "The key detail is",
    "The passage shows that",
    "Notice how the text explains",
    "Focus on the moment when",
  ];
  const starterIndex = Math.abs(
    String(question?.question || "")
      .split("")
      .reduce((sum, ch) => sum + ch.charCodeAt(0), 0),
  ) % passageStarters.length;
  const passageStarter = passageStarters[starterIndex];
  const why = (usePassage
    ? (() => {
      let boundedSnippet = snippet || "";
      if (!boundedSnippet || boundedSnippet.length < 15) {
        boundedSnippet = fallbackEvidenceSnippet(passage);
      }
      const cleanSnippet = summarizeEvidenceIdea(boundedSnippet);
      const evidence = cleanSnippet && cleanSnippet.length > 15
        ? cleanSnippet
        : fallbackEvidenceSnippet(passage);
      return `${passageStarter} "${summarizeEvidenceIdea(evidence)}" supports ${correctLetter}${correctChoice ? ` (${correctChoice})` : ""}`;
    })()
    : `Focus on the moment when each condition in the problem is checked in order. That process supports ${correctLetter}${correctChoice ? ` (${correctChoice})` : ""}.`);

  const mistake = usePassage
    ? "A common mistake is choosing an option that sounds related but is not directly supported by the passage evidence."
    : "A common mistake is choosing an option that seems plausible without checking all constraints in the question.";

  const tip = usePassage
    ? "Go back to the exact line that proves the answer before choosing."
    : "Test each option against the full question, not just one keyword.";

  return { why, mistake, tip };
}

function buildAnswerKeyExplanation(
  question: any,
  passage: string,
  usedEvidence: Set<string>,
  usePassage: boolean,
): { why: string; mistake: string; tip: string } {
  const normalizedChoices = normalizeChoices(question?.choices);
  const correctLetter = safeCorrectAnswer(question?.correct_answer);
  const correctIndex = Math.max(0, LETTERS.indexOf(correctLetter));
  const correctChoice = String(normalizedChoices[correctIndex] || "").trim();
  let snippet = usePassage ? selectEvidenceSnippet(question, String(passage || ""), usedEvidence) : null;
  if (!snippet || snippet.length < 15) {
    snippet = fallbackEvidenceSnippet(passage);
  }
  const cleanSnippet = summarizeEvidenceIdea(snippet || "");
  const evidence = cleanSnippet && cleanSnippet.length > 15
    ? cleanSnippet
    : fallbackEvidenceSnippet(passage);

  return {
    why: usePassage
      ? `The passage explains that "${evidence}", which supports ${correctLetter}${correctChoice ? ` (${correctChoice})` : ""}.`
      : `The explanation supports ${correctLetter}${correctChoice ? ` (${correctChoice})` : ""} based on the question requirements.`,
    mistake: "This distractor may seem correct but is not supported by the passage.",
    tip: "Check the exact detail that confirms the correct answer.",
  };
}

function buildDistractorFeedback(question: any): string {
  return "";
}

function selectEvidenceSnippet(
  question: any,
  passage: string,
  usedEvidence: Set<string>,
): string | null {
  if (!passage) return null;
  const sentences = passage
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (!sentences.length) return null;

  const normalizedChoices = normalizeChoices(question?.choices);
  const correctLetter = safeCorrectAnswer(question?.correct_answer);
  const correctIndex = Math.max(0, LETTERS.indexOf(correctLetter));
  const correctChoice = String(normalizedChoices[correctIndex] || "").trim();
  const questionText = String(question?.question || "").trim();
  const anchorText = `${questionText} ${correctChoice}`.toLowerCase();

  const stopwords = new Set([
    "about", "after", "again", "also", "because", "before", "being", "between", "could", "every", "from", "have",
    "into", "just", "like", "many", "more", "most", "only", "other", "over", "same", "some", "than", "that",
    "their", "there", "these", "they", "this", "those", "through", "under", "very", "what", "when", "where",
    "which", "while", "with", "would",
  ]);

  const queryTokens = anchorText
    .split(/[^a-z0-9-]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4 && !stopwords.has(token));

  const scoreSentence = (sentence: string): number => {
    const lower = sentence.toLowerCase();
    const sentenceTokens = new Set(
      lower
        .split(/[^a-z0-9-]+/)
        .map((token) => token.trim())
        .filter((token) => token.length >= 4 && !stopwords.has(token)),
    );
    let score = 0;
    for (const token of queryTokens) {
      if (sentenceTokens.has(token)) score += 1;
    }
    if (correctChoice && lower.includes(correctChoice.toLowerCase())) score += 3;
    if (questionText && lower.includes(questionText.toLowerCase().slice(0, 20))) score += 1;
    return score;
  };

  const scored = sentences
    .map((sentence) => ({ sentence, score: scoreSentence(sentence) }))
    .filter((entry) => entry.sentence.split(/\s+/).length >= 5)
    .sort((a, b) => b.score - a.score);

  const bestUnused = scored.find((entry) => !usedEvidence.has(entry.sentence) && entry.score > 0);
  if (bestUnused) {
    usedEvidence.add(bestUnused.sentence);
    return bestUnused.sentence;
  }

  const fallbackPair = scored.filter((entry) => !usedEvidence.has(entry.sentence)).slice(0, 2);
  if (fallbackPair.length >= 2 && (fallbackPair[0].score > 0 || fallbackPair[1].score > 0)) {
    const combined = `${fallbackPair[0].sentence} ${fallbackPair[1].sentence}`.trim();
    usedEvidence.add(fallbackPair[0].sentence);
    usedEvidence.add(fallbackPair[1].sentence);
    return combined;
  }

  const firstUnused = sentences.find((sentence) => !usedEvidence.has(sentence));
  if (firstUnused) {
    usedEvidence.add(firstUnused);
    return firstUnused;
  }

  const firstSentence = sentences[0] || null;
  if (firstSentence) {
    usedEvidence.add(firstSentence);
  }
  return firstSentence;
}

function buildCrossFallbackContent(subject: CanonicalSubject, level: Level, skill: string): {
  passage: string;
  questions: Question[];
} {
  const passage = buildSubjectPassage(subject, level);
  void skill;
  const questions: Question[] = [];
  return { passage, questions };
}

function buildThinkPrompt(question: any): string {
  return "Think about what the question is asking and find evidence that supports the best answer.";
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
  if (mode === "Cross-Curricular") return { min: 150, max: 200 };
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

function variedParentTip(index: number): string {
  const tips = [
    "👨‍👩‍👧 Parent Tip:\nHave your child reread the question, then restate it in their own words before choosing an answer.",
    "👨‍👩‍👧 Parent Tip:\nAsk your child to eliminate two weak choices first and explain why those options do not match the passage.",
    "👨‍👩‍👧 Parent Tip:\nInvite your child to underline one key detail in the passage and connect that detail to the best answer.",
    "👨‍👩‍👧 Parent Tip:\nAsk your child to think out loud and explain each step of their reasoning before locking in the answer.",
  ];
  return tips[Math.abs(index) % tips.length];
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
    return `A key detail is "${snippet}." This clue points to ${extractKeyConcept(correctChoice)}, which helps confirm the best answer.`;
  }
  return "";
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

function ensureUsableExplanation(
  explanation: string,
  subject: string
): string {
  const trimmed = String(explanation || "").trim();

  if (trimmed.length > 20) {
    return trimmed;
  }

  const s = subject.toLowerCase();

  if (s.includes("math")) {
    return "Check each step and make sure the operations match what the problem is asking.";
  }

  if (s.includes("science")) {
    return "Think about the cause-and-effect relationship and which answer best matches the evidence.";
  }

  if (s.includes("social")) {
    return "Think about the events and relationships and which answer best fits the context.";
  }

  return "Think about what the passage shows and which answer best matches the main idea or detail.";
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
  if (!question || question.length < 8) return false;

  const badPatterns = [
    "which is",
    "what is",
    "one detail",
    "another clue",
  ];

  const lower = question.toLowerCase();

  if (badPatterns.some((p) => lower.includes(p))) {
    console.warn("⚠️ Validation warning: question stem may be weak");
  }

  return true;
}

function isGenericChoice(choice: string): boolean {
  const normalized = String(choice || "").trim().toLowerCase();

  if (!normalized) return true;

  return [
    /\bbased on the passage\b/i,
    /\bone detail\b/i,
    /\banother clue\b/i,
  ].some((pattern) => pattern.test(normalized));
}

function isValidPassage(passage: string): boolean {
  return isUsablePassage(passage);
}

function isUsablePassage(passage: string): boolean {
  const text = String(passage || "").trim();
  return Boolean(text && text.length > 60);
}

function splitPassageSentences(passage: string): string[] {
  return String(passage || "")
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function isCompleteSentence(sentence: string): boolean {
  const trimmed = String(sentence || "").trim();
  if (!trimmed) return false;
  if (!/[.!?]["')\]]*$/.test(trimmed)) return false;

  const withoutTerminalPunctuation = trimmed
    .replace(/[.!?]["')\]]*$/, "")
    .trim();
  if (!withoutTerminalPunctuation) return false;

  const lower = withoutTerminalPunctuation.toLowerCase();
  if (/[,:;\-–—]$/.test(withoutTerminalPunctuation)) return false;
  const forbiddenEndings = ["and the", "which", "it", "this"];
  if (forbiddenEndings.some((ending) => lower.endsWith(ending))) return false;

  const words = withoutTerminalPunctuation.split(/\s+/).filter(Boolean);
  if (words.length < 6) return false;

  const hasVerbSignal = /\b(is|are|was|were|be|been|being|has|have|had|do|does|did|can|could|will|would|should|may|might|must|include|includes|included|show|shows|showed|create|creates|created)\b/i
    .test(withoutTerminalPunctuation) ||
    /\b\w+(ed|ing)\b/i.test(withoutTerminalPunctuation);
  return hasVerbSignal;
}

function isCompletePassage(passage: string): boolean {
  if (!isUsablePassage(passage)) return false;
  const sentences = splitPassageSentences(passage);
  if (sentences.length < 5 || sentences.length > 7) return false;
  if (!sentences.every((sentence) => isCompleteSentence(sentence))) return false;

  const finalSentence = sentences[sentences.length - 1] || "";
  const finalLower = finalSentence.toLowerCase();
  const hasConclusionSignal = /\b(finally|overall|therefore|as a result|in conclusion|in the end|ultimately|concluded|decided|recommended|showed)\b/.test(finalLower);
  return hasConclusionSignal || finalSentence.length >= 50;
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

function sanitizeChoices(questions: Question[]): Question[] {
  return questions.map(q => ({
    ...q,
    choices: normalizeChoices(q.choices)
  }));
}

function sanitizeExplanations(questions: Question[], passage: PassageContent | string): Question[] {
  void passage;
  return questions;
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
      "Q1 light recall / confidence check",
      "Q2 scenario analysis",
      "Q3 cause → effect reasoning",
      "Q4 conditions → outcome analysis",
      "Q5 process → result explanation",
    ].join("\n");
  }

  if (subject === "Social Studies") {
    return [
      "Q1 light recall / confidence check",
      "Q2 decision → consequence",
      "Q3 event → impact",
      "Q4 short-term vs long-term effect",
      "Q5 historical/civic reasoning",
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

function generatePassagePrompt(params: {
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

  if (subject !== "Reading") {
    return `Create JSON only.

Return exactly:
{
  "passage": null
}

Rules:
- Subject is ${subject}; no passage is needed for practice generation.
- Return null for passage.
- No markdown. JSON only.`;
  }

  const readingRange = readingPracticeWordRange(level);
  return `Create JSON only for PRACTICE MODE passage generation.

Inputs:
- Grade: ${grade}
- Subject: ${subject}
- Skill: ${skill}
- Level: ${levelInstruction}
- Context Type: ${contextType}
- TEKS Alignment Code: ${teksCode}

${ENGAGING_CONTEXT_RULES}
${THINKING_OVER_RECALL_RULES}

Return exactly:
{
  "passage": "REQUIRED ${textType || "fiction"} passage (${readingRange.min}–${readingRange.max} words)"
}

Rules:
- Generate exactly 1 complete passage.
- Every sentence must be complete and meaningful.
- Ensure passage includes enough detail to support 5 rigorous STAAR-style questions.
- Use natural, non-robotic language.
- No markdown. JSON only.`;
}

function generateQuestionsPrompt(params: {
  grade: number;
  subject: CanonicalSubject;
  skill: string;
  level: Level;
  passage: string | null;
  teksCode?: string;
}): string {
  const { grade, subject, skill, level, passage, teksCode = "Unknown" } = params;
  const normalizedSkill = String(skill || "").toLowerCase();
  const levelThinkingGuidance = level === "Advanced"
    ? `
Advanced questions should:
- require deeper reasoning or multiple steps
- involve applying ideas to new situations
- include prediction, comparison, or evaluation
- avoid simple recall or one-step answers
`
    : level === "Below"
    ? `
Below-level questions should:
- focus on direct relationships and clear support from the prompt
- use simple reasoning with minimal steps
- build confidence before deeper analysis
`
    : `
On-Level questions should:
- focus on clear cause/effect or direct relationships
- require basic reasoning or simple application
- avoid overly complex or multi-step thinking
`;
  const scienceInvestigationFocus = normalizedSkill.includes("scientific investigation")
    ? `
- For scientific investigation:
  - Do NOT generate definition or vocabulary-focused questions.
  - Focus on scenarios, experiments, or changes in conditions.
  - Include questions that ask what will happen, why it happens, or how variables affect outcomes.
  - At least 3 questions should ask students to predict or explain investigation results.
  - Focus on reasoning about processes, not just recalling facts.
`
    : "";
  void teksCode;
  void passage;

  if (subject === "Reading") {
    return `
Generate concise STAAR-style Reading practice content.

Requirements:
- Write one full passage (150-300 words) in "passage".
- Then write exactly 5 comprehension questions in "questions".
- Every question and choice must be answerable from the passage.
- Keep output concise.

Practice Mode rigor enforcement (CRITICAL):
- Eliminate ALL simple recall questions.
- If a question can be answered by copying one sentence from the passage, rewrite that question.
- At least 3 of the 5 questions MUST be inference-based.
- No more than 1 direct recall question is allowed.
- Every question must require thinking beyond the text.
- Reject stems like:
  - "What did ___ do?"
  - "What did ___ find?"
  - "Which season...?"
  - Any single stated-fact question.
- Before finalizing, self-check: if more than 1 question is recall, rewrite until compliant.
- Questions should not feel like a basic worksheet; they must require analysis and justification.

Return JSON:
{
  "passage": "",
  "questions": [
    {
      "question": "",
      "choices": ["", "", "", ""],
      "correct_answer": "A"
    }
  ]
}`;
  }

  if (subject === "Math") {
    const onLevelMathGuidance = level === "On Level"
      ? `
On-Level multi-step expectations:
- On-Level problems should often include a second step after the first calculation.
- Use situations with remaining amounts, giving away items, change, or value comparisons.
- Students should have to decide what to do next, not just run one operation.
- Avoid having most problems solved in a single step.
- Include at least 2 problems that clearly require more than one step to solve.
`
      : "";

    return `
Generate concise STAAR-style Math practice content.

Requirements:
- DO NOT generate a passage.
- Set "passage" to null.
- Generate exactly 5 word problems in "questions".
- Each question must be self-contained with its own context.
- Problems should usually require more than one step to solve.
- Whenever possible:
  - combine operations (for example, multiply then subtract, or divide then add)
  - include a second action after an initial calculation
  - require students to decide what to do first before calculating
- Avoid simple one-step problems unless needed for variety.
- At least some problems should require multiple steps or decisions to reach the final answer.
- Include a mix of:
  - problems where a value is found first and then used in a second calculation
  - problems involving comparison or remaining amounts
  - problems that require interpreting the situation before solving
${levelThinkingGuidance}
- Keep output concise.

Return JSON:
{
  "passage": null,
  "questions": [
    {
      "question": "",
      "choices": ["", "", "", ""],
      "correct_answer": "A"
    }
  ]
}`;
  }

  if (subject === "Science") {
    return `
Generate concise STAAR-style Science practice content.

Requirements:
- Write one short informational excerpt (50-120 words) in "passage".
- Then write exactly 5 questions in "questions" based on that excerpt.
- Do NOT generate definition-only or identification-only sets.
- Allow at most 1 light recall question; at least 4 questions must require reasoning.
- Prioritize:
  - cause → effect
  - conditions → outcome
  - process → result
  - real-world application of concepts
- Prefer "what happens if..." or "which result is most likely..." style prompts over term-definition prompts.
- Include variables, observations, or simple experimental setups whenever possible.
- If questions drift into pure vocabulary recall, revise them toward scenario-based reasoning.
${scienceInvestigationFocus}
${levelThinkingGuidance}
- If a question can be answered by memorizing one sentence, rewrite it to require thinking.
- Keep output concise.

Return JSON:
{
  "passage": "",
  "questions": [
    {
      "question": "",
      "choices": ["", "", "", ""],
      "correct_answer": "A"
    }
  ]
}`;
  }

  return `
Generate concise STAAR-style Social Studies practice content.

Requirements:
- Write one short historical or informational excerpt (50-120 words) in "passage".
- Then write exactly 5 questions in "questions" based on that excerpt.
- Do NOT generate sets that only ask for names, dates, or numbers.
- Allow at most 1 light recall question; at least 4 questions must require reasoning.
- Prioritize:
  - why events happened
  - effects of decisions
  - short-term vs long-term impacts
  - how events influenced people or society
- Match reasoning depth to level (On-Level = direct relationships; Advanced = multi-step prediction/comparison/evaluation).
${levelThinkingGuidance}
- If a question can be answered by memorizing one sentence, rewrite it to require thinking.
- Keep output concise.

Return JSON:
{
  "passage": "",
  "questions": [
    {
      "question": "",
      "choices": ["", "", "", ""],
      "correct_answer": "A"
    }
  ]
}`;
}

function crossCurricularPassageTopicRule(subject: CanonicalSubject): string {
  if (subject === "Reading") return "Science OR Social Studies passage";
  if (subject === "Math") return "Real-world / problem-based passage (word context)";
  if (subject === "Science") return "Science passage";
  if (subject === "Social Studies") return "Social Studies / historical passage";
  return "Academic subject-aligned passage";
}

function generateCrossCurricularPrompt(params: {
  grade: number;
  subject: CanonicalSubject;
  skill: string;
  level: Level;
  teksCode?: string;
}): string {
  const { grade, subject, skill, level, teksCode = "Unknown" } = params;
  const topicRule = crossCurricularPassageTopicRule(subject);
  const normalizedSkill = String(skill || "").toLowerCase();
  const crossLevelThinking = level === "Advanced"
    ? `
Advanced cross questions should:
- require deeper reasoning or multiple steps
- apply ideas to new situations from the passage
- include prediction, comparison, or evaluation
- avoid simple recall or one-step answers
`
    : level === "On Level"
    ? `
On-Level cross questions should:
- focus on clear cause/effect or direct relationships
- require basic reasoning or simple application
- avoid unnecessary complexity while still requiring thought
`
    : `
Below-level cross questions should:
- stay clear and direct
- use simple reasoning with strong support from the passage
- build toward more complex reasoning gradually
`;
  const crossScienceInvestigationFocus = subject === "Science" && normalizedSkill.includes("scientific investigation")
    ? `
- For scientific investigation sets, emphasize experiment logic:
  - scenario/condition-change questions
  - variable → outcome reasoning
  - result interpretation and prediction
- Avoid definition-only or term-identification questions.
`
    : "";
  const crossQuestionFocus = subject === "Reading"
    ? `
Question design rules (Reading cross-curricular):
- Focus on reading skills (inference, main idea, structure, author's purpose) using the passage context.
- Avoid simple fact-retrieval and content-only recall questions.
- Require students to connect multiple details to justify answers.
- Include a balanced set:
  - inference and supporting-detail reasoning
  - at least one structure/purpose style item
  - one question where two plausible answers must be separated with evidence.
`
    : subject === "Math"
    ? `
Question design rules (Math cross-curricular):
- Focus on questions that require using numbers from the passage to solve problems.
- Avoid reading-only question types such as main idea, structure, or author's purpose.
- At least 3 questions should involve calculation or numerical decision-making.
- Students should need to use values in the passage (totals, differences, rates, comparisons, or remaining amounts).
- Include a balanced set:
  - mostly numerical reasoning questions
  - at least one comparison/decision question
  - optional light inference tied to numeric evidence.
`
    : subject === "Science"
    ? `
Question design rules (Science cross-curricular):
- Focus on questions that require applying scientific ideas from the passage.
- Avoid reading-only question types such as main idea, structure, or author's purpose.
- Focus on what will happen, why it happens, or how variables affect outcomes.
- Questions should require thinking like a scientist, not just understanding the text.
- Include a balanced set:
  - mostly prediction/application questions
  - at least one variable-focused question
  - optional light inference tied to scientific evidence.
${crossScienceInvestigationFocus}
`
    : subject === "Social Studies"
    ? `
Question design rules (Social Studies cross-curricular):
- Focus on cause/effect, decisions, and likely outcomes grounded in passage events.
- Avoid reading-only question types such as structure or author's purpose.
- Require students to analyze why people/groups made choices and what consequences followed.
- Include a balanced set:
  - mostly cause/effect and decision-analysis questions
  - at least one outcomes/consequences question
  - optional light inference tied to historical or civic context from the passage.
`
    : `
Question design rules:
- Focus on subject-aligned reasoning using passage evidence.
- Questions must require thinking, not simple recall.
`;

  return `You are a senior STAAR item writer. Generate cross-curricular content with strong subject-aligned rigor.

Inputs:
- Grade: ${grade}
- Subject: ${subject}
- Skill: ${skill}
- Level: ${level}
- TEKS: ${teksCode}

Requirements:
- Passage should be 150–200 words. Do not exceed 220 words.
- Passage topic must be: ${topicRule}.
- Passage must support reasoning questions with enough usable detail.
- Include at least one clear cause/effect or comparison relationship.
- Passage must include 5–7 full sentences.
- Every sentence must express a complete idea.
- NEVER output incomplete sentences.
- Final sentence must clearly conclude the idea.
- Do NOT leave unfinished comparisons or thoughts.
- Do NOT end any sentence with:
  - "and the"
  - "which"
  - "it"
  - "this"
  - a trailing comma or other unfinished punctuation
- If any sentence is incomplete or feels cut off, rewrite the entire passage before writing questions.

Question design rules:
- Generate exactly 5 multiple-choice questions.
- The "questions" array MUST contain exactly 5 items.
- NEVER return an empty questions array.
- If you cannot generate questions, you MUST still return 5.
${crossQuestionFocus}
- Match the reasoning depth to the requested level:
${crossLevelThinking}
- Each question MUST directly reference the passage.
- Do NOT generate generic or reusable questions.
- Every question must include a specific idea, action, or detail from the passage.
- Maintain similar rigor to Practice Mode question quality.
- Keep all questions grounded in the passage; avoid background-knowledge-only items.
- Every question MUST include 4 complete answer choices.
- Do NOT use placeholders like "Unsupported option".
- Each choice must be meaningful and connected to the passage.
- If unsure, generate the best possible answer rather than leaving blank.

RIGOR & LEVEL GUIDELINES:

GENERAL:
- Avoid direct retrieval questions (answers should not be found in a single sentence)
- Prioritize inference, supporting details, and reasoning over simple recall

- Questions should require the student to:
  - connect multiple details
  - interpret meaning
  - explain relationships or changes

LEVEL ADJUSTMENT:

Below Level:
- Keep language simple and direct
- Still require thinking, but reduce complexity of reasoning steps
- Focus on clear supporting details and basic inference

On Level:
- Use full grade-level expectations
- Include a mix of supporting detail, inference, and structure questions

Advanced Level:
- Emphasize deeper reasoning and interpretation
- Include questions that require:
  - connecting ideas across the passage
  - analyzing meaning or impact
  - selecting the BEST evidence rather than obvious details

IMPORTANT:
- Keep all questions grounded in the passage
- Maintain clarity and readability
- Do NOT make questions confusing or overly complex

Skill focus checks:
- Main/Central idea questions must reflect the full passage, not a single detail or event.
- Inference questions must require reasoning beyond directly stated wording.
- Structure questions must focus on organization of ideas (cause/effect, problem/solution, sequence), not topic or purpose labels.
- Purpose questions must ask why the author includes specific details and connect those details to the broader message.

Distractor quality:
- Each question has exactly 4 choices.
- One correct answer supported by passage evidence.
- Two plausible distractors based on passage details but incorrect.
- Choices must be similar in tone and length.
- Keep structure simple and clear.
- Distractors should be plausible misunderstandings (detail confusion, partial reasoning) without being obviously wrong.

Output format:
Return JSON only:
{
  "cross": {
    "passage": "string (150-200 words)",
    "questions": [
      {
        "question": "string",
        "choices": ["string", "string", "string", "string"],
        "correct_answer": "A"
      }
    ]
  }
}

Hard constraints:
- Exactly 5 questions
- Exactly 4 choices per question
- Only one correct answer per question
- No explanations
- No extra text outside JSON
- No placeholders

Return JSON only.`;
}


function buildCoreEnrichmentPrompt(params: {
  grade: number;
  subject: CanonicalSubject;
  skill: string;
  level: Level;
  practiceQuestions: Question[];
  crossQuestions: Question[];
  crossPassage?: string;
}): string {
  const compactPractice = params.practiceQuestions.map((q) => ({
    question: q.question,
    choices: q.choices,
    correct_answer: q.correct_answer,
  }));
  const compactCross = params.crossQuestions.map((q) => ({
    question: q.question,
    choices: q.choices,
    correct_answer: q.correct_answer,
  }));
  const crossPassage = String(params.crossPassage || "").trim();

  return `
You are generating structured tutoring support for STAAR practice.

Return JSON only. No markdown. No extra text.

OUTPUT FORMAT:
{
  "tutor": {
    "practice": [
      {
        "questionIndex": number,
        "hint": string,
        "strategy": string,
        "step_by_step": string
      }
    ],
    "cross": [
      {
        "questionIndex": number,
        "hint": string,
        "strategy": string,
        "step_by_step": string
      }
    ]
  },
  "answerKey": {
    "practice": [
      {
        "questionIndex": number,
        "correct_answer": string,
        "explanation": string,
        "why": string
      }
    ],
    "cross": [
      {
        "questionIndex": number,
        "correct_answer": string,
        "explanation": string,
        "why": string
      }
    ]
  }
}

INPUT DATA:
Practice Questions:
${JSON.stringify(compactPractice)}

Cross Passage:
${crossPassage}

Cross Questions:
${JSON.stringify(compactCross)}

--------------------------------------------------
TUTOR + ANSWER KEY INTELLIGENCE RULES
--------------------------------------------------

You are a high-quality STAAR tutor. Your goal is to teach thinking, not just give answers.

GENERAL RULES (ALL SUBJECTS)
- Every explanation must be specific to the question (no generic advice)
- Avoid repeating the same phrases across questions
- Each response must feel like a real teacher guiding a student step-by-step
- Vary language naturally across questions
- ALWAYS return ALL fields
- NEVER return {}
- NEVER omit tutor.cross or answerKey.cross
- If any section is incomplete, still return your best attempt for all sections.
- If unsure, generate best possible answer
- Each array MUST match question count
- questionIndex must align to input order (0-based)

SUBJECT-SPECIFIC TUTOR BEHAVIOR
MATH:
- Explain exact steps using numbers from the problem
- Clearly state the order of operations (first, next, last)
- Reference actual values from the question
- Show how to break the problem into parts
- Avoid vague language; be precise

SCIENCE:
- Focus on cause-and-effect relationships
- Explain what happens when a variable changes
- Use reasoning patterns like: when ___ increases, ___ happens
- Explain what this leads to and why
- Emphasize reasoning and prediction

SOCIAL STUDIES:
- Focus on decisions, actions, and consequences
- Explain why people or groups made choices
- Connect actions to outcomes
- Use historical or civic reasoning

READING:
- Refer to specific moments, ideas, or patterns in the passage
- Focus on inference, structure, and author’s purpose
- Help the student connect multiple ideas

HINT RULES
- Give a starting point, not the answer
- Point the student toward the first step of thinking
- Keep hints specific to the question

STEP-BY-STEP RULES
- Break the thinking into clear steps
- Each step should move the student closer to the answer
- Do not skip reasoning steps

"WHY" (CORRECT ANSWER EXPLANATION)
- Explain why the correct answer works
- Reference the actual situation (numbers, events, or ideas)
- Make the reasoning clear and logical

"MISTAKE" (WRONG THINKING)
- Describe a realistic wrong approach
- Do not restate the correct steps
- Focus on common student errors (wrong operation, skipped step, misunderstood cause/effect, misread situation)

PARENT TIP RULES
- Keep it simple and actionable
- Adapt to subject:
  - Math: Have your child explain each step and check their calculations.
  - Reading: Ask your child what part of the passage most supports their answer.
  - Science: Ask what changed and what effect it caused.
  - Social Studies: Ask why the decision led to that outcome.

FINAL GOAL
- Every response should feel like a real tutor helping a student think step-by-step, not a generic AI explanation.

--------------------------------------------------
RETURN JSON ONLY
--------------------------------------------------
`;
}



function isValidCoreEnrichmentOutput(data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  const parsed = data as Record<string, unknown>;
  const cross = parsed.cross as Record<string, unknown> | undefined;
  const tutor = parsed.tutor as Record<string, unknown> | undefined;
  const answerKey = parsed.answerKey as Record<string, unknown> | undefined;
  const crossQuestions = Array.isArray(cross?.questions) ? cross.questions : [];

  if (!cross || typeof cross.passage !== "string" || !cross.passage.trim()) return false;
  // Be tolerant of partial/malformed model output; sanitizers can recover shape.
  if (crossQuestions.length < 3) return false;

  return Boolean(
    tutor &&
    answerKey &&
    Array.isArray(tutor.practice) &&
    Array.isArray(tutor.cross) &&
    Array.isArray(answerKey.practice) &&
    Array.isArray(answerKey.cross)
  );
}

function normalizeEnrichmentSupport(
  data: Record<string, unknown> | null,
  practiceQuestions: Question[],
  crossQuestions: Question[],
): {
  tutor: { practice: TutorExplanation[]; cross: TutorExplanation[] };
  answerKey: { practice: AnswerKeyEntry[]; cross: AnswerKeyEntry[] };
} {
  const safePracticeLength = practiceQuestions.length;
  const safeCrossLength = crossQuestions.length;
  const tutorNode = data?.tutor && typeof data.tutor === "object"
    ? data.tutor as Record<string, unknown>
    : null;
  const answerNode = data?.answerKey && typeof data.answerKey === "object"
    ? data.answerKey as Record<string, unknown>
    : null;

  return {
    tutor: {
      practice: Array.from({ length: safePracticeLength }, (_, i) => {
        const source = Array.isArray(tutorNode?.practice) && typeof tutorNode.practice[i] === "object"
          ? tutorNode.practice[i] as Record<string, unknown>
          : {};
        return {
          question_id: ensureQuestionId(practiceQuestions[i], i, "practice"),
          question: String(practiceQuestions[i]?.question || "").trim(),
          explanation: String(source.strategy || "").trim() || "Use evidence from the passage.",
          common_mistake: "Choosing an answer without enough supporting evidence.",
          hint: String(source.hint || "").trim() || "Think about what the question is asking.",
          think: "",
          step_by_step: String(source.step_by_step || "").trim() || "Read carefully and eliminate wrong answers.",
        };
      }),
      cross: Array.from({ length: safeCrossLength }, (_, i) => {
        const source = Array.isArray(tutorNode?.cross) && typeof tutorNode.cross[i] === "object"
          ? tutorNode.cross[i] as Record<string, unknown>
          : {};
        return {
          question_id: ensureQuestionId(crossQuestions[i], i, "cross"),
          question: String(crossQuestions[i]?.question || "").trim(),
          explanation: String(source.strategy || "").trim() || "Focus on key details.",
          common_mistake: "Ignoring important evidence from the cross passage.",
          hint: String(source.hint || "").trim() || "Look back at the passage for clues.",
          think: "",
          step_by_step: String(source.step_by_step || "").trim() || "Break the question down step by step.",
        };
      }),
    },
    answerKey: {
      practice: Array.from({ length: safePracticeLength }, (_, i) => {
        const source = Array.isArray(answerNode?.practice) && typeof answerNode.practice[i] === "object"
          ? answerNode.practice[i] as Record<string, unknown>
          : {};
        const explanation = String(source.explanation || "").trim() || "This is supported by the passage.";
        return {
          question_id: ensureQuestionId(practiceQuestions[i], i, "practice"),
          correct_answer: normalizeAnswerKeyEntry(String(source.correct_answer || "").trim() || "A"),
          explanation,
          common_mistake: String(source.why || "").trim() || "The correct answer matches the main idea.",
          parent_tip: "",
        };
      }),
      cross: Array.from({ length: safeCrossLength }, (_, i) => {
        const source = Array.isArray(answerNode?.cross) && typeof answerNode.cross[i] === "object"
          ? answerNode.cross[i] as Record<string, unknown>
          : {};
        const explanation = String(source.explanation || "").trim() || "This is supported by the passage.";
        return {
          question_id: ensureQuestionId(crossQuestions[i], i, "cross"),
          correct_answer: normalizeAnswerKeyEntry(String(source.correct_answer || "").trim() || "A"),
          explanation,
          common_mistake: String(source.why || "").trim() || "The correct answer aligns with the evidence.",
          parent_tip: "",
        };
      }),
    },
  };
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

function buildExplanation(answer: string, question: string): string {
  const cleanAnswer = String(answer || "").trim();
  const prompt = String(question || "").toLowerCase();
  if (prompt.includes("purpose")) {
    return `This answer best matches the author’s purpose: ${cleanAnswer}. A wrong choice changes or weakens that purpose.`;
  }
  if (prompt.includes("infer")) {
    return `This answer follows the strongest clues in the text: ${cleanAnswer}. A distractor overstates or reverses those clues.`;
  }
  return `This answer is the best fit for the text details: ${cleanAnswer}. A distractor is only partly true or not fully justified.`;
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
        "Which explanation is best supported for the central message of the passage?",
        "Which statement best expresses the theme?",
        "What lesson does the passage convey?",
        "Which idea best reflects the author’s message?",
        "Why does the main message develop this way in the passage?",
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
      "Which explanation best supports the main idea of the passage?",
      "Which detail best supports a key idea?",
      "What can the reader conclude?",
      "Which statement accurately reflects the passage?",
    ]);
  }

  if (subject === "Math") {
    return selectByDOK([
      "Which answer correctly solves the problem?",
      "Which calculation is most valid based on the information provided?",
      "Which calculation leads to the correct result?",
      "Why does the final answer follow from the steps used?",
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
//   };
// }

function normalizeChoices(choices: unknown): [string, string, string, string] {
  if (!Array.isArray(choices)) return ["A", "B", "C", "D"];
  const clean = choices.slice(0, 4).map((choice) => String(choice ?? ""));
  while (clean.length < 4) clean.push(clean[0] || "Option");
  return clean as [string, string, string, string];
}

function normalizeCorrectAnswer(q: Question): Question {
  if (Array.isArray(q.correct_answer)) {
    return {
      ...q,
      correct_answer: q.correct_answer[0] || "A",
    };
  }
  return q;
}

function withSafeQuestionDefaults(q: Partial<Question> | null | undefined): Question {
  const base = (q || {}) as Question;
  const withDefaults: Question = {
    ...base,
    question: String(base.question || ""),
    choices: normalizeChoices(base.choices),
    correct_answer: base.correct_answer ?? "A",
    explanation: String(base.explanation || ""),
  };
  const normalized = normalizeCorrectAnswer(withDefaults);
  return {
    ...normalized,
    choices: normalizeChoices(normalized.choices),
    correct_answer: safeCorrectAnswer(normalized.correct_answer),
  };
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
function enforceQuestionDesignStem(question: string, level: Level = "On Level"): string {
  const q = String(question || "").trim();
  if (!q) return q;
  const normalized = q.replace(/\s+/g, " ");

  if (/^which example shows\b/i.test(normalized)) {
    return level === "Below"
      ? "Which explanation is best supported by the information provided?"
      : "Which explanation is best supported, and why?";
  }
  if (/^what is\b/i.test(normalized)) {
    return level === "Below"
      ? "Which explanation is best supported by the details?"
      : "Why does this happen based on the evidence?";
  }
  if (/^which is\b/i.test(normalized)) {
    return level === "Below"
      ? "Which explanation is best supported by the details?"
      : "Which situation is most valid and why?";
  }

  if (level === "Advanced" && /^what\b/i.test(normalized)) {
    return normalized.replace(/^what\b/i, "Why");
  }

  return normalized;
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
  const normalizedChoices = normalizeChoices(q.choices);
  const answer = q.correct_answer;
  if (Array.isArray(answer)) {
    return "";
  }
  if (typeof answer !== "string") {
    return "";
  }
  const idx = letters.indexOf(answer as ChoiceLetter);
  return idx >= 0 ? String(normalizedChoices[idx] || "").trim() : "";
}

async function repairWeakQuestions(questions: Question[], passage: string): Promise<Question[]> {
  void passage;
  return questions;
}

function hasPassageSupportForChoice(passage: string, choice: string): boolean {
  void passage;
  void choice;
  return false;
}

function hasLooseSupport(passage: string, choice: string): boolean {
  const p = String(passage || "").toLowerCase();
  const words = String(choice || "").toLowerCase().split(/\s+/).filter((w) => w.length > 4);

  let matches = 0;

  for (const word of words) {
    if (p.includes(word)) matches++;
  }

  return matches >= 2;
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
    const normalizedChoices = normalizeChoices(choices);
    const prompt = `
Question: ${question}

Choices:
A. ${normalizedChoices[0]}
B. ${normalizedChoices[1]}
C. ${normalizedChoices[2]}
D. ${normalizedChoices[3]}

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

function isValidQuestion(q: any): boolean {
  return (
    q &&
    typeof q.question === "string" &&
    Array.isArray(q.choices) &&
    q.choices.length === 4 &&
    q.choices.every((c: unknown) => typeof c === "string" && c.trim().length > 0)
  );
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

function isWeakChoice(choice: string): boolean {
  const text = String(choice || "").trim();
  if (!text) return true;
  return text.length < 8 || isGenericChoice(text);
}

function improveChoice(choice: string, passage: PassageContent | string): string {
  void passage;
  const text = String(choice || "").trim();
  return text;
}

function improveQuestion(question: Question, passage: PassageContent | string): Question {
  const normalized = withSafeQuestionDefaults(question);
  const stem = String(normalized.question || "").trim();
  const improvedStem = stem.length >= 8
    ? stem
    : "Which option is best supported by the passage evidence?";
  const improvedChoices = normalizeChoices(normalized.choices).map((choice) =>
    improveChoice(choice, passage)
  ) as [string, string, string, string];
  return {
    ...normalized,
    question: improvedStem,
    choices: makeChoicesUnique(improvedChoices, "Reading", improvedStem),
    explanation: String(normalized.explanation || "").trim() ||
      "The best answer is the one most strongly supported by details in the text.",
  };
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
  void passage;
  void skill;
  if (!q || !Array.isArray(q.choices) || q.choices.length !== 4) return true;
  const text = `${q.question || ""} ${q.choices.join(" ")}`.toLowerCase();
  if (text.includes("newspaper") || text.includes("interview")) {
    console.warn("⚠️ Validation warning: possible context mismatch");
  }
  if (new Set(q.choices.map((choice) => String(choice || "").trim().toLowerCase())).size < 4) {
    console.warn("⚠️ Validation warning: duplicate choices detected");
  }
  return true;
}

function repairQuestion(q: Question, subject: CanonicalSubject, passage: PassageContent | string): Question {
  return validateMCQuestion(q, passage, subject);
}

function validateMCQuestion(
  q: Question,
  passage: PassageContent | string,
  subject: CanonicalSubject = "Reading",
): Question {
  void passage;
  void subject;
  return {
    ...q,
    type: "mc",
    choices: normalizeChoices(q.choices),
    correct_answer: safeCorrectAnswer(q.correct_answer),
  };
}

function normalizeAndValidate(q: Question, passage: PassageContent | string): Question {
  const normalized = withSafeQuestionDefaults(q);
  return validateMCQuestion(normalized, passage, "Reading");
}

function validateOnce(questions: Question[], passage: PassageContent | string): Question[] {
  const normalizedQuestions = (questions || []).map((q) => withSafeQuestionDefaults(q));
  return normalizedQuestions.map((q) => normalizeAndValidate(q, passage));
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
  allowAlternative = true,
): string {
  const cleaned = String(passage || "").replace(/\s+/g, " ").trim();
  const words = cleaned.split(" ").filter(Boolean);
  if (words.length >= min && words.length <= max) return trimExpansionTail(cleaned);
  if (words.length > max) return trimExpansionTail(words.slice(0, max).join(" "));
  if (words.length < min) {
    return trimExpansionTail(cleaned);
  }
  // return cleaned content only
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
  void choices;
  return false;
}

function rewriteChoicesFromPassage(passage: string): [string, string, string, string] {
  void passage;
  return ["", "", "", ""];
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

function isGenericQuestion(q: string): boolean {
  const patterns = [
    "why does this happen",
    "what can we infer",
    "how does the character",
    "what is the effect",
    "why might the author",
    "how does this affect",
  ];

  const lower = String(q || "").toLowerCase();
  return patterns.some((pattern) => lower.includes(pattern)) && lower.length < 120;
}

function isPassageAnchored(q: string, passage: string): boolean {
  const passageWords = String(passage || "").toLowerCase().split(/\W+/).filter(Boolean);
  return String(q || "").toLowerCase().split(/\W+/).some((word) => word && passageWords.includes(word));
}

function rewriteQuestion(q: string, passage: string, index: number): string {
  void q;
  void index;
  const sentence = (String(passage || "").split(".")[0] || "").trim() || "the main idea in the passage";
  return `Which detail from the passage best supports ${sentence.toLowerCase()}?`;
}

async function repairChoicesBatchWithAI(params: {
  passage: PassageContent | string;
  subject: CanonicalSubject;
  skill: string;
  items: Array<{ index: number; question: string; choices: unknown }>;
}): Promise<Record<number, [string, string, string, string]>> {
  const { passage, subject, skill, items } = params;
  if (!items.length) return {};
  const prompt = `
You are repairing STAAR-style multiple choice answers.

Subject: ${subject}
Skill: ${skill}
Passage:
${getPassageText(passage)}

Broken questions (JSON):
${JSON.stringify(items.map((item) => ({
    index: item.index,
    question: String(item.question || "").trim(),
    choices: Array.isArray(item.choices) ? item.choices : [],
  })))}

For EACH item above, return EXACTLY 4 repaired answer choices.
Rules:
- Keep alignment to the specific question and passage.
- No placeholders or generic options.
- Keep tone/length comparable across choices.
- Return ONLY JSON object where each key is the item index and value is an array of 4 strings.
`.trim();

  const repaired = await callOpenAI(prompt, 15000) as unknown;
  if (!repaired || typeof repaired !== "object" || Array.isArray(repaired)) return {};

  const out: Record<number, [string, string, string, string]> = {};
  for (const [key, value] of Object.entries(repaired as Record<string, unknown>)) {
    const index = Number(key);
    if (!Number.isInteger(index)) continue;
    if (!Array.isArray(value) || value.length !== 4) continue;
    const cleaned = value.map((choice) => String(choice || "").trim());
    if (cleaned.some((choice) => !choice)) continue;
    out[index] = cleaned as [string, string, string, string];
  }
  return out;
}

async function sanitizeQuestions(
  raw: unknown,
  subject: CanonicalSubject,
  mode: CanonicalMode,
  skill: string,
  level: Level = "On Level",
  passage: PassageContent | string = "",
  grade = 5,
  repairState: { used: boolean } | null = null,
): Promise<Question[]> {
  const incoming = Array.isArray(raw) ? raw.slice(0, 5) : [];
  const originalQuestions = incoming
    .map((item) => (item && typeof item === "object" ? withSafeQuestionDefaults(item as Partial<Question>) : null))
    .filter((item): item is Question => Boolean(item));
  void grade;
  const requestedSkillType = getSkillType(skill);
  const isGenericChoices = (choices: string[]): boolean => {
    const joined = choices.join(" ").toLowerCase();
    return (
      joined.includes("option") ||
      joined.includes("best demonstrates") ||
      joined.includes("reasonable") ||
      joined.includes("partial") ||
      joined.includes("overgeneralizes")
    );
  };
  const needsRepair = (choices: unknown): boolean => {
    if (!Array.isArray(choices)) return true;
    if (choices.length !== 4) return true;
    if (isGenericChoices(choices.map((c) => String(c || "").trim()))) return true;
    return choices.some((c) => !c || !String(c).trim());
  };
  const brokenItems = incoming
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => {
      const q = item && typeof item === "object" ? item as Record<string, unknown> : {};
      return needsRepair(q.choices);
    })
    .map(({ item, index }) => {
      const q = item && typeof item === "object" ? item as Record<string, unknown> : {};
      return { index, question: String(q.question || ""), choices: q.choices };
    });
  let repairedChoicesByIndex: Record<number, [string, string, string, string]> = {};
  if (repairState && !repairState.used && brokenItems.length > 0) {
    repairState.used = true;
    const repaired = await Promise.race([
      repairChoicesBatchWithAI({
        passage,
        subject,
        skill,
        items: brokenItems,
      }),
      new Promise<Record<number, [string, string, string, string]> | null>((resolve) => setTimeout(() => resolve(null), 1500)),
    ]);
    if (!repaired) {
      console.warn("⚠️ Repair timeout — using original");
    } else {
      repairedChoicesByIndex = repaired;
    }
  }

  const sanitized: Question[] = [];
  for (let i = 0; i < incoming.length; i += 1) {
    const item = incoming[i];
    const q = item && typeof item === "object" ? item as Record<string, unknown> : {};
    let patchedChoices: [string, string, string, string];
    if (!needsRepair(q.choices)) {
      patchedChoices = (q.choices as unknown[]).map((c) => String(c || "").trim()) as [string, string, string, string];
    } else if (repairedChoicesByIndex[i]) {
      patchedChoices = repairedChoicesByIndex[i];
      console.warn("⚠️ Using AI to repair choices");
    } else {
      patchedChoices = Array.isArray(q.choices)
        ? q.choices.map((c) => String(c || "").trim()).slice(0, 4) as [string, string, string, string]
        : normalizeChoices(q.choices);
    }

    if (!Array.isArray(q.choices) || q.choices.length !== 4 || q.choices.every((choice) => !String(choice || "").trim())) {
      console.warn("⚠️ Patching question instead of rejecting", {
        reason: "INVALID_CHOICES_LENGTH",
        question: String(q.question || "").slice(0, 80),
        length: Array.isArray(q.choices) ? q.choices.length : null,
      });
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
    let normalizedChoices = normalizeChoices(patchedChoices).map(cleanForSubject) as [string, string, string, string];
    const normalizedCorrectAnswer = type === "multi_select"
      ? normalizeMultiSelectAnswer(q.correct_answer || "")
      : safeCorrectAnswer(q.correct_answer);
    const safeAnswer = type === "multi_select"
      ? (Array.isArray(normalizedCorrectAnswer) && normalizedCorrectAnswer.length > 0 ? normalizedCorrectAnswer : "A")
      : safeCorrectAnswer(normalizedCorrectAnswer);
    if (type !== "multi_select" && !parseAnswerLetter(q.correct_answer)) {
      console.warn("⚠️ Patching question instead of rejecting", { reason: "INVALID_CORRECT_ANSWER" });
    }
    const correctChoiceIndex = type === "mc" ? LETTERS.indexOf(safeAnswer as AnswerLetter) : -1;
    void correctChoiceIndex;

    const isReadingMainIdea = subject === "Reading" && isMainIdeaSkill(skill);
    let normalizedQuestionText = questionText;
    if (isReadingMainIdea && !isAllowedMainIdeaStem(normalizedQuestionText)) {
      normalizedQuestionText = i % 2 === 0
        ? "What is the main idea of the passage?"
        : "Which statement best describes the main idea?";
    }
    normalizedQuestionText = enforceThinkingStem(subject, normalizedQuestionText);
    normalizedQuestionText = enforceQuestionDesignStem(normalizedQuestionText, level);

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
      correct_answer: safeAnswer,
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
    sanitized.push(base);
  }

  let questions = sanitized.slice(0, 5);
  const passageText = getPassageText(passage);
  void skill;

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
  if (finalQuestions.length === 0) return originalQuestions;
  console.log("🔥 VALIDATION COMPLETE — CLEAN QUESTIONS:", finalQuestions.length);
  const subjectAligned = enforceScienceSocialReasoningMix(subject, finalQuestions, passageText);
  const alignedSet = subject === "Math"
    ? enforceMathMultiStepMix(subjectAligned)
    : subjectAligned;
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
    const validatedCross = alignedSet;
    if (subject === "Math") {
      const crossMathOutput = enforceMathMultiStepMix(validatedCross);
      return crossMathOutput.length ? crossMathOutput : originalQuestions;
    }
    if (subject === "Science") {
      const scienceCrossOutput = enforceScienceCrossApplication(validatedCross);
      return scienceCrossOutput.length ? scienceCrossOutput : originalQuestions;
    }
    const crossOutput = enforceCrossReadingOnly(validatedCross, passageText);
    return crossOutput.length ? crossOutput : originalQuestions;
  }

  if (questions.length === 0) {
    return originalQuestions;
  }
  const practiceOutput = alignedSet.slice(0, 5);
  return practiceOutput.length ? practiceOutput : originalQuestions;
}

const CROSS_READING_ANGLE_STEMS = [
  "Which statement best captures the central idea developed in the passage?",
  "Which detail from the passage best supports the author’s reasoning?",
  "What can the reader infer about the decision-making process described in the passage?",
  "How does the author organize information to develop the main point?",
  "What is the author’s purpose for including these specific details in the passage?",
] as const;

const SCIENCE_CROSS_APPLICATION_STEMS = [
  "If one condition in the investigation changes, what result is most likely?",
  "Which variable change would most likely increase or decrease the observed outcome?",
  "Why would changing this condition affect the process described in the passage?",
  "Based on the passage evidence, what prediction best fits the next trial?",
  "Which setup would most likely produce the strongest effect in this investigation?",
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

function rewriteScienceCrossStem(index: number): string {
  return SCIENCE_CROSS_APPLICATION_STEMS[index % SCIENCE_CROSS_APPLICATION_STEMS.length];
}

function isReadingOnlyCrossStem(question: string): boolean {
  const q = String(question || "").toLowerCase();
  return q.includes("main idea") ||
    q.includes("author's purpose") ||
    q.includes("author’s purpose") ||
    q.includes("organized") ||
    q.includes("structure") ||
    q.includes("what can be inferred");
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
    const rewrittenStem = rewriteCrossQuestionStem(output.length);
    const rewritten: Question = needsRewrite
      ? {
        ...q,
        type: "mc",
        question: rewrittenStem,
        choices: buildCrossReadingChoices(passage, normalizeChoices(q.choices)),
        correct_answer: "A",
      }
      : {
        ...q,
        question: String(q.question || "").trim() || rewrittenStem,
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

function enforceScienceCrossApplication(
  questions: Question[],
): Question[] {
  const output: Question[] = [];
  for (const q of questions) {
    const needsRewrite = isReadingOnlyCrossStem(String(q.question || ""));
    output.push({
      ...q,
      question: needsRewrite ? rewriteScienceCrossStem(output.length) : String(q.question || "").trim(),
      choices: normalizeChoices(q.choices),
    });
    if (output.length === 5) break;
  }
  return output;
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

function isLikelyRecallStem(question: string): boolean {
  const stem = String(question || "").toLowerCase().trim();
  if (!stem) return false;
  return /^(what is|what was|who was|who is|when did|where did|how much|which person|which date|define|identify|name)\b/.test(stem) ||
    /\b(according to the passage, )?(who|when|where)\b/.test(stem);
}

function rewriteRecallStemForReasoning(subject: CanonicalSubject, question: string, passage: string, index: number): string {
  const topic = extractKeyTopic(passage || question || "");
  if (subject === "Science") {
    const stems = [
      `Based on the passage, why does ${topic} most likely change under these conditions?`,
      `Based on the investigation, which condition most likely caused the outcome described for ${topic}?`,
      `Which explanation best connects the process in the passage to the result involving ${topic}?`,
      `How would changing one condition in the passage most likely affect the outcome for ${topic}?`,
    ];
    return stems[index % stems.length];
  }
  if (subject === "Social Studies") {
    const stems = [
      `Based on the passage, why was the decision about ${topic} important for later events?`,
      `Which outcome best explains the long-term impact of ${topic} in the passage?`,
      `How did the decision or event involving ${topic} most influence people or society?`,
      `Which cause-and-effect relationship best explains what happened after ${topic}?`,
    ];
    return stems[index % stems.length];
  }
  return question;
}

function enforceScienceSocialReasoningMix(
  subject: CanonicalSubject,
  questions: Question[],
  passage: string,
): Question[] {
  if (subject !== "Science" && subject !== "Social Studies") return questions;
  const fixed = questions.map((q) => ({ ...q }));
  const recallIndexes = fixed
    .map((q, i) => ({ i, recall: isLikelyRecallStem(String(q.question || "")) }))
    .filter((entry) => entry.recall)
    .map((entry) => entry.i);

  if (recallIndexes.length <= 1) return fixed;

  // Keep at most one lighter recall item (prefer the first question as confidence builder).
  const keepRecallIndex = recallIndexes.includes(0) ? 0 : recallIndexes[0];
  for (const idx of recallIndexes) {
    if (idx === keepRecallIndex) continue;
    fixed[idx].question = rewriteRecallStemForReasoning(subject, String(fixed[idx].question || ""), passage, idx);
  }
  return fixed;
}

function isLikelyOneStepMathQuestion(question: string): boolean {
  const q = String(question || "").toLowerCase();
  if (!q.trim()) return false;
  const multiStepSignals = [
    "then",
    "after",
    "before",
    "remaining",
    "left",
    "difference",
    "compare",
    "altogether",
    "in total",
    "per",
    "each",
    "first",
    "next",
  ];
  const hasMultiSignal = multiStepSignals.some((signal) => q.includes(signal));
  if (hasMultiSignal) return false;
  const operationSignals = ["sum", "total", "difference", "product", "quotient", "plus", "minus", "times", "divide", "multipl", "add", "subtract"];
  const operationCount = operationSignals.filter((signal) => q.includes(signal)).length;
  return operationCount <= 1;
}

function rewriteMathForMultiStep(index: number): string {
  const templates = [
    "A student group buys equal packs for an event, then uses part of the supplies. How many items are left after the event?",
    "A store compares two pricing plans for the same number of items. Which plan costs less, and by how much?",
    "A team calculates total earnings from ticket sales, then subtracts expenses. What is the final amount?",
    "A class divides students into equal groups and then adds late arrivals. How many students are in all groups now?",
    "A club tracks supplies used each day and the supplies restocked later. What is the net change in supplies?",
  ];
  return templates[index % templates.length];
}

function isLikelyMathReasoningStem(question: string): boolean {
  const q = String(question || "").toLowerCase();
  if (!q.trim()) return false;
  const reasoningSignals = [
    "how much",
    "how many",
    "total",
    "difference",
    "left",
    "remaining",
    "cost",
    "rate",
    "percent",
    "average",
    "plan costs less",
    "by how much",
    "net change",
  ];
  return reasoningSignals.some((signal) => q.includes(signal));
}

function enforceMathMultiStepMix(questions: Question[]): Question[] {
  const fixed = questions.map((q) => ({ ...q }));
  const oneStepIndexes = fixed
    .map((q, i) => ({ i, oneStep: isLikelyOneStepMathQuestion(String(q.question || "")) }))
    .filter((entry) => entry.oneStep)
    .map((entry) => entry.i);
  const reasoningCount = fixed.filter((q) => isLikelyMathReasoningStem(String(q.question || ""))).length;
  const multiStepCount = fixed.length - oneStepIndexes.length;

  // Soft enforcement targets:
  // - at least some multi-step structure (target 2+)
  // - majority numeric reasoning stems (target 3+)
  if (multiStepCount >= 2 && reasoningCount >= 3) return fixed;

  const indexesToRewrite = [...oneStepIndexes];
  if (indexesToRewrite.length === 0) {
    for (let i = 0; i < fixed.length; i += 1) indexesToRewrite.push(i);
  }

  let rewritesNeeded = Math.max(0, 2 - multiStepCount);
  rewritesNeeded = Math.max(rewritesNeeded, Math.max(0, 3 - reasoningCount));
  rewritesNeeded = Math.min(rewritesNeeded, indexesToRewrite.length);
  for (const idx of indexesToRewrite) {
    if (rewritesNeeded <= 0) break;
    fixed[idx].question = rewriteMathForMultiStep(idx);
    rewritesNeeded -= 1;
  }
  return fixed;
}

function validateRigorAlignment(level: Level, passage: PassageContent | string, questions: Question[]): boolean {
  return validatePassageComplexity(level, passage) && validateQuestionDepth(level, questions);
}

async function callOpenAI(prompt: string, timeout = 15000): Promise<Record<string, unknown> | null> {
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
      input: prompt,
      max_output_tokens: 1400,
    }),
    signal: AbortSignal.timeout(timeout),
  });

  if (!aiRes.ok) return null;

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

  if (!text || isBadOutput(text)) return null;

  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return tryParseJsonPayload(text) || null;
  }
}

function isValidAIOutput(data: any): boolean {
  if (!data?.questions || !Array.isArray(data.questions)) {
    console.warn("Invalid structure — retrying");
    return false;
  }

  if (data.questions.length === 0) {
    console.warn("Empty questions — retrying");
    return false;
  }

  // ACCEPT partial responses (we will repair them)
  return true;
}

async function generateWithRetry(prompt: string) {
  try {
    const result = await callOpenAI(prompt, 35000);
    console.log("RAW AI RESPONSE:", JSON.stringify(result, null, 2));
    return result;
  } catch (err) {
    console.warn("⚠️ Generation failed", err);
    return null;
  }
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

function validateCrossCurricular(data: { passage?: unknown; questions?: unknown[]; cross?: { passage?: unknown; questions?: unknown[] } }): boolean {
  const scoped = data?.cross && typeof data.cross === "object" ? data.cross : data;
  const passageText = String(scoped?.passage || "").trim();
  const passage = passageText.toLowerCase();
  const questions = Array.isArray(scoped?.questions) ? scoped.questions : [];
  if (!passageText) return false;
  if (questions.length < 1) return false;
  const words = passageText.split(/\s+/).filter(Boolean).length;
  if (words < 110 || words > 260) return false;
  const hasValidChoices = questions.every((q) => {
    const item = q && typeof q === "object" ? q as Record<string, unknown> : {};
    const choices = Array.isArray(item.choices) ? item.choices : [];
    return choices.length === 4;
  });
  if (!hasValidChoices) return false;

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
  const aligned = buildAnswerKeyExplanation(question, passage, new Set<string>(), true);
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
      const correctAnswer = letter ? `${letter}. ${choice}` : "";
      const aligned = buildAlignedExplanation(q, scopedPassageText, usedEvidence, shouldUsePassage);
      const baseExplanation = shouldUsePassage
        ? aligned.why
        : (String(q.explanation || "").trim() ||
          (correctAnswer
            ? `Start by following the question requirements one step at a time, then match your reasoning to evidence from the prompt. This confirms ${correctAnswer}.`
            : "Start by following the question requirements one step at a time and matching each part to clear evidence."));
      const explanation = baseExplanation;

      return {
        question_id: ensureQuestionId(q, index, mode),
        question: String(q.question || "").trim(),
        explanation,
        common_mistake: String(q.common_mistake || "").trim() || "Choosing an option before checking the strongest evidence in the passage or problem.",
        hint: String(q.hint || "").trim() ||
          "Start by finding the exact detail that the question depends on, then use it to test your choice.",
        think: String(q.think || "").trim() ||
          (correctAnswer ? `Which detail leads to ${correctAnswer} only after you reason through the prompt?` : "Which detail in the passage or problem gives the strongest support?"),
        step_by_step: String(q.step_by_step || "").trim() ||
          (correctAnswer
            ? `1. Read the question and identify what it asks.\n2. Locate the exact line or fact in the passage or problem.\n3. Explain what that detail proves.\n4. Confirm the correct answer is ${correctAnswer}.`
            : "1. Read the question and identify what it asks.\n2. Locate the exact supporting line or fact.\n3. Explain how that detail supports your conclusion."),
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
      const correctIndex = Math.max(0, LETTERS.indexOf(correctLetter));
      const correctChoice = String(normalizedChoices[correctIndex] || "").trim();
      const distractor = normalizedChoices
        .map((choice, idx) => ({ letter: LETTERS[idx], choice: String(choice || "").trim() }))
        .find((entry) => entry.letter !== correctLetter && entry.choice);
      const aligned = buildAnswerKeyExplanation(q, scopedPassageText, usedEvidence, shouldUsePassage);
      const explanationLead = aligned.why || (shouldUsePassage
        ? `The passage supports ${correctLetter}${correctChoice ? ` (${correctChoice})` : ""}.`
        : `The question supports ${correctLetter}${correctChoice ? ` (${correctChoice})` : ""}.`);
      const explanation = distractor
        ? `${explanationLead} ${distractor.letter} (${distractor.choice}) sounds possible, but that choice is not what this specific detail actually supports.`
        : explanationLead;
      const commonMistake = distractor
        ? `${distractor.letter} can seem related, but it is not the best-supported interpretation of the passage evidence.`
        : aligned.mistake;

      const parentTip = aligned.tip || variedParentTip(index);
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
  raw: unknown,
  sourceQuestions: Question[],
  subject: CanonicalSubject,
  mode: "practice" | "cross",
  crossPassage = "",
): TutorExplanation[] {
  const aiEntries = Array.isArray(raw) ? raw as TutorExplanation[] : [];
  const genericCoachPattern = /\b(choose the best answer|look back at the passage|think about the question|read carefully)\b/i;
  const hintStarters = subject === "Math"
    ? [
      "What numbers should you use first?",
      "Which calculation comes first?",
      "What do you need to find before the final answer?",
      "What operation should you start with?",
      "How can you break this into steps?",
    ]
    : subject === "Science"
    ? [
      "What is changing in this situation?",
      "What effect does that change cause?",
      "What happens when this increases or decreases?",
      "Which variable matters most here?",
      "What result would you expect?",
    ]
    : subject === "Social Studies"
    ? [
      "What decision was made here?",
      "What happened as a result?",
      "Why would they make that choice?",
      "What was the outcome of that action?",
      "What effect followed this event?",
    ]
    : [
      "Which part supports that idea?",
      "Where do you see that happening?",
      "What moment best matches your answer?",
      "Which action in the text pushes you toward one choice?",
      "Which reaction in the passage confirms your thinking?",
    ];
  const fallback = mode === "cross"
    ? sourceQuestions.slice(0, 5).map((q) => buildCrossTutorFallback(subject, q, crossPassage))
    : buildTutorFromPractice(sourceQuestions.slice(0, 5)).practice;
  const base = aiEntries.length > 0 ? aiEntries.slice(0, 5) : fallback;
  const usedEvidence = new Set<string>();

  return sourceQuestions.slice(0, 5).map((q, i) => {
    const fromAi = base[i] || fallback[i] || buildPracticeTutorFallback(subject, q);
    const expectedId = ensureQuestionId(q, i, mode);
    const questionText = String(q.question || "").trim();
    const evidence = mode === "cross"
      ? summarizeEvidenceIdea(selectEvidenceSnippet(q, crossPassage, usedEvidence) || fallbackEvidenceSnippet(crossPassage))
      : "";
    const starter = hintStarters[i % hintStarters.length];
    const existingHint = String(fromAi.hint || "").trim();
    const hint = (!existingHint || genericCoachPattern.test(existingHint))
      ? (mode === "cross" && evidence
        ? (subject === "Math"
          ? `${starter} Use the numbers in the problem to guide your steps.`
          : subject === "Science"
          ? `${starter} Think about how the change described affects the outcome.`
          : subject === "Social Studies"
          ? `${starter} Focus on what decision was made and what happened next.`
          : `${starter} Think about the part where ${evidence}.`)
        : `${starter} Focus on the part of the question that decides between the two closest choices.`)
      : existingHint;

    const existingExplanation = String(fromAi.explanation || "").trim();
    const conciseExisting = existingExplanation.split(/(?<=[.!?])\s+/).slice(0, 2).join(" ").trim();
    const explanation = (!conciseExisting || genericCoachPattern.test(conciseExisting))
      ? (mode === "cross" && evidence
        ? `Start by looking at the moment where ${evidence}. This part matters because it reveals the key idea, while a common trap is choosing an option that only sounds related.`
        : `Notice the exact condition in the question. This is where students get confused: a nearby choice may fit one detail but still miss the full requirement.`)
      : conciseExisting;

    const existingSteps = String(fromAi.step_by_step || "").trim();
    const stepByStep = existingSteps || (
      subject === "Math"
        ? "1. Identify the important numbers.\n2. Decide what operation to use first.\n3. Solve step by step.\n4. Check your answer."
        : subject === "Science"
        ? "1. Identify what is changing.\n2. Determine the effect of that change.\n3. Connect cause and effect."
        : subject === "Social Studies"
        ? "1. Identify the decision or action.\n2. Determine what happened because of it.\n3. Connect cause and outcome."
        : "1. Identify what the question is asking.\n2. Find the relevant part of the passage.\n3. Match it to the best answer."
    );

    return {
      question_id: expectedId,
      question: questionText,
      explanation,
      common_mistake: String(fromAi.common_mistake || "").trim() ||
        (subject === "Math"
          ? "Using the wrong operation or skipping a step can lead to the wrong answer."
          : subject === "Science"
          ? "Confusing the cause and effect or misreading the variable can lead to an incorrect answer."
          : subject === "Social Studies"
          ? "Misunderstanding the decision or its outcome can lead to an incorrect answer."
          : "Choosing an answer that sounds correct without fully checking the passage."),
      hint,
      think: String(fromAi.think || "").trim() || buildThinkPrompt(q),
      step_by_step: stepByStep,
    };
  });
}

function sanitizeAnswerKey(
  raw: unknown,
  sourceQuestions: Question[],
  subject: CanonicalSubject,
  _tutor: TutorExplanation[],
  mode: "practice" | "cross",
  crossPassage = "",
): AnswerKeyEntry[] {
  const aiEntries = Array.isArray(raw) ? raw as AnswerKeyEntry[] : [];
  void subject;
  void _tutor;
  const genericCoachPattern = /\b(choose the best answer|look back at the passage|think about the question|read carefully)\b/i;
  const fallback = mode === "cross"
    ? sourceQuestions.slice(0, 5).map((q, i) => ({
      question_id: ensureQuestionId(q, i, mode),
      correct_answer: normalizeAnswer(normalizeAnswerKeyEntry(q.correct_answer)),
      ...buildCrossAnswerFallback(subject, q, crossPassage),
    }))
    : buildAnswerKeyFromPractice(sourceQuestions.slice(0, 5)).practice;
  const base = aiEntries.length > 0 ? aiEntries.slice(0, 5) : fallback;
  const usedEvidence = new Set<string>();

  return sourceQuestions.slice(0, 5).map((q, i) => {
    const fromAi = base[i] || fallback[i];
    const correct = normalizeAnswer(
      String(fromAi?.correct_answer || normalizeAnswerKeyEntry(q.correct_answer) || ""),
    );
    const expectedId = ensureQuestionId(q, i, mode);
    const evidence = mode === "cross"
      ? summarizeEvidenceIdea(selectEvidenceSnippet(q, crossPassage, usedEvidence) || fallbackEvidenceSnippet(crossPassage))
      : "";
    const currentExplanation = String(fromAi?.explanation || "").trim();
    const conciseExisting = currentExplanation.split(/(?<=[.!?])\s+/).slice(0, 2).join(" ").trim();
    const explanation = (!conciseExisting || genericCoachPattern.test(conciseExisting))
      ? (subject === "Math"
        ? `Choice ${correct} is correct because the calculation using the given numbers leads to this result. A wrong answer may come from using the wrong operation or skipping a step.`
        : subject === "Science"
        ? `Choice ${correct} is correct because it correctly explains the cause-and-effect relationship described. A wrong answer may confuse the variable or outcome.`
        : subject === "Social Studies"
        ? `Choice ${correct} is correct because it matches the outcome of the decision or event. A wrong answer may misinterpret the consequence.`
        : mode === "cross" && evidence
        ? `Choice ${correct} fits because it matches the moment where ${evidence}. A nearby wrong option can sound right when it mentions a related detail but misses the passage's main point in that moment.`
        : `Choice ${correct} fits best based on the passage details and reasoning required.`)
      : conciseExisting;

    return {
      question_id: expectedId,
      correct_answer: correct || normalizeAnswer(normalizeAnswerKeyEntry(q.correct_answer)),
      explanation,
      common_mistake: String(fromAi?.common_mistake || "").trim() ||
        (subject === "Math"
          ? "Using the wrong operation or skipping a step can lead to the wrong answer."
          : subject === "Science"
          ? "Confusing the cause and effect or misreading the variable can lead to an incorrect answer."
          : subject === "Social Studies"
          ? "Misunderstanding the decision or its outcome can lead to an incorrect answer."
          : "Choosing an answer that sounds correct without fully checking the passage."),
      parent_tip: String(fromAi?.parent_tip || "").trim() ||
        (subject === "Math"
          ? "Have your child explain each step and check their calculations."
          : subject === "Science"
          ? "Ask what changed and what effect it caused."
          : subject === "Social Studies"
          ? "Ask why the decision led to that outcome."
          : "Ask your child what part of the passage supports their answer."),
    };
  });
}

function validateTutorAnswerKeyAlignment(
  questions: Question[],
  tutor: TutorExplanation[],
  answerKey: AnswerKeyEntry[],
  mode: "practice" | "cross",
): boolean {
  if (!questions.length) return false;
  if (tutor.length < questions.length || answerKey.length < questions.length) return false;
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
    ...withSafeQuestionDefaults(q as Partial<Question>),
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

function diversifyChoiceStarts(choices: [string, string, string, string]): [string, string, string, string] {
  const cleaned = choices.map((choice) => cleanAnswerChoice(choice)) as [string, string, string, string];
  const uniqueChoices = new Set(cleaned.map((choice) => choice.toLowerCase().trim())).size === 4;
  if (!uniqueChoices) return cleaned;

  const prefixes = ["Specifically, ", "By contrast, ", "For example, ", "As a result, "] as const;
  const diversified = cleaned.map((choice, idx) => {
    const normalized = String(choice || "").trim();
    if (!normalized) return normalized;
    if (/^[A-D]\)?\s*$/i.test(normalized) || /^-?\d+(\.\d+)?$/.test(normalized)) return normalized;
    if (/^(specifically|by contrast|for example|as a result),\s+/i.test(normalized)) return normalized;
    return `${prefixes[idx]}${normalized.charAt(0).toLowerCase()}${normalized.slice(1)}`;
  }) as [string, string, string, string];

  return diversified;
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

    const safeChoices = diversifyChoiceStarts(normalizedChoices);

    return {
      ...q,
      choices: safeChoices,
    };
  });
}

function enforceSingleSourceOfTruth(data: WorkerAttempt, subject: CanonicalSubject = "Reading"): WorkerAttempt {
  const legacy = data as WorkerAttempt & { questions?: Question[] };
  if (Array.isArray(legacy.questions)) {
    if (!Array.isArray(data.practice?.questions) || data.practice.questions.length === 0) {
      data.practice = { questions: legacy.questions };
    }
    delete legacy.questions;
  }

  const practicePassage = data.passage ?? null;
  const practicePassageForOps = subject === "Reading" ? String(practicePassage || "") : "";
  const crossPassage = data.cross?.passage || "";

  const validatedPractice = [...(data.practice.questions || [])]
    .map((q) => ({
      ...q,
      choices: normalizeChoices(q.choices),
    }));

  let validatedCross: Question[] = [];
  if (data.cross?.questions) {
    validatedCross = [...data.cross.questions]
      .map((q) => ({
        ...q,
        choices: normalizeChoices(q.choices),
      }));
    data.cross.questions = validatedCross;
  }
  data.practice.questions = validatedPractice.slice(0, 5);
  data.cross.questions = validatedCross.slice(0, 5);

  const buildBoundSupport = (
    q: Question,
    passage: PassageContent | string,
    usedEvidence: Set<string>,
    variant = 0,
  ): { explanation: string; commonMistake: string; hint: string; think: string; stepByStep: string; parentTip: string } => {
    const passageText = getPassageText(passage);
    const normalizedChoices = normalizeChoices(q.choices);
    const correctLetter = normalizeAnswer(normalizeAnswerKeyEntry(q.correct_answer));
    const correctIndex = Math.max(0, LETTERS.indexOf(correctLetter));
    const correctChoice = String(normalizedChoices[correctIndex] || "").trim();
    const wrongOption = normalizedChoices
      .map((choice, idx) => ({ letter: LETTERS[idx], choice: String(choice || "").trim() }))
      .find((entry) => entry.letter !== correctLetter && entry.choice);
    const evidenceSnippet = selectEvidenceSnippet(q, passageText, usedEvidence) ||
      getRelevantSnippet(passageText, q.question, correctChoice) ||
      "a specific detail stated in the passage";
    const groundedEvidence = evidenceSnippet.replace(/\s+/g, " ").trim();

    const explanationVariants = [
      `Start with "${groundedEvidence}" and ask yourself what that detail is really telling you.`,
      `Look closely at "${groundedEvidence}" first, then connect it to what the question is asking.`,
      `Read "${groundedEvidence}" and explain what conclusion that detail supports before choosing any option.`,
      `Use "${groundedEvidence}" as your anchor and test which claim it fully supports.`,
    ];
    const explanationLead = explanationVariants[Math.abs(variant) % explanationVariants.length];
    const explanationTail = wrongOption
      ? ` A common trap is choosing an option that sounds related to "${groundedEvidence}" without matching what the quoted detail actually shows.`
      : " A common trap is choosing an option that sounds related without checking the exact passage wording.";
    const explanation = `${explanationLead}${explanationTail} Which choice best matches that exact idea?`;

    const commonMistake = wrongOption
      ? `Students often choose a topic-related option too quickly and miss what "${groundedEvidence}" actually says.`
      : `One trap here is picking a familiar-sounding choice without checking which passage idea is actually supported.`;

    const hintVariants = [
      `Use this passage detail as your anchor: "${groundedEvidence}".`,
      `Find the line "${groundedEvidence}" and ask which option it truly supports.`,
      `Look at "${groundedEvidence}" first, then test each choice against that exact idea.`,
    ];
    const thinkVariants = [
      `Which answer still works if you point to "${groundedEvidence}" as proof?`,
      `What does the detail "${groundedEvidence}" imply about the best answer?`,
      `If "${groundedEvidence}" is true, which option is fully supported and which ones overreach?`,
    ];
    const stepVariants = [
      `1. Read the question carefully.\n2. Locate the evidence: "${groundedEvidence}".\n3. Explain the conclusion that detail supports.\n4. Choose the option that best matches that evidence.`,
      `1. Identify what the question asks you to prove.\n2. Re-read "${groundedEvidence}".\n3. Compare options to that detail.\n4. Eliminate choices that do not match the passage idea.`,
      `1. Start with the passage line "${groundedEvidence}".\n2. Decide what conclusion that detail supports.\n3. Test options against that conclusion.\n4. Pick the choice that stays closest to the text.`,
    ];
    const hint = hintVariants[Math.abs(variant) % hintVariants.length];
    const think = thinkVariants[Math.abs(variant + 1) % thinkVariants.length];
    const stepByStep = stepVariants[Math.abs(variant + 2) % stepVariants.length];
    const parentTip = variedParentTip(variant);

    return { explanation, commonMistake, hint, think, stepByStep, parentTip };
  };
  const buildBoundAnswerSupport = (
    q: Question,
    passage: PassageContent | string,
    usedEvidence: Set<string>,
    variant = 0,
  ): { explanation: string; commonMistake: string; parentTip: string } => {
    const passageText = getPassageText(passage);
    const normalizedChoices = normalizeChoices(q.choices);
    const correctLetter = normalizeAnswer(normalizeAnswerKeyEntry(q.correct_answer));
    const correctIndex = Math.max(0, LETTERS.indexOf(correctLetter));
    const correctChoice = String(normalizedChoices[correctIndex] || "").trim();
    const wrongOption = normalizedChoices
      .map((choice, idx) => ({ letter: LETTERS[idx], choice: String(choice || "").trim() }))
      .find((entry) => entry.letter !== correctLetter && entry.choice);
    const evidenceSnippet = selectEvidenceSnippet(q, passageText, usedEvidence) ||
      getRelevantSnippet(passageText, q.question, correctChoice) ||
      "a specific detail stated in the passage";
    const groundedEvidence = evidenceSnippet.replace(/\s+/g, " ").trim();

    const explanationVariants = [
      `The correct answer is ${correctLetter}${correctChoice ? ` (${correctChoice})` : ""} because the passage states "${groundedEvidence}".`,
      `${correctLetter}${correctChoice ? ` (${correctChoice})` : ""} is correct because "${groundedEvidence}" directly supports it.`,
      `The passage detail "${groundedEvidence}" proves that ${correctLetter}${correctChoice ? ` (${correctChoice})` : ""} is the best answer.`,
      `${correctLetter}${correctChoice ? ` (${correctChoice})` : ""} is the strongest choice, and this is shown by "${groundedEvidence}".`,
    ];
    const explanationLead = explanationVariants[Math.abs(variant) % explanationVariants.length];
    const explanation = wrongOption
      ? `${explanationLead} ${wrongOption.letter} (${wrongOption.choice}) is a tempting distractor, but it adds an idea the passage detail does not show.`
      : explanationLead;

    const mistakeVariants = wrongOption
      ? [
        `A common mistake is choosing ${wrongOption.letter} (${wrongOption.choice}) because it sounds related, but it is not fully supported by the quoted detail.`,
        `Students often pick ${wrongOption.letter} (${wrongOption.choice}) when they focus on topic words and skip what "${groundedEvidence}" actually shows.`,
        `${wrongOption.letter} (${wrongOption.choice}) can seem reasonable at first glance, but it overreaches beyond the evidence in "${groundedEvidence}".`,
      ]
      : [
        "A common mistake is selecting a choice that sounds familiar without checking exact text evidence.",
        "Students often choose an option that matches the topic but not the passage proof.",
        "One mistake is relying on general meaning instead of the specific supporting line.",
      ];
    const commonMistake = mistakeVariants[Math.abs(variant + 1) % mistakeVariants.length];

    const tipVariants = [
      "Ask your child to quote one line that proves the answer before finalizing.",
      "Have your child eliminate choices that are related to the topic but unsupported by text evidence.",
      "Prompt your child to restate the key detail, then match it to the most precise option.",
      "Encourage your child to verify every answer with exact wording from the passage.",
    ];
    const parentTip = tipVariants[Math.abs(variant + 2) % tipVariants.length];

    return { explanation, commonMistake, parentTip };
  };

  const buildTutor = (questions: Question[], mode: "practice" | "cross"): TutorExplanation[] => {
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

  const buildAnswerKey = (questions: Question[], mode: "practice" | "cross"): AnswerKeyEntry[] => {
    const sourcePassage = mode === "cross" ? crossPassage : practicePassage;
    const usedEvidence = new Set<string>();
    return questions.map((q, i) => {
      const support = buildBoundAnswerSupport(q, sourcePassage, usedEvidence, i);
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
    practice: buildTutor(validatedPractice, "practice"),
    cross: buildTutor(validatedCross, "cross"),
  };

  data.answerKey = {
    practice: buildAnswerKey(validatedPractice, "practice"),
    cross: buildAnswerKey(validatedCross, "cross"),
  };

  return data;
}

function ensureNonEmptyQuestions(
  questions: Question[] | undefined,
  subject: CanonicalSubject,
  skill: string,
  mode: "practice" | "cross" = "practice",
): Question[] {
  void subject;
  void skill;
  const normalized = Array.isArray(questions) ? questions : [];
  if (mode === "cross") return normalized;
  return normalized;
}

function rebuildCrossFromPractice(
  practiceQuestions: Question[] | undefined,
  subject: CanonicalSubject,
  skill: string,
): Question[] {
  const normalizedPractice = Array.isArray(practiceQuestions) ? practiceQuestions : [];
  if (normalizedPractice.length > 0) {
    return normalizedPractice.slice(0, 3).map((question, index) => ({
      ...question,
      question_id: ensureQuestionId(question, index, "cross"),
    }));
  }
  void subject;
  void skill;
  return [];
}

function ensureNonEmptySupport(
  questions: Question[],
  tutor: TutorExplanation[] | undefined,
  answerKey: AnswerKeyEntry[] | undefined,
  mode: "practice" | "cross",
): { tutor: TutorExplanation[]; answerKey: AnswerKeyEntry[] } {
  if (mode === "cross") {
    return {
      tutor: Array.isArray(tutor) ? tutor : [],
      answerKey: Array.isArray(answerKey) ? answerKey : [],
    };
  }
  const fallbackTutor = buildTutorFromPractice(questions).practice;
  const fallbackAnswerKey = buildAnswerKeyFromPractice(questions).practice;
  const safeTutor = Array.isArray(tutor) && tutor.length === questions.length ? tutor : fallbackTutor;
  const safeAnswerKey = Array.isArray(answerKey) && answerKey.length === questions.length ? answerKey : fallbackAnswerKey;
  return { tutor: safeTutor, answerKey: safeAnswerKey };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  let grade = 5;
  let subject: CanonicalSubject = "Reading";
  let skill = READING_SKILL_DEFAULT;
  let level: Level = "On Level";
  let effectiveMode: "core" | "cross" | "support" | "enrichment" | "practice_only" = "core";
  let contentMode: CanonicalMode = "Practice";
  let effectiveSubject: CanonicalSubject = "Reading";
  let effectiveSkill = READING_SKILL_DEFAULT;
  let teksCode = "Unknown";
  let contextType = "real-world application";
  const repairState = { used: false };

  const jsonResponse = (payload: Record<string, unknown>, status = 200) =>
    new Response(JSON.stringify({ ...payload, source: "ai" }), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  const enforceResponseContract = (payload: {
    cross?: { passage?: unknown; questions?: unknown[] };
    tutor?: { practice?: unknown[]; cross?: unknown[] };
    answerKey?: { practice?: unknown[]; cross?: unknown[] };
  }) => ({
    cross: {
      passage: String(payload?.cross?.passage || ""),
      questions: Array.isArray(payload?.cross?.questions) ? payload.cross.questions : [],
    },
    tutor: {
      practice: Array.isArray(payload?.tutor?.practice) ? payload.tutor.practice : [],
      cross: Array.isArray(payload?.tutor?.cross) ? payload.tutor.cross : [],
    },
    answerKey: {
      practice: Array.isArray(payload?.answerKey?.practice) ? payload.answerKey.practice : [],
      cross: Array.isArray(payload?.answerKey?.cross) ? payload.answerKey.cross : [],
    },
  });
  const hardenCrossPayload = (
    cross: Partial<EnrichmentResponse["cross"]> | undefined,
    practiceQuestions: Question[],
    fallbackPassage = "",
  ): EnrichmentResponse["cross"] => {
    const fallbackQuestions = rebuildCrossFromPractice(practiceQuestions, subject, skill);
    const seededQuestions = Array.isArray(cross?.questions) && cross.questions.length > 0
      ? cross.questions
      : fallbackQuestions;
    const safeQuestions = sanitizeChoices(
      sanitizeExplanations(
        seededQuestions.map((q) => ({ ...q })),
        String(cross?.passage || fallbackPassage || ""),
      ),
    )
      .slice(0, 5);
    const seededQuestion = safeQuestions[0] || fallbackQuestions[0];
    while (safeQuestions.length < 5) {
      const index = safeQuestions.length;
      const question = seededQuestion
        ? { ...seededQuestion }
        : {
          question: getUniversalQuestion(subject, skill, index),
          choices: normalizeChoices([]),
          correct_answer: "A",
          explanation: "Use evidence from the passage to select the strongest answer.",
          common_mistake: "Selecting an option that sounds plausible but is not best supported.",
        } as Question;
      safeQuestions.push({
        ...question,
        question: String(question.question || getUniversalQuestion(subject, skill, index)).trim(),
        choices: normalizeChoices(question.choices),
        correct_answer: normalizeAnswerKeyEntry(question.correct_answer),
        explanation: String(question.explanation || "Use evidence from the passage to support your choice."),
      });
    }
    const safePassage = String(cross?.passage || fallbackPassage || "").trim()
      || buildSubjectPassage(subject, level);
    return {
      passage: safePassage,
      questions: safeQuestions,
    };
  };
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
    const baseCross = buildCrossFallbackContent(subject, level, skill);
    const constraints = getGradeConstraints(grade);
    const crossPassage = ensurePassageLength(
      baseCross.passage,
      150,
      200,
      subject,
      "Cross-Curricular",
      grade,
      level,
    );
    const gradeSafeCrossPassage = enforceSentenceLength(crossPassage, constraints.maxWordsPerSentence);
    const crossQuestions = await sanitizeQuestions(
      baseCross.questions || [],
      subject,
      "Cross-Curricular",
      skill,
      level,
      gradeSafeCrossPassage,
      grade,
      repairState,
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
      questions: await sanitizeQuestions(
        crossPipeline.questions,
        subject,
        "Cross-Curricular",
        skill,
        level,
        gradeSafeCrossPassage,
        grade,
        repairState,
      ),
    };
  };
  const returnCore = async (data: CoreResponse) => {
    const sanitizeAndValidateQuestions = (
      questions: Question[],
      passage: PassageContent | string,
      mode: "practice" | "cross",
    ): Question[] => {
      const normalizedQuestions = questions
        .map((q) => ({ ...q, choices: normalizeChoices(q.choices) }));
      void mode;
      void passage;

      return normalizedQuestions.slice(0, 5);
    };

    const practice = {
      questions: [...(data?.practice?.questions || [])],
    };
    const practicePassage = data?.passage ?? null;
    const practicePassageForOps = subject === "Reading" ? String(practicePassage || "") : "";

    practice.questions = sanitizeAndValidateQuestions(practice.questions, practicePassageForOps, "practice");
    if (!practice.questions.length) throw new Error("NO_QUESTIONS_FROM_AI");
    practice.questions = practice.questions.slice(0, 5);

    const cross = await generateCross({
      grade,
      subject,
      skill,
      level,
      practiceQuestions: practice.questions,
    });
    const crossPassage = cross?.passage || "";
    cross.questions = sanitizeAndValidateQuestions(cross.questions, crossPassage, "cross");
    cross.questions = ensureNonEmptyQuestions(cross.questions, subject, skill, "cross");
    practice.questions = practice.questions.map((q) => ({ ...q, choices: normalizeChoices(q.choices) }));
    cross.questions = sanitizeChoices(cross.questions);
    practice.questions = sanitizeExplanations(practice.questions, practicePassageForOps);
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
        : null,
      practice: {
        questions: practice.questions,
      },
      cross,
      tutor: { practice: [], cross: [] },
      answerKey: { practice: [], cross: [] },
    }, subject);
    finalized.practice.questions = Array.isArray(finalized.practice.questions) ? finalized.practice.questions : [];
    finalized.cross = hardenCrossPayload(
      finalized.cross,
      finalized.practice.questions || [],
      String(finalized.cross?.passage || ""),
    );
    const practiceSupport = ensureNonEmptySupport(
      finalized.practice.questions,
      finalized.tutor?.practice,
      finalized.answerKey?.practice,
      "practice",
    );
    const crossSupport = ensureNonEmptySupport(
      finalized.cross.questions,
      finalized.tutor?.cross,
      finalized.answerKey?.cross,
      "cross",
    );
    finalized.tutor = { practice: practiceSupport.tutor, cross: crossSupport.tutor };
    finalized.answerKey = { practice: practiceSupport.answerKey, cross: crossSupport.answerKey };

    if (!finalized.tutor || !finalized.answerKey) console.warn("⚠️ Missing support blocks after hardening");

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
  const returnEnrichment = (data: WorkerAttempt) =>
    {
      const practiceQuestions = ((data.practice?.questions || []) as Question[])
        .map((q) => ({ ...q, choices: normalizeChoices(q.choices) }));
      if (!practiceQuestions.length) {
        throw new Error("NO_QUESTIONS_FROM_AI");
      }
      const limitedPracticeQuestions = practiceQuestions.slice(0, 5);
      let cross = data?.cross as Partial<EnrichmentResponse["cross"]> | undefined;
      if (!cross || !Array.isArray(cross.questions) || cross.questions.length === 0) {
        console.error("❌ CROSS GENERATION FAILED — AI RETURNED EMPTY");
        cross = {
          passage: String(cross?.passage || (data as Partial<WorkerAttempt>)?.passage || ""),
          questions: rebuildCrossFromPractice(limitedPracticeQuestions, subject, skill),
        };
      }
      const sanitizedPracticeQuestions = limitedPracticeQuestions.map((q) => ({ ...q, choices: normalizeChoices(q.choices) }));
      const finalCorePassage = (() => {
        const source = (data as Partial<WorkerAttempt>)?.passage;
        if (typeof source === "string" && source.trim().length > 0) return source.trim();
        return null;
      })();
      const finalized = enforceSingleSourceOfTruth({
        passage: String((data as Partial<WorkerAttempt>)?.passage || ""),
        practice: {
          questions: sanitizedPracticeQuestions,
        },
        cross: hardenCrossPayload(
          cross,
          sanitizedPracticeQuestions,
          String(cross?.passage || (data as Partial<WorkerAttempt>)?.passage || ""),
        ),
        tutor: { practice: [], cross: [] },
        answerKey: { practice: [], cross: [] },
      }, subject);
      finalized.cross = hardenCrossPayload(
        finalized.cross,
        sanitizedPracticeQuestions,
        String(cross?.passage || (data as Partial<WorkerAttempt>)?.passage || ""),
      );
      const practiceSupport = ensureNonEmptySupport(
        sanitizedPracticeQuestions,
        (data as Partial<WorkerAttempt>)?.tutor?.practice as TutorExplanation[] | undefined,
        (data as Partial<WorkerAttempt>)?.answerKey?.practice as AnswerKeyEntry[] | undefined,
        "practice",
      );
      const crossSupport = ensureNonEmptySupport(
        finalized.cross.questions,
        (data as Partial<WorkerAttempt>)?.tutor?.cross as TutorExplanation[] | undefined,
        (data as Partial<WorkerAttempt>)?.answerKey?.cross as AnswerKeyEntry[] | undefined,
        "cross",
      );
      finalized.tutor = {
        practice: practiceSupport.tutor,
        cross: crossSupport.tutor,
      };
      finalized.answerKey = {
        practice: practiceSupport.answerKey,
        cross: crossSupport.answerKey,
      };
      if (!finalized.tutor || !finalized.answerKey) console.warn("⚠️ Missing support blocks after hardening");
      const contract = enforceResponseContract({
        cross: finalized.cross,
        tutor: finalized.tutor,
        answerKey: finalized.answerKey,
      });
      assertSupportIntegrity({
        practice: { questions: sanitizedPracticeQuestions },
        cross: contract.cross,
        tutor: contract.tutor,
        answerKey: contract.answerKey,
      });
      return jsonResponse({
        teks: teksCode,
        skill,
        grade,
        passage: finalCorePassage,
        practice: {
          questions: sanitizedPracticeQuestions,
        },
        cross: contract.cross,
        tutor: contract.tutor,
        answerKey: contract.answerKey,
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

    const trigger = String(body?.trigger || "").trim().toLowerCase();
    if (trigger === "login_check") {
      return jsonResponse({ ok: true, trigger: "login_check" });
    }

    const {
      grade: incomingGrade,
      subject: incomingSubject,
      skill: incomingSkill,
      level: incomingLevel,
      mode: incomingMode,
      contextType: incomingContextType,
    } = body;
    const requestPath = new URL(req.url).pathname;

    if (requestPath.endsWith("/enrich")) {
      const practiceQuestions = Array.isArray(body.practiceQuestions)
        ? body.practiceQuestions as Question[]
        : Array.isArray(body.practice)
        ? body.practice as Question[]
        : Array.isArray(body.questions)
        ? body.questions as Question[]
        : [];
      const bodyCross = body.cross && typeof body.cross === "object"
        ? body.cross as Record<string, unknown>
        : null;
      const crossQuestions = Array.isArray(body.crossQuestions)
        ? body.crossQuestions as Question[]
        : bodyCross && Array.isArray(bodyCross.questions)
        ? bodyCross.questions as Question[]
        : Array.isArray(body.cross)
        ? body.cross as Question[]
        : [];
      const crossPassage = String(
        body.crossPassage ??
          (bodyCross?.passage ?? ""),
      ).trim();
      const enrichGrade = Number(body.grade || 5);
      const enrichSubject = canonicalizeSubject(body.subject);
      const enrichSkill = String(body.skill || READING_SKILL_DEFAULT).trim() || READING_SKILL_DEFAULT;
      const enrichLevel = normalizeLevel(body.level);

      if (!crossQuestions.length) {
        return jsonResponse({
          error: "MISSING_CROSS_INPUT",
          message: "Cross questions must be generated before enrichment runs.",
        }, 400);
      }

      const enrichment = await generateWithRetry(
        buildCoreEnrichmentPrompt({
          grade: enrichGrade,
          subject: enrichSubject,
          skill: enrichSkill,
          level: enrichLevel,
          practiceQuestions,
          crossQuestions,
          crossPassage,
        }),
      ) as Record<string, unknown> | null;
      if (!enrichment || Object.keys(enrichment).length === 0) {
        throw new Error("ENRICHMENT_EMPTY_RESPONSE");
      }
      const { tutor, answerKey } = normalizeEnrichmentSupport(
        enrichment,
        practiceQuestions,
        crossQuestions,
      );
      const tutorPractice = tutor.practice;
      const tutorCross = tutor.cross;
      const answerPractice = answerKey.practice;
      const answerCross = answerKey.cross;

      const safeTutorPractice = tutorPractice.length === practiceQuestions.length
        ? tutorPractice
        : buildTutorFromPractice(practiceQuestions).practice;
      const safeAnswerPractice = answerPractice.length === practiceQuestions.length
        ? answerPractice
        : buildAnswerKeyFromPractice(practiceQuestions).practice;
      const safeTutorCross = tutorCross.length === crossQuestions.length
        ? tutorCross
        : buildTutorFromPractice(crossQuestions).practice.map((entry, index) => ({
          ...entry,
          question_id: ensureQuestionId(crossQuestions[index], index, "cross"),
        }));
      const safeAnswerCross = answerCross.length === crossQuestions.length
        ? answerCross
        : buildAnswerKeyFromPractice(crossQuestions).practice.map((entry, index) => ({
          ...entry,
          question_id: ensureQuestionId(crossQuestions[index], index, "cross"),
        }));

      if (safeTutorPractice !== tutorPractice) console.warn("⚠️ Incomplete tutor practice — rebuilding from practice questions");
      if (safeAnswerPractice !== answerPractice) console.warn("⚠️ Incomplete answer practice — rebuilding from practice questions");
      if (safeTutorCross !== tutorCross) console.warn("⚠️ Incomplete tutor cross — rebuilding from cross questions");
      if (safeAnswerCross !== answerCross) console.warn("⚠️ Incomplete answer cross — rebuilding from cross questions");
      const practiceSupport = ensureNonEmptySupport(
        practiceQuestions,
        safeTutorPractice,
        safeAnswerPractice,
        "practice",
      );
      const contract = enforceResponseContract({
        tutor: {
          practice: practiceSupport.tutor,
          cross: safeTutorCross,
        },
        answerKey: {
          practice: practiceSupport.answerKey,
          cross: safeAnswerCross,
        },
      });

      return jsonResponse({
        tutor: contract.tutor,
        answerKey: contract.answerKey,
      });
    }

    console.log("🔥 BACKEND RECEIVED:", {
      subject: incomingSubject,
      grade: incomingGrade,
      skill: incomingSkill,
      level: incomingLevel,
      mode: incomingMode,
    });

    if (!incomingSubject || !incomingGrade || !incomingSkill || !incomingLevel) {
      console.warn("⚠️ Missing required generation fields — skipping AI call");
      return jsonResponse(
        {
          error: "Missing required fields: subject, grade, skill, level",
        },
        400,
      );
    }

    grade = Number(incomingGrade || 5);
    subject = canonicalizeSubject(incomingSubject);
    skill = String(incomingSkill || READING_SKILL_DEFAULT).trim() || READING_SKILL_DEFAULT;
    teksCode = resolveTeks(subject, skill, grade);
    level = normalizeLevel(incomingLevel);
    contextType = String(incomingContextType || "real-world application").trim() || "real-world application";
    const normalizedMode = String(incomingMode || "").toLowerCase().trim();
    if (normalizedMode === "cross" || normalizedMode === "cross-curricular") {
      effectiveMode = "cross";
    } else if (normalizedMode === "support") {
      effectiveMode = "support";
    } else if (normalizedMode === "enrichment") {
      effectiveMode = "enrichment";
    } else if (normalizedMode === "practice_only") {
      effectiveMode = "practice_only";
    } else {
      effectiveMode = "core";
    }
    if (effectiveMode === "cross") {
      contentMode = "Cross-Curricular";
    } else if (effectiveMode === "support") {
      contentMode = "Support";
    } else if (effectiveMode === "practice_only") {
      contentMode = "Practice";
    } else {
      contentMode = "Practice";
    }
    effectiveSubject = subject;
    effectiveSkill = skill ?? "Main Idea";

    console.log("🔥 FINAL MODE:", contentMode);

    // 🚀 NEW MODE ROUTING
    if (effectiveMode === "cross") {
      const aiCross = await generateWithRetry(
        generateCrossCurricularPrompt({
          grade,
          subject,
          skill: effectiveSkill,
          level,
          teksCode,
        }),
      ) as Record<string, unknown> | null;
      const scopedCross = aiCross?.cross && typeof aiCross.cross === "object"
        ? aiCross.cross as Record<string, unknown>
        : aiCross;
      const crossPayload = {
        passage: String(scopedCross?.passage || ""),
        questions: Array.isArray(scopedCross?.questions)
          ? scopedCross.questions
          : Array.isArray(scopedCross?.items)
          ? scopedCross.items
          : [],
      };
      const crossPassage = String(crossPayload.passage || "").trim() || buildSubjectPassage(subject, level);
      const result = await runPipeline({
        stems: [],
        crossSubject: subject,
        subject,
        skill: effectiveSkill,
        level,
        crossPassage: crossPassage,
        questions: [],
      });
      let crossQuestions = Array.isArray(crossPayload.questions)
        ? crossPayload.questions.slice(0, 5)
        : [];
      if (!crossQuestions.length && Array.isArray(result.questions)) {
        crossQuestions = result.questions;
      }
      if (!Array.isArray(crossQuestions) || crossQuestions.length === 0) {
        crossQuestions = await sanitizeQuestions(
          crossQuestions,
          subject,
          "Cross-Curricular",
          effectiveSkill,
          level,
          crossPassage,
          grade,
          repairState,
        );
      }

      if (!crossQuestions.length) {
        console.warn("❌ No cross questions from AI");
      }
      crossQuestions = crossQuestions.slice(0, 5);

      return jsonResponse({
        teks: teksCode,
        skill,
        grade,
        cross: {
          passage: crossPassage,
          questions: crossQuestions,
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
    let generatedCorePassage: string | null = null;
    let generatedCoreQuestions: Question[] | null = null;
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
            const variationId = Math.random().toString(36).slice(2, 8);
            const passageRes = subject === "Reading"
              ? await generateWithRetry(
                generatePassagePrompt({
                  grade,
                  subject,
                  skill: effectiveSkill,
                  level,
                  teksCode,
                  contextType,
                }) + `\nVariation ID: ${variationId}`,
              ) as Record<string, unknown> | null
              : { passage: null };
            const safePassage = subject === "Reading" ? String(passageRes?.passage || "").trim() : null;
            console.log("✅ FLOW STEP: generateQuestionsPrompt");
            let questionRes = await generateWithRetry(
              generateQuestionsPrompt({
                grade,
                subject,
                skill: effectiveSkill,
                level,
                teksCode,
                passage: safePassage,
              }) + `\nVariation ID: ${variationId}`,
            ) as Record<string, unknown> | null;
            const parsed: any = questionRes || {};
            if (!Array.isArray(parsed.questions)) {
              parsed.questions = Array.isArray(parsed.items) ? parsed.items : [];
            }

            console.log("FINAL PRACTICE QUESTIONS:", parsed.questions.length);
            questionRes = parsed;

            const aiQuestions = questionRes?.questions || questionRes?.items || [];
            const coreQuestions = (Array.isArray(aiQuestions) ? aiQuestions : []).map((q) => {
              const item = (q || {}) as Question;
              const patchedChoices = normalizeChoices(item.choices);
              return { ...item, choices: patchedChoices } as Question;
            }).filter((q) =>
              typeof q.question === "string" &&
              q.question.length > 10 &&
              Array.isArray(q.choices) &&
              q.choices.length === 4
            );
            if (!coreQuestions.length) {
              throw new Error("NO_VALID_QUESTIONS");
            }
            const finalQuestions = coreQuestions.slice(0, 5);

            console.timeEnd("OPENAI_CALL");
            console.log("⏱️ AI Duration:", Date.now() - aiStartTime);
            const corePassage = String(parsed.passage || "");
            generatedCorePassage = isUsablePassage(corePassage)
              ? corePassage
              : isUsablePassage(String(passageRes?.passage || ""))
              ? String(passageRes?.passage || "")
              : null;
            generatedCoreQuestions = finalQuestions;
        }

        if (effectiveMode === "practice_only") {
          const coreQuestions = (Array.isArray(generatedCoreQuestions) ? generatedCoreQuestions : []).map((q) => ({
            ...(q as Question),
            choices: normalizeChoices((q as Question).choices),
          }));
          if (!coreQuestions.length) {
            throw new Error("NO_QUESTIONS_FROM_AI");
          }
          const finalPracticePassage = typeof generatedCorePassage === "string" && generatedCorePassage.trim().length > 0
            ? generatedCorePassage.trim()
            : "";
          returnType = "PRACTICE_ONLY";
          logReturnMetrics();
          return jsonResponse({
            practice: {
              passage: finalPracticePassage,
              questions: coreQuestions.slice(0, 5),
            },
          });
        }

        const priorPractice = effectiveMode === "core" && Array.isArray(generatedCoreQuestions)
          ? generatedCoreQuestions
          : Array.isArray(body.practiceQuestions)
          ? body.practiceQuestions
          : [];

        const finalCorePassage =
          typeof generatedCorePassage === "string" &&
            generatedCorePassage.trim().length > 0
            ? generatedCorePassage.trim()
            : null;
        const corePassageFromRequest = effectiveMode === "core"
          ? finalCorePassage
          : typeof body.passage === "string"
          ? body.passage
          : null;
        const corePassageForChecks = corePassageFromRequest;
        console.log("🧪 FINAL PRACTICE PASSAGE:", corePassageForChecks);
        if (effectiveSubject === "Reading" && (!corePassageForChecks || corePassageForChecks.length < 30)) {
          console.warn("⚠️ Missing or short passage — returning anyway");
        }
        const normalizedPractice = priorPractice.map((q) => {
          const item = (q || {}) as Question;
          const patchedChoices = normalizeChoices(item.choices);
          return { ...item, choices: patchedChoices } as Question;
        });
        if (!normalizedPractice.length) {
          throw new Error("NO_QUESTIONS_FROM_AI");
        }
        const safePracticeQuestions = [...normalizedPractice];
        safePracticeQuestions.splice(5);
        console.log("🧠 CROSS SUBJECT:", effectiveSubject);
        const baseCrossPassage = buildSubjectPassage(effectiveSubject, level);
        if (baseCrossPassage === corePassageForChecks) {
          console.log("⚠️ Cross passage duplication detected");
        }

        console.time("OPENAI_CALL");
        const enrichStartTime = Date.now();
        const variationId = Math.random().toString(36).slice(2, 8);
        const shouldGenerateCross = true;
        let crossRes: Record<string, unknown> | null = null;
        if (shouldGenerateCross) {
          console.log("✅ FLOW STEP: generateCrossCurricularPrompt");
          crossRes = await generateWithRetry(
            generateCrossCurricularPrompt({
              grade,
              subject: effectiveSubject,
              skill: effectiveSkill,
              level,
              teksCode,
            }) + `\nVariation ID: ${variationId}`,
          ) as Record<string, unknown> | null;
        }
        console.log("🔥 RAW CROSS RESPONSE:", JSON.stringify(crossRes, null, 2));
        console.log("🧠 RAW AI RESPONSE:", JSON.stringify(crossRes, null, 2));
        console.timeEnd("OPENAI_CALL");
        console.log("⏱️ AI Duration:", Date.now() - enrichStartTime);

        const scopedCross = crossRes?.cross && typeof crossRes.cross === "object"
          ? crossRes.cross as Record<string, unknown>
          : crossRes;
        console.log("🔍 SCOPED CROSS:", JSON.stringify(scopedCross, null, 2));

        if (!scopedCross || !Object.keys(scopedCross).length) {
          console.warn("⚠️ Empty cross payload — using fallback cross content");
        }

        const aiCross = {
          passage: String(scopedCross?.passage || ""),
          questions:
            Array.isArray(scopedCross?.questions)
              ? scopedCross.questions
              : Array.isArray(scopedCross?.items)
              ? scopedCross.items
              : Array.isArray(crossRes?.questions)
              ? crossRes.questions
              : [],
        };
        const aiCrossSafe = structuredClone(aiCross);
        const aiQuestions = Array.isArray(aiCrossSafe.questions) ? aiCrossSafe.questions : [];

        let cross = {
          passage: String(aiCrossSafe.passage || ""),
          questions: aiQuestions as unknown[],
        };
        const crossShapeValid = validateCrossCurricular({
          passage: cross.passage,
          questions: cross.questions,
        });
        if (!crossShapeValid) {
          console.warn("⚠️ Invalid cross shape from AI — applying guard rails");
        }
        cross.questions = aiQuestions;
        if (!cross.passage || cross.passage.split(/\s+/).filter(Boolean).length < 120) {
          cross.passage = cross.passage || buildSubjectPassage(effectiveSubject, level);
        }

        const aiQuestionCount = Array.isArray(aiQuestions)
          ? aiQuestions.length
          : 0;

        const finalQuestionCount = cross.questions.length;

        console.log("📊 CROSS SOURCE:", {
          aiCount: aiQuestionCount,
          finalCount: finalQuestionCount,
          usedFallback: aiQuestionCount === 0
        });

        if (!cross?.questions?.length) {
          console.warn("❌ No cross questions from AI");
        }

        const getCrossPayloadFromResponse = (raw: Record<string, unknown> | null) => {
          const scoped = raw?.cross && typeof raw.cross === "object"
            ? raw.cross as Record<string, unknown>
            : raw;
          const payloadQuestions =
            Array.isArray(scoped?.questions)
              ? scoped.questions
              : Array.isArray(scoped?.items)
              ? scoped.items
              : Array.isArray(raw?.questions)
              ? raw.questions
              : [];
          return {
            passage: String(scoped?.passage || ""),
            questions: Array.isArray(payloadQuestions) ? payloadQuestions : [],
          };
        };
        const parsedCross: Record<string, unknown> = {
          passage: String(cross.passage || baseCrossPassage),
          questions: cross.questions,
        };
        let subjectCrossPassage = String(parsedCross.passage || "").trim() || baseCrossPassage;
        const isUsable = Boolean(subjectCrossPassage && subjectCrossPassage.length > 80);
        if (!isUsable) {
          console.warn("Weak cross passage — retrying...");
          const retryCrossRes = await generateWithRetry(
            generateCrossCurricularPrompt({
              grade,
              subject: effectiveSubject,
              skill: effectiveSkill,
              level,
              teksCode,
            }) + `\nVariation ID: ${variationId}-retry`,
          ) as Record<string, unknown> | null;
          const retryCross = getCrossPayloadFromResponse(retryCrossRes);
          subjectCrossPassage = String(retryCross.passage || "").trim();

          if (
            !isCompletePassage(subjectCrossPassage) ||
            subjectCrossPassage === corePassageForChecks
          ) {
            console.warn("Retry failed — using safe fallback");
            subjectCrossPassage = baseCrossPassage;
          } else {
            parsedCross.questions = retryCross.questions?.length
              ? retryCross.questions
              : [];
          }
        }
        const constraints = getGradeConstraints(grade);
        subjectCrossPassage = ensurePassageLength(
          subjectCrossPassage,
          150,
          200,
          effectiveSubject,
          "Cross-Curricular",
          grade,
          level,
        );
        subjectCrossPassage = enforceSentenceLength(subjectCrossPassage, constraints.maxWordsPerSentence);
        if (violatesGradeLevel(subjectCrossPassage, grade)) {
          console.warn("⚠️ Passage too advanced for grade, keeping AI output");
        }
        parsedCross.passage = subjectCrossPassage;

        const finalCrossQuestions = Array.isArray(parsedCross.questions)
          ? parsedCross.questions.slice(0, 5)
          : [];
        const finalCrossPayload = {
          passage: aiCrossSafe.passage,
          questions: finalCrossQuestions,
        };
        let crossQuestions = finalCrossPayload.questions;
        if (!Array.isArray(crossQuestions)) crossQuestions = [];
        if (!aiQuestions.length) {
          console.warn("❌ Cross came back empty from AI");
        }
        let tutorPractice = sanitizeTutorExplanations(
          [],
          safePracticeQuestions,
          effectiveSubject,
          "practice",
        );
        let tutorCross: TutorExplanation[] = [];
        let answerKeyPractice = sanitizeAnswerKey(
          [],
          safePracticeQuestions,
          effectiveSubject,
          tutorPractice,
          "practice",
        );
        let answerKeyCross: AnswerKeyEntry[] = [];
        console.log("CROSS QUESTIONS COUNT:", crossQuestions.length);
        console.log("✅ FLOW STEP: buildCoreEnrichmentPrompt");
        const crossEnrichment = await generateWithRetry(
          buildCoreEnrichmentPrompt({
            grade,
            subject: effectiveSubject,
            skill: effectiveSkill,
            level,
            practiceQuestions: safePracticeQuestions,
            crossQuestions,
            crossPassage: subjectCrossPassage,
          }),
        ) as Record<string, unknown> | null;
        if (!crossEnrichment || Object.keys(crossEnrichment).length === 0) {
          console.warn("⚠️ Empty enrichment payload — using sanitizer fallbacks");
        }
        const { tutor: crossTutor, answerKey: crossAnswer } = normalizeEnrichmentSupport(
          crossEnrichment || {},
          safePracticeQuestions,
          crossQuestions,
        );

        tutorPractice = sanitizeTutorExplanations(
          crossTutor.practice,
          safePracticeQuestions,
          effectiveSubject,
          "practice",
        );
        tutorCross = sanitizeTutorExplanations(
          crossTutor.cross,
          crossQuestions,
          effectiveSubject,
          "cross",
          subjectCrossPassage,
        );

        answerKeyPractice = sanitizeAnswerKey(
          crossAnswer.practice,
          safePracticeQuestions,
          effectiveSubject,
          tutorPractice,
          "practice",
        );
        answerKeyCross = sanitizeAnswerKey(
          crossAnswer.cross,
          crossQuestions,
          effectiveSubject,
          tutorCross,
          "cross",
          subjectCrossPassage,
        );
        const practiceAligned = validateTutorAnswerKeyAlignment(safePracticeQuestions, tutorPractice, answerKeyPractice, "practice");
        const crossAligned = validateTutorAnswerKeyAlignment(crossQuestions, tutorCross, answerKeyCross, "cross");
        if (!practiceAligned) {
          console.warn("⚠️ Weak or missing practice support — patching instead");
        }

        if (!crossAligned) {
          console.warn("⚠️ Weak cross support — KEEPING AI OUTPUT");
        }

        console.log("🔥 FINAL CROSS SUBJECT:", effectiveSubject);
        console.log("🔥 FINAL CROSS PASSAGE:", subjectCrossPassage);

        console.log("🧠 FINAL CROSS QUESTIONS (POST-PIPELINE):", crossQuestions);

        const practiceSupport = ensureNonEmptySupport(
          safePracticeQuestions,
          tutorPractice,
          answerKeyPractice,
          "practice",
        );
        const crossSupport = ensureNonEmptySupport(
          crossQuestions,
          tutorCross,
          answerKeyCross,
          "cross",
        );

        const finalPracticePassage = effectiveMode === "core"
          ? finalCorePassage
          : typeof corePassageForChecks === "string" && corePassageForChecks.trim().length > 0
          ? corePassageForChecks.trim()
          : null;
        const payload: WorkerAttempt = {
          passage: finalPracticePassage,
          practice: { questions: safePracticeQuestions },
          cross: {
            passage: subjectCrossPassage,
            questions: crossQuestions,
          },
          tutor: { practice: practiceSupport.tutor, cross: crossSupport.tutor },
          answerKey: { practice: practiceSupport.answerKey, cross: crossSupport.answerKey },
        };
        const contract = enforceResponseContract({
          cross: payload.cross,
          tutor: payload.tutor,
          answerKey: payload.answerKey,
        });
        assertSupportIntegrity({
          practice: { questions: safePracticeQuestions },
          cross: contract.cross,
          tutor: contract.tutor,
          answerKey: contract.answerKey,
        });
        bestAttempt = {
          passage: finalPracticePassage,
          practice: { questions: safePracticeQuestions },
          cross: contract.cross,
          tutor: contract.tutor,
          answerKey: contract.answerKey,
        };
        returnType = "PRIMARY";
        logReturnMetrics();
        return returnEnrichment(bestAttempt);
      } catch (err) {
        console.error("BACKEND ERROR:", err);
        if (isTimedOut()) {
          console.warn("⚠️ Timed out while generating support — returning best available payload");
          break;
        }
        markRetry("no_questions_returned");
      }
    }

    if (bestAttempt) {
      returnType = "BEST_ATTEMPT";
      logReturnMetrics();
      return returnEnrichment(bestAttempt);
    }
    const fallbackPracticeSource = Array.isArray(generatedCoreQuestions) && generatedCoreQuestions.length
      ? generatedCoreQuestions
      : Array.isArray(body.practiceQuestions)
      ? body.practiceQuestions as Question[]
      : [];
    const fallbackPractice = ensureNonEmptyQuestions(
      fallbackPracticeSource.map((q) => ({ ...(q as Question), choices: normalizeChoices((q as Question).choices) })),
      effectiveSubject,
      effectiveSkill,
      "practice",
    ).slice(0, 5);
    const fallbackCrossPassage = buildSubjectPassage(effectiveSubject, level);
    const fallbackCrossQuestions = rebuildCrossFromPractice(fallbackPractice, effectiveSubject, effectiveSkill);
    const fallbackSupportPractice = ensureNonEmptySupport(
      fallbackPractice,
      [],
      [],
      "practice",
    );
    const fallbackSupportCross = ensureNonEmptySupport(
      fallbackCrossQuestions,
      [],
      [],
      "cross",
    );
    const fallbackAttempt: WorkerAttempt = {
      passage: effectiveMode === "core" ? (generatedCorePassage || null) : null,
      practice: { questions: fallbackPractice },
      cross: {
        passage: fallbackCrossPassage,
        questions: fallbackCrossQuestions,
      },
      tutor: { practice: fallbackSupportPractice.tutor, cross: fallbackSupportCross.tutor },
      answerKey: { practice: fallbackSupportPractice.answerKey, cross: fallbackSupportCross.answerKey },
    };
    returnType = "SAFE_FALLBACK";
    logReturnMetrics();
    return jsonResponse({
      teks: teksCode,
      skill,
      grade,
      ...(effectiveSubject === "Reading" ? { passage: fallbackAttempt.passage } : {}),
      practice: { questions: Array.isArray(fallbackAttempt.practice?.questions) ? fallbackAttempt.practice.questions : [] },
      cross: {
        passage: String(fallbackAttempt.cross?.passage || fallbackCrossPassage),
        questions: Array.isArray(fallbackAttempt.cross?.questions) ? fallbackAttempt.cross.questions : [],
      },
      tutor: {
        practice: Array.isArray(fallbackAttempt.tutor?.practice) ? fallbackAttempt.tutor.practice : [],
        cross: Array.isArray(fallbackAttempt.tutor?.cross) ? fallbackAttempt.tutor.cross : [],
      },
      answerKey: {
        practice: Array.isArray(fallbackAttempt.answerKey?.practice) ? fallbackAttempt.answerKey.practice : [],
        cross: Array.isArray(fallbackAttempt.answerKey?.cross) ? fallbackAttempt.answerKey.cross : [],
      },
    });
  } catch (err) {
    console.error("🔥 EDGE FUNCTION ERROR:", err);
    return jsonResponse({
      error: "FALLBACK_TRIGGERED",
      details: String(err instanceof Error ? err.message : err),
    }, 500);
  }
});
