import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

type Question = {
  question: string;
  choices: [string, string, string, string];
  correct_answer: "A" | "B" | "C" | "D" | Array<"A" | "B" | "C" | "D">;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const practice = Array.isArray(body.practice) ? body.practice as Question[] : [];
  const passage = typeof body.passage === "string" ? body.passage : "";
  if (!practice.length) {
    return new Response(JSON.stringify({ error: "practice is required" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const payload = {
    grade: body.grade,
    subject: body.subject,
    skill: body.skill,
    level: body.level,
    mode: "enrichment",
    practiceQuestions: practice,
    passage,
  };

  const target = new URL(req.url);
  target.pathname = target.pathname.replace(/\/generate-enrichment$/, "/bright-worker");

  const res = await fetch(target.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      authorization: req.headers.get("authorization") || "",
      apikey: req.headers.get("apikey") || "",
      "x-client-info": req.headers.get("x-client-info") || "",
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json();
  if (!res.ok) {
    return new Response(JSON.stringify(data), {
      status: res.status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({
    cross: data.cross,
    tutor: data.tutor,
    answerKey: data.answerKey,
  }), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
