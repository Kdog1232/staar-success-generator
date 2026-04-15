import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const payload = {
      ...body,
      mode: "enrichment",
    };

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    if (!supabaseUrl) {
      throw new Error("SUPABASE_URL missing");
    }

    const authHeader = req.headers.get("Authorization") || "";
    const apiKeyHeader = req.headers.get("apikey") || Deno.env.get("SUPABASE_ANON_KEY") || "";

    const enrichRes = await fetch(`${supabaseUrl}/functions/v1/bright-worker`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(authHeader ? { Authorization: authHeader } : {}),
        ...(apiKeyHeader ? { apikey: apiKeyHeader } : {}),
      },
      body: JSON.stringify(payload),
    });

    if (!enrichRes.ok) {
      throw new Error(`cross_only_status_${enrichRes.status}`);
    }

    const enrichData = await enrichRes.json();
    return new Response(JSON.stringify({
      cross: {
        passage: String(enrichData?.cross?.passage || ""),
        questions: Array.isArray(enrichData?.cross?.questions) ? enrichData.cross.questions.slice(0, 5) : [],
      },
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.warn("[cross-only] failed:", err?.message ?? String(err));
    return new Response(JSON.stringify({
      cross: {
        passage: "",
        questions: [],
      },
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
