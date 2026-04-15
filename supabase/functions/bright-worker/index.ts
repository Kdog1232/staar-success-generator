import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type ChoiceLetter = "A" | "B" | "C" | "D";
type CanonicalSubject = "Reading" | "Math" | "Science" | "Social Studies";
type Level = "Below" | "On Level" | "Advanced";

type Question = {
  question: string;
  choices: [string, string, string, string];
  correct_answer: ChoiceLetter;
  explanation: string;
  common_mistake: string;
  parent_tip: string;
};

type WorkerResponse = {
  passage: string;
  questions: Question[];
  practice: { questions: Question[] };
  crossPassage: string;
  cross: { questions: Question[] };
  tutor: {
    explanations: Array<{
      question: string;
      explanation: string;
      common_mistake: string;
      parent_tip: string;
    }>;
  };
  answerKey: { answers: Array<{ answer: string }> };
  meta: { fallback: boolean; reason: string; error?: string };
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const READING_SKILL_DEFAULT = "Finding the main idea";

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

function normalizeAnswer(letter: unknown): ChoiceLetter {
  const v = String(letter ?? "A").trim().toUpperCase();
  if (v.startsWith("B")) return "B";
  if (v.startsWith("C")) return "C";
  if (v.startsWith("D")) return "D";
  return "A";
}

function parseJsonPayload(text: string): Record<string, unknown> {
  const cleaned = String(text || "").replace(/```json/gi, "").replace(/```/g, "").trim();
  try {
    const parsed = JSON.parse(cleaned);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      const parsed = JSON.parse(cleaned.slice(start, end + 1));
      return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
    }
    return {};
  }
}

function normalizeChoices(choices: unknown): [string, string, string, string] {
  const fallback: [string, string, string, string] = [
    "A detail supported by the passage.",
    "A partially true detail that misses key context.",
    "A detail that is not supported by the passage.",
    "A claim that contradicts the passage evidence.",
  ];

  const raw = Array.isArray(choices) ? choices.slice(0, 4) : [];
  while (raw.length < 4) raw.push(fallback[raw.length]);

  return raw.map((entry, index) => {
    const cleaned = String(entry ?? "").trim();
    return cleaned || fallback[index];
  }) as [string, string, string, string];
}

function normalizeQuestions(raw: unknown): Question[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 5).map((item) => {
    const q = item && typeof item === "object" ? item as Record<string, unknown> : {};
    return {
      question: String(q.question || "").trim(),
      choices: normalizeChoices(q.choices),
      correct_answer: normalizeAnswer(q.correct_answer),
      explanation: String(q.explanation || "").trim(),
      common_mistake: String(q.common_mistake || "").trim(),
      parent_tip: String(q.parent_tip || "").trim(),
    };
  });
}

function isLightlyValid(passage: unknown, questions: Question[]): boolean {
  const hasPassage = String(passage || "").trim().length > 0;
  const hasQuestions = Array.isArray(questions) && questions.length > 0;
  const hasFourChoicesEach = questions.every((q) => Array.isArray(q.choices) && q.choices.length === 4);
  return hasPassage && hasQuestions && hasFourChoicesEach;
}

function buildPrompt(params: {
  grade: number;
  subject: CanonicalSubject;
  skill: string;
  level: Level;
}): string {
  const { grade, subject, skill, level } = params;

  return `Generate STAAR-style content. Return JSON only (no markdown).

Inputs:
- grade: ${grade}
- subject: ${subject}
- skill: ${skill}
- level: ${level}

Return this exact structure:
{
  "passage": "string",
  "questions": [
    {
      "question": "string",
      "choices": ["string", "string", "string", "string"],
      "correct_answer": "A|B|C|D",
      "explanation": "string",
      "common_mistake": "string",
      "parent_tip": "string"
    }
  ]
}

Requirements:
- passage must be non-empty
- include 5 questions
- each question must have exactly 4 answer choices
- explanations, common_mistake, and parent_tip must be complete and specific`;
}

function buildFallbackResponse(reason: string): WorkerResponse {
  const questions: Question[] = [
    {
      question: "What is the main idea of the passage?",
      choices: [
        "The passage explains a central idea and supports it with details.",
        "The passage provides unrelated facts without a clear focus.",
        "The passage only gives opinions with no evidence.",
        "The passage is mainly a list of vocabulary words.",
      ],
      correct_answer: "A",
      explanation: "Choice A is correct because the passage presents one clear idea and supports it with evidence.",
      common_mistake: "Students often pick a choice with one true detail but miss the full central idea.",
      parent_tip: "Ask your child to underline one sentence that states the main point before answering.",
    },
  ];

  return {
    passage: "Students read a short informational passage and use text evidence to answer questions about the central idea.",
    questions,
    practice: { questions },
    crossPassage: "",
    cross: { questions: [] },
    tutor: {
      explanations: questions.map((q) => ({
        question: q.question,
        explanation: q.explanation,
        common_mistake: q.common_mistake,
        parent_tip: q.parent_tip,
      })),
    },
    answerKey: { answers: questions.map((q) => ({ answer: q.correct_answer })) },
    meta: { fallback: true, reason },
  };
}

function buildWorkerResponse(passage: string, questions: Question[]): WorkerResponse {
  return {
    passage,
    questions,
    practice: { questions },
    crossPassage: "",
    cross: { questions: [] },
    tutor: {
      explanations: questions.map((q) => ({
        question: q.question,
        explanation: q.explanation,
        common_mistake: q.common_mistake,
        parent_tip: q.parent_tip,
      })),
    },
    answerKey: { answers: questions.map((q) => ({ answer: q.correct_answer })) },
    meta: { fallback: false, reason: "ai_success" },
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const jsonResponse = (payload: WorkerResponse) =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

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
    if (!user) return jsonResponse(buildFallbackResponse("unauthorized"));

    let body: Record<string, unknown> = {};
    try {
      body = await req.json();
    } catch (err) {
      return jsonResponse(buildFallbackResponse(`invalid_request_json:${err instanceof Error ? err.message : String(err)}`));
    }

    const grade = Number(body.grade || 5);
    const subject = canonicalizeSubject(body.subject);
    const skill = String(body.skill || READING_SKILL_DEFAULT).trim() || READING_SKILL_DEFAULT;
    const level = normalizeLevel(body.level);

    const aiRes = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${Deno.env.get("OPENAI_API_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        input: buildPrompt({ grade, subject, skill, level }),
        max_output_tokens: 2200,
      }),
      signal: AbortSignal.timeout(18000),
    });

    if (!aiRes.ok) {
      return jsonResponse(buildFallbackResponse(`openai_status_${aiRes.status}`));
    }

    const aiJson = await aiRes.json() as {
      output?: Array<{ content?: Array<{ text?: string }> }>;
      output_text?: string;
    };

    const text = String(
      aiJson.output?.[0]?.content?.[0]?.text ||
      aiJson.output_text ||
      "",
    ).trim();

    const parsed = parseJsonPayload(text);
    const passage = String(parsed.passage || "").trim();
    const questions = normalizeQuestions(parsed.questions);

    if (!isLightlyValid(passage, questions)) {
      return jsonResponse(buildFallbackResponse("light_validation_failed"));
    }

    return jsonResponse(buildWorkerResponse(passage, questions));
  } catch (err) {
    return jsonResponse(buildFallbackResponse(`runtime_error:${err instanceof Error ? err.message : String(err)}`));
  }
});
