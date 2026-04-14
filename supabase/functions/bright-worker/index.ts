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

type WorkerResponse = {
  passage: PassageContent;
  questions: Question[];
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

function pickCrossSubject(index: number): CrossConnection["subject"] {
  const cycle: CrossConnection["subject"][] = ["Science", "Math", "Social Studies"];
  return cycle[index % cycle.length];
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
  const effectiveSkill = skill || READING_SKILL_DEFAULT;
  if (mode === "Practice" && subject !== "Reading") {
    return `You are a Texas STAAR 2.0 assessment expert.

Your task is to generate PRACTICE MODE questions that match real STAAR item behavior.

========================
MODE: PRACTICE
========================

INPUTS:
- Grade: ${grade}
- Subject: ${subject}
- Skill: ${effectiveSkill}
- Level: ${level}

========================
GLOBAL RULES (ALL SUBJECTS)
========================

- Generate EXACTLY 5 questions:
  1) Multiple Choice
  2) Multiple Choice
  3) Multiple Choice
  4) Multi-select (MUST say "Select TWO answers.")
  5) Short Constructed Response (SCR)
- NO reading passage unless subject is Reading.
- Each question must feel like a standalone STAAR item.
- At least TWO questions MUST include a visual scenario:
  diagram, table, chart, model, or map.
- Visuals must be REQUIRED to answer the question.
- Distractors MUST be plausible, reflect common student mistakes, and include partial truths.
- All answer choices must be similar in length, structure, and tone.
- Avoid one obviously longer correct answer or one obviously short incorrect answer.
- Correct answers must not follow a predictable pattern; distribute across A-D.

========================
SUBJECT-SPECIFIC BEHAVIOR
========================

MATH (CRITICAL):
- Require numerical reasoning, multi-step problem solving, and data interpretation.
- At least ONE question must involve a table, graph, or number-based model.
- Students MUST perform math to get the answer.
- FORBIDDEN: purely descriptive questions or items answerable without calculation/reasoning.

SCIENCE (CRITICAL):
- Require scientific concepts, experiment/system analysis, and cause-and-effect reasoning.
- At least ONE question must involve an experiment setup or diagram/model.
- Students must interpret scientific relationships.
- FORBIDDEN: definition-only or recall-only questions.

SOCIAL STUDIES (CRITICAL):
- Require historical/civic reasoning, cause-and-effect analysis, and source interpretation.
- At least ONE question must include a map, chart, or historical scenario.
- Questions must involve decisions, events, or impact.
- FORBIDDEN: simple fact recall or isolated trivia.

========================
MULTI-SELECT RULE (VERY IMPORTANT)
========================

- The TWO correct answers must represent DIFFERENT valid ideas.
- At least one wrong answer must be a strong partial truth.
- Students must evaluate ALL options carefully.

========================
SHORT RESPONSE RULE (VERY IMPORTANT)
========================

- Q5 must begin with "Explain..."
- Q5 must require:
  1) correct subject reasoning
  2) justification using the scenario, diagram, or data
- Q5 must end with: "Write your response..."

========================
EXPLANATION / MISCONCEPTION / PARENT SUPPORT (CRITICAL)
========================

For EVERY question, provide:
- "explanation" (specific)
- "common_mistake" (specific)
- "parent_tip" (specific and actionable)

Rules:
- explanation must clearly state WHY the correct answer is correct and reference the scenario/visual + concept.
- common_mistake must name a specific wrong-reasoning pattern or wrong choice type and explain why students pick it.
- parent_tip must include a direct question a parent can ask the student and what evidence/concept to focus on.

OUTPUT FORMAT (STRICT)
Return ONLY valid JSON (for app parsing). In each question text and choice text, use only student-facing wording:
{
  "passage": "NO_PASSAGE_FOR_${subject.toUpperCase()}",
  "questions": [
    {
      "type": "mc|multi_select|scr",
      "question": "...",
      "choices": ["...", "...", "...", "..."],
      "correct_answer": "A OR [A,C]",
      "explanation": "...",
      "common_mistake": "...",
      "parent_tip": "...",
      "sample_answer": "...",
      "visual": {
        "type": "table|diagram|chart|model|map",
        "title": "...",
        "description": "...",
        "headers": ["...", "..."],
        "rows": [["...", "..."]],
        "diagram_type": "...",
        "components": [{ "type": "...", "x": 0, "y": 0 }]
      }
    }
  ]
}
- EXACTLY 5 questions in this order: mc, mc, mc, multi_select, scr.
- Q4 question MUST include "Select TWO answers."
- Include structured "visual" objects in at least two questions and make visuals necessary to answer.
- Q5 must begin with "Explain..." and end with "Write your response..."
- No teacher language, no extra sections, and no markdown.`;
  }

  if (mode === "Cross-Curricular") {
    return `You are a Texas STAAR 2.0 assessment expert.

Your task is to generate CROSS-CURRICULAR practice that integrates reading comprehension skills with SUBJECT content.

========================
MODE: CROSS-CURRICULAR
========================

INPUTS:
- Grade: ${grade}
- Subject: ${subject}
- Skill: ${effectiveSkill}
- Level: ${level}

========================
CORE REQUIREMENTS
========================

Generate a STAAR-style worksheet that follows this structure:
1) HEADER with Skill, Level, and Progress line
2) TITLE: "STAAR Practice Worksheet"
3) PASSAGE: content-based informational text tied to subject + skill, 150-250 words, with a real-world scenario OR classroom experiment, clear cause/effect relationships, and concept vocabulary
4) QUESTIONS: EXACTLY 5 in this order:
   - Q1 Main Idea (mc)
   - Q2 Supporting Detail (mc)
   - Q3 Inference (mc, deeper thinking)
   - Q4 Multi-select with exactly 2 correct answers
   - Q5 SCR that begins with "Explain..." and requires passage evidence

========================
RIGOR
========================

- Questions must require close reading, evidence analysis, and idea connection.
- Questions must require both reading comprehension and understanding of the ${subject} concept.
- Distractors must be plausible and reflect common student mistakes.
- At least one incorrect answer must reflect a common misunderstanding of the ${subject} concept.
- All answer choices must be similar in length, structure, and tone.
- Avoid one obviously longer correct answer or one obviously short incorrect answer.
- Correct answers must not follow a predictable pattern; distribute across A-D.
- No simple recall questions.

========================
EXPLANATION / MISCONCEPTION / PARENT SUPPORT (CRITICAL)
========================

For EVERY question, provide:
- "explanation" (specific)
- "common_mistake" (specific)
- "parent_tip" (specific and actionable)

Rules:
- explanation must clearly state WHY the correct answer is correct and reference the scenario/visual + concept.
- common_mistake must name a specific wrong-reasoning pattern or wrong choice type and explain why students pick it.
- parent_tip must include a direct question a parent can ask the student and what evidence/concept to focus on.

========================
CROSS-CURRICULAR RULE
========================

This is reading applied to ${subject} content.
- Every question must depend on the passage.
- Content knowledge supports thinking but does not replace reading analysis.
- Each question must explicitly reference:
  - the scenario, experiment, or situation described in the passage
  - the subject concept being tested
- Avoid generic phrasing such as "According to the passage..."

OUTPUT FORMAT (STRICT)
Return ONLY valid JSON:
{
  "passage": "...",
  "questions": [
    {
      "type": "mc|multi_select|scr",
      "question": "...",
      "choices": ["...", "...", "...", "..."],
      "correct_answer": "A OR [A,C]",
      "explanation": "...",
      "common_mistake": "...",
      "parent_tip": "...",
      "sample_answer": "..."
    }
  ]
}
- EXACTLY 5 questions.
- Q4 MUST include the sentence "Select TWO answers." in the question text and must have exactly 2 correct answers.
- For Q4 multi-select:
  - The two correct answers must represent DIFFERENT valid ideas or factors.
  - At least one incorrect answer must be a strong partial truth.
  - Students should need to evaluate ALL options carefully.
- Q5 MUST begin with "Explain..." and require evidence from the passage.
- NO markdown.
- NO teacher notes, no extra sections, and no additional prose outside JSON.`;
  }

  return `You are a Texas STAAR assessment expert.

All questions MUST align to TEKS-based reading comprehension skills.

Generate STAAR 2.0-style reading content with EXACTLY 5 questions.

INPUTS:
- Grade: ${grade}
- Subject: ${effectiveSubject}
- Skill: ${effectiveSkill}
- Level: ${level}

QUESTION TYPES (REQUIRED)
- "mc"
- "part_a"
- "part_b"
- "multi_select"
- "scr"

MANDATORY QUESTION ORDER (EXACTLY 5)
1) Main Idea (type "mc")
2) Supporting Detail (type "mc")
3) Part A inference item (type "part_a") with paired Part B evidence data fields:
   - "part_b_question"
   - "part_b_choices" (4 options)
   - "part_b_correct_answer" (A-D)
   - "paired_with": 3
4) Multi-select (type "multi_select") with exactly 2 correct answers in array format
5) Short Constructed Response (type "scr") with "sample_answer" (2-4 sentences)

DOK PROGRESSION (REQUIRED)
1. DOK 1–2 main idea comprehension
2. DOK 2 supporting detail
3. DOK 2–3 inference + evidence pairing
4. DOK 3 multi-select reasoning
5. DOK 3 evidence-based SCR

LEVEL DIFFERENTIATION
- Below: mostly DOK 1-2, simpler vocabulary, more obvious evidence
- On Level: balanced DOK 2-3, standard STAAR rigor
- Advanced: heavy DOK 3, subtle distractors, inference-heavy reasoning

SKILL ALIGNMENT (STRICT)
All 5 questions must align to this skill only:
"${effectiveSkill}"

DISTRACTOR RULES
- Wrong answers must be plausible, text-based, and reflect student mistakes
- Use partial truth, misinterpretation, and overgeneralization
- Keep answer choices similar in tone and length
- All answer choices must be fully written, content-based, and tied to the passage.
- Never use placeholders like "Option 1", "Option 2", or "Choice A".
- Do not include backend labels in choice text (no "A. ", "B. ", etc.). Choices must be plain text.
- Inference distractors must be plausible misinterpretations, partial truths, or incorrect conclusions.

PASSAGE RULES
- Passage must support all five questions with enough textual evidence
- Include details enabling inference and justification
- If skill includes "compare", "contrast", or "two texts", return:
  {
    "text_1": "...",
    "text_2": "..."
  }
  and require cross-text reasoning in Part A/Part B, multi-select, and SCR.

OUTPUT FORMAT (STRICT)
Return ONLY valid JSON:
{
  "passage": "... OR { text_1, text_2 }",
  "questions": [
    {
      "type": "mc|part_a|part_b|multi_select|scr",
      "question": "...",
      "choices": ["...", "...", "...", "..."],
      "correct_answer": "A OR [A,C]",
      "explanation": "...",
      "paired_with": 3,
      "sample_answer": "...",
      "part_b_question": "...",
      "part_b_choices": ["A...", "B...", "C...", "D..."],
      "part_b_correct_answer": "C"
    }
  ]
}
- EXACTLY 5 questions
- For "multi_select": include the sentence "Select TWO answers." in the question text and set exactly 2 correct answers.
- SCR item should appear once as a single question object (no duplicate question text blocks).
- FINAL SELF-CHECK before returning JSON:
  1) No duplicate choice labels (for example "A. A.")
  2) No placeholders
  3) Multi-select has exactly 2 correct answers
  4) SCR appears once
  5) Every question aligns to the requested skill
- NO markdown
- NO extra text`;
}

function normalizeChoices(choices: unknown): [string, string, string, string] {
  const fallbackChoices = [
    "A claim that is directly supported by multiple details in the passage",
    "A partial truth that omits a key condition from the passage",
    "A likely-sounding conclusion that extends beyond the passage evidence",
    "An interpretation that misreads the author’s main point",
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
    return clampPassageWords(
      "A city park team studied how weather, water use, and public planning affected tree growth across neighborhoods. Volunteers compared monthly rainfall records, mapped shaded and sunny zones, and interviewed families about how often they visited each area. Students summarized findings in charts and explained why some sections stayed cooler during hot afternoons. They also read short reports about urban ecosystems, budget choices, and community design. By combining evidence from reading, data, and civic decision-making, the group recommended planting native trees near playgrounds and bus stops. Their plan balanced environmental science, mathematical measurement, and social studies priorities so that more residents could safely enjoy outdoor spaces.",
      min,
      max,
    );
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

function fallbackQuestionSet(subject: CanonicalSubject, mode: CanonicalMode, skill: string): Question[] {
  const effectiveSubject = mode === "Cross-Curricular" ? "Reading" : subject;
  const effectiveSkill = mode === "Cross-Curricular" ? (skill || READING_SKILL_DEFAULT) : skill;
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
    const crossStems = [
      "Which statement best expresses the main idea of the passage?",
      "Which detail from the passage best supports the main idea?",
      "Which inference about the scenario is best supported by the passage?",
      "Which two details best support the author’s explanation of the topic? Select TWO answers.",
      "Explain how the author uses details to show cause-and-effect relationships. Use evidence from the passage to support your response.",
    ];

    return crossStems.map((stem, i) => {
      const type: QuestionType = i === 3 ? "multi_select" : i === 4 ? "scr" : "mc";
      const support = buildSupportContent("Reading", stem, type, i);
      return {
        type,
        question: stem,
        choices: [
          "A claim that is directly supported by key details in the passage.",
          "A partially true idea that leaves out an important condition from the text.",
          "A likely-sounding conclusion that goes beyond the passage evidence.",
          "An interpretation that confuses related details from the scenario.",
        ],
        correct_answer: type === "multi_select" ? nextMultiAnswer() : nextSingleAnswer(),
        explanation: support.explanation,
        sample_answer: type === "scr"
          ? "The author shows cause and effect by describing an action and then explaining the result. One detail identifies what changed, and another explains why that change happened. Together, these details support the passage’s main point."
          : undefined,
        hint: support.hint,
        think: support.think,
        step_by_step: support.step_by_step,
        common_mistake: support.common_mistake,
        parent_tip: support.parent_tip,
      };
    });
  }

  const baseReading = [
    `Which statement best captures the ${effectiveSkill.toLowerCase().includes("theme") ? "theme" : "main idea"} of the passage?`,
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
    const crossSubject = pickCrossSubject(i);
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
      visual: i === 1
        ? {
          type: effectiveSubject === "Science" ? "diagram" : effectiveSubject === "Social Studies" ? "map" : "table",
          title: effectiveSubject === "Science" ? "System Diagram" : effectiveSubject === "Social Studies" ? "Regional Map" : "Sales Table",
          description: effectiveSubject === "Science"
            ? "A diagram shows components in a closed system and how energy moves between them."
            : effectiveSubject === "Social Studies"
            ? "A map shows movement of goods between regions along labeled routes."
            : "A table shows quantities and unit values used to calculate totals.",
          headers: effectiveSubject === "Math" ? ["Day", "Kits Sold", "Cost per Kit"] : undefined,
          rows: effectiveSubject === "Math" ? [["Mon", "18", "$7"], ["Tue", "21", "$7"], ["Thu", "24", "$7"]] : undefined,
          diagram_type: effectiveSubject === "Science" ? "circuit" : undefined,
          components: effectiveSubject === "Science"
            ? [{ type: "battery", x: 10, y: 50 }, { type: "wire", path: [[10, 50], [80, 50]] }, { type: "bulb", x: 80, y: 50 }]
            : undefined,
        }
        : i === 3
        ? {
          type: "model",
          title: "Comparison Model",
          description: "A model compares two conditions and their outcomes for decision making.",
        }
        : undefined,
    };

    if (mode === "Cross-Curricular") {
      question.cross = {
        subject: crossSubject,
        connection: `This reading question connects to ${crossSubject} because students must apply text evidence to a real-world interdisciplinary situation.`,
      };
    }

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

function sanitizeCross(value: unknown, index: number): CrossConnection {
  const obj = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const preferred = String(obj.subject || "").trim();
  const subject = preferred === "Science" || preferred === "Math" || preferred === "Social Studies"
    ? preferred
    : pickCrossSubject(index);

  const connection = String(obj.connection || "").trim() || `This question connects reading to ${subject} through real-world interdisciplinary reasoning.`;
  return { subject, connection };
}

function sanitizeVisual(value: unknown): Question["visual"] | undefined {
  const obj = value && typeof value === "object" ? value as Record<string, unknown> : null;
  if (!obj) return undefined;
  const type = String(obj.type || "").trim().toLowerCase();
  if (!["diagram", "table", "chart", "model", "map"].includes(type)) return undefined;
  const headers = Array.isArray(obj.headers) ? obj.headers.map((h) => String(h)).slice(0, 6) : undefined;
  const rows = Array.isArray(obj.rows)
    ? obj.rows.filter((row) => Array.isArray(row)).slice(0, 8).map((row) => (row as unknown[]).map((cell) => String(cell)).slice(0, 6))
    : undefined;
  const components = Array.isArray(obj.components)
    ? obj.components.filter((c) => c && typeof c === "object").slice(0, 30).map((c) => c as Record<string, unknown>)
    : undefined;

  return {
    type: type as "diagram" | "table" | "chart" | "model" | "map",
    title: String(obj.title || "").trim() || undefined,
    description: String(obj.description || "").trim() || undefined,
    headers,
    rows,
    diagram_type: String(obj.diagram_type || "").trim() || undefined,
    components,
  };
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

    const base: Question = {
      type,
      question: questionText,
      choices: normalizeChoices(q.choices),
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

    if (mode === "Cross-Curricular") {
      base.cross = sanitizeCross(q.cross, i);
    }

    return base;
  });

  while (sanitized.length < 5) sanitized.push(fallback[sanitized.length]);

  return sanitized.slice(0, 5).map((q, i) => {
    if (mode === "Cross-Curricular") {
      return { ...q, cross: sanitizeCross(q.cross, i) };
    }
    const { cross, ...rest } = q;
    void cross;
    return rest;
  });
}

function buildFallbackResponse(
  grade: number,
  subject: CanonicalSubject,
  skill: string,
  mode: CanonicalMode,
): WorkerResponse {
  const effectiveSubject = subject;
  return {
    passage: fallbackPassageContent(effectiveSubject, mode, grade, skill),
    questions: fallbackQuestionSet(effectiveSubject, mode, skill),
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
    meta: { fallback: boolean; reason: string; error?: string },
  ) =>
    new Response(JSON.stringify({
      passage: payload.passage,
      questions: Array.isArray(payload.questions) ? payload.questions : fallbackQuestionSet(effectiveSubject, mode, effectiveSkill),
      meta,
    }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  const safeFallback = (reason: string, error?: string) => {
    const payload = buildFallbackResponse(grade, effectiveSubject, effectiveSkill, mode);
    return jsonResponse(payload, { fallback: true, reason, ...(error ? { error } : {}) });
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

    grade = Number(body?.grade || 5);
    subject = canonicalizeSubject(body?.subject);
    skill = String(body?.skill || READING_SKILL_DEFAULT).trim() || READING_SKILL_DEFAULT;
    level = normalizeLevel(body?.level);
    mode = canonicalizeMode(body?.mode);
    effectiveSubject = subject;
    effectiveSkill = skill || READING_SKILL_DEFAULT;
    const range = gradeWordRange(grade, effectiveSubject, mode);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 25000);

    try {
      let attempts = 0;
      let retryFailureReason = "bad_output_after_retry";

      while (attempts < 2) {
        try {
          const aiRes = await fetch("https://api.openai.com/v1/responses", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${Deno.env.get("OPENAI_API_KEY")}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: "gpt-4o-mini",
              input: buildPrompt({
                grade,
                subject,
                skill: effectiveSkill,
                level,
                mode,
              }),
              max_output_tokens: 2500,
            }),
            signal: controller.signal,
          });

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
          ) || fallbackPassageContent(effectiveSubject, mode, grade, effectiveSkill);
          const questions = sanitizeQuestions(parsed.questions, effectiveSubject, mode, effectiveSkill);
          if (questions.length < 5) {
            console.log("⚠️ Padding questions");
          }

          while (questions.length < 5) {
            questions.push({
              type: "mc",
              question: "Which detail best supports the main idea?",
              choices: [
                "A detail that is directly supported by the passage evidence",
                "A partially correct idea that leaves out an important condition",
                "A plausible misinterpretation of what the passage says",
                "An idea that is not connected to the passage details",
              ],
              correct_answer: "A",
              explanation: "The correct answer is directly supported by the text.",
            });
          }

          return jsonResponse(
            { passage: safePassage, questions: questions.length ? questions : fallbackQuestionSet(effectiveSubject, mode, effectiveSkill) },
            { fallback: false, reason: "ai_success" },
          );
        } catch (err) {
          console.error("BACKEND ERROR:", err);
          retryFailureReason = controller.signal.aborted ? "openai_timeout_abort" : "openai_request_failed";
          attempts++;
        }
      }

      return safeFallback(retryFailureReason);
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (err) {
    console.error("BACKEND ERROR:", err);
    return safeFallback("ai_failure_catch", err instanceof Error ? err.message : String(err));
  }
});
