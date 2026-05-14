import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type LessonQuestion = {
  question?: string;
  choices?: Array<string | { text?: string; choice?: string }>;
  explanation?: string;
  hint?: string;
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
    explanation: String(question?.explanation || ""),
    hint: String(question?.hint || ""),
  }));
  return {
    practice: { passage: practice.passage || "", questions: mapQuestions(practice.questions) },
    cross: { passage: cross.passage || "", questions: mapQuestions(cross.questions) },
  };
}

function blankTranslationFromSeed(seed: ReturnType<typeof buildTranslationSeed>) {
  const mapQuestions = (questions: Array<{ question: string; choices: string[]; explanation?: string; hint?: string }>) => questions.map(() => ({
    question: "",
    choices: [],
    answers: [],
    hint: "",
    explanation: "",
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
  "practice": { "passage": "...", "questions": [{ "question": "...", "choices": ["..."], "answers": ["..."], "hint": "", "explanation": "", "simplified": "", "rephrase": "", "guided_prompt": "" }] },
  "cross": { "passage": "...", "questions": [{ "question": "...", "choices": ["..."], "answers": ["..."], "hint": "", "explanation": "", "simplified": "", "rephrase": "", "guided_prompt": "" }] }
}
Do not add, remove, reorder, or relabel answer choices. Translate display text only: passages, question text, answer choice text, hints, and explanations. Preserve names, numbers, units, formulas, answer order, and IDs implicitly by position.

Lesson JSON:
${JSON.stringify(seed)}`;

  console.log("[translateWithOpenAI] sending request");
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

  console.log("[translateWithOpenAI] response status:", response.status);
  if (!response.ok) throw new Error(`openai_status_${response.status}`);
  const json = await response.json() as { output_text?: string; output?: Array<{ content?: Array<{ text?: string }> }> };
  const raw = String(json.output_text || json.output?.[0]?.content?.[0]?.text || "").trim();
  console.log("[translateWithOpenAI] raw response length:", raw.length);
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
      if (incomingChoices.length !== sourceQuestion.choices.length) {
        console.error("[normalizeTranslation] CHOICE LENGTH MISMATCH", {
          sectionName,
          index,
          sourceChoices: sourceQuestion.choices,
          incomingChoices,
        });
      }
      const choices = sourceQuestion.choices.map((choice, choiceIndex) => incomingChoices[choiceIndex] || choice);
      return {
        question: String(incoming.question || sourceQuestion.question),
        choices,
        answers: choices,
        hint: String(incoming.hint || sourceQuestion.hint || ""),
        explanation: String(incoming.explanation || sourceQuestion.explanation || ""),
        simplified: String(incoming.simplified || ""),
        rephrase: String(incoming.rephrase || ""),
        guided_prompt: String(incoming.guided_prompt || ""),
      };
    });
  };

  const practiceQuestions = normalizeQuestions("practice");
  const crossQuestions = normalizeQuestions("cross");
  console.log("[normalizeTranslation] practice translated questions:", practiceQuestions.length);
  console.log("[normalizeTranslation] cross translated questions:", crossQuestions.length);
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

function mergeSpanishFieldsIntoLesson(lesson: Record<string, unknown>, spanish: ReturnType<typeof normalizeTranslation>) {
  const merged = structuredClone(lesson || {}) as Record<string, unknown>;
  merged.spanish_practice_passage = String(spanish.practice?.passage || spanish.passage || "");
  merged.spanish_cross_passage = String(spanish.cross?.passage || "");

  const mergeSection = (sectionName: "practice" | "cross") => {
    const sourceSection = merged[sectionName] && typeof merged[sectionName] === "object"
      ? merged[sectionName] as Record<string, unknown>
      : {};
    const translatedSection = spanish[sectionName];
    const sourceQuestions = Array.isArray(sourceSection.questions) ? sourceSection.questions : [];
    sourceSection.spanish_passage = sectionName === "practice" ? merged.spanish_practice_passage : merged.spanish_cross_passage;
    sourceSection.passage_es = sourceSection.spanish_passage;
    sourceSection.questions = sourceQuestions.map((question, index) => {
      const sourceQuestion = question && typeof question === "object" ? question as Record<string, unknown> : {};
      const translatedQuestion = Array.isArray(translatedSection.questions) ? translatedSection.questions[index] : undefined;
      return {
        ...sourceQuestion,
        spanish_question: translatedQuestion?.question || String(sourceQuestion.spanish_question || ""),
        spanish_choices: Array.isArray(translatedQuestion?.choices) ? translatedQuestion.choices : (Array.isArray(sourceQuestion.spanish_choices) ? sourceQuestion.spanish_choices : []),
        spanish_explanation: translatedQuestion?.explanation || translatedQuestion?.simplified || String(sourceQuestion.spanish_explanation || ""),
        spanish_hint: translatedQuestion?.hint || String(sourceQuestion.spanish_hint || ""),
      };
    });
    merged[sectionName] = sourceSection;
  };

  mergeSection("practice");
  mergeSection("cross");
  return merged;
}

async function translateLessonContent(lesson: Record<string, unknown>) {
  console.log("[translateLessonContent] building seed");
  const seed = buildTranslationSeed(lesson);
  console.log("[translateLessonContent] practice questions:", seed.practice.questions.length);
  console.log("[translateLessonContent] cross questions:", seed.cross.questions.length);
  try {
    const translated = await translateWithOpenAI(seed);
    const spanish = normalizeTranslation(translated, seed);
    console.log("[translateLessonContent] translation complete");
    return { lesson: mergeSpanishFieldsIntoLesson(lesson, spanish), translations: { spanish } };
  } catch (error) {
    console.warn("[translateLessonContent] falling back to English fields:", error instanceof Error ? error.message : String(error));
    const spanish = normalizeTranslation({}, seed);
    console.log("[translateLessonContent] translation complete");
    return { lesson: mergeSpanishFieldsIntoLesson(lesson, spanish), translations: { spanish }, error: error instanceof Error ? error.message : String(error) };
  }
}

serve(async (req) => {
  console.log("[translate-lesson] request received");
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json();
    const targetLanguage = String(body?.targetLanguage || "spanish").toLowerCase();
    const lesson = body?.lesson && typeof body.lesson === "object" ? body.lesson as Record<string, unknown> : {};
    console.log("[translate-lesson] target language:", targetLanguage);
    console.log("[translate-lesson] lesson keys:", Object.keys(lesson || {}));
    if (targetLanguage !== "spanish") throw new Error("Only Spanish translation is supported.");
    const translatedLesson = await translateLessonContent(lesson);
    console.log("[translate-lesson] sending response");
    return jsonResponse(translatedLesson);
  } catch (error) {
    console.warn("[translate-lesson] failed:", error instanceof Error ? error.message : String(error));
    return jsonResponse({ translations: { spanish: null }, error: error instanceof Error ? error.message : String(error) }, 200);
  }
});
