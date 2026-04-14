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

type Question = {
  question: string;
  choices: [string, string, string, string];
  correct_answer: ChoiceLetter;
  explanation: string;
  hint?: string;
  think?: string;
  step_by_step?: string;
  common_mistake?: string;
  parent_tip?: string;
  cross?: CrossConnection;
};

type WorkerResponse = {
  passage: string;
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
  const range = gradeWordRange(grade, effectiveSubject, mode);

  const passageRules = mode === "Cross-Curricular"
    ? `PASSAGE RULES:\n- Informational READING passage only (no pure math/science-only prompt).\n- Include real-world content and interdisciplinary context.\n- ${range.min}-${range.max} words.`
    : effectiveSubject === "Math"
      ? `PASSAGE RULES:\n- Short scenario only (no long story passage).\n- ${range.min}-${range.max} words.\n- Real-world context required.`
      : `PASSAGE RULES:\n- ${range.min}-${range.max} words.\n- Must support ALL five questions.`;

  const modeRules = mode === "Cross-Curricular"
    ? `MODE RULES (MANDATORY):
- Keep questions reading-skill aligned.
- Every question must include:
  "cross": { "subject": "Science|Math|Social Studies", "connection": "..." }
- cross.connection must explain real-world interdisciplinary thinking.`
    : mode === "Tutor"
      ? "MODE RULES: Include clear hint/think/step_by_step for each question."
      : mode === "Answer Key"
        ? "MODE RULES: Include strong explanations plus common_mistake and parent_tip."
        : "MODE RULES: Practice-focused question clarity and rigorous distractors.";

  const strictSubjectRules = effectiveSubject === "Reading"
    ? `READING STRUCTURE (STRICT):\n${readingStructure(effectiveSkill)}`
    : `${effectiveSubject.toUpperCase()} STRUCTURE (STRICT):\n${subjectStructure(effectiveSubject)}`;

  return `You are generating production STAAR content.

INPUT
- Grade: ${grade}
- Subject: ${effectiveSubject}
- Original Subject Toggle: ${subject}
- Skill: ${effectiveSkill}
- Level: ${level}
- Mode: ${mode}

CORE CONTRACT (STRICT)
- Return valid JSON only.
- NEVER return malformed JSON.
- Passage must be non-empty.
- Exactly 5 questions.
- Questions must align to selected subject + skill + mode.
- Wrong answer choices must be plausible student mistakes.
- No generic or trivial items.
- ${rigorInstruction(level)}

${passageRules}

${strictSubjectRules}

${modeRules}

SUBJECT-SPECIFIC CONSTRAINTS
- Reading: question set must align to the specific reading skill structure.
- Math: all five are real-world multi-step or reasoning word problems; avoid simple computation-only questions.
- Science: enforce reasoning, cause/effect, data or experimental analysis.
- Social Studies: enforce main idea, cause/effect, context reasoning, and evidence.

OUTPUT SHAPE
{
  "passage": "",
  "questions": [
    {
      "question": "",
      "choices": ["A. ...","B. ...","C. ...","D. ..."],
      "correct_answer": "A",
      "explanation": "",
      "hint": "",
      "think": "",
      "step_by_step": "",
      "common_mistake": "",
      "parent_tip": "",
      "cross": {
        "subject": "Science",
        "connection": ""
      }
    }
  ]
}`;
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
      const question: Question = {
        question: stem,
        choices: [
          "A. The plants closest to the lamp grew taller due to increased light exposure",
          "B. All plants grew equally regardless of light conditions",
          "C. Plants farther from the lamp grew faster due to less heat",
          "D. Plant growth was not affected by light at all",
        ],
        correct_answer: "A",
        explanation: "The correct choice is best supported by the passage details, context, and required reasoning steps.",
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

function isBadOutput(text: string): boolean {
  return (
    text.includes("fully supported by evidence") ||
    text.includes("plausible interpretation") ||
    text.includes("common misconception")
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

    const base: Question = {
      question: String(q.question || fallback[i].question).trim() || fallback[i].question,
      choices: normalizeChoices(q.choices),
      correct_answer: normalizeAnswer(q.correct_answer),
      explanation: String(q.explanation || fallback[i].explanation).trim() || fallback[i].explanation,
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
    passage: fallbackPassage(effectiveSubject, mode, grade),
    questions: fallbackQuestionSet(effectiveSubject, mode, skill),
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

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

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const grade = Number(body?.grade || 5);
    const subject = canonicalizeSubject(body?.subject);
    const skill = String(body?.skill || READING_SKILL_DEFAULT).trim() || READING_SKILL_DEFAULT;
    const level = normalizeLevel(body?.level);
    const mode = canonicalizeMode(body?.mode);

    const effectiveSubject: CanonicalSubject = mode === "Cross-Curricular" ? "Reading" : subject;
    const effectiveSkill = mode === "Cross-Curricular"
      ? (skill.toLowerCase().includes("main") || skill.toLowerCase().includes("infer") || skill.toLowerCase().includes("theme")
        ? skill
        : READING_SKILL_DEFAULT)
      : skill;
    const range = gradeWordRange(grade, effectiveSubject, mode);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);

    try {
      console.log("CALLING OPENAI");

      let attempts = 0;
      let text = "";

      while (attempts < 2) {
        console.log("🧠 CALLING OPENAI (attempt)", attempts + 1);

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

        console.log("OPENAI STATUS", aiRes.status);

        if (!aiRes.ok) {
          throw new Error(`OpenAI request failed with status ${aiRes.status}`);
        }

        const aiJson = await aiRes.json();
        text = String(aiJson.output_text || aiJson.output?.[0]?.content?.[0]?.text || "");

        if (!isBadOutput(text)) break;

        console.log("⚠️ Bad output detected — retrying...");
        attempts++;
      }

      if (isBadOutput(text)) {
        console.log("🚨 FINAL FALLBACK TRIGGERED (SAFE)");

        const safeFallback = buildFallbackResponse(grade, effectiveSubject, effectiveSkill, mode);

        return new Response(JSON.stringify({
          ...safeFallback,
          meta: {
            fallback: true,
            reason: "bad_output_after_retry",
          },
        }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const parsed = parseJsonPayload(text);

      const passage = clampPassageWords(String(parsed.passage || ""), range.min, range.max);
      const questions = sanitizeQuestions(parsed.questions, effectiveSubject, mode, effectiveSkill);

      let result: WorkerResponse = {
        passage: passage || fallbackPassage(effectiveSubject, mode, grade),
        questions: questions.length === 5 ? questions : fallbackQuestionSet(effectiveSubject, mode, effectiveSkill),
      };

      if (!result.passage || !Array.isArray(result.questions)) {
        console.log("❌ INVALID FINAL SHAPE");

        result = {
          passage: "Students worked together to solve a problem and learned an important lesson.",
          questions: Array.from({ length: 5 }).map(() => ({
            question: "What is the main idea?",
            choices: [
              "A. Teamwork helps solve problems",
              "B. Working alone is better",
              "C. School is hard",
              "D. Friends are fun",
            ],
            correct_answer: "A",
            explanation: "This answer best matches the central idea.",
          })),
        };
      }

      console.log("RETURNING CONTENT");

      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } catch (err) {
      console.log("AI FAILURE", err instanceof Error ? err.message : String(err));
      let result = buildFallbackResponse(grade, effectiveSubject, effectiveSkill, mode);
      if (!result.passage || !Array.isArray(result.questions)) {
        console.log("❌ INVALID FINAL SHAPE");

        result = {
          passage: "Students worked together to solve a problem and learned an important lesson.",
          questions: Array.from({ length: 5 }).map(() => ({
            question: "What is the main idea?",
            choices: [
              "A. Teamwork helps solve problems",
              "B. Working alone is better",
              "C. School is hard",
              "D. Friends are fun",
            ],
            correct_answer: "A",
            explanation: "This answer best matches the central idea.",
          })),
        };
      }
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } finally {
      clearTimeout(timeoutId);
    }
  } catch {
    const fallback = buildFallbackResponse(5, "Reading", READING_SKILL_DEFAULT, "Practice");
    return new Response(JSON.stringify(fallback), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
