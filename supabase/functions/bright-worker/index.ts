import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type ChoiceLetter = "A" | "B" | "C" | "D";
type CanonicalSubject = "Reading" | "Math" | "Science" | "Social Studies";
type Level = "Below" | "On Level" | "Advanced";
type Mode = "Practice" | "Cross-Curricular";
type QuestionType = "mc" | "multi_select" | "evidence_based" | "scr";
type CorrectAnswer = ChoiceLetter | [ChoiceLetter, ChoiceLetter] | "See sample response";

type Question = {
  type: QuestionType;
  question: string;
  choices: [string, string, string, string];
  correct_answer: CorrectAnswer;
  explanation: string;
  common_mistake: string;
  parent_tip: string;
  sample_answer?: string;
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
  answerKey: { answers: Array<{ answer: CorrectAnswer }> };
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

function normalizeMode(mode: unknown): Mode {
  const value = String(mode || "").toLowerCase();
  if (value.includes("cross")) return "Cross-Curricular";
  return "Practice";
}

function normalizeAnswer(letter: unknown): ChoiceLetter {
  const v = String(letter ?? "A").trim().toUpperCase();
  if (v.startsWith("B")) return "B";
  if (v.startsWith("C")) return "C";
  if (v.startsWith("D")) return "D";
  return "A";
}

function normalizeQuestionType(value: unknown): QuestionType {
  const v = String(value || "").trim().toLowerCase();
  if (v === "multi_select" || v === "multiselect" || v === "select_two") return "multi_select";
  if (v === "evidence_based" || v === "evidence") return "evidence_based";
  if (v === "scr" || v === "short_constructed_response") return "scr";
  return "mc";
}

function normalizeCorrectAnswer(type: QuestionType, value: unknown): CorrectAnswer {
  if (type === "scr") return "See sample response";
  if (type === "multi_select") {
    const raw = Array.isArray(value)
      ? value
      : String(value || "")
        .split(/[,&/|]/)
        .map((entry) => entry.trim())
        .filter(Boolean);
    const letters = raw.map((entry) => normalizeAnswer(entry));
    const deduped = Array.from(new Set(letters));
    const first = deduped[0] || "A";
    const second = deduped[1] || (first === "A" ? "B" : "A");
    return [first, second];
  }
  return normalizeAnswer(value);
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
  return raw.map((item) => {
    const q = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const type = normalizeQuestionType(q.type ?? q.question_type);
    const sampleAnswer = String(q.sample_answer || "").trim();
    return {
      type,
      question: String(q.question || "").trim(),
      choices: normalizeChoices(q.choices),
      correct_answer: normalizeCorrectAnswer(type, q.correct_answer),
      explanation: String(q.explanation || "").trim(),
      common_mistake: String(q.common_mistake || "").trim(),
      parent_tip: String(q.parent_tip || "").trim(),
      ...(sampleAnswer ? { sample_answer: sampleAnswer } : {}),
    };
  });
}

function countWords(value: string): number {
  return String(value || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .length;
}

function isLightlyValid(passage: unknown, questions: Question[], requirePassage: boolean): boolean {
  const passageText = String(passage || "").trim();
  const hasPassage = passageText.length > 0;
  const passageWordCount = countWords(passageText);
  const hasValidPassageLength = passageWordCount >= 200 && passageWordCount <= 250;
  const hasExactQuestionCount = Array.isArray(questions) && questions.length === 5;
  const hasValidChoiceStructure = questions.every((q) =>
    q.type === "scr" || (Array.isArray(q.choices) && q.choices.length === 4)
  );
  const hasRequiredTypes =
    questions.some((q) => q.type === "mc") &&
    questions.some((q) => q.type === "multi_select") &&
    questions.some((q) => q.type === "evidence_based") &&
    questions.some((q) => q.type === "scr");
  const hasValidMultiSelect = questions
    .filter((q) => q.type === "multi_select")
    .every((q) => Array.isArray(q.correct_answer) && q.correct_answer.length === 2);
  const hasValidScr = questions
    .filter((q) => q.type === "scr")
    .every((q) => String(q.sample_answer || "").trim().length > 0 && q.correct_answer === "See sample response");
  const passageValid = requirePassage ? hasPassage && hasValidPassageLength : true;
  return passageValid && hasExactQuestionCount && hasValidChoiceStructure && hasValidMultiSelect && hasValidScr && hasRequiredTypes;
}

function buildCorePrompt(params: {
  grade: number;
  subject: CanonicalSubject;
  skill: string;
  level: Level;
  mode: Mode;
}): string {
  const { grade, subject, skill, level, mode } = params;

  return `You are a Texas STAAR assessment expert.

Generate realistic, high-quality STAAR-style practice that a teacher would trust.

INPUTS
Grade: ${grade}
Subject: ${subject}
Skill: ${skill}
Level: ${level}
Mode: ${mode}

OUTPUT FORMAT (STRICT)
Return JSON only:
{
  "passage": "string",
  "questions": [
    {
      "type": "mc|multi_select|evidence_based|scr",
      "question": "string",
      "choices": ["string", "string", "string", "string"],
      "correct_answer": "A|B|C|D OR [\"A\",\"C\"] for multi_select OR \"See sample response\" for scr",
      "explanation": "string",
      "common_mistake": "string",
      "parent_tip": "string",
      "sample_answer": "string (required for scr)"
    }
  ]
}

MODE LOGIC

PRACTICE MODE
- Reading: MUST include a passage; questions must target main idea, inference, evidence, and vocabulary in context
- Math: NO passage; all questions must be word problems with STAAR-style real-world, multi-step thinking
- Science: NO passage; use scenario-based questions (experiments, systems, observations) requiring reasoning about cause/effect, variables, and outcomes
- Social Studies: NO passage; use context-based questions (events, decisions, impact) requiring analysis of cause/effect and significance

CROSS-CURRICULAR MODE
- ALL subjects MUST include a passage
- Passage must be based on the selected subject
- Reading special rule: passage must be about Science OR Math OR Social Studies (not a generic reading story)
- Questions for all subjects in this mode MUST be reading-based (ELAR) and answerable using the passage only
- Include reading targets: main idea, inference, evidence, and reasoning or vocabulary
- Do NOT ask math computation questions
- Do NOT ask science fact-recall questions
- Do NOT require outside knowledge

PASSAGE REQUIREMENTS
- Follow mode logic above for when passage is required vs omitted
- When included, passage must be engaging, realistic, subject-aligned, and detailed enough to support all questions
- Passage complexity must scale by grade and level
- When a passage is included, it MUST be 200-250 words

ENGAGEMENT RULES
- Use relatable real-life situations students understand
- Use a natural, conversational tone (not formal or robotic)
- Occasionally include light, modern expressions students recognize
- Keep language clear, grade-appropriate, and school-appropriate
- Do NOT overuse slang or include distracting/confusing terms
- Avoid meme-heavy wording or excessive slang (for example: skibidi, rizz)
- Engagement must support comprehension and STAAR rigor, not distract from it

QUESTION REQUIREMENTS
- PRIORITY RULE: You MUST generate all required questions.
- If needed, make explanations shorter.
- If needed, make parent tips shorter.
- If needed, keep sample answers brief.
- Do NOT reduce the number of questions.
- Include exactly 5 questions
- Follow mode logic above for passage-based vs no-passage question design
- In Cross-Curricular mode, all questions MUST depend on the passage
- Include the required skill mix for the active mode
- Include these question types across the set:
  - 1+ multiple choice (mc)
  - 1+ multi-select with "Select TWO answers"
  - 1+ evidence-based question asking for the BEST supporting detail
  - 1+ short constructed response (scr)
- Questions should require thinking (not just recall)
- Use STAAR-style wording where appropriate:
  - "What can the reader conclude..."
  - "Which detail best supports..."
  - "Based on the passage..."

ANSWER CHOICES
- 1 correct answer
- 1 strong distractor that seems correct but misinterprets the passage/context
- 1 partial answer that includes some correct information but misses the full idea
- 1 clearly incorrect answer
- At least TWO answer choices must feel logical to a student
- For multi_select, clearly state "Select TWO answers" and provide exactly TWO correct answers

SUPPORT CONTENT
Explanation:
- 1–2 sentences
- Clearly explain why the correct answer is best using passage/context evidence or reasoning

Common Mistake:
- Explain the student's thinking, not just the mistake
- Explain why a student might choose the wrong answer
- Use realistic confusion patterns such as:
  - focusing on one detail instead of the whole passage/context
  - misunderstanding a key word or phrase
  - making a logical but incomplete conclusion

Parent Tip:
- Explain what skill the student is learning
- Tell the parent how to help the child think through the problem
- Include one simple action such as:
  - asking the child to point to evidence in the passage/context
  - having the child explain their thinking out loud
  - guiding them to compare answer choices
- Should feel like a teacher coaching a parent
- Do NOT restate the answer
- If question type is scr, parent_tip MUST coach RACE:
  - R = Restate the question
  - A = Answer the question
  - C = Cite evidence from the passage/context
  - E = Explain why the evidence supports the answer
  - Include actions like asking the child to restate, point to evidence, and explain why it matters

SCR RULES
- scr prompts must require explaining thinking with evidence from passage/context only
- For scr, set correct_answer to "See sample response"
- For scr, include sample_answer that models RACE with a clear answer, evidence, and explanation

SUBJECT-SPECIFIC RIGOR RULES

READING (ELAR)
- Passage must carry a clear central idea with supporting details
- Questions must require:
  - identifying main/central idea
  - making inferences
  - selecting text evidence
  - vocabulary in context
- Avoid simple recall questions
- Require students to interpret meaning from multiple sentences

READING LEVEL ADJUSTMENTS
- Below: shorter passage; more direct wording
- On Level: standard STAAR phrasing; some inference required
- Advanced: deeper inference; subtle answer choices; multiple plausible distractors

MATH
- MUST use real-world scenarios
- MUST require multi-step problem solving
- Questions must include:
  - interpreting numbers in context
  - selecting correct operation(s)
  - reasoning about steps (not just computing)
- Avoid simple one-step problems
- Avoid pure calculation without context

MATH LEVEL ADJUSTMENTS
- Below: simpler numbers; fewer steps
- On Level: 2-step problems; clear setup
- Advanced: multi-step reasoning; layered information; trap answers based on common mistakes

SCIENCE
- MUST include a scenario (experiment, observation, or system)
- Questions must require:
  - cause and effect reasoning
  - identifying variables
  - interpreting data or outcomes
- Avoid memorization-only questions
- Avoid vocabulary recall without context

SCIENCE LEVEL ADJUSTMENTS
- Below: simple cause/effect; obvious relationships
- On Level: basic analysis of results
- Advanced: multiple variables; deeper reasoning about systems and outcomes

SOCIAL STUDIES
- MUST include historical or civic context
- Questions must require:
  - interpreting events
  - understanding cause/effect
  - analyzing decisions or outcomes
- Avoid fact recall only
- Avoid simple definitions

SOCIAL STUDIES LEVEL ADJUSTMENTS
- Below: clearer cause/effect relationships
- On Level: basic analysis of events
- Advanced: multiple perspectives; long-term impact reasoning

GLOBAL RIGOR RULES
- Respect mode-specific passage requirements (passage required only where defined by mode)
- Questions must require thinking, not recall
- Answer choices must be plausible and reflect real mistakes
- Answer choices must be grounded in passage/context content
- explanation must justify the correct answer with passage/context evidence
- common_mistake must describe the student misunderstanding
- parent_tip must coach how to read/reason and think through the passage or context

IMPORTANT RULES
- Keep responses concise.
- Keep writing concise and clear
- Do NOT include extra sections or headings
- Do NOT include markdown
- Do NOT explain outside JSON
- Focus on clarity, realism, and STAAR alignment
- Everything must be generated in ONE pass
- Maintain fast generation with concise output (under 10 seconds target)`;
}

function buildFallbackResponse(reason: string): WorkerResponse {
  const questions: Question[] = [
    {
      type: "mc",
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
    const mode = normalizeMode(body.mode);
    const requirePassage = mode === "Cross-Curricular" || subject === "Reading";

    const aiRes = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${Deno.env.get("OPENAI_API_KEY")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        input: buildCorePrompt({ grade, subject, skill, level, mode }),
        max_output_tokens: 2200,
      }),
      signal: AbortSignal.timeout(22000),
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

    if (!isLightlyValid(passage, questions, requirePassage)) {
      return jsonResponse(buildFallbackResponse("light_validation_failed"));
    }

    return jsonResponse(buildWorkerResponse(passage, questions));
  } catch (err) {
    return jsonResponse(buildFallbackResponse(`runtime_error:${err instanceof Error ? err.message : String(err)}`));
  }
});
