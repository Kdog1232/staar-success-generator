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

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const READING_SKILL_DEFAULT = "Finding the main idea";
const LETTERS: ChoiceLetter[] = ["A", "B", "C", "D"];

function shuffledLetters(): ChoiceLetter[] {
  const pool = [...LETTERS];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool;
}

function canonicalizeMode(mode: unknown): CanonicalMode {
  const value = String(mode || "").toLowerCase();
  if (value.includes("cross")) return "Cross-Curricular";
  if (value.includes("tutor")) return "Tutor";
  if (value.includes("answer")) return "Answer Key";
  return "Practice";
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
  if (!normalized) throw new Error("Missing skill");
  if (normalized.includes("vocabulary")) return "vocab";
  if (normalized.includes("main idea")) return "main_idea";
  if (normalized.includes("infer")) return "inference";
  if (normalized.includes("theme")) return "theme";
  return "generic";
}

function getDifficultyInstructions(level: Level): string {
  if (level === "Below") {
    return "Use simpler vocabulary, shorter passages, and direct questions.";
  }
  if (level === "On Level") {
    return "Use grade-appropriate vocabulary and standard STAAR rigor.";
  }
  if (level === "Advanced") {
    return "Use complex vocabulary, layered inference, and higher DOK questions.";
  }
  return "";
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
}): string {
  const { grade, subject, skill, level } = params;
  const rigor = applyRigor(level);
  if (subject === "Reading") {
    return `Create JSON only for PRACTICE MODE.
Grade: ${grade}
Subject: ${subject}
Skill: ${skill}
Level: ${level}

Return exactly:
{
  "passage": "REQUIRED string (250–300 words)",
  "practice": { "questions": [5 items with question, choices, correct_answer, explanation] }
}

Rules:
- PRACTICE MODE ONLY. Do not generate cross-curricular content.
- Subject is Reading, so include a new 250–300 word passage.
- Generate exactly 5 STAAR-style reading questions tied directly to that passage.
- Rigor profile:
  - passage complexity: ${rigor.passage}
  - question depth: ${rigor.questionDepth}
  - distractor quality: ${rigor.distractorQuality}
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
- Subject is ${subject}, so DO NOT generate a passage.
- Generate exactly 5 standalone STAAR-style ${subject} questions.
- Use multi-step reasoning where appropriate.
- Questions must be subject-driven and not ELAR-framed.
- Forbidden wording in questions/choices: "main idea", "central idea", "author", "theme", "reader", "claim".
- Rigor profile:
  - question depth: ${rigor.questionDepth}
  - distractor quality: ${rigor.distractorQuality}
- Every question has 4 distinct, specific answer choices.
- No markdown. JSON only.`;
}

function buildEnrichmentPrompt(params: {
  subject: CanonicalSubject;
  skill: string;
  practiceQuestions: Question[];
  level: Level;
}): string {
  const { subject, skill, practiceQuestions, level } = params;
  const rigor = applyRigor(level);
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
- Each question must include exactly 4 clear, distinct, passage-specific answer choices.
- Choices must be clean answer options only (no explanations or commentary text).
- Validate answer correctness before returning.
- Tutor entries (practice + cross) must include: question_id, question, explanation, common_mistake, parent_tip, hint, think, step_by_step.
- Answer key entries (practice + cross) must include: question_id, correct_answer, explanation, common_mistake, parent_tip.
- Cross tutor + answer key must reference cross passage evidence.
- JSON only.`;
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

function normalizeChoices(choices: unknown): [string, string, string, string] {
  const fallbackChoices = [
    "The claim is best supported by details from the middle section where results and outcomes are compared across groups.",
    "The claim is partly supported by one detail, but it ignores a later detail that changes the conclusion.",
    "The claim misreads the evidence by treating one early event as the final result described in the passage.",
    "The claim confuses background context with the author’s main evidence for the final conclusion.",
  ];
  const raw = Array.isArray(choices) ? choices.slice(0, 4) : [];
  while (raw.length < 4) raw.push(fallbackChoices[raw.length]);

  return raw.map((entry, index) => {
    const stripped = String(entry ?? "").trim().replace(/^[A-D]\.\s*/i, "");
    const normalized = stripped.toLowerCase();
    const isPlaceholder = !stripped ||
      normalized === "option" ||
      /^option\s*\d+$/i.test(stripped) ||
      /^choice\s*[a-d]$/i.test(stripped) ||
      /^choice\s*\d+$/i.test(stripped);
    return isPlaceholder ? fallbackChoices[index] : stripped;
  }) as [string, string, string, string];
}

function strengthenChoiceSet(
  choices: [string, string, string, string],
  questionText: string,
  passage: PassageContent | string = "",
  subject: CanonicalSubject = "Reading",
): [string, string, string, string] {
  if (subject !== "Reading") return normalizeChoices(choices);

  const text = getPassageText(passage);
  const keywords = passageKeywords(text).slice(0, 4);
  const defaultKeywords = questionText
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 4)
    .slice(0, 4);
  const anchors = (keywords.length ? keywords : defaultKeywords).slice(0, 2);
  const [anchorA, anchorB] = [anchors[0] || "evidence", anchors[1] || "results"];

  const weakSignal = /(unrelated|not supported|random|impossible|always|never|no evidence|cannot be)/i;
  const upgraded = choices.map((choice, index) => {
    const clean = String(choice || "").trim();
    if (!clean || weakSignal.test(clean)) {
      const variants = [
        `This option uses one true detail about ${anchorA} but misreads how it connects to ${anchorB}.`,
        `This option is partly correct about ${anchorA}, but it ignores a later detail that changes the result.`,
        `This option confuses the sequence of ${anchorA} and ${anchorB}, leading to a wrong conclusion.`,
        `This option applies the passage details to the wrong cause-and-effect relationship involving ${anchorA}.`,
      ];
      return variants[index % variants.length];
    }

    if (clean.split(/\s+/).length < 8) {
      const shortVariants = [
        `${clean} based on ${anchorA} and ${anchorB}.`,
        `${clean} using the passage details about ${anchorA}.`,
        `${clean} with evidence connected to ${anchorB}.`,
        `${clean} from the scenario data on ${anchorA}.`,
      ];
      return shortVariants[index % shortVariants.length];
    }

    return clean;
  });

  return upgraded as [string, string, string, string];
}

function validateHybridCross(questions: Question[]): boolean {
  return questions.every((q) => {
    const text = q.question.toLowerCase();
    const hasReading = text.includes("what caused") ||
      text.includes("which event happened after") ||
      text.includes("which detail shows") ||
      text.includes("what can be inferred") ||
      text.includes("what can be concluded") ||
      text.includes("why did");

    const hasSubject = text.includes("experiment") ||
      text.includes("event") ||
      text.includes("data") ||
      text.includes("result") ||
      text.includes("temperature") ||
      text.includes("bridge") ||
      text.includes("sales") ||
      text.includes("earnings");

    return hasReading && hasSubject;
  });
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

function ensurePassageLength(passage: string, min = 250, max = 300): string {
  const cleaned = String(passage || "").replace(/\s+/g, " ").trim();
  const words = cleaned.split(" ").filter(Boolean);
  if (words.length >= min && words.length <= max) return cleaned;
  if (words.length > max) return words.slice(0, max).join(" ");
  const extension = "The report adds key evidence, compares outcomes, and explains why each detail matters for the final conclusion.";
  let expanded = cleaned;
  while (expanded.split(/\s+/).filter(Boolean).length < min) {
    expanded = `${expanded} ${extension}`.trim();
  }
  return expanded.split(/\s+/).filter(Boolean).slice(0, max).join(" ");
}

function isWeakPassage(passage: PassageContent | string): boolean {
  const text = getPassageText(passage).trim();
  return !text || text.split(/\s+/).filter(Boolean).length < 200;
}

function fallbackPassage(subject: CanonicalSubject, mode: CanonicalMode, grade: number, level: Level = "On Level"): string {
  const min = 250;
  const max = 300;

  if (mode === "Cross-Curricular") {
    return ensurePassageLength(clampPassageWords(buildSubjectPassage(subject, level), min, max), min, max);
  }

  if (subject === "Math") {
    return ensurePassageLength(clampPassageWords(
      "A school is planning a weekend market fundraiser. Student teams must decide pricing, estimate supply needs, and compare costs for materials and transportation. Their plan includes tracking sales data, calculating totals after discounts, and checking whether the final profit meets a goal for classroom technology.",
      min,
      max,
    ), min, max);
  }

  if (subject === "Science") {
    return ensurePassageLength(clampPassageWords(
      "Students tested how light intensity affects plant growth by placing seedlings at different distances from a lamp. They measured height changes, tracked water use, and recorded observations over two weeks. The class analyzed patterns in the data and debated which variables might have influenced unexpected results.",
      min,
      max,
    ), min, max);
  }

  if (subject === "Social Studies") {
    return ensurePassageLength(clampPassageWords(
      "In the early years of a growing town, leaders debated whether to invest limited funds in roads, irrigation, or a public market. Farmers, merchants, and families offered different priorities based on geography, trade routes, and available jobs. Newspaper editorials from the period show how economic choices shaped civic life and daily routines.",
      min,
      max,
    ), min, max);
  }

  return ensurePassageLength(clampPassageWords(
    "A class read an informational article about how communities solve local problems by collecting evidence, comparing ideas, and choosing the most effective solution. Students tracked key details, discussed author choices, and explained which evidence best supported the central claim.",
    min,
    max,
  ), min, max);
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
): { explanation: string; common_mistake: string; parent_tip: string; hint: string; think: string; step_by_step: string } {
  const usesVisual = /(table|diagram|model|map|chart)/i.test(questionText);
  const sourceRef = usesVisual ? "the visual and scenario details" : "the scenario details";
  const subjectConcept = subject === "Math"
    ? "the mathematical relationship in the problem"
    : subject === "Science"
    ? "the scientific cause-and-effect relationship"
    : subject === "Social Studies"
    ? "the historical or civic cause-and-effect relationship"
    : "the central idea and supporting evidence";

  const explanation = type === "multi_select"
    ? `Both correct answers are supported by ${sourceRef} and each captures a different part of ${subjectConcept}.`
    : type === "scr"
    ? `A strong response explains ${subjectConcept} and cites exact evidence from ${sourceRef}.`
    : `The correct answer is supported by ${sourceRef} and correctly applies ${subjectConcept}.`;

  const common_mistake = type === "multi_select"
    ? `Students may choose one true statement and one partial-truth distractor because both sound reasonable, but only two choices are fully supported by ${sourceRef}.`
    : type === "scr"
    ? `Students often retell the scenario without explaining ${subjectConcept}, which misses the required evidence-based reasoning.`
    : `Students may pick a choice that uses familiar vocabulary but does not match what ${sourceRef} shows about ${subjectConcept}.`;

  const parent_tip = type === "scr"
    ? `Ask your child, "Which exact detail from ${usesVisual ? "the visual or scenario" : "the scenario"} proves your explanation?" Then have them underline the evidence before writing.`
    : `Ask your child, "What evidence in ${usesVisual ? "the visual and scenario" : "the scenario"} proves this answer?" Then compare that evidence to one wrong choice.`;

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

  const hint = hintVariants[index % hintVariants.length];
  const think = thinkVariants[index % thinkVariants.length];
  const step_by_step = stepVariants[index % stepVariants.length];

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
  const rigor = applyRigor(level);
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
      `What is the main idea of the passage about ${effectiveSkill.toLowerCase()}?`,
      "Which detail supports the main idea best?",
      "What can the reader infer from the passage details?",
      "Which word meaning is best supported by context in the passage?",
      "Which summary best matches the passage?",
    ];
  const singleAnswerSequence = [...shuffledLetters(), ...shuffledLetters()];
  let singleAnswerIndex = 0;
  const nextSingleAnswer = (): ChoiceLetter => {
    const letter = singleAnswerSequence[singleAnswerIndex % singleAnswerSequence.length];
    singleAnswerIndex += 1;
    return letter;
  };
  const passageDrivenChoices = passage ? generateChoicesFromPassage(passage) : null;

  return stems.map((stem, i) => {
    const type: QuestionType = i === 1 ? "part_a_b" : "mc";
    const leveledStem = rigor.questionDepth === "low" && subject !== "Reading"
      ? stem.replace("Which statement best explains", "What is the best answer")
      : stem;
    const support = buildSupportContent(subject, stem, "mc", i);
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
        "A detail from the passage directly supports the main idea.",
        "A detail from the passage is repeated but does not support the main idea.",
        "A detail from outside the passage is introduced as evidence.",
        "A detail contradicts the main idea presented in the passage.",
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
        "The sentence includes a passage detail that proves the main idea.",
        "The sentence repeats a side detail without proving the main idea.",
        "The sentence gives background context but no supporting evidence.",
        "The sentence conflicts with the main point of the passage.",
      ];
    const choices = subject === "Math"
      ? [
        "A value that correctly combines all quantities using the needed operations in the problem.",
        "A value from using only one part of the information and missing another step.",
        "A value found by using the wrong operation on one quantity.",
        "A value unrelated to the totals described in the problem.",
      ]
      : subject === "Science"
      ? [
        rigor.distractorQuality === "obvious"
          ? "The only answer that matches the cause/effect or data in the scenario."
          : "An explanation that matches the cause/effect or data shown in the scenario.",
        rigor.distractorQuality === "subtle"
          ? "An explanation with accurate vocabulary but a slightly incorrect scientific link."
          : "An explanation with one true detail but a wrong scientific connection.",
        "An explanation that ignores the tested variable or observed result.",
        "An explanation not supported by the scenario evidence.",
      ]
      : subject === "Social Studies"
      ? [
        "A response that matches the event, timeline, or consequence described.",
        "A response that mixes the order of events in the scenario.",
        "A response that confuses a cause with a later result.",
        "A response not supported by the historical/civic details provided.",
      ]
      : (passageDrivenChoices || [
        rigor.distractorQuality === "obvious"
          ? "The choice that directly matches the passage idea."
          : "A response grounded in passage evidence",
        rigor.distractorQuality === "subtle"
          ? "A nearly correct idea that misses one key detail from later in the passage."
          : "A partially supported detail that misses key evidence",
        "A statement not supported by the passage",
        "An unrelated claim from outside the passage",
      ]);
    const question: Question = {
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
            ? "Part B: Which step shows the correct reasoning for your Part A answer?"
            : subject === "Science"
            ? "Part B: Which evidence from the scenario supports your Part A answer?"
            : subject === "Social Studies"
            ? "Part B: Which detail from the event timeline best supports your Part A answer?"
            : "Part B: Which sentence best supports your Part A answer?",
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
    return question;
  });
}

function generateChoicesFromPassage(passage: PassageContent | string): [string, string, string, string] {
  const text = getPassageText(passage).trim();
  const keywords = passageKeywords(text).slice(0, 4);
  const focus = keywords[0] || "the passage topic";
  const detail = keywords[1] || "key details";
  const context = keywords[2] || "supporting evidence";
  const outlier = keywords[3] || "an unrelated detail";

  return [
    `It focuses on ${focus} and is supported by ${detail} in the passage.`,
    `It mentions ${detail} but ignores how ${context} shapes the main point.`,
    `It overemphasizes ${outlier} even though it is not central to the passage.`,
    "It introduces outside information that is not stated in the passage.",
  ];
}

function buildCrossFallback(subject: CanonicalSubject, level: Level = "On Level"): Question[] {
  const rigor = applyRigor(level);
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
        "Because second-hour changes affected the number of paid items, organizers had to compare revenue from both hours before restocking.",
        "Because combo packs always make the most money, first-hour numbers alone were enough for the final decision.",
        "Because single items are cheaper, they never affect total earnings as much as combo packs.",
        "Because sales changed, revenue could not be compared between the two hours.",
      ],
      [
        "After combo sales dropped by 8, volunteers recorded that single-item sales increased by 15.",
        "After combo sales dropped by 8, the sale ended before any other counts were recorded.",
        "After combo sales dropped by 8, both combo and single-item sales dropped together.",
        "After combo sales dropped by 8, prices changed from $6 and $2 to new values.",
      ],
      [
        "The passage says single-item sales increased by 15 after an announcement in the second hour.",
        "The passage says single-item prices were the same as combo pack prices.",
        "The passage says combo sales increased by 15 after the announcement.",
        "The passage says no counts were recorded for the second hour.",
      ],
      [
        "They needed totals from both hours because each hour had different quantities and prices that changed total revenue.",
        "They only needed second-hour combo sales because combo packs are always the best indicator.",
        "They only needed first-hour single-item sales because later changes are not useful.",
        "They did not need any totals because the decision could be made without the data.",
      ],
      [
        "A change in single-item demand can shift total earnings even when combo sales decrease.",
        "Combo sales determine all earnings, so single-item changes do not matter.",
        "Single items and combo packs always contribute equal revenue per sale.",
        "The passage gives no numbers, so no earnings conclusion can be made.",
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
    const leveledStem = rigor.questionDepth === "high"
      ? `${stem} Which passage detail best supports your analysis?`
      : stem;
    const support = buildSupportContent(subject, leveledStem, "mc", i);
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

  return stems.map((stem, i) => {
    const type: QuestionType = i === 1 ? "part_a_b" : i === 4 ? "scr" : "mc";
    const support = buildSupportContent("Reading", stem, type, i);
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
    return {
      type,
      question: stem,
      choices: [
        "It matches the central claim and is supported by details from both the earlier explanation and the final section of the passage.",
        "It uses one accurate detail from the opening paragraph but ignores later evidence that changes the author’s conclusion.",
        "It focuses on a side detail mentioned once in the passage and treats it as the main point.",
        "It reverses the relationship between evidence and conclusion described across the passage sections.",
      ],
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
  });
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
    const support = buildSupportContent(effectiveSubject, stem, type, i);
    const question: Question = {
      type,
      question: stem,
      choices: [
        "The plants closest to the lamp grew taller because they received more direct light.",
        "All plants grew at the same rate, so light intensity did not matter in this setup.",
        "Plants farther from the lamp appeared to grow faster because lower heat outweighed reduced light.",
        "Plant height changed randomly and was not related to the light conditions in the investigation.",
      ],
      correct_answer: type === "multi_select"
        ? nextMultiAnswer()
        : type === "part_a_b"
        ? { partA: nextSingleAnswer(), partB: nextSingleAnswer() }
        : nextSingleAnswer(),
      partA: type === "part_a_b"
        ? {
          question: `Part A: ${stem}`,
          choices: [
            "The plants closest to the lamp grew taller because they received more direct light.",
            "All plants grew at the same rate, so light intensity did not matter in this setup.",
            "Plants farther from the lamp appeared to grow faster because lower heat outweighed reduced light.",
            "Plant height changed randomly and was not related to the light conditions in the investigation.",
          ],
        }
        : undefined,
      partB: type === "part_a_b"
        ? {
          question: "Part B: Which evidence best supports your Part A answer?",
          choices: [
            "The investigation compared plant growth at different distances from the lamp over two weeks.",
            "The passage says all plants were measured only once at the end of the week.",
            "The class ignored light distance and focused only on soil color.",
            "The scenario states that light intensity never changed during the test.",
          ],
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
      const candidate = cleaned.slice(start, end + 1);
      const parsed = JSON.parse(candidate);
      return (parsed && typeof parsed === "object") ? parsed as Record<string, unknown> : {};
    }
    throw new Error("Malformed model JSON");
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
  const forbiddenNonReading = ["main idea", "central idea", "author", "theme", "claim", "reader", "best explains"];
  const skillTokens = String(skill || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 3);
  const cleanChoiceText = (value: unknown): string =>
    String(value ?? "")
      .replace(/^[A-D]\.\s*/i, "")
      .replace(/\s*(This interpretation sounds possible.*)$/i, "")
      .replace(/\s*\b(because|since|so that)\b.*$/i, "")
      .trim();
  const hasForbiddenLanguage = (text: string) =>
    subject !== "Reading" && forbiddenNonReading.some((term) => text.includes(term));
  const hasSkillSignal = (text: string) =>
    skillTokens.length === 0 || skillTokens.some((token) => text.includes(token));
  const isSelfContained = (q: Question) => {
    const questionText = String(q.question || "").toLowerCase();
    if (!questionText || questionText.length < 12) return false;
    if (hasForbiddenLanguage(questionText)) return false;
    const allChoiceText = (q.choices || []).map((choice) => String(choice || "").toLowerCase()).join(" ");
    if (hasForbiddenLanguage(allChoiceText)) return false;
    if (!hasSkillSignal(`${questionText} ${allChoiceText}`)) return false;
    if (mode === "Cross-Curricular") {
      const requiresPassageSignal =
        /(according to the passage|based on the passage|from the passage|in the passage|scenario|data|table|model|investigation|timeline)/i
          .test(questionText);
      if (!requiresPassageSignal) return false;
    }
    if (q.type === "part_a_b") {
      const partAText = String(q.partA?.question || "").toLowerCase();
      const partBText = String(q.partB?.question || "").toLowerCase();
      if (!partAText || !partBText) return false;
      const sharedKeywords = questionText.split(/\s+/).filter((word) =>
        word.length > 5 && partAText.includes(word) && partBText.includes(word)
      );
      if (sharedKeywords.length < 1) return false;
    }
    return true;
  };
  const answerFitsQuestion = (q: Question): boolean => {
    if (q.type === "part_a_b") {
      const partAnswer = normalizePartABAnswer(q.correct_answer);
      return Boolean(
        q.partA?.choices?.[LETTERS.indexOf(partAnswer.partA)] &&
          q.partB?.choices?.[LETTERS.indexOf(partAnswer.partB)],
      );
    }
    const single = normalizeAnswer(q.correct_answer);
    return Boolean(q.choices?.[LETTERS.indexOf(single)]);
  };
  const replaceWithFallback = (index: number): Question => ({ ...fallback[index] });
  const sanitized: Question[] = incoming.map((item, i) => {
    const q = item && typeof item === "object" ? item as Record<string, unknown> : {};
    if (!q.question || !q.choices || !Array.isArray(q.choices) || q.choices.length < 4) {
      return replaceWithFallback(i);
    }
    const expectedType = fallback[i].type || "mc";
    const type: QuestionType = expectedType;
    const rawQuestion = String(q.question || fallback[i].question).trim() || fallback[i].question;
    const questionText = type === "multi_select" && !/select\s+two\s+answers\./i.test(rawQuestion)
      ? `${rawQuestion.replace(/\s+$/g, "")} Select TWO answers.`
      : rawQuestion;

    let normalizedChoices = (
      subject === "Reading"
        ? strengthenChoiceSet(normalizeChoices(q.choices), questionText, passage, subject)
        : normalizeChoices(q.choices).map((choice) => cleanChoiceText(choice))
    ) as [string, string, string, string];

    if (subject === "Math") {
      normalizedChoices = normalizedChoices.map((choice) => {
        const cleaned = String(choice).trim();
        if (/[+\-*/=]/.test(cleaned)) return cleaned;
        const match = cleaned.match(/-?\d+(\.\d+)?/);
        return match ? match[0] : cleaned;
      }) as [string, string, string, string];
    }

    const forbidden = /(interpretation|supports|claim|evidence|conclusion)/i;
    if (subject !== "Reading") {
      const fallbackChoices = [...fallback[i].choices];
      normalizedChoices = normalizedChoices.map((choice) =>
        forbidden.test(choice) ? (fallbackChoices.shift() || choice) : choice
      ) as [string, string, string, string];
    }

    const fallbackPartA = fallback[i].partA || {
      question: "Part A: What is the best answer?",
      choices: normalizeChoices(fallback[i].choices),
    };
    const fallbackPartB = fallback[i].partB || {
      question: "Part B: Which evidence best supports Part A?",
      choices: normalizeChoices(fallback[i].choices),
    };

    const base: Question = {
      type,
      question: questionText,
      choices: normalizedChoices,
      correct_answer: type === "multi_select"
        ? normalizeMultiSelectAnswer(q.correct_answer || fallback[i].correct_answer)
        : type === "part_a_b"
        ? normalizePartABAnswer(q.correct_answer || fallback[i].correct_answer)
        : normalizeAnswer(q.correct_answer || fallback[i].correct_answer),
      partA: type === "part_a_b"
        ? {
          question: String((q.partA as Record<string, unknown> | undefined)?.question || fallbackPartA.question).trim() || fallbackPartA.question,
          choices: strengthenChoiceSet(
            normalizeChoices((q.partA as Record<string, unknown> | undefined)?.choices || fallbackPartA.choices),
            String((q.partA as Record<string, unknown> | undefined)?.question || fallbackPartA.question),
            passage,
            subject,
          ).map((choice) => cleanChoiceText(choice)) as [string, string, string, string],
        }
        : undefined,
      partB: type === "part_a_b"
        ? {
          question: String((q.partB as Record<string, unknown> | undefined)?.question || fallbackPartB.question).trim() || fallbackPartB.question,
          choices: strengthenChoiceSet(
            normalizeChoices((q.partB as Record<string, unknown> | undefined)?.choices || fallbackPartB.choices),
            String((q.partB as Record<string, unknown> | undefined)?.question || fallbackPartB.question),
            passage,
            subject,
          ).map((choice) => cleanChoiceText(choice)) as [string, string, string, string],
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

    if (!isSelfContained(base) || !answerFitsQuestion(base)) {
      return replaceWithFallback(i);
    }
    return base;
  });

  while (sanitized.length < 5) sanitized.push(replaceWithFallback(sanitized.length));

  return sanitized.slice(0, 5).map((q) => q);
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
    return tokens.length === 0 || tokens.some((token) => text.includes(token));
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
  const passageText = getPassageText(passage).trim();
  if (!passageText || passageText.length <= 50) return false;
  if (!Array.isArray(questions) || questions.length === 0) return false;

  return questions.every((question) => {
    const stem = String(question?.question || "").toLowerCase();
    const choices = Array.isArray(question?.choices) ? question.choices : [];
    return (
      choices.length === 4 &&
      !stem.includes("which author choice best supports your reasoning") &&
      !choices.some((choice) => String(choice || "").toLowerCase().includes("choice directly supported"))
    );
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

    const combined = `${q.question} ${q.choices.join(" ")}`.toLowerCase();
    const overlap = keywords.filter((k) => combined.includes(k)).length;
    if (overlap < 2) return false;

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

function sanitizeTutorExplanations(
  raw: unknown,
  sourceQuestions: Question[],
  mode: "practice" | "cross",
  crossPassage = "",
): TutorExplanation[] {
  const incoming = Array.isArray(raw) ? raw.slice(0, 5) : [];
  const fallback = sourceQuestions.slice(0, 5).map((q, index) => ({
    question_id: ensureQuestionId(q, index, mode),
    question: q.question,
    explanation: mode === "cross"
      ? (q.explanation || `Use evidence from the cross passage to answer Question ${index + 1}.`)
      : (q.explanation || `Use evidence from the question scenario to answer Question ${index + 1}.`),
    common_mistake: q.common_mistake || "Picking a choice that sounds right but is not proven by evidence.",
    parent_tip: q.parent_tip || "Ask your child to cite one line of evidence before choosing.",
    hint: q.hint || "Underline the key words in the question.",
    think: q.think || "Eliminate choices that are only partially supported.",
    step_by_step: q.step_by_step || "1) Read question 2) Check evidence 3) Confirm answer.",
  }));

  const sanitized = incoming.map((item, index) => {
    const entry = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const base = fallback[index] || fallback[fallback.length - 1];
    const explanation = String(entry.explanation || base.explanation).trim() || base.explanation;
    const resolvedExplanation = mode === "cross" && crossPassage
      ? (/\bpassage\b/i.test(explanation) ? explanation : `${explanation} Use details from the cross passage.`)
      : explanation;
    return {
      question_id: String(entry.question_id || base.question_id),
      question: String(entry.question || base.question).trim() || base.question,
      explanation: resolvedExplanation,
      common_mistake: String(entry.common_mistake || base.common_mistake).trim() || base.common_mistake,
      parent_tip: String(entry.parent_tip || base.parent_tip).trim() || base.parent_tip,
      hint: String(entry.hint || base.hint || "").trim() || base.hint,
      think: String(entry.think || base.think || "").trim() || base.think,
      step_by_step: String(entry.step_by_step || base.step_by_step || "").trim() || base.step_by_step,
    };
  });

  while (sanitized.length < 5) sanitized.push(fallback[sanitized.length]);
  return sanitized.slice(0, 5);
}

function sanitizeAnswerKey(
  raw: unknown,
  sourceQuestions: Question[],
  tutor: TutorExplanation[],
  mode: "practice" | "cross",
  crossPassage = "",
): AnswerKeyEntry[] {
  const incoming = Array.isArray(raw) ? raw.slice(0, 5) : [];
  const fallback = sourceQuestions.slice(0, 5).map((q, index) => ({
    question_id: ensureQuestionId(q, index, mode),
    correct_answer: normalizeAnswerKeyEntry(q.correct_answer),
    explanation: tutor[index]?.explanation || q.explanation || "Use evidence to justify the correct answer.",
    common_mistake: tutor[index]?.common_mistake || q.common_mistake || "Choosing an answer without evidence.",
    parent_tip: tutor[index]?.parent_tip || q.parent_tip || "Ask your child to cite evidence before deciding.",
  }));
  const sanitized = incoming.map((item, index) => {
    const entry = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const base = fallback[index] || fallback[fallback.length - 1];
    const explanation = String(entry.explanation || base.explanation).trim() || base.explanation;
    return {
      question_id: String(entry.question_id || base.question_id),
      correct_answer: normalizeAnswerKeyEntry(entry.correct_answer || entry.answer || base.correct_answer),
      explanation: mode === "cross" && crossPassage && !/\bpassage\b/i.test(explanation)
        ? `${explanation} Refer to evidence in the cross passage.`
        : explanation,
      common_mistake: String(entry.common_mistake || base.common_mistake).trim() || base.common_mistake,
      parent_tip: String(entry.parent_tip || base.parent_tip).trim() || base.parent_tip,
    };
  });

  while (sanitized.length < 5) sanitized.push(fallback[sanitized.length]);
  return sanitized.slice(0, 5);
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
  const practiceKeywords = ["main idea", "detail", "infer", "meaning", "summary"];
  const practiceValid = practice.every((q) =>
    practiceKeywords.some((k) => String(q.question || "").toLowerCase().includes(k))
  );

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
  const crossTutor = sanitizeTutorExplanations([], crossContent.questions, "cross", crossContent.passage);
  const practiceTutor = sanitizeTutorExplanations([], practiceQuestions, "practice");
  return {
    passage: subject === "Reading" ? practicePassage : "",
    practice: { questions: practiceQuestions },
    cross: { passage: crossContent.passage, questions: crossContent.questions },
    tutor: { practice: practiceTutor, cross: crossTutor },
    answerKey: {
      practice: sanitizeAnswerKey([], practiceQuestions, practiceTutor, "practice"),
      cross: sanitizeAnswerKey([], crossContent.questions, crossTutor, "cross", crossContent.passage),
    },
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  let grade = 5;
  let subject: CanonicalSubject = "Reading";
  let skill = READING_SKILL_DEFAULT;
  let level: Level = "On Level";
  let mode: CanonicalMode = "Practice";
  let requestMode: "core" | "enrichment" = "core";
  let effectiveSubject: CanonicalSubject = "Reading";
  let effectiveSkill = READING_SKILL_DEFAULT;

  const jsonResponse = (payload: Record<string, unknown>) =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  const returnCore = (data: CoreResponse) =>
    jsonResponse(subject === "Reading"
      ? {
        passage: ensurePassageLength(getPassageText(data.passage || ""), 250, 300),
        practice: data.practice,
      }
      : {
        practice: data.practice,
      });
  const returnEnrichment = (data: EnrichmentResponse) =>
    jsonResponse({
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
    if (!user) return safeFallback("unauthorized");

    let body: Record<string, unknown> = {};
    try {
      body = await req.json();
    } catch (err) {
      console.error("BACKEND ERROR:", err);
      return safeFallback("invalid_request_json", err instanceof Error ? err.message : String(err));
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
    level = normalizeLevel(incomingLevel);
    requestMode = String(incomingMode || "core").toLowerCase() === "enrichment" ? "enrichment" : "core";
    mode = canonicalizeMode(incomingContentMode);
    effectiveSubject = subject;
    effectiveSkill = skill ?? "Main Idea";
    console.log("🧠 REQUEST MODE:", requestMode);
    console.log("🧠 CONTENT MODE:", mode);
    console.log("🧠 SUBJECT:", subject);
    console.log("🧠 EFFECTIVE SUBJECT:", effectiveSubject);
    const range = { min: 250, max: 300 };

    let attempts = 0;
    const MAX_ATTEMPTS = 2;
    const start = Date.now();
    const MAX_TIME = 15000;
    const isTimedOut = () => Date.now() - start > MAX_TIME;
    let retryFailureReason = "bad_output_after_retry";
    let bestAttempt: WorkerAttempt | null = null;
    let returnType = "UNKNOWN";
    const logReturnMetrics = () => {
      console.log("🔁 ATTEMPTS USED:", attempts);
      console.log("🎯 RETURN TYPE:", returnType);
      console.log("⏱ TOTAL TIME:", Date.now() - start, "ms");
    };
    while (attempts < MAX_ATTEMPTS) {
      if (isTimedOut()) {
        console.warn("⏰ Time limit reached, returning best result");
        break;
      }
      attempts++;
      try {
        if (requestMode === "core") {
          console.time("OPENAI_CALL");
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
              }),
              max_output_tokens: 1800,
            }),
            signal: AbortSignal.timeout(18000),
          });
          console.timeEnd("OPENAI_CALL");

          if (!aiRes.ok) {
            retryFailureReason = `openai_status_${aiRes.status}`;
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
            retryFailureReason = "bad_output_after_retry";
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
            retryFailureReason = "json_parse_failed";
            continue;
          }

          const parsedPassage = parsed.passage;
          const passage = parsedPassage && typeof parsedPassage === "object" && !Array.isArray(parsedPassage)
            ? {
              text_1: ensurePassageLength(clampPassageWords(String((parsedPassage as Record<string, unknown>).text_1 || ""), range.min, range.max), range.min, range.max),
              text_2: ensurePassageLength(clampPassageWords(String((parsedPassage as Record<string, unknown>).text_2 || ""), range.min, range.max), range.min, range.max),
            }
            : ensurePassageLength(clampPassageWords(String(parsedPassage || ""), range.min, range.max), range.min, range.max);
          const safePassage = subject === "Reading"
            ? (
              typeof passage === "string"
                ? passage
                : (passage.text_1 && passage.text_2 ? passage : null)
            )
            : "";
          if (subject === "Reading" && (!safePassage || !getPassageText(safePassage).trim())) {
            retryFailureReason = "empty_passage";
            continue;
          }
          if (subject === "Reading" && isWeakPassage(safePassage) && attempts < MAX_ATTEMPTS) {
            console.log("🔁 Weak passage — regenerating...");
            retryFailureReason = "weak_passage";
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

          const skillAligned = validateSkillAlignment(effectiveSkill, practiceQuestions);
          if (!skillAligned) {
            console.warn("⚠️ Skill mismatch detected; accepting sanitized questions to avoid retries.");
          }

          const outputValid = subject === "Reading"
            ? isValidOutput(practiceQuestions, safePassage)
            : Array.isArray(practiceQuestions) && practiceQuestions.length === 5;
          if (!outputValid) {
            console.warn("⚠️ Minor issue, keeping AI output");
          }

          const payload: CoreResponse = {
            passage: subject === "Reading" ? ensurePassageLength(getPassageText(safePassage), range.min, range.max) : undefined,
            practice: { questions: practiceQuestions },
          };
          if (subject !== "Reading") {
            delete payload.passage;
          }
          bestAttempt = {
            passage: payload.passage || "",
            practice: payload.practice,
            cross: { passage: "", questions: [] },
            tutor: { practice: [], cross: [] },
            answerKey: { practice: [], cross: [] },
          };
          returnType = "PRIMARY";
          logReturnMetrics();
          return returnCore(payload);
        }

        const priorPractice = body.practiceQuestions;
        if (!Array.isArray(priorPractice) || priorPractice.length === 0) {
          return safeFallback("missing_enrichment_inputs");
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

        console.time("OPENAI_CALL");
        const enrichRes = await fetch("https://api.openai.com/v1/responses", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${Deno.env.get("OPENAI_API_KEY")}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            input: buildEnrichmentPrompt({
              subject: effectiveSubject,
              skill: effectiveSkill,
              practiceQuestions: normalizedPractice,
              level,
            }),
            max_output_tokens: 2200,
          }),
          signal: AbortSignal.timeout(18000),
        });
        console.timeEnd("OPENAI_CALL");

        if (!enrichRes.ok) {
          retryFailureReason = `openai_status_${enrichRes.status}`;
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
        subjectCrossPassage = ensurePassageLength(subjectCrossPassage, 250, 300);

        let crossQuestions = sanitizeQuestions(
          parsedCross.questions || [],
          effectiveSubject,
          "Cross-Curricular",
          effectiveSkill,
          level,
          subjectCrossPassage,
        );
        const crossChoiceSubjectAligned = validateChoiceSubjectAlignment(effectiveSubject, crossQuestions);
        if (!crossChoiceSubjectAligned) {
          console.warn("⚠️ Cross choice-subject alignment warning: accepting output without fallback.");
        }
        const crossSeparationValid = validateSeparation(normalizedPractice, crossQuestions, effectiveSubject);
        if (!crossSeparationValid) {
          console.warn("⚠️ Cross separation warning: accepting output without fallback.");
        }
        const crossQuestionSetsDistinct = areQuestionSetsDistinct(normalizedPractice, crossQuestions);
        if (!crossQuestionSetsDistinct) {
          console.warn("⚠️ Cross question-set distinctness warning: accepting output without fallback.");
        }

        const distractorQualityOk = validateDistractorQuality(crossQuestions, subjectCrossPassage);
        if (!distractorQualityOk) {
          console.warn("⚠️ Weak distractors, continuing anyway");
        }

        const crossInvalid = !validateCrossCurricular({ passage: subjectCrossPassage, questions: crossQuestions }) ||
          !validateCrossQuestionRequirements(effectiveSubject, subjectCrossPassage, crossQuestions) ||
          !validateRigorAlignment(level, subjectCrossPassage, crossQuestions) ||
          !validateHybridCross(crossQuestions) ||
          !validateUniqueChoices(crossQuestions);
        if (crossInvalid) {
          console.warn("⚠️ Invalid cross output detected; replacing full cross set.");
          const forcedCross = buildSubjectCrossContent(effectiveSubject, level);
          subjectCrossPassage = ensurePassageLength(forcedCross.passage, 250, 300);
          crossQuestions = sanitizeQuestions(
            forcedCross.questions,
            effectiveSubject,
            "Cross-Curricular",
            effectiveSkill,
            level,
            subjectCrossPassage,
          );
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
          "practice",
        );
        const tutorCross = sanitizeTutorExplanations(
          parsedTutor.cross || [],
          crossQuestions,
          "cross",
          subjectCrossPassage,
        );

        const answerKeyPractice = sanitizeAnswerKey(
          parsedAnswerKey.practice || parsedAnswerKey.answers || [],
          normalizedPractice,
          tutorPractice,
          "practice",
        );
        const answerKeyCross = sanitizeAnswerKey(
          parsedAnswerKey.cross || [],
          crossQuestions,
          tutorCross,
          "cross",
          subjectCrossPassage,
        );

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
        retryFailureReason = "openai_request_failed";
      }
    }

    if (bestAttempt) {
      returnType = "BEST_ATTEMPT";
      logReturnMetrics();
      if (requestMode === "enrichment") {
        return returnEnrichment(bestAttempt);
      }
      return returnCore(bestAttempt);
    }
    returnType = "FALLBACK";
    logReturnMetrics();
    return safeFallback(retryFailureReason);
  } catch (err) {
    console.error("BACKEND ERROR:", err);
    return safeFallback("ai_failure_catch", err instanceof Error ? err.message : String(err));
  }
});
