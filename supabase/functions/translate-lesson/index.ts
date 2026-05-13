import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type LessonQuestion = {
  question?: string;
  choices?: Array<string | { text?: string; choice?: string }>;
};

type LessonSection = {
  passage?: string;
  questions?: LessonQuestion[];
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function extractChoiceText(choice: string | { text?: string; choice?: string }): string {
  return typeof choice === "string" ? choice : String(choice?.text || choice?.choice || "");
}

function getSection(lesson: Record<string, unknown>, name: "practice" | "cross"): LessonSection {
  const section = lesson?.[name] && typeof lesson[name] === "object" ? lesson[name] as LessonSection : {};
  return {
    passage: String(section.passage || (name === "practice" ? lesson?.passage || "" : "")),
    questions: Array.isArray(section.questions) ? section.questions : [],
  };
}

function buildTranslationSeed(lesson: Record<string, unknown>) {
  const practice = getSection(lesson, "practice");
  const cross = getSection(lesson, "cross");
  const mapQuestions = (questions: LessonQuestion[] = []) => questions.map((question) => ({
    question: String(question?.question || ""),
    choices: Array.isArray(question?.choices) ? question.choices.map(extractChoiceText) : [],
  }));
  return {
    practice: { passage: practice.passage || "", questions: mapQuestions(practice.questions) },
    cross: { passage: cross.passage || "", questions: mapQuestions(cross.questions) },
  };
}

function blankTranslationFromSeed(seed: ReturnType<typeof buildTranslationSeed>) {
  const mapQuestions = (questions: Array<{ question: string; choices: string[] }>) => questions.map(() => ({
    question: "",
    choices: [],
    answers: [],
    hint: "",
    simplified: "",
    rephrase: "",
    guided_prompt: "",
  }));
  return {
    passage: "",
    questions: [],
    answers: [],
    directions: {
      practiceTitle: "Lectura de práctica",
      crossTitle: "Lectura interdisciplinaria",
      practiceQuestionsTitle: "Preguntas de práctica",
      crossQuestionsTitle: "Preguntas interdisciplinarias",
    },
    practice: { passage: "", questions: mapQuestions(seed.practice.questions) },
    cross: { passage: "", questions: mapQuestions(seed.cross.questions) },
  };
}

async function translateWithOpenAI(seed: ReturnType<typeof buildTranslationSeed>) {
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) throw new Error("OPENAI_API_KEY missing");

  const prompt = `Translate this STAAR student lesson display text from English to Spanish for Texas students.
Return ONLY valid JSON matching this schema:
{
  "passage": "Spanish practice passage",
  "questions": ["Spanish practice question text"],
  "answers": [["Spanish A", "Spanish B", "Spanish C", "Spanish D"]],
  "directions": {
    "practiceTitle": "Lectura de práctica",
    "crossTitle": "Lectura interdisciplinaria",
    "practiceQuestionsTitle": "Preguntas de práctica",
    "crossQuestionsTitle": "Preguntas interdisciplinarias"
  },
  "practice": { "passage": "...", "questions": [{ "question": "...", "choices": ["..."], "answers": ["..."], "hint": "", "simplified": "", "rephrase": "", "guided_prompt": "" }] },
  "cross": { "passage": "...", "questions": [{ "question": "...", "choices": ["..."], "answers": ["..."], "hint": "", "simplified": "", "rephrase": "", "guided_prompt": "" }] }
}
Do not add, remove, reorder, or relabel answer choices. Translate display text only. Preserve names, numbers, units, formulas, answer order, and IDs implicitly by position.

Lesson JSON:
${JSON.stringify(seed)}`;

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.2,
      max_output_tokens: 6000,
      input: prompt,
    }),
    signal: AbortSignal.timeout(20000),
  });

  if (!response.ok) throw new Error(`openai_status_${response.status}`);
  const json = await response.json() as { output_text?: string; output?: Array<{ content?: Array<{ text?: string }> }> };
  const raw = String(json.output_text || json.output?.[0]?.content?.[0]?.text || "").trim();
  const cleaned = raw.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  return JSON.parse(cleaned);
}

function normalizeTranslation(translated: Record<string, unknown>, seed: ReturnType<typeof buildTranslationSeed>) {
  const fallback = blankTranslationFromSeed(seed);
  const normalizeQuestions = (sectionName: "practice" | "cross") => {
    const translatedSection = translated?.[sectionName] && typeof translated[sectionName] === "object"
      ? translated[sectionName] as { questions?: unknown[] }
      : {};
    const translatedQuestions = Array.isArray(translatedSection.questions) ? translatedSection.questions : [];
    return seed[sectionName].questions.map((sourceQuestion, index) => {
      const incoming = translatedQuestions[index] && typeof translatedQuestions[index] === "object"
        ? translatedQuestions[index] as Record<string, unknown>
        : {};
      const incomingChoices = Array.isArray(incoming.choices) ? incoming.choices.map((choice) => String(choice || "")) : [];
      const choices = sourceQuestion.choices.map((choice, choiceIndex) => incomingChoices[choiceIndex] || choice);
      return {
        question: String(incoming.question || sourceQuestion.question),
        choices,
        answers: choices,
        hint: String(incoming.hint || ""),
        simplified: String(incoming.simplified || ""),
        rephrase: String(incoming.rephrase || ""),
        guided_prompt: String(incoming.guided_prompt || ""),
      };
    });
  };

  const practiceQuestions = normalizeQuestions("practice");
  const crossQuestions = normalizeQuestions("cross");
  const practiceSection = translated.practice && typeof translated.practice === "object" ? translated.practice as Record<string, unknown> : {};
  const crossSection = translated.cross && typeof translated.cross === "object" ? translated.cross as Record<string, unknown> : {};
  return {
    ...fallback,
    passage: String(translated.passage || practiceSection.passage || seed.practice.passage),
    questions: practiceQuestions.map((question) => question.question),
    answers: practiceQuestions.map((question) => question.choices),
    directions: {
      ...fallback.directions,
      ...(translated.directions && typeof translated.directions === "object" ? translated.directions : {}),
    },
    practice: {
      passage: String(practiceSection.passage || translated.passage || seed.practice.passage),
      questions: practiceQuestions,
    },
    cross: {
      passage: String(crossSection.passage || seed.cross.passage),
      questions: crossQuestions,
    },
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json();
    const targetLanguage = String(body?.targetLanguage || "spanish").toLowerCase();
    if (targetLanguage !== "spanish") throw new Error("Only Spanish translation is supported.");
    const lesson = body?.lesson && typeof body.lesson === "object" ? body.lesson as Record<string, unknown> : {};
    const seed = buildTranslationSeed(lesson);
    const translated = await translateWithOpenAI(seed);
    const spanish = normalizeTranslation(translated, seed);
    return jsonResponse({ translations: { spanish } });
  } catch (error) {
    console.warn("[translate-lesson] failed:", error instanceof Error ? error.message : String(error));
    return jsonResponse({ translations: { spanish: null }, error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
