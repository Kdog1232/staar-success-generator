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
You are a STAAR test generator.

Requested grade: ${grade}
Requested subject: ${subject}
Requested skill: ${skill}
Requested level: ${level}

Return ONLY valid JSON. Do NOT include explanations or markdown.

Use this schema:

{
  "questions": [
    {
      "question": "string",
      "choices": ["A", "B", "C", "D"],
      "correct_answer": "A",
      "explanation": "string",
      "hint": "string",
      "think": "string",
      "step_by_step": "string",
      "common_mistake": "string",
      "parent_tip": "string"
    }
  ]
}

Rules:
- Exactly 5 questions
- Each question must include ALL fields in the schema
- Each question must be STAAR-style and match requested skill/level
- Include exactly 4 answer choices
- Correct answer must match one of the choices
- Explanation must explain WHY the answer is correct
- Hint must be simple and student-friendly
- Think must be a guiding question
- Step_by_step must be clear and concise (1-3 steps)
- Common_mistake must be realistic
- Parent_tip must be helpful and actionable
- No extra text outside JSON
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
