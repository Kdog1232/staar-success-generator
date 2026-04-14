import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type Level = "Below" | "On Level" | "Advanced";
type Question = {
  question: string;
  choices: [string, string, string, string];
  correct_answer: "A" | "B" | "C" | "D";
  explanation: string;
};

type WorkerResponse = {
  passage: string;
  questions: Question[];
  fallback?: string;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const LETTERS = ["A", "B", "C", "D"] as const;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function stripCodeFence(input: string): string {
  return input.replace(/```json/gi, "").replace(/```/g, "").trim();
}

function normalizeChoice(choice: unknown, index: number): string {
  const prefix = `${LETTERS[index]}. `;
  const raw = String(choice ?? "").replace(/^[A-D]\.?\s*/i, "").trim();
  return `${prefix}${raw || "Option not provided"}`;
}

function normalizeCorrectAnswer(value: unknown): "A" | "B" | "C" | "D" {
  const parsed = String(value ?? "").trim().toUpperCase().replace(".", "");
  return (LETTERS.includes(parsed as (typeof LETTERS)[number]) ? parsed : "A") as "A" | "B" | "C" | "D";
}

function ensureQuestionShape(item: unknown, index: number, subject: string, skill: string, grade: number): Question {
  const q = (item ?? {}) as Record<string, unknown>;
  const choicesRaw = Array.isArray(q.choices) ? q.choices : [];
  const normalizedChoices = [0, 1, 2, 3].map((i) => normalizeChoice(choicesRaw[i], i)) as [string, string, string, string];
  const correct = normalizeCorrectAnswer(q.correct_answer);

  return {
    question: String(q.question ?? "").trim() || `Question ${index + 1}: Which choice is best supported by the ${subject} passage for ${skill}?`,
    choices: normalizedChoices,
    correct_answer: correct,
    explanation: String(q.explanation ?? "").trim() || `Use evidence from the passage and grade ${grade} ${subject} reasoning to verify the best answer.`,
  };
}

function skillSequence(subject: string, skill: string): string {
  const subjectLower = subject.toLowerCase();
  const skillLower = skill.toLowerCase();

  if (subjectLower.includes("reading")) {
    if (skillLower.includes("main idea")) {
      return [
        "Q1: determine main idea",
        "Q2-Q3: supporting details",
        "Q4: development of idea",
        "Q5: strongest evidence",
      ].join("; ");
    }
    if (skillLower.includes("inference")) {
      return [
        "Q1: make inference",
        "Q2-Q3: identify clues",
        "Q4: explain reasoning",
        "Q5: strongest textual evidence",
      ].join("; ");
    }
    if (skillLower.includes("theme")) {
      return [
        "Q1: determine theme",
        "Q2-Q3: events/details shaping theme",
        "Q4: character action impact",
        "Q5: strongest evidence",
      ].join("; ");
    }
  }

  if (subjectLower.includes("math")) {
    return "All 5 questions must be real-world word problems; include 2-step problems when appropriate; include at least one reasoning/justification question.";
  }

  if (subjectLower.includes("science")) {
    return "Question flow: concept -> scenario -> cause/effect -> data interpretation -> evidence-based conclusion.";
  }

  if (subjectLower.includes("social")) {
    return "Informational passage and question flow: main idea -> cause/effect -> key detail -> reasoning -> strongest evidence.";
  }

  return "All questions must align tightly to subject, skill, grade, and level with non-repetitive STAAR-style structure.";
}

function levelRule(level: Level): string {
  if (level === "Below") return "Use simplified language while keeping the same core thinking demand.";
  if (level === "Advanced") return "Increase rigor with deeper reasoning and stronger evidence analysis.";
  return "Use grade-appropriate vocabulary and rigor for on-level students.";
}

function buildPrompt({ grade, subject, skill, level }: { grade: number; subject: string; skill: string; level: Level }): string {
  return `You are generating STAAR-style instructional content.
Return ONLY strict JSON, no markdown, no extra keys.

Input:
- grade: ${grade}
- subject: ${subject}
- skill: ${skill}
- level: ${level}

Hard requirements:
- Always include a non-empty passage aligned to the selected subject/skill/grade/level.
- Always return exactly 5 questions.
- Every question must be answerable from the passage.
- Every question must include 4 plausible STAAR-style distractors.
- Avoid vague or repeated question stems.
- Keep distractors plausible but clearly incorrect based on passage evidence.

Skill alignment plan:
${skillSequence(subject, skill)}

Level rigor:
${levelRule(level)}

Output schema (exact):
{
  "passage": "string",
  "questions": [
    {
      "question": "string",
      "choices": ["A. ...", "B. ...", "C. ...", "D. ..."],
      "correct_answer": "A",
      "explanation": "string"
    }
  ]
}

Return only valid JSON.`;
}

function fallbackPassage(subject: string, skill: string, grade: number, level: Level): string {
  return `Grade ${grade} ${subject} practice passage (${level}): This passage is focused on ${skill}. It provides clear, text-based details so each question can be answered with evidence and reasoning.`;
}

function fallbackQuestions(subject: string, skill: string, grade: number): Question[] {
  const stems = [
    `Which statement best matches the main focus of this ${subject} passage about ${skill}?`,
    `Which detail from the passage most strongly supports the idea about ${skill}?`,
    `Which choice best explains how the passage develops understanding of ${skill}?`,
    `Which reasoning is most accurate based on the passage evidence?`,
    `Which evidence from the passage is strongest for answering the skill question?`,
  ];

  return stems.map((stem, idx) => ({
    question: stem,
    choices: [
      "A. The option directly supported by specific passage evidence",
      "B. A partly related idea with missing evidence",
      "C. A claim that overgeneralizes beyond the passage",
      "D. An unrelated statement not supported in the text",
    ],
    correct_answer: "A",
    explanation: `Question ${idx + 1} is solved by selecting the choice with explicit evidence from the passage and grade ${grade} reasoning.`,
  }));
}

function normalizeResponse(parsed: unknown, subject: string, skill: string, grade: number, level: Level): WorkerResponse {
  const obj = (parsed ?? {}) as Record<string, unknown>;
  const passage = String(obj.passage ?? "").trim() || fallbackPassage(subject, skill, grade, level);
  const rawQuestions = Array.isArray(obj.questions) ? obj.questions : [];
  const normalized = rawQuestions.slice(0, 5).map((q, idx) => ensureQuestionShape(q, idx, subject, skill, grade));

  while (normalized.length < 5) {
    const fallbacks = fallbackQuestions(subject, skill, grade);
    normalized.push(fallbacks[normalized.length]);
  }

  return {
    passage,
    questions: normalized.slice(0, 5),
    fallback: "",
  };
}

async function callOpenAI(prompt: string, key: string): Promise<string> {
  console.log("CALLING OPENAI");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);

  try {
    const res = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        input: prompt,
        max_output_tokens: 1800,
      }),
      signal: controller.signal,
    });

    console.log("OPENAI STATUS", res.status);

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error((data as Record<string, unknown>)?.error?.message as string ?? "Generation failed");
    }

    return String((data as Record<string, unknown>).output_text ?? "").trim()
      || String((data as Record<string, any>)?.output?.[0]?.content?.[0]?.text ?? "").trim();
  } finally {
    clearTimeout(timeout);
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      {
        global: {
          headers: { Authorization: req.headers.get("Authorization") ?? "" },
        },
      },
    );

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }

    const requestBody = await req.json().catch(() => ({}));
    const loginCheckOnly = requestBody?.trigger === "login_check";

    const email = user.email?.toLowerCase().trim();
    const paidEmails = ["garyadams892@gmail.com", "mdhowell64@gmail.com"];

    if (email && paidEmails.includes(email)) {
      const { data: existingProfile } = await supabase
        .from("profiles")
        .select("id, plan")
        .eq("id", user.id)
        .single();

      if (existingProfile && existingProfile.plan !== "paid") {
        await supabase.from("profiles").update({ plan: "paid", generations_used: 0 }).eq("id", user.id);
      }
    }

    const { data: profile } = await supabase
      .from("profiles")
      .select("plan, generations_used")
      .eq("id", user.id)
      .single();

    if (!profile) {
      return jsonResponse({ error: "Profile not found" }, 404);
    }

    if (loginCheckOnly) {
      return jsonResponse({ ok: true, plan: profile.plan, generations_used: profile.generations_used }, 200);
    }

    if (profile.plan !== "paid" && profile.generations_used >= 5) {
      return jsonResponse({ error: "Free limit reached" }, 403);
    }

    const grade = Number(requestBody?.grade ?? 3);
    const subject = String(requestBody?.subject ?? "Reading").trim();
    const skill = String(requestBody?.skill ?? "Main Idea").trim();
    const level = (["Below", "On Level", "Advanced"].includes(String(requestBody?.level))
      ? requestBody.level
      : "On Level") as Level;

    const openAiKey = Deno.env.get("OPENAI_API_KEY");
    if (!openAiKey) {
      return jsonResponse({ error: "Missing OPENAI_API_KEY" }, 500);
    }

    let normalized: WorkerResponse;

    try {
      const prompt = buildPrompt({ grade, subject, skill, level });
      const rawText = await callOpenAI(prompt, openAiKey);
      const cleaned = stripCodeFence(rawText);
      const parsed = JSON.parse(cleaned);
      normalized = normalizeResponse(parsed, subject, skill, grade, level);
    } catch (err) {
      console.error("AI FAILURE", err);
      normalized = {
        passage: fallbackPassage(subject, skill, grade, level),
        questions: fallbackQuestions(subject, skill, grade),
        fallback: "Fallback used due to AI generation issue.",
      };
    }

    await supabase
      .from("profiles")
      .update({ generations_used: profile.generations_used + 1 })
      .eq("id", user.id);

    console.log("RETURNING CONTENT", {
      questions: normalized.questions.length,
      passageLength: normalized.passage.length,
    });

    return jsonResponse({
      passage: normalized.passage,
      questions: normalized.questions.slice(0, 5),
      fallback: normalized.fallback ?? "",
    });
  } catch (err) {
    return jsonResponse({ error: (err as Error)?.message ?? "Unknown server error" }, 500);
  }
});
