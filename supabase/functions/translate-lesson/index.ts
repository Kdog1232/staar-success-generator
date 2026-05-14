import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const apiKey = Deno.env.get("GOOGLE_TRANSLATE_API_KEY");
const googleTranslateUrl = "https://translation.googleapis.com/language/translate/v2";

type Choice = string | { text?: string; choice?: string };

type LessonQuestion = {
  question?: string;
  choices?: Choice[];
  explanation?: string;
  hint?: string;
  spanish_question?: string;
  spanish_choices?: string[];
  spanish_explanation?: string;
  spanish_hint?: string;
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

function extractChoiceText(choice: Choice): string {
  return typeof choice === "string" ? choice : String(choice?.text || choice?.choice || "");
}

function getSection(lesson: Record<string, unknown>, name: "practice" | "cross"): LessonSection {
  const section = lesson?.[name] && typeof lesson[name] === "object" ? lesson[name] as LessonSection : {};
  return {
    passage: String(section.passage || (name === "practice" ? lesson?.passage || "" : "")),
    questions: Array.isArray(section.questions) ? section.questions : [],
  };
}

function getMutableSection(
  lesson: Record<string, unknown>,
  name: "practice" | "cross",
): Record<string, unknown> | null {
  return lesson?.[name] && typeof lesson[name] === "object"
    ? lesson[name] as Record<string, unknown>
    : null;
}

async function translateText(text: string): Promise<string> {
  if (!text) return text;

  try {
    if (!apiKey) {
      throw new Error("GOOGLE_TRANSLATE_API_KEY missing");
    }

    const response = await fetch(`${googleTranslateUrl}?key=${apiKey}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        q: text,
        target: "es",
        format: "text",
      }),
    });

    if (!response.ok) {
      throw new Error(`google_translate_status_${response.status}`);
    }

    const payload = await response.json() as {
      data?: { translations?: Array<{ translatedText?: string }> };
    };
    const translatedText = payload?.data?.translations?.[0]?.translatedText;

    return typeof translatedText === "string" && translatedText.length > 0
      ? translatedText
      : text;
  } catch (err) {
    console.error("TRANSLATION FAILED", err);
    return text;
  }
}

async function translateChoices(choices: string[]): Promise<string[]> {
  return await Promise.all(choices.map((choice) => translateText(choice)));
}

async function translateQuestion(
  question: LessonQuestion,
  index: number,
  sectionName: "practice" | "cross",
): Promise<void> {
  if (!Array.isArray(question.choices) || question.choices.length !== 4) {
    console.error("INVALID CHOICE STRUCTURE", question);
  }

  const choiceTexts = Array.isArray(question.choices)
    ? question.choices.map(extractChoiceText)
    : [];
  const logPrefix = sectionName === "practice" ? "practice" : "cross";
  console.log(`[translate-lesson] translating ${logPrefix} question:`, index);

  const [spanishQuestion, spanishChoices, spanishHint, spanishExplanation] =
    await Promise.all([
      translateText(String(question.question || "")),
      translateChoices(choiceTexts),
      translateText(String(question.hint || "")),
      translateText(String(question.explanation || "")),
    ]);

  question.spanish_question = spanishQuestion;
  question.spanish_choices = spanishChoices;
  question.spanish_hint = spanishHint;
  question.spanish_explanation = spanishExplanation;
}

async function translateLessonContent(lesson: Record<string, unknown>) {
  const translatedLesson = structuredClone(lesson || {}) as Record<
    string,
    unknown
  >;
  const practice = getSection(translatedLesson, "practice");
  const cross = getSection(translatedLesson, "cross");

  console.log("[translate-lesson] translating practice passage");
  const [spanishPracticePassage, spanishCrossPassage] = await Promise.all([
    translateText(practice.passage || ""),
    translateText(cross.passage || ""),
  ]);

  translatedLesson.spanish_practice_passage = spanishPracticePassage;
  translatedLesson.spanish_cross_passage = spanishCrossPassage;

  const translateSectionQuestions = async (
    sectionName: "practice" | "cross",
  ) => {
    const section = getMutableSection(translatedLesson, sectionName);
    const questions = section && Array.isArray(section.questions)
      ? section.questions
      : [];

    await Promise.all(
      questions.map((question, index) => {
        if (!question || typeof question !== "object") {
          console.error("INVALID QUESTION STRUCTURE", question);
          return Promise.resolve();
        }

        return translateQuestion(question as LessonQuestion, index, sectionName);
      }),
    );
  };

  await Promise.all([
    translateSectionQuestions("practice"),
    translateSectionQuestions("cross"),
  ]);

  console.log("[translate-lesson] translation complete");

  return {
    lesson: translatedLesson,
    translations: {
      spanish: {
        enabled: true,
      },
    },
  };
}

serve(async (req) => {
  console.log("[translate-lesson] request received");
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  let lesson: Record<string, unknown> = {};

  try {
    const body = await req.json();
    const targetLanguage = String(body?.targetLanguage || "spanish").toLowerCase();
    lesson = body?.lesson && typeof body.lesson === "object"
      ? body.lesson as Record<string, unknown>
      : {};
    console.log("[translate-lesson] target language:", targetLanguage);
    console.log("[translate-lesson] lesson keys:", Object.keys(lesson || {}));
    if (targetLanguage !== "spanish") {
      console.warn("[translate-lesson] unsupported target language; translating Spanish fields only");
    }
    const translatedLesson = await translateLessonContent(lesson);
    console.log("[translate-lesson] sending response");
    return jsonResponse(translatedLesson);
  } catch (error) {
    console.warn("[translate-lesson] failed:", error instanceof Error ? error.message : String(error));
    return jsonResponse({
      lesson,
      translations: {
        spanish: {
          enabled: true,
        },
      },
    }, 200);
  }
});
