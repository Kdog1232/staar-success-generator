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

type QuestionType = "mc" | "part_a" | "part_b" | "multi_select" | "scr";
type PassageContent = string | { text_1: string; text_2: string };

type Question = {
  type?: QuestionType;
  question: string;
  choices: [string, string, string, string];
  correct_answer: ChoiceLetter | [ChoiceLetter, ChoiceLetter];
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
  question: string;
  explanation: string;
  common_mistake: string;
  parent_tip: string;
  hint?: string;
  think?: string;
  step_by_step?: string;
};

type AnswerKeyEntry = {
  answer: string;
};

type WorkerResponse = {
  passage: PassageContent;
  crossPassage: string;
  practice: {
    questions: Question[];
  };
  cross: {
    questions: Question[];
  };
  tutor: {
    explanations: TutorExplanation[];
  };
  answerKey: {
    answers: AnswerKeyEntry[];
  };
};

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
  return `Create JSON only for a STAAR reading set.
Grade: ${grade}
Subject context: ${subject}
Skill: ${skill}
Level: ${level}

Return exactly:
{
  "passage": "string",
  "practice": { "questions": [5 items with question, choices, correct_answer, explanation] }
}

Rules:
- Passage must support all 5 questions.
- Questions must be ELAR comprehension focused.
- No markdown. JSON only.`;
}

function buildEnrichmentPrompt(params: {
  subject: CanonicalSubject;
  passage: PassageContent;
  practiceQuestions: Question[];
}): string {
  const { subject, passage, practiceQuestions } = params;
  const passageText = typeof passage === "string"
    ? passage
    : `${passage.text_1 || ""}\n\n${passage.text_2 || ""}`;
  return `Using the passage and practice questions, return JSON only:
{
  "cross": { "questions": [5 subject-aligned questions] },
  "tutor": { "explanations": [5 entries with question, explanation, common_mistake, parent_tip, hint, think, step_by_step] },
  "answerKey": { "answers": [5 entries with answer] }
}

Subject: ${subject}
Passage:
${passageText}

Practice questions:
${JSON.stringify(practiceQuestions.slice(0, 5))}

Rules:
- cross questions must be different from practice questions.
- cross questions MUST be HYBRID: reading comprehension + ${subject} reasoning.
- Every cross question must require interpreting passage evidence and applying subject knowledge.
- Cross questions must sound more academic and analytical than practice questions, using longer sentence structure and domain vocabulary.
- Include these reasoning words across stems: explain, infer, evidence, relationship, impact.
- Include subject references in stems (as appropriate): experiment/event/data/result/pattern.
- FORBIDDEN stems:
  "What is the main idea", "Which detail supports", "Calculate", "Solve", "When did"
- Each cross question must include exactly 4 REAL answer choices tied to passage evidence.
- Choices must include plausible misconceptions and subject-specific reasoning.
- Each question MUST have its own unique answer choices.
- Do NOT reuse answer choices across questions.
- Each set of choices must reflect the specific question being asked.
- Choices must directly reference passage content, not generic reasoning.
- Answer choices MUST reflect the subject context of the passage:
  - Science → experiments, variables, results
  - Social Studies → events, decisions, impact
  - Math → relationships, quantities, patterns
- Never use generic placeholders like:
  "A correct interpretation...", "A partially correct...", "An incorrect conclusion..."
- answerKey should match practice question answers.
- JSON only.`;
}

function buildSubjectPassage(subject: CanonicalSubject): string {
  if (subject === "Science") {
    return "During a campus investigation, students tested how surface type affected temperature at recess. They placed thermometers on blacktop, grass, and concrete every hour and recorded wind speed, cloud cover, and sunlight. The data showed that dark pavement heated fastest in direct sun, while shaded grass stayed cooler because moisture and airflow reduced heat buildup. Students repeated the experiment after watering one section and observed a smaller temperature increase there. In their report, they explained the physical process of heat transfer and used cause-and-effect evidence to recommend shade trees and lighter playground materials.";
  }

  if (subject === "Social Studies") {
    return "In 1908, leaders in a river town debated whether to spend limited tax funds on a bridge or a larger rail depot. Farmers argued that a bridge would move crops to market faster, while merchants supported the depot to attract outside trade. Meeting records show that the council first approved rail expansion, but repeated flooding delayed shipments and raised prices. Five years later, after population growth along the opposite bank, voters passed a bond for the bridge. Newspaper timelines and election results suggest that transportation choices changed migration patterns, business investment, and daily life across the town.";
  }

  if (subject === "Math") {
    return "The student council planned a field-day snack sale with two pricing options for families. A combo pack cost $6 and included one drink and two snacks, while single items cost $2 each. In the first hour, volunteers sold 38 combo packs and 24 single items. In the second hour, combo sales dropped by 8, but single-item sales increased by 15 after an announcement. Organizers used these numbers to compare revenue patterns and decide whether to restock combo materials or individual items. Their final decision depended on how the quantities in both hours related to total earnings.";
  }

  return "Students read an informational text and answered reading-comprehension questions using evidence from the passage.";
}

