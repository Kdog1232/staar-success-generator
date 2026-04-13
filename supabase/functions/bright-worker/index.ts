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
    const { grade, subject, skill, level, tutorMode = false } = requestBody;

    const prompt = `
You are a Texas STAAR assessment expert.

Generate HIGH-RIGOR STAAR-style practice.

INPUTS:
- Grade: ${grade}
- Subject: ${subject}
- Skill Focus: ${skill}
- Level: ${level}

GOAL:
Create realistic STAAR practice that matches test difficulty and question style while remaining clear for students.

RIGOR RULES (ALWAYS):
- Match STAAR rigor and wording.
- Write plausible, high-quality distractors.
- Include reasoning-based items, not only recall.
- Include a mix of easy, medium, and challenging questions
- Do NOT label questions with DOK levels
- Keep each question aligned to the selected skill focus.

SUBJECT-SPECIFIC REQUIREMENTS:
- Reading: Include one engaging passage (250-400 words) and build questions from it.
- Math: Include multi-step real-world problems and show authentic STAAR-style structure.
- Science: Include scenario-based reasoning questions with evidence-focused thinking.
- Social Studies: Include historical or civic context that requires analysis, interpretation, and cause/effect reasoning.

SKILL MAPPING:
Use the selected skill focus (${skill}) as the primary target for most questions.

OUTPUT FORMAT (USE THESE HEADERS EXACTLY):
### PASSAGE OR CONTEXT:
...

### QUESTIONS:
...

### ANSWER KEY:
- For EACH question, use this exact structure:
  1. Correct Answer: <letter or short answer>
     Explanation:
     <clear why, with evidence from passage/problem>
     Common Mistake:
     <why a student might pick a wrong answer>
     Parent Tip:
     <simple practical coaching step for a parent>

- Keep language parent-friendly:
  - short, clear sentences
  - no educational jargon
  - specific help, not generic advice
  - concise but still rigorous in reasoning

### PARENT HELP:
- Give 3-5 short coaching tips parents can use right away based on common errors in this set.

TUTOR MODE UPGRADE (APPLY ONLY IF tutorMode = true):
${tutorMode ? `- Add a section titled "### TUTOR MODE:"
- For EACH question include:
  - Hint: Reference exact words/phrases from the passage or context. Avoid generic hints.
  - Think like this: 1-2 short coaching lines that model real student thinking using evidence from THIS passage/context.
  - Correct Answer: Include answer choice and short label when possible (example: C) Excited).
  - Why: 1-2 concise sentences that quote or paraphrase the strongest textual/math/science evidence.
- Keep tone like a live tutor guiding one child through one exact question.` : `- tutorMode is false. Do not include a TUTOR MODE section.`}

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

    const text = data.output?.[0]?.content?.[0]?.text || "No response generated";

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
