import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

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
          headers: { Authorization: req.headers.get("Authorization")! },
        },
      }
    );

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
    }

    const { grade, subject, skill, level, mode } = await req.json();

    // ===============================
    // 🔥 SKILL STRUCTURE ENGINE
    // ===============================
    function getSkillStructure() {
      const s = skill.toLowerCase();
      const subj = subject.toLowerCase();

      if (subj === "reading") {
        if (s.includes("main idea")) return `
- Q1: Main idea
- Q2: Supporting detail
- Q3: Supporting detail
- Q4: Development of idea
- Q5: Strongest evidence
`;

        if (s.includes("inference")) return `
- Q1: Inference
- Q2: Text clue
- Q3: Text clue
- Q4: Character reasoning
- Q5: Best evidence
`;

        if (s.includes("theme")) return `
- Q1: Theme
- Q2: Supporting event
- Q3: Supporting detail
- Q4: Character action
- Q5: Strongest evidence
`;

        if (s.includes("vocabulary")) return `
- Q1: Meaning in context
- Q2: Supporting clue
- Q3: Another clue
- Q4: Word usage
- Q5: Best definition
`;

        if (s.includes("comparing")) return `
- Q1: Compare texts
- Q2: Similarity
- Q3: Difference
- Q4: Author purpose
- Q5: Best evidence
`;
      }

      if (subj === "math") {
        return `
- Q1: Real-world problem (2-step)
- Q2: Real-world problem (2-step)
- Q3: Conceptual understanding
- Q4: Application
- Q5: Error analysis or reasoning
`;
      }

      if (subj === "science") {
        return `
- Q1: Concept
- Q2: Scenario
- Q3: Cause/effect
- Q4: Data
- Q5: Evidence reasoning
`;
      }

      if (subj.includes("social")) {
        return `
- Q1: Main idea
- Q2: Cause/effect
- Q3: Detail
- Q4: Reasoning
- Q5: Evidence
`;
      }

      return "";
    }

    // ===============================
    // 🔥 PROMPT BUILDER
    // ===============================
    function buildPrompt() {
      const g = parseInt(grade);

      return `
MODE: ${mode}
SUBJECT: ${subject}
GRADE: ${grade}
LEVEL: ${level}
SKILL: ${skill}

PASSAGE:
${g <= 3 ? "- 80–140 words, simple" : "- 200–300 words"}

QUESTION STRUCTURE:
${getSkillStructure()}

RULES:
- EXACTLY 5 questions
- Follow structure exactly
- Align to skill
- No random questions

OUTPUT JSON ONLY:
{
  "passage": "",
  "questions": [
    {
      "question": "",
      "choices": ["A. ...","B. ...","C. ...","D. ..."],
      "correct_answer": "A",
      "explanation": ""
    }
  ]
}
`;
    }

    // ===============================
    // 🔁 GENERATION WITH TIMEOUT
    // ===============================
    async function generateContent() {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 12000);

        console.log("📡 CALLING OPENAI");

        const res = await fetch("https://api.openai.com/v1/responses", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${Deno.env.get("OPENAI_API_KEY")}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            input: buildPrompt(),
          }),
          signal: controller.signal,
        });

        clearTimeout(timeout);

        console.log("📥 OPENAI STATUS:", res.status);

        if (!res.ok) {
          throw new Error(`OpenAI error: ${res.status}`);
        }

        const data = await res.json();

        const text =
          data.output_text ||
          data.output?.[0]?.content?.[0]?.text ||
          "";

        if (!text) {
          throw new Error("Empty AI response");
        }

        const cleaned = text.replace(/```json/g, "").replace(/```/g, "").trim();

        let parsed;

        try {
          parsed = JSON.parse(cleaned);
        } catch {
          throw new Error("Invalid JSON from AI");
        }

        let questions = parsed.questions || [];

        while (questions.length < 5) {
          questions.push({
            question: "Which answer best supports the idea?",
            choices: [
              "A. Correct answer",
              "B. Incorrect",
              "C. Incorrect",
              "D. Incorrect"
            ],
            correct_answer: "A",
            explanation: "This supports the concept."
          });
        }

        console.log("✅ RETURNING AI CONTENT");

        return {
          passage: parsed.passage || "",
          questions
        };

      } catch (err) {
        console.log("❌ AI FAILURE:", err);

        return {
          passage: "Students worked together to solve a problem and learned the importance of teamwork.",
          questions: Array.from({ length: 5 }).map(() => ({
            question: "What is the main idea?",
            choices: [
              "A. Teamwork helps solve problems",
              "B. Working alone is better",
              "C. School is hard",
              "D. Friends are fun"
            ],
            correct_answer: "A",
            explanation: "Teamwork is the focus."
          }))
        };
      }
    }

    const result = await generateContent();

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
});
