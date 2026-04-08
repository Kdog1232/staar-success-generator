import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

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
    const { grade, subject, skill, level } = await req.json();

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
