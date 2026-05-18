import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const apiKey = Deno.env.get("GOOGLE_TRANSLATE_API_KEY");
const googleTranslateUrl = "https://translation.googleapis.com/language/translate/v2";
const FUNCTION_VERSION = "translate-lesson-v3-debug";

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
  console.log("STEP 6 - translateText executing");
  console.log("[translate-lesson] translateText executing", { hasText: Boolean(text), length: text?.length || 0 });
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
    console.log("STEP 7 - google response received");

    if (!response.ok) {
      throw new Error(`google_translate_status_${response.status}`);
    }

    const payload = await response.json() as {
      data?: { translations?: Array<{ translatedText?: string }> };
    };
    const translatedText = payload?.data?.translations?.[0]?.translatedText;
    console.log("STEP 8 - translated text parsed", translatedText);
    console.log("[translate-lesson] google translate parsed translatedText", { hasTranslatedText: typeof translatedText === "string" && translatedText.length > 0 });

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
  if (sectionName === "practice") {
    console.log("[translate-lesson] translating practice question", index);
  } else {
    console.log("[translate-lesson] translating cross question", index);
  }

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
  console.log("STEP 4 - entered translateLessonContent");
  console.log("[translate-lesson] entering translation pipeline");
  const translatedLesson = structuredClone(lesson || {}) as Record<
    string,
    unknown
  >;
  const practice = getSection(translatedLesson, "practice");
  const cross = getSection(translatedLesson, "cross");

  console.log("[translate-lesson] translating practice passage");
  console.log("STEP 5 - about to call translateText");
  const spanishPracticePassage = await translateText(practice.passage || "");
  console.log("[translate-lesson] translating cross passage");
  const spanishCrossPassage = await translateText(cross.passage || "");

  translatedLesson.spanish_practice_passage = spanishPracticePassage;
  translatedLesson.spanish_cross_passage = spanishCrossPassage;

  const mutablePractice = getMutableSection(translatedLesson, "practice");
  if (mutablePractice) {
    mutablePractice.spanish_passage = spanishPracticePassage;
    mutablePractice.passage_es = spanishPracticePassage;
  }

  const mutableCross = getMutableSection(translatedLesson, "cross");
  if (mutableCross) {
    mutableCross.spanish_passage = spanishCrossPassage;
    mutableCross.passage_es = spanishCrossPassage;
  }

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
  console.log("SPANISH PRACTICE PASSAGE", translatedLesson.spanish_practice_passage);
  console.log("FIRST SPANISH QUESTION", (translatedLesson.practice as LessonSection | undefined)?.questions?.[0]?.spanish_question);
  console.log("FIRST SPANISH CHOICES", (translatedLesson.practice as LessonSection | undefined)?.questions?.[0]?.spanish_choices);
  console.log("FINAL TRANSLATED LESSON", JSON.stringify(translatedLesson, null, 2));

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
  try {
    console.log("STEP 1 - handler entered");
    console.log("FUNCTION VERSION", FUNCTION_VERSION);
    console.log(
      "GOOGLE_TRANSLATE_API_KEY EXISTS",
      !!Deno.env.get("GOOGLE_TRANSLATE_API_KEY"),
    );
    console.log("TRANSLATE LESSON FUNCTION HIT");
    console.log("[translate-lesson] request received");
    if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

    let lesson: Record<string, unknown> = {};

    const body = await req.json();
    console.log("STEP 2 - body parsed");
    const targetLanguage = String(body?.targetLanguage || "spanish").toLowerCase();
    lesson = body?.lesson && typeof body.lesson === "object"
      ? body.lesson as Record<string, unknown>
      : {};
    console.log("[translate-lesson] target language:", targetLanguage);
    console.log("[translate-lesson] lesson keys:", Object.keys(lesson || {}));
    if (targetLanguage !== "spanish") {
      console.warn("[translate-lesson] unsupported target language; translating Spanish fields only");
    }
    console.log("STEP 3 - about to translate lesson");
    const translatedLesson = await translateLessonContent(lesson);
    console.log("[translate-lesson] sending response");
    console.log("STEP 9 - returning translated lesson");
    return jsonResponse({
      ...translatedLesson,
      version: FUNCTION_VERSION,
    });
  } catch (err) {
    const errorDetails = err as { message?: string; stack?: string };
    console.warn("[translate-lesson] failed:", errorDetails?.message || String(err));
    console.error("TRANSLATE LESSON FATAL ERROR", {
      message: errorDetails?.message,
      stack: errorDetails?.stack,
      error: err,
    });

    return new Response(
      JSON.stringify({
        error: true,
        message: errorDetails?.message,
        stack: errorDetails?.stack,
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
