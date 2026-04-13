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
          upgraded_via: "gumroad_manual",
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
    const { grade, subject, skill, level, tutorMode = false, contentMode = "standard" } = requestBody;

    const prompt = `
You are generating a teacher-ready STAAR practice assignment for Texas students.

INPUTS:
- Grade: ${grade}
- Subject: ${subject}
- Skill Focus: ${skill}
- Level: ${level}
- Tutor Mode Enabled: ${tutorMode}
- Content Mode: ${contentMode}

PRIMARY GOAL:
Produce HIGH-RIGOR, SUBJECT-ACCURATE STAAR-aligned practice that is better than typical worksheet generators.

GLOBAL RULES (MANDATORY):
- Keep output polished, classroom-ready, and instructionally useful.
- Match authentic STAAR tone and structure by subject.
- Include 5-8 total questions with difficulty progression (easy -> medium -> hard).
- Include at least 1 reasoning question and at least 1 application question.
- Use realistic distractors (no obvious throwaway choices).
- Avoid repetitive stems and avoid generic recall-only questions.
- Align questions to TEKS-level rigor and the selected skill focus (${skill}).
- Do NOT label DOK levels.
- NEVER force every subject into long-passage format.
- Use correct markdown headers exactly as specified below.

CONTENT MODE RULES (MANDATORY):
- If contentMode = "standard":
  - Reading/ELAR stays passage-based.
  - Math stays direct-problem first (no long passage).
  - Science stays direct-concept first + short scenario.
  - Social Studies stays short stimulus based.
- If contentMode = "cross_curricular":
  - CROSS-CURRICULAR MODE:
  - Include ONE passage (250-350 words) related to the selected subject.
  - Most questions should reference the passage.
  - Maintain subject rigor (math = calculations, science = reasoning, etc.).
  - Keep instructions simple and clear.

SUBJECT FORMAT RULES (STRICT):
1) READING / ELAR
- Must include one passage of 250-400 words.
- Every question must depend on that passage.
- Ensure question mix includes:
  - inference
  - vocabulary in context
  - theme/central idea
  - evidence-based analysis

2) MATH
- If contentMode = "standard":
  - Do NOT include a long passage.
  - Begin with 4-6 direct problems (equations, multi-step, and real-world math).
  - Then include 1-2 applied problems using one short scenario (2-3 sentences max).
- If contentMode = "cross_curricular":
  - Use a 250-400 word subject-based passage/context and derive all math items from it.
- Include STAAR-style word problems, multi-step reasoning, and numerical response when appropriate.

3) SCIENCE
- If contentMode = "standard":
  - Do NOT include a long passage.
  - Begin with 3-4 direct concept questions.
  - Then include one short scenario (experiment, observation, or real-world situation).
  - Add 1-2 questions tied to that scenario.
- If contentMode = "cross_curricular":
  - Use a 250-400 word subject-based real-world science passage/context and derive all science items from it.
- Emphasize cause/effect, scientific reasoning, and evidence use.

4) SOCIAL STUDIES
- If contentMode = "standard":
  - Use a short historical/civic stimulus (not a full passage).
- If contentMode = "cross_curricular":
  - Use a 250-400 word historical/civic passage/context and derive all items from it.
- Include interpretation, cause/effect, and reasoning questions tied to the stimulus/context.

OUTPUT FORMAT (STRICT - USE THESE HEADERS EXACTLY):
### PASSAGE OR CONTEXT:

This section must ALWAYS exist if contentMode = "cross_curricular".
Write the full passage immediately under this header before writing any questions.

### QUESTIONS:
- Number questions clearly.
- Ensure the full set follows the subject format rules above.

### ANSWER KEY:
For EACH question include:
- Correct Answer:
- Explanation: (must reference the actual question/scenario and model reasoning)
- Common Mistake: (why a student might miss it)
- Parent Tip: (simple actionable coaching step)

${tutorMode ? `### TUTOR MODE:
For EACH question include:
- Hint: reference an exact part of the question/scenario.
- Think Like This: model student thinking in 1-2 steps.
- Why: short evidence-based reasoning.
` : ``}
### PARENT HELP:
- Provide 3-5 actionable parent tips based on likely student errors in this set.

`;

    const OPENAI_KEY = Deno.env.get("OPENAI_API_KEY");

    if (!OPENAI_KEY) {
      return new Response(JSON.stringify({ error: "Missing OPENAI_API_KEY" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const aiRes = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        input: prompt,
      }),
    });

    const data = await aiRes.json();

    if (!aiRes.ok) {
      return new Response(JSON.stringify(data), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    data.output_text = data.output_text || data.output?.[0]?.content?.[0]?.text || "No response generated";

    console.log("CONTENT MODE:", contentMode);
    console.log("OUTPUT LENGTH:", data.output_text?.length);

    if (
      contentMode === "cross_curricular" &&
      !/###\s*PASSAGE/i.test(data.output_text)
    ) {
      console.error("❌ Missing passage — injecting fallback");

      data.output_text = `
### PASSAGE OR CONTEXT:
A short informational passage about ${subject} and ${skill}.

### QUESTIONS:
1. Based on the passage, what is being explained?
A) ...
B) ...
C) ...
D) ...

### ANSWER KEY:
1. Correct Answer: A
Explanation: Placeholder explanation
Common Mistake: Misreading the passage
Parent Tip: Encourage careful reading

### PARENT HELP:
- Review key ideas from the passage
`;
    }

    const text = data.output_text;

    await supabase
      .from("profiles")
      .update({
        generations_used: profile.generations_used + 1,
      })
      .eq("id", user.id);

    return new Response(JSON.stringify({ text }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
