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
  console.log("AUTH HEADER:", req.headers.get("Authorization"));

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_ANON_KEY") ?? "",
    {
      global: {
        headers: {
          Authorization: req.headers.get("Authorization")!,
        },
      },
    }
  );

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const requestBody = await req.json().catch(() => ({}));
  const loginCheckOnly = requestBody?.trigger === "login_check";

  const email = user.email?.toLowerCase().trim();
  const paidEmails = [
    "garyadams892@gmail.com",
    "mdhowell64@gmail.com",
  ];

  if (email && paidEmails.includes(email)) {
    const { data: existingProfile } = await supabase
      .from("profiles")
      .select("id, plan")
      .eq("id", user.id)
      .single();

    if (existingProfile && existingProfile.plan !== "paid") {
      console.log("🔥 Upgrading user in backend:", email);

      await supabase
        .from("profiles")
        .update({
          plan: "paid",
          generations_used: 0,
        })
        .eq("id", user.id);
    }
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("plan, generations_used")
    .eq("id", user.id)
    .single();

  if (!profile) {
    return new Response(JSON.stringify({ error: "Profile not found" }), {
      status: 404,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (loginCheckOnly) {
    return new Response(
      JSON.stringify({
        ok: true,
        plan: profile.plan,
        generations_used: profile.generations_used,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }

  if (profile.plan !== "paid" && profile.generations_used >= 5) {
    return new Response(JSON.stringify({ error: "Free limit reached" }), {
      status: 403,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
    const { grade, subject, skill, level } = requestBody;

    const buildPrompt = () => `
You are an expert STAAR test designer.

Create rigorous STAAR-style questions that REQUIRE higher-order thinking.

Grade: ${grade}
Subject: ${subject}
Skill: ${skill}
Level: ${level}

---

CORE RULES (MANDATORY):

- NO simple recall questions
- NO definition-only questions
- NO obvious answers
- Every question must require:
  - inference
  - analysis
  - reasoning
  - or evidence-based thinking

---

QUESTION DESIGN REQUIREMENTS:

Each question MUST:
- Require students to think deeply
- Include plausible distractors (wrong answers that sound correct)
- Force students to justify their thinking
- Avoid surface-level clues

---

READING (CRITICAL):

- ALWAYS include a passage (150–300 words)
- Questions must require:
  - main idea (inference, not obvious)
  - author's purpose
  - text evidence
  - inference across sentences
- DO NOT ask “What is the main idea?” directly
👉 Instead ask:
  - “Which statement best explains…”
  - “What can the reader conclude…”
  - “Which detail supports…”

---

MATH:

- Use multi-step problems
- Require reasoning (not just calculation)
- Include word problems
- Answers must include common student mistakes

---

SCIENCE:

- Use scenarios or experiments
- Ask about cause/effect, reasoning, or prediction
- Avoid definition questions

---

SOCIAL STUDIES:

- Use real-world or historical scenarios
- Ask about impact, reasoning, or conclusions
- Require interpreting information

---

OUTPUT FORMAT (JSON ONLY):

{
  "passage": "",
  "questions": [
    {
      "question": "",
      "choices": ["A...", "B...", "C...", "D..."],
      "correct_answer": "A",
      "explanation": "",
      "hint": "",
      "think": "",
      "step_by_step": "",
      "common_mistake": "",
      "parent_tip": ""
    }
  ]
}

---

RIGOR RULES:

- Exactly 5 questions
- Each question must feel like a real STAAR test item
- Distractors must be believable
- Explanation must explain WHY others are wrong too
- Hint must guide thinking (not give answer)
- Think must push reasoning
- Step_by_step must show strategy
- Common_mistake must reflect real student errors
- Parent_tip must be actionable

---

TONE:

- Clear and grade-appropriate
- Engaging (light modern tone allowed, but not excessive slang)
- Keep it school appropriate

---

CRITICAL:

If a question could be answered without thinking, it is INVALID.
Every question must challenge the student.

Return ONLY valid JSON.
NO extra text.
`;

    const OPENAI_KEY = Deno.env.get("OPENAI_API_KEY");

    if (!OPENAI_KEY) {
      return new Response(JSON.stringify({ error: "Missing OPENAI_API_KEY" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const generateContent = async () => {
      const aiRes = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          input: buildPrompt(),
        }),
      });

      const data = await aiRes.json();

      if (!aiRes.ok) {
        throw new Error(data?.error?.message || "Generation failed");
      }

      return data.output_text || data.output?.[0]?.content?.[0]?.text || "";
    };
    const aiText = await generateContent();
    const cleaned = aiText
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .trim();
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      console.error("JSON parse failed:", aiText);
      parsed = {
        questions: [],
        fallback: aiText
      };
    }

    await supabase
      .from("profiles")
      .update({
        generations_used: profile.generations_used + 1,
      })
      .eq("id", user.id);

    const normalizedQuestions = Array.isArray(parsed.questions)
      ? parsed.questions.map((q: Record<string, unknown>) => ({
        question: String(q.question ?? ""),
        choices: Array.isArray(q.choices) ? q.choices.slice(0, 4).map((choice) => String(choice)) : [],
        correct_answer: String(q.correct_answer ?? ""),
        explanation: String(q.explanation ?? ""),
        hint: String(q.hint ?? ""),
        think: String(q.think ?? ""),
        step_by_step: String(q.step_by_step ?? ""),
        common_mistake: String(q.common_mistake ?? ""),
        parent_tip: String(q.parent_tip ?? ""),
      }))
      : [];

    return new Response(JSON.stringify({
      questions: normalizedQuestions,
      fallback: parsed.fallback || ""
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