function normalizeChoices(choices: unknown): [string, string, string, string] {
  const fallbackChoices = [
    "A correct interpretation based on the passage",
    "A partially correct idea missing key details",
    "An incorrect conclusion not supported by the passage",
    "A misunderstanding of the information provided",
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

function validateHybridCross(questions: Question[]): boolean {
  return questions.every((q) => {
    const text = q.question.toLowerCase();
    const hasReading =
      text.includes("explain") ||
      text.includes("infer") ||
      text.includes("evidence") ||
      text.includes("relationship") ||
      text.includes("impact");

    const hasSubject =
      text.includes("experiment") ||
      text.includes("event") ||
      text.includes("data") ||
      text.includes("result") ||
      text.includes("pattern");

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

function clampPassageWords(passage: string, min: number, max: number): string {
  const cleaned = String(passage || "").replace(/\s+/g, " ").trim();
  const words = cleaned.split(" ").filter(Boolean);

  if (words.length < min) {
    return cleaned;
  }

  return words.slice(0, max).join(" ");
}

function fallbackPassage(subject: CanonicalSubject, mode: CanonicalMode, grade: number): string {
  const { min, max } = gradeWordRange(grade, mode === "Cross-Curricular" ? "Reading" : subject, mode);

  if (mode === "Cross-Curricular") {
    return clampPassageWords(buildSubjectPassage(subject), min, max);
  }

  if (subject === "Math") {
    return clampPassageWords(
      "A school is planning a weekend market fundraiser. Student teams must decide pricing, estimate supply needs, and compare costs for materials and transportation. Their plan includes tracking sales data, calculating totals after discounts, and checking whether the final profit meets a goal for classroom technology.",
      min,
      max,
    );
  }

  if (subject === "Science") {
    return clampPassageWords(
      "Students tested how light intensity affects plant growth by placing seedlings at different distances from a lamp. They measured height changes, tracked water use, and recorded observations over two weeks. The class analyzed patterns in the data and debated which variables might have influenced unexpected results.",
      min,
      max,
    );
  }

  if (subject === "Social Studies") {
    return clampPassageWords(
      "In the early years of a growing town, leaders debated whether to invest limited funds in roads, irrigation, or a public market. Farmers, merchants, and families offered different priorities based on geography, trade routes, and available jobs. Newspaper editorials from the period show how economic choices shaped civic life and daily routines.",
      min,
      max,
    );
  }

  return clampPassageWords(
    "A class read an informational article about how communities solve local problems by collecting evidence, comparing ideas, and choosing the most effective solution. Students tracked key details, discussed author choices, and explained which evidence best supported the central claim.",
    min,
    max,
  );
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
): PassageContent {
  if (!isCompareSkill(skill)) return fallbackPassage(subject, mode, grade);

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

function buildPracticeFallback(skill: string): Question[] {
  const effectiveSkill: string = skill ?? "Main Idea";
  const stems = [
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
  return stems.map((stem, i) => {
    const support = buildSupportContent("Reading", stem, "mc", i);
    return {
      type: "mc",
      question: stem,
      choices: [
        "A choice directly supported by passage evidence",
        "A partially supported detail that misses key evidence",
        "A statement not supported by the passage",
        "An unrelated claim from outside the passage",
      ],
      correct_answer: nextSingleAnswer(),
      explanation: support.explanation,
      hint: support.hint,
      think: support.think,
      step_by_step: support.step_by_step,
      common_mistake: support.common_mistake,
      parent_tip: support.parent_tip,
    };
  });
}

function buildCrossFallback(subject: CanonicalSubject): Question[] {
  const singleAnswerSequence = [...shuffledLetters(), ...shuffledLetters()];
  let singleAnswerIndex = 0;
  const nextSingleAnswer = (): ChoiceLetter => {
    const letter = singleAnswerSequence[singleAnswerIndex % singleAnswerSequence.length];
    singleAnswerIndex += 1;
    return letter;
  };

  const mathStemVariants = [
    "Which statement best explains the relationship between the quantities in the scenario data and the overall result, based on evidence from the passage?",
    "Which conclusion about the quantity relationship is most supported by the pattern across the passage data?",
    "What inference can be made about how the quantities interact based on the evidence in the passage?",
    "Which interpretation best describes the pattern in the data relationship and its impact on the aggregate result?",
    "Which explanation best justifies the change in results and supports the planning decision in the passage?",
  ];

  const stems = subject === "Science"
    ? [
      "Which analytical claim most effectively explains the relationship between the experiment's independent and dependent variables, using the quantitative evidence presented in the passage data?",
      "Based on the experimental procedure and reported results, what can be inferred about the mechanism driving the observed change, and which evidence most directly justifies that inference?",
      "Which explanation of causal interaction demonstrates the strongest alignment with the experiment data and the author’s evidence-based reasoning in the passage?",
      "Which interpretation of the data relationship best explains the downstream impact of adjusting a single variable within the experimental system described in the passage?",
      "Which evidence-based inference most convincingly explains the broader impact of the experiment results on the passage’s final scientific recommendation?",
    ]
    : subject === "Social Studies"
    ? [
      "Which interpretation most effectively explains the relationship between the central historical event and its political or economic impact, using evidence from the passage?",
      "What can be inferred about the motivations behind leadership decisions, and which event evidence most persuasively supports that inference?",
      "Which causal explanation most clearly shows how one historical event contributed to a subsequent result, according to the evidence in the passage?",
      "Which analysis of the relationship between stakeholder motivations and policy outcomes best explains the event impact described in the passage?",
      "Which inference about long-term societal impact is most defensible when the event timeline evidence in the passage is considered as a whole?",
    ]
    : mathStemVariants;

  const choiceBanks: [string, string, string, string][] = subject === "Math"
    ? [
      [
        "The relationship evidence indicates the total is driven by how multiple quantities move together across both time periods, not by one value in isolation.",
        "A single quantity controls the final outcome completely, so the other values have no meaningful relationship to the result.",
        "Any increase in one quantity guarantees a higher total even when another quantity decreases by a larger amount.",
        "The pattern cannot be interpreted at all unless every final value is computed first, so no relationship claim is justified.",
      ],
      [
        "The pattern suggests the result shifted because the quantity relationship changed between periods, with one increase partially offsetting another decrease.",
        "The data prove the second period must be better only because one quantity increased, regardless of all other relationships.",
        "No meaningful pattern exists because the quantities are from different time periods and cannot be compared.",
        "The shift happened randomly, so relationship-based inference is not possible from the quantities provided.",
      ],
      [
        "The strongest explanation describes a stable relationship pattern in which combined quantities, not isolated arithmetic steps, drive the interpretation.",
        "The best claim is that the largest number always determines the outcome, regardless of the relationship among the other quantities.",
        "Because one quantity stayed close to its earlier value, the overall relationship pattern did not change in any relevant way.",
        "The scenario is descriptive only, so no quantitative relationship can be inferred from the passage evidence.",
      ],
      [
        "The evidence shows that adjusting one quantity changes the overall relationship and therefore changes planning decisions tied to total results.",
        "Changing one quantity has no meaningful effect on the aggregate result if at least one other quantity remains constant.",
        "The passage implies every quantity contributes equally, so shifting one value cannot alter the relationship interpretation.",
        "The impact is unknowable because relationship evidence does not apply to real planning decisions.",
      ],
      [
        "The observed pattern supports choosing the option that accounts for quantity relationships across both periods before making the final plan.",
        "The best plan is to focus only on the latest quantity and ignore earlier relationship patterns in the evidence.",
        "Pattern evidence is less reliable than intuition, so planning should not depend on quantity relationships.",
        "The data are too general to support any defensible pattern-based planning inference.",
      ],
    ]
    : subject === "Science"
    ? [
      [
        "The experiment evidence supports a variable-result relationship in which changing the tested condition produced a consistent directional result.",
        "The result appears random, indicating no meaningful relationship between the manipulated variable and the measured outcome.",
        "The experiment shows that outside conditions alone caused the change, so the tested variable had no effect on the result.",
        "Because the observations were limited, no variable-result explanation can be made from the experiment evidence.",
      ],
      [
        "The procedure and results support an inference that the independent variable influenced the outcome through a repeatable experimental mechanism.",
        "The results show the dependent variable changed on its own, so the experiment does not support variable-based causation.",
        "The best inference is that measurement errors explain all result changes better than the tested variable does.",
        "The experiment lacks enough structure to infer how any variable affected the final result.",
      ],
      [
        "The strongest causal explanation connects the reported experiment result to the interaction between the tested variable and observed conditions.",
        "The best claim is that the result was unaffected by the tested variable because one data point did not follow the trend exactly.",
        "The evidence supports rejecting all causal interpretations since experiments cannot show variable relationships reliably.",
        "The passage provides descriptive notes but no result evidence relevant to variable-based explanation.",
      ],
      [
        "The data relationship indicates that adjusting one variable changed downstream results in a way consistent with the experiment evidence.",
        "The downstream result cannot be tied to the adjusted variable because all experimental changes are equally irrelevant.",
        "Any impact in the results must come from uncontrolled factors, not from the variable intentionally adjusted in the experiment.",
        "No defensible inference can be made because variable-result relationships require perfect data with zero uncertainty.",
      ],
      [
        "The passage supports inferring that the experiment results justify the recommendation because variable-driven evidence aligns with the final claim.",
        "The recommendation is unsupported because experiment results cannot inform decisions beyond the exact trial conditions.",
        "The results imply the opposite conclusion: the tested variable should be ignored in future explanations.",
        "The final claim is unrelated to the experiment because no measurable variable-result pattern appears in the passage.",
      ],
    ]
    : [
      [
        "The event evidence shows that leadership decisions responded to conditions and produced measurable social and economic impact over time.",
        "The passage suggests outcomes happened independently of key decisions, so no event-impact relationship is supported.",
        "Because one group influenced debate, broader events had no role in shaping final outcomes or impact.",
        "The timeline is descriptive only and cannot support inference about decisions or civic impact.",
      ],
      [
        "The strongest inference is that leaders made decisions based on immediate event pressures and expected long-term community impact.",
        "The evidence shows decisions were symbolic only and had no meaningful relationship to later events or impact.",
        "Motivations cannot be inferred because event records never help explain why decisions were made.",
        "The passage proves all leaders shared identical goals, so decision analysis is unnecessary for impact claims.",
      ],
      [
        "The causal chain is best supported by linking one documented event to a later decision and its measurable community impact.",
        "The best interpretation is that events and decisions were unrelated, with impact determined only by outside forces.",
        "Because the timeline includes multiple events, no single decision can be evaluated for impact.",
        "The evidence supports only short-term description, not causal reasoning about event-driven impact.",
      ],
      [
        "The passage supports analyzing how competing stakeholder decisions shaped policy outcomes and changed event impact across groups.",
        "Stakeholder positions did not influence policy decisions, so impact differences must be ignored in interpretation.",
        "Policy outcomes in the passage were accidental, making decision-based event analysis invalid.",
        "The event sequence lacks enough information to reason about decision tradeoffs or impact.",
      ],
      [
        "Considering the full event timeline, the most defensible claim is that key decisions produced cumulative long-term civic impact.",
        "Long-term impact cannot be inferred because earlier events are irrelevant once a final decision appears.",
        "The timeline shows that impact was fixed from the start, so later decisions did not matter.",
        "No conclusion about societal impact is possible because event evidence never supports long-range inference.",
      ],
    ];

  const shuffledChoiceBanks = [...choiceBanks];
  for (let i = shuffledChoiceBanks.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffledChoiceBanks[i], shuffledChoiceBanks[j]] = [shuffledChoiceBanks[j], shuffledChoiceBanks[i]];
  }

  return stems.map((_, i) => {
    const stem = subject === "Math" ? mathStemVariants[i] : stems[i];
    const support = buildSupportContent(subject, stem, "mc", i);
    const choices = shuffledChoiceBanks[i % shuffledChoiceBanks.length];

    return {
      type: "mc",
      question: stem,
      choices: choices as [string, string, string, string],
      correct_answer: nextSingleAnswer(),
      explanation: support.explanation,
      hint: support.hint,
      think: support.think,
      step_by_step: support.step_by_step,
      common_mistake: support.common_mistake,
      parent_tip: support.parent_tip,
    };
  });
}

function fallbackQuestionSet(subject: CanonicalSubject, mode: CanonicalMode, skill: string): Question[] {
  if (mode === "Practice") return buildPracticeFallback(skill);

  const effectiveSubject = subject;
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

  if (mode === "Cross-Curricular") {
    return buildCrossFallback(subject);
  }

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
    const type: QuestionType = i === 3 ? "multi_select" : i === 4 ? "scr" : "mc";
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
      correct_answer: type === "multi_select" ? nextMultiAnswer() : nextSingleAnswer(),
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
): Question[] {
  const incoming = Array.isArray(raw) ? raw.slice(0, 5) : [];
  const fallback = fallbackQuestionSet(subject, mode, skill);
  const sanitized: Question[] = incoming.map((item, i) => {
    const q = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const expectedType = fallback[i].type || "mc";
    const type: QuestionType = expectedType;
    const rawQuestion = String(q.question || fallback[i].question).trim() || fallback[i].question;
    const questionText = type === "multi_select" && !/select\s+two\s+answers\./i.test(rawQuestion)
      ? `${rawQuestion.replace(/\s+$/g, "")} Select TWO answers.`
      : rawQuestion;

    const normalizedChoices = normalizeChoices(q.choices);
    const hasGenericChoices = normalizedChoices.some((choice) => {
      const text = String(choice || "").toLowerCase();
      return text.includes("correct interpretation") ||
        text.includes("partially correct") ||
        text.includes("incorrect conclusion") ||
        text.includes("misunderstanding of the information");
    });

    const base: Question = {
      type,
      question: questionText,
      choices: mode === "Cross-Curricular" && hasGenericChoices ? fallback[i].choices : normalizedChoices,
      correct_answer: type === "multi_select" ? normalizeMultiSelectAnswer(q.correct_answer) : normalizeAnswer(q.correct_answer),
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

  while (sanitized.length < 5) sanitized.push(fallback[sanitized.length]);

  return sanitized.slice(0, 5).map((q) => q);
}

function validateSkillAlignment(skill: string, questions: Question[]): boolean {
  if (!skill || !Array.isArray(questions) || questions.length === 0) return false;
  const skillLower = String(skill).toLowerCase();
  if (skillLower.includes("vocabulary")) {
    return questions.some((q) => {
      const prompt = String(q?.question || "").toLowerCase();
      return prompt.includes("meaning") || prompt.includes("word");
    });
  }
  return true;
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
  if (Array.isArray(value)) {
    const letters = value.map((entry) => normalizeAnswer(entry));
    return letters.join(", ");
  }
  return normalizeAnswer(value);
}

function sanitizeTutorExplanations(raw: unknown, practiceQuestions: Question[]): TutorExplanation[] {
  const incoming = Array.isArray(raw) ? raw.slice(0, 5) : [];
  const fallback = practiceQuestions.slice(0, 5).map((q, index) => ({
    question: q.question,
    explanation: q.explanation || `Use evidence from the passage to answer Question ${index + 1}.`,
    common_mistake: q.common_mistake || "Picking a choice that sounds right but is not proven by the passage.",
    parent_tip: q.parent_tip || "Ask your child to cite one line of evidence before choosing.",
    hint: q.hint || "Underline the key words in the question.",
    think: q.think || "Eliminate choices that are only partially supported.",
    step_by_step: q.step_by_step || "1) Read question 2) Check evidence 3) Confirm answer.",
  }));

  const sanitized = incoming.map((item, index) => {
    const entry = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const base = fallback[index] || fallback[fallback.length - 1];
    return {
      question: String(entry.question || base.question).trim() || base.question,
      explanation: String(entry.explanation || base.explanation).trim() || base.explanation,
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

function sanitizeAnswerKey(raw: unknown, practiceQuestions: Question[]): AnswerKeyEntry[] {
  const incoming = Array.isArray(raw) ? raw.slice(0, 5) : [];
  const fallback = practiceQuestions.slice(0, 5).map((q) => ({
    answer: normalizeAnswerKeyEntry(q.correct_answer),
  }));
  const sanitized = incoming.map((item, index) => {
    const entry = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const base = fallback[index] || fallback[fallback.length - 1];
    return {
      answer: normalizeAnswerKeyEntry(entry.answer || base.answer),
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
  const crossKeywords: Record<CanonicalSubject, string[]> = {
    Reading: ["explain", "infer", "evidence", "relationship", "impact"],
    "Social Studies": ["explain", "infer", "evidence", "relationship", "impact"],
    Science: ["explain", "infer", "evidence", "relationship", "impact"],
    Math: ["explain", "infer", "evidence", "relationship", "impact"],
  };

  const practiceValid = practice.every((q) =>
    practiceKeywords.some((k) => String(q.question || "").toLowerCase().includes(k))
  );

  const subjectKeywords = crossKeywords[subject] ?? [];
  const crossValid = cross.some((q) =>
    subjectKeywords.some((k) => String(q.question || "").toLowerCase().includes(k))
  );

  return practiceValid && crossValid;
}

function buildFallbackResponse(
  grade: number,
  subject: CanonicalSubject,
  skill: string,
): WorkerResponse {
  const effectiveSubject = subject;
  const practiceQuestions = buildPracticeFallback(skill);
  const crossQuestions = buildCrossFallback(effectiveSubject);
  return {
    passage: fallbackPassageContent(effectiveSubject, "Practice", grade, skill),
    crossPassage: buildSubjectPassage(effectiveSubject),
    practice: { questions: practiceQuestions },
    cross: { questions: crossQuestions },
    tutor: { explanations: sanitizeTutorExplanations([], practiceQuestions) },
    answerKey: { answers: sanitizeAnswerKey([], practiceQuestions) },
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
  let effectiveSubject: CanonicalSubject = "Reading";
  let effectiveSkill = READING_SKILL_DEFAULT;

  const jsonResponse = (
    payload: WorkerResponse,
    meta: { fallback: boolean; reason: string; error?: string; usedFallbackCross?: boolean },
  ) =>
    new Response(JSON.stringify({
      passage: payload.passage,
      crossPassage: payload.crossPassage,
      practice: payload.practice,
      cross: payload.cross,
      tutor: payload.tutor,
      answerKey: payload.answerKey,
      meta,
    }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  const safeFallback = (reason: string, error?: string) => {
    console.log("🚨 FALLBACK TRIGGERED:", reason);
    const payload = buildFallbackResponse(grade, effectiveSubject, effectiveSkill);
    return jsonResponse(payload, { fallback: true, reason, usedFallbackCross: false, ...(error ? { error } : {}) });
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
    mode = canonicalizeMode(incomingMode);
    effectiveSubject = subject;
    effectiveSkill = skill ?? "Main Idea";
    const range = gradeWordRange(grade, effectiveSubject, mode);

    let attempts = 0;
    let retryFailureReason = "bad_output_after_retry";
    const phase = String(body.phase || "core").toLowerCase() === "enrich" ? "enrich" : "core";

    while (attempts < 2) {
      try {
        if (phase === "core") {
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
            signal: AbortSignal.timeout(45000),
          });
          console.timeEnd("OPENAI_CALL");

          if (!aiRes.ok) {
            retryFailureReason = `openai_status_${aiRes.status}`;
            attempts++;
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
            attempts++;
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
            attempts++;
            continue;
          }

          const parsedPassage = parsed.passage;
          const passage = parsedPassage && typeof parsedPassage === "object" && !Array.isArray(parsedPassage)
            ? {
              text_1: clampPassageWords(String((parsedPassage as Record<string, unknown>).text_1 || ""), 45, 220),
              text_2: clampPassageWords(String((parsedPassage as Record<string, unknown>).text_2 || ""), 45, 220),
            }
            : clampPassageWords(String(parsedPassage || ""), range.min, range.max);
          const safePassage = (
            typeof passage === "string"
              ? passage
              : (passage.text_1 && passage.text_2 ? passage : null)
          ) || fallbackPassageContent(effectiveSubject, "Practice", grade, effectiveSkill);

          const practiceQuestions = sanitizeQuestions(
            parsed?.practice && typeof parsed.practice === "object"
              ? (parsed.practice as Record<string, unknown>).questions
              : parsed.questions,
            effectiveSubject,
            "Practice",
            effectiveSkill,
          );

          const skillAligned = validateSkillAlignment(effectiveSkill, practiceQuestions);
          if (!skillAligned) {
            console.warn("⚠️ Skill mismatch detected; accepting sanitized questions to avoid retries.");
          }

          return jsonResponse(
            {
              passage: safePassage,
              crossPassage: buildSubjectPassage(effectiveSubject),
              practice: { questions: practiceQuestions },
              cross: { questions: [] },
              tutor: { explanations: [] },
              answerKey: { answers: [] },
            },
            { fallback: false, reason: "ai_core_success", usedFallbackCross: false },
          );
        }

        const priorPassage = body.passage;
        const priorPractice = body.practiceQuestions;
        if (!priorPassage || !Array.isArray(priorPractice) || priorPractice.length === 0) {
          return safeFallback("missing_enrichment_inputs");
        }

        const normalizedPractice = sanitizeQuestions(
          priorPractice,
          effectiveSubject,
          "Practice",
          effectiveSkill,
        );
        const normalizedPassage = typeof priorPassage === "object" && priorPassage !== null
          ? {
            text_1: String((priorPassage as Record<string, unknown>).text_1 || ""),
            text_2: String((priorPassage as Record<string, unknown>).text_2 || ""),
          }
          : String(priorPassage || "").trim();
        const safePassage = (
          typeof normalizedPassage === "string"
            ? clampPassageWords(normalizedPassage, range.min, range.max)
            : normalizedPassage
        ) || fallbackPassageContent(effectiveSubject, "Practice", grade, effectiveSkill);
        let subjectCrossPassage = buildSubjectPassage(effectiveSubject);

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
              passage: safePassage,
              practiceQuestions: normalizedPractice,
            }),
            max_output_tokens: 2200,
          }),
          signal: AbortSignal.timeout(45000),
        });
        console.timeEnd("OPENAI_CALL");

        if (!enrichRes.ok) {
          retryFailureReason = `openai_status_${enrichRes.status}`;
          attempts++;
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
        const candidateCrossPassage = String((parsed as Record<string, unknown>).crossPassage || "").trim();
        if (candidateCrossPassage) subjectCrossPassage = candidateCrossPassage;
        if (!validateCrossPassage(subjectCrossPassage)) {
          subjectCrossPassage = buildSubjectPassage(effectiveSubject);
        }

        let crossQuestions = sanitizeQuestions(
          parsed?.cross && typeof parsed.cross === "object"
            ? (parsed.cross as Record<string, unknown>).questions
            : [],
          effectiveSubject,
          "Cross-Curricular",
          effectiveSkill,
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

        const crossInvalid = !validateHybridCross(crossQuestions) ||
          !validateUniqueChoices(crossQuestions);
        if (crossInvalid) {
          console.warn("⚠️ Cross output partially invalid; regenerating cross questions only.");
          crossQuestions = buildCrossFallback(effectiveSubject);
        }

        const tutorExplanations = sanitizeTutorExplanations(
          parsed?.tutor && typeof parsed.tutor === "object"
            ? (parsed.tutor as Record<string, unknown>).explanations
            : [],
          normalizedPractice,
        );

        const answerKeyAnswers = sanitizeAnswerKey(
          parsed?.answerKey && typeof parsed.answerKey === "object"
            ? (parsed.answerKey as Record<string, unknown>).answers
            : [],
          normalizedPractice,
        );

        return jsonResponse(
          {
            passage: safePassage,
            crossPassage: subjectCrossPassage,
            practice: { questions: normalizedPractice },
            cross: { questions: crossQuestions },
            tutor: { explanations: tutorExplanations },
            answerKey: { answers: answerKeyAnswers },
          },
          {
            fallback: false,
            reason: crossInvalid ? "ai_enrichment_success_with_cross_fallback" : "ai_enrichment_success",
            usedFallbackCross: crossInvalid,
          },
        );
      } catch (err) {
        console.error("BACKEND ERROR:", err);
        retryFailureReason = "openai_request_failed";
        attempts++;
      }
    }

    return safeFallback(retryFailureReason);
  } catch (err) {
    console.error("BACKEND ERROR:", err);
    return safeFallback("ai_failure_catch", err instanceof Error ? err.message : String(err));
  }
});
