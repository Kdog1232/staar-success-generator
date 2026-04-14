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
  if (mode === "Cross-Curricular") return { min: 150, max: 300 };
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
  const effectiveSubject: CanonicalSubject = mode === "Cross-Curricular" ? "Reading" : subject;
  const effectiveSkill = mode === "Cross-Curricular" ? (skill || READING_SKILL_DEFAULT) : skill;
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
      "choices": ["A...", "B...", "C...", "D..."],
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
- NO markdown
- NO extra text`;
}

function normalizeChoices(choices: unknown): [string, string, string, string] {
  const raw = Array.isArray(choices) ? choices.slice(0, 4) : [];
  while (raw.length < 4) raw.push(`${LETTERS[raw.length]}. Option ${raw.length + 1}`);

  return raw.map((entry, index) => {
    const text = String(entry ?? "").trim() || `Option ${index + 1}`;
    if (/^[A-D]\.\s*/.test(text)) return text;
    return `${LETTERS[index]}. ${text}`;
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

  const baseReading = [
    `Which statement best captures the ${effectiveSkill.toLowerCase().includes("theme") ? "theme" : "main idea"} of the passage?`,
    "Which detail from the passage best supports the correct interpretation?",
    "Which additional detail most strengthens that interpretation?",
    "How does the author develop the central idea across the passage?",
    "Which quotation or detail is the strongest evidence for the best answer?",
  ];

  const baseMath = [
    "Which multi-step strategy best solves the real-world problem in the scenario?",
    "After applying both required operations, which result is most reasonable in context?",
    "Which statement best explains the mathematical concept used in the scenario?",
    "How should the model be applied to a new condition in the same scenario?",
    "A student made an error in step 2. Which correction leads to a valid solution?",
  ];

  const baseScience = [
    "Which claim is best supported by the scientific information in the passage?",
    "In the described scenario, which prediction is most scientifically reasonable?",
    "Which cause-and-effect relationship is best supported by the evidence?",
    "Which conclusion is justified by the data trend in the scenario?",
    "Which piece of evidence best supports the strongest scientific explanation?",
  ];

  const baseSocial = [
    "What is the main idea of the social studies passage?",
    "Which event best shows a cause-and-effect relationship described in the text?",
    "Which detail most directly supports the historical or civic context?",
    "Which inference about decisions in the passage is best supported?",
    "Which evidence from the text best supports the strongest conclusion?",
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
    const type: QuestionType = i === 2 ? "part_a" : i === 3 ? "multi_select" : i === 4 ? "scr" : "mc";
    const question: Question = {
      type,
      question: stem,
      choices: [
        "A. The plants closest to the lamp grew taller due to increased light exposure",
        "B. All plants grew equally regardless of light conditions",
        "C. Plants farther from the lamp grew faster due to less heat",
        "D. Plant growth was not affected by light at all",
      ],
      correct_answer: type === "multi_select" ? ["A", "C"] : "A",
      explanation: "The correct choice is best supported by the passage details, context, and required reasoning steps.",
      paired_with: type === "part_a" ? 3 : undefined,
      part_b_question: type === "part_a" ? "Which sentence from the passage best supports the answer to Part A?" : undefined,
      part_b_choices: type === "part_a"
        ? [
          "A. A sentence that directly supports the Part A inference",
          "B. A sentence that is related but does not prove the inference",
          "C. A sentence that describes a different idea in the passage",
          "D. A sentence that does not connect to the inference",
        ]
        : undefined,
      part_b_correct_answer: type === "part_a" ? "A" : undefined,
      sample_answer: type === "scr"
        ? "The author develops the central idea by introducing a problem and supporting the solution with clear evidence. One detail explains the challenge, and another shows why the response is effective. These details justify the best interpretation."
        : undefined,
      hint: "Identify what the question asks, then match evidence precisely.",
      think: "Eliminate options that are partly true but not fully supported.",
      step_by_step: "1) Read carefully. 2) Test each option against evidence. 3) Select the strongest supported answer.",
      common_mistake: "Choosing an option that sounds familiar but lacks full support.",
      parent_tip: "Ask the student to justify the answer with exact evidence.",
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
    const typeValue = String(q.type || fallback[i].type || "mc").trim();
    const type: QuestionType = typeValue === "part_a" || typeValue === "part_b" || typeValue === "multi_select" || typeValue === "scr"
      ? typeValue
      : "mc";

    const base: Question = {
      type,
      question: String(q.question || fallback[i].question).trim() || fallback[i].question,
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
  const effectiveSubject = mode === "Cross-Curricular" ? "Reading" : subject;
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
    effectiveSubject = mode === "Cross-Curricular" ? "Reading" : subject;
    effectiveSkill = mode === "Cross-Curricular" ? (skill || READING_SKILL_DEFAULT) : skill;
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
                "A. A detail directly supported by the passage",
                "B. A partially correct but incomplete idea",
                "C. A misinterpretation of the passage",
                "D. An unrelated idea",
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
