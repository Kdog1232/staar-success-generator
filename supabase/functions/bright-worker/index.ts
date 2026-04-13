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
    const { grade, subject, skill, level, tutorMode = false } = requestBody;

    const buildPrompt = (contentMode: "standard" | "cross_curricular") => `
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
- Include 6-8 total questions with difficulty progression (easy -> medium -> hard).
- Include at least 1 reasoning question and at least 1 application question.
- Use realistic distractors (no obvious throwaway choices).
- Answer choices must reflect realistic mistakes:
  - wrong operation
  - partial calculation
  - misreading the problem
- DO NOT include obviously incorrect answers.
- Avoid repetitive stems and avoid generic recall-only questions.
- Align questions to TEKS-level rigor and the selected skill focus (${skill}).
- Do NOT label DOK levels.
- NEVER force every subject into long-passage format.
- Use correct markdown headers exactly as specified below.
- Use clear but authentic STAAR-style wording.
- Avoid overly childish phrasing.
- Keep reading level appropriate for the grade.

CONTENT MODE RULES (STRICT):
OUTPUT STRUCTURE RULE (CRITICAL):
You must choose ONE format ONLY.

If contentMode = "standard":
- Output ONLY questions
- DO NOT include any section headers
- DO NOT include "### PASSAGE" or "### PASSAGE OR CONTEXT"
- DO NOT include a passage at any point
- Return exactly 6-8 questions
- NEVER include the word "PASSAGE"
- NEVER include any section headers

If contentMode = "cross_curricular":
- You MUST use this format:

### PASSAGE OR CONTEXT:
(write full passage here)

### QUESTIONS:
(all questions must be based on the passage)

Do NOT combine formats.
Do NOT switch formats mid-response.
Do NOT insert a passage after questions.

SUBJECT-SPECIFIC REQUIREMENTS (STRICT):
Math (CRITICAL UPGRADE):
- ALL questions must be word problems (no plain computation).
- Use real-world contexts such as:
  - school events
  - shopping
  - measurements
  - time
  - money
  - data
- Require 2-step or multi-step thinking when appropriate.
- Include situations where students must:
  - decide what operation to use
  - interpret information
  - ignore irrelevant details when appropriate
- Avoid overly simple problems like:
  - "8 + 5 = ?"
  - "How many total?"
- Good example:
  "A teacher is organizing books into boxes. Each box holds 6 books. If the teacher has 28 books, how many boxes will be completely filled?"
- Bad example:
  "28 ÷ 6 = ?"

Science (CRITICAL UPGRADE):
- EVERY question must be grounded in a real-world scenario.
- NO definition-only or isolated questions.
- Keep science content accurate for force and motion topics.
- When simple machines are used, concepts must be correct:
  - simple machines make work easier by reducing force or changing direction
  - include lever, pulley, inclined plane, wedge, screw, wheel & axle when relevant
- Use believable distractors tied to scientific misconceptions.
- DO NOT use obviously wrong answers.
- Include a rigor mix of DOK 1 and DOK 2.
- At least 50% of questions must be application-based.
- Integrate vocabulary naturally in context:
  - force, motion, work, fulcrum, effort
- Do NOT isolate vocabulary as definition-only items.
- Support below-level readability with short, clear wording without reducing rigor.
- Use this question type mix:
  - 5-6 multiple choice questions (A-D)
  - 1 short constructed response (SCR)
- SCR must include:
  - a sentence stem
  - a clear expectation for what the student must explain
- After EACH question include:
  - Correct Answer:
  - Explanation: 1-2 sentences explaining why
  - Common Mistake: why students pick the wrong answer
- Final self-check before output:
  - If any question lacks real-world context -> rewrite it
  - If distractors are not believable -> rewrite them
  - If the question would not appear on STAAR-style practice -> rewrite it

Social Studies (CRITICAL UPGRADE):
- DO NOT require a full passage.
- Use a mix of:
  - direct knowledge questions
  - scenario-based questions
  - micro-context (1-2 sentence background when needed)
- If a question references "based on the passage", remove or rewrite it.
- Total questions must be exactly 7.
- Required mix:
  - 3-4 direct knowledge questions
  - 2-3 application/scenario questions
  - 1-2 short constructed responses (SCR)
- Include DOK 1 and DOK 2 rigor.
- At least 50% must require thinking, not just recall.
- Use real-world or historical scenarios.
- Distractors must be believable misconceptions.
- Do NOT use obviously wrong answers.
- Integrate vocabulary naturally in context:
  - settlement
  - resources
  - culture
  - conflict
  - opportunity
- Do NOT create definition-only questions unless paired with context.
- Use short, clear sentences for below-level accessibility.
- Add sentence stems for ALL short responses.
- At least 2 questions must include micro-context (1-2 sentences) before the question.
- For each multiple-choice question include:
  - Correct Answer:
  - Explanation: 1 sentence
  - Common Mistake: why students pick the wrong answer
- Final self-check before output:
  - If any question references a passage -> rewrite it
  - If fewer than 2 questions are scenario-based -> fix it
  - If distractors are not believable -> fix them
  - If it feels like trivia instead of STAAR practice -> fix it

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
  - Output ONLY 6-8 numbered questions.
  - Each question must be a word problem.
  - No passage.
  - No section headers.
- If contentMode = "cross_curricular":
  - Use a 250-400 word subject-based passage/context and derive all math items from it.
- Include STAAR-style word problems, multi-step reasoning, and numerical response when appropriate.

3) SCIENCE
- If contentMode = "standard":
  - Output 6-7 total questions.
  - Include 5-6 multiple choice questions (A-D) and 1 short constructed response.
  - Every question must use a real-world scenario.
  - Keep language short and clear for below-level accessibility without reducing rigor.
- If contentMode = "cross_curricular":
  - Use a 250-400 word subject-based real-world science passage/context and derive all science items from it.
  - Include 5-6 passage-based multiple choice questions (A-D) and 1 short constructed response tied to the passage.
- Emphasize force/motion reasoning, cause/effect, scientific evidence, and application.

4) SOCIAL STUDIES
- If contentMode = "standard":
  - Output exactly 7 questions.
  - Do NOT use or require a full passage.
  - Include 3-4 direct knowledge questions.
  - Include 2-3 application/scenario questions.
  - Include 1-2 short constructed responses with sentence stems.
  - Include micro-context before at least 2 questions.
- If contentMode = "cross_curricular":
  - Use a 250-400 word historical/civic passage/context and derive all items from it.
- Include interpretation, cause/effect, and reasoning questions tied to the stimulus/context.

OUTPUT FORMAT (STRICT):
- If contentMode = "standard": return only numbered questions (no headers).
- If contentMode = "cross_curricular": use only these headers in this order:
  - ### PASSAGE OR CONTEXT:
  - ### QUESTIONS:

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

    const generateContent = async (contentMode: "standard" | "cross_curricular") => {
      const aiRes = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          input: buildPrompt(contentMode),
        }),
      });

      const data = await aiRes.json();

      if (!aiRes.ok) {
        throw new Error(data?.error?.message || "Generation failed");
      }

      data.output_text = data.output_text || data.output?.[0]?.content?.[0]?.text || "No response generated";
      console.log("CONTENT MODE:", contentMode);
      console.log("OUTPUT LENGTH:", data.output_text?.length);

      if (contentMode === "cross_curricular" && !/###\s*PASSAGE/i.test(data.output_text)) {
        console.error("❌ Missing passage — injecting fallback");
        return `
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

      return data.output_text;
    };

    const validateSocialStudies = (outputText: string) => {
      const hasPassageReference = /based on the passage/i.test(outputText);
      const questionMatches = outputText.match(/\n\s*\d+\./g) || [];
      const questionCount = questionMatches.length;
      const scrCount = (outputText.match(/Use this sentence starter:/gi) || []).length;
      const scenarioCount = (outputText.match(/A settler|A citizen|A group|Imagine|A person/gi) || []).length;
      const directCount = questionCount - scenarioCount - scrCount;

      return {
        isValid:
          !hasPassageReference &&
          questionCount === 7 &&
          scrCount >= 1 &&
          scrCount <= 2 &&
          scenarioCount >= 2 &&
          directCount >= 3,
      };
    };

    const socialStudiesFallback = () => `1. Which word best describes a new community started by families moving to a new area?
A. settlement
B. electricity
C. pollution
D. telescope
Correct Answer: A
Explanation: A settlement is a community where people establish homes.
Common Mistake: Choosing B because modern cities use electricity, but electricity is not the name of a community.

2. A group of families moves near a river because the land is good for farming and water is nearby. Which resource are they using most?
A. volcanoes
B. fresh water
C. mountain snow
D. desert sand
Correct Answer: B
Explanation: The scenario points to the river as the key resource for farming and daily life.
Common Mistake: Choosing C because snow is water, but the scenario gives a river as the available resource.

3. Settlers in one town trade crops for tools from another town. What opportunity does this create?
A. fewer goods to share
B. more conflict over weather
C. better access to needed supplies
D. less need for resources
Correct Answer: C
Explanation: Trading helps both towns get resources they need.
Common Mistake: Choosing B because conflict can happen, but the question asks about the trade opportunity.

4. A citizen notices two groups disagree about land boundaries but agree to meet and discuss rules. What is the main goal of this meeting?
A. to increase conflict
B. to solve conflict peacefully
C. to remove all resources
D. to stop all cultural traditions
Correct Answer: B
Explanation: Meeting to discuss rules is a peaceful way to resolve conflict.
Common Mistake: Choosing A by focusing on the disagreement instead of the purpose of the meeting.

5. Imagine a community has rich soil but very little clean water. Which action is the best first step?
A. plant larger fields immediately
B. ignore the water problem
C. develop a plan to protect and share water
D. move all crops indoors
Correct Answer: C
Explanation: Communities must manage limited resources before expanding farming.
Common Mistake: Choosing A because rich soil seems enough, but water is still required.

6. A person says, "Our culture includes music, food, and celebrations from our families." How can culture help a community?
Use this sentence starter: "One way culture helps a community is..."

7. A group of settlers must choose between building near a trade road or near farmland. Which location should they choose and why?
Use this sentence starter: "The better location is... because..."`;

    const standardOutput = await generateContent("standard");
    const crossOutput = await generateContent("cross_curricular");

    let finalStandard = standardOutput;

    if (/^social studies$/i.test(subject)) {
      let validation = validateSocialStudies(standardOutput);

      if (!validation.isValid) {
        console.log("⚠️ Regenerating Social Studies (failed validation)");
        finalStandard = await generateContent("standard");
        validation = validateSocialStudies(finalStandard);
      }

      if (!validation.isValid) {
        console.log("⚠️ Social Studies regeneration failed validation, using fallback");
        finalStandard = socialStudiesFallback();
      }
    }

    await supabase
      .from("profiles")
      .update({
        generations_used: profile.generations_used + 1,
      })
      .eq("id", user.id);

    return new Response(JSON.stringify({
      standard: finalStandard,
      cross: crossOutput
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
