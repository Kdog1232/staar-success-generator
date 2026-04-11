import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    console.log("[gumroad-webhook] Incoming webhook event");
    const body = await req.json();
    console.log("[gumroad-webhook] Payload received");

    // Normalize email to prevent casing/format matching issues.
    const email = (body?.email || body?.purchase?.email || "").toLowerCase().trim();
    console.log("[gumroad-webhook] Extracted email:", email);

    if (!email) {
      console.log("[gumroad-webhook] Missing email in payload");
      return new Response(JSON.stringify({ error: "No email found" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    );

    // Lookup user profile by normalized email.
    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("id, plan")
      .eq("email", email)
      .single();

    // If user is not present yet, don't fail webhook delivery.
    if (profileError && profileError.code === "PGRST116") {
      console.log("[gumroad-webhook] Profile not found yet, acking webhook for email:", email);
      return new Response(JSON.stringify({ success: true, message: "User not found yet; webhook acknowledged." }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (profileError) {
      console.log("[gumroad-webhook] Profile lookup error:", profileError.message);
      return new Response(JSON.stringify({ error: profileError.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!profile) {
      console.log("[gumroad-webhook] No profile returned; acking webhook for email:", email);
      return new Response(JSON.stringify({ success: true, message: "No matching user yet; webhook acknowledged." }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log("[gumroad-webhook] Profile found:", profile.id);

    // Idempotency: if already paid, don't update again.
    if (profile.plan === "paid") {
      console.log("[gumroad-webhook] User already on paid plan. No update required.");
      return new Response(JSON.stringify({ success: true, message: "Already paid" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { error: updateError } = await supabase
      .from("profiles")
      .update({
        plan: "paid",
        generations_used: 0,
      })
      .eq("id", profile.id);

    if (updateError) {
      console.log("[gumroad-webhook] Upgrade update error:", updateError.message);
      return new Response(JSON.stringify({ error: updateError.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log("[gumroad-webhook] Upgrade applied for profile:", profile.id);
    return new Response(JSON.stringify({ success: true, message: "Upgrade applied" }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.log("[gumroad-webhook] Unexpected error:", err?.message ?? String(err));
    return new Response(JSON.stringify({ error: "Webhook processing failed" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
